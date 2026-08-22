/**
 * RunStore adapters (ADR-0060) — in-memory (tests/dev) and Redis (production).
 *
 * The run store is the DURABLE source of truth for a HITL run: its metadata
 * (dag, input, identity, status, timestamps) and the serialized `{state,
 * context}` checkpoint. The queue backend is only a wake-up trigger, so a run
 * survives queue retention and resumes from here.
 *
 * Redis key layout (checkpoint split from metadata so per-transition checkpoint
 * writes never race the status writes), tenant-prefixed (AD-4 / FR-013 / SC-001):
 *   fugue:<tenant>:hitl:run:<runId>   →  JSON RunMeta (record minus checkpoint)
 *   fugue:<tenant>:hitl:ckpt:<runId>  →  checkpoint string (framework `toJson`)
 *
 * SECURITY INVARIANT (load-bearing for AD-4 / FR-013 / SC-001):
 *   The Redis store is constructed bound to ONE `TenantId`, so a single store
 *   instance can only ever read/write its own tenant's run & checkpoint keys.
 *   Under the per-tenant Redis ACL (`~fugue:<tenant>:*`) a store holding tenant
 *   A's id physically cannot name tenant B's runs/checkpoints — making a flat,
 *   cross-tenant HITL key unrepresentable.
 */

import { z } from "zod";
import { asNonEmptyString, ok, err, safeErrorMessage, tryRunId, tryNodeId, tryDagId } from "@fuguejs/framework";
import type { Result, RunId } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import { markTeam } from "../../domain/auth.js";
import type { TenantId } from "../../domain/tenant.js";
import type { HitlRedisPort, LogPort } from "../../ports.js";
import type { RunLease, RunStorePort } from "../ports.js";
import { tryRunTimestampMs } from "../types.js";
import type { RunRecord, RunStatus, RunTimestampMs } from "../types.js";

// ── Persisted-shape validators (parse-don't-validate across the Redis boundary) ─
//
// The metadata half of a run is read back off the wire and then drives status
// projections and exhaustive `match`es on resume. Like the `tryRunId`/`tryNodeId`
// smart constructors guarding the HTTP/bot read paths, it must be PARSED, not
// `as`-cast: a value that parses as JSON but is structurally wrong (unknown
// status/identity `kind`, missing field) is rejected rather than flowing in to
// drive an exhaustive match off corrupt data. A `failed` status parses the
// complete current `FrameworkError` shape: missing required fields are rejected,
// while loose objects preserve additive fields across rolling upgrades.
//
// Branded ids are refined through the SAME smart constructors the HTTP/bot
// ingress paths use (`tryRunId`/`tryNodeId`/`tryDagId`), not a bare
// `z.string()`: a hand-edited Redis value carrying a `nodeId` with a space (or
// any char outside `ID_PATTERN`) is rejected here rather than flowing in as a
// branded `NodeId` its own regex would reject — closing the last gap between
// "parses" and "is a valid branded id".

/** A zod string refined by a framework id smart constructor (parse-don't-validate). */
const brandedId = (parse: (s: string) => Result<unknown, string>) =>
  z.string().refine((s) => parse(s).ok, { message: "value is not a valid branded id" });

const PersistedIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("admin") }),
  z.object({ kind: z.literal("team"), team: z.string(), label: z.string() }),
  z.object({ kind: z.literal("user"), sub: z.string(), azp: z.string() }),
]);

const NodeIdSchema = brandedId(tryNodeId);
const RunIdSchema = brandedId(tryRunId);
const optionalUsage = z.object({ tokensIn: z.number(), tokensOut: z.number() }).optional();
const retriability = z.enum(["retriable", "non-retriable"]);
const frameworkErrorKinds = z.enum([
  "validation", "retry-exhausted", "checkpoint-missing", "checkpoint-expired",
  "checkpoint-corrupt", "checkpoint-version-mismatch", "checkpoint-write-failed",
  "prompt-not-found", "cache-error", "node-crash", "cycle-detected", "aborted",
  "rejected", "invalid-reroute", "transient", "missing-default-edge",
  "output-unreachable-under-routing", "predicate-malformed", "duplicate-edge",
  "root-expects-input", "source-has-incoming", "invalid-dag-input-edge",
  "missing-capability", "llm-budget-exceeded", "infra-unreachable",
  "policy-refusal", "downstream-denied",
]);

// Persisted run failures are control-plane data, not an opaque diagnostic blob.
// Require every current FrameworkError variant's mandatory fields while keeping
// objects loose so additive fields survive rolling upgrades.
const FrameworkErrorSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("validation"), nodeId: NodeIdSchema, message: z.string(), path: z.string().optional() }),
  z.looseObject({ kind: z.literal("retry-exhausted"), nodeId: NodeIdSchema, attempts: z.number(), lastError: z.string(), rootErrorKind: frameworkErrorKinds.exclude(["retry-exhausted"]) }),
  z.looseObject({ kind: z.literal("checkpoint-missing"), runId: RunIdSchema }),
  z.looseObject({ kind: z.literal("checkpoint-expired"), runId: RunIdSchema, expiredAt: z.string() }),
  z.looseObject({ kind: z.literal("checkpoint-corrupt"), runId: RunIdSchema, nodeId: NodeIdSchema.optional(), message: z.string() }),
  z.looseObject({ kind: z.literal("checkpoint-version-mismatch"), runId: RunIdSchema, expected: z.string(), actual: z.string().optional() }),
  z.looseObject({ kind: z.literal("checkpoint-write-failed"), runId: RunIdSchema, nodeId: NodeIdSchema, invalidRunId: z.string().optional(), invalidNodeId: z.string().optional(), message: z.string() }),
  z.looseObject({ kind: z.literal("prompt-not-found"), promptName: z.string(), reason: z.string() }),
  z.looseObject({ kind: z.literal("cache-error"), operation: z.string(), message: z.string(), failureClass: z.enum(["transient", "permanent"]).optional() }),
  z.looseObject({ kind: z.literal("node-crash"), nodeId: NodeIdSchema, message: z.string(), stack: z.string().optional(), retriability, httpStatus: z.number().optional(), usage: optionalUsage }),
  z.looseObject({ kind: z.literal("cycle-detected"), nodeIds: z.array(NodeIdSchema) }),
  z.looseObject({ kind: z.literal("aborted"), reason: z.string(), usage: optionalUsage }),
  z.looseObject({ kind: z.literal("rejected"), nodeId: NodeIdSchema, reason: z.string() }),
  z.looseObject({ kind: z.literal("invalid-reroute"), targetNodeId: NodeIdSchema, message: z.string() }),
  z.looseObject({ kind: z.literal("transient"), nodeId: NodeIdSchema, message: z.string(), httpStatus: z.number().optional(), usage: optionalUsage }),
  z.looseObject({ kind: z.literal("missing-default-edge"), nodeId: NodeIdSchema }),
  z.looseObject({ kind: z.literal("output-unreachable-under-routing"), outputNodeId: NodeIdSchema, missedFromNode: NodeIdSchema }),
  z.looseObject({ kind: z.literal("predicate-malformed"), nodeId: NodeIdSchema, message: z.string() }),
  z.looseObject({ kind: z.literal("duplicate-edge"), fromNodeId: NodeIdSchema, toNodeId: NodeIdSchema }),
  z.looseObject({ kind: z.literal("root-expects-input"), nodeId: NodeIdSchema, message: z.string() }),
  z.looseObject({ kind: z.literal("source-has-incoming"), nodeId: NodeIdSchema, message: z.string() }),
  z.looseObject({ kind: z.literal("invalid-dag-input-edge"), edge: z.object({ from: z.string(), to: z.string() }), message: z.string() }),
  z.looseObject({ kind: z.literal("missing-capability"), missing: z.array(z.object({ nodeId: NodeIdSchema, capability: z.string() })).min(1) }),
  z.looseObject({ kind: z.literal("llm-budget-exceeded"), runId: RunIdSchema, nodeId: NodeIdSchema, cumulative: z.number(), budget: z.number() }),
  z.looseObject({ kind: z.literal("infra-unreachable"), operation: z.enum(["mint", "exchange", "federation", "downstream"]), hop: z.string(), message: z.string() }),
  z.looseObject({ kind: z.literal("policy-refusal"), scope: z.string(), agentClientId: z.string().optional() }),
  z.looseObject({ kind: z.literal("downstream-denied"), resource: z.string(), reason: z.string() }),
]);

const RunStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("queued") }),
  z.object({ kind: z.literal("running") }),
  z.object({
    kind: z.literal("suspended"),
    nodeId: NodeIdSchema,
    prompt: z.string().refine((value) => asNonEmptyString(value) !== undefined, { message: "prompt must be non-empty" }),
  }),
  z.object({ kind: z.literal("completed"), output: z.unknown() }),
  z.object({ kind: z.literal("failed"), error: FrameworkErrorSchema }),
]);

const RunMetaSchema = z.object({
  runId: brandedId(tryRunId),
  dagId: brandedId(tryDagId),
  ownerTeam: z.string().transform(markTeam),
  input: z.unknown(),
  identity: PersistedIdentitySchema,
  status: RunStatusSchema,
  createdAtMs: z.number().finite().transform((value) => value as RunTimestampMs),
  updatedAtMs: z.number().finite().transform((value) => value as RunTimestampMs),
});

// ── Active-run index (ADR-0074) ──────────────────────────────────────────────

/** A terminal run has left the active set; a non-terminal run still occupies a slot. */
const isTerminalStatus = (status: RunStatus): boolean =>
  status.kind === "completed" || status.kind === "failed";

const leaseLost = (lease: RunLease): Result<never, HostError> =>
  err({ kind: "run-lease-lost", runId: lease.runId });

const logWithoutThrowing = (
  logger: LogPort | undefined,
  level: "warn" | "error",
  message: string,
  data: Record<string, unknown>,
): void => {
  try {
    logger?.[level]?.(message, data);
  } catch {
    // Diagnostics never replace the store's typed persistence outcome.
  }
};

const readRunTimestamp = (now: () => number): Result<RunTimestampMs, HostError> => {
  const timestamp = tryRunTimestampMs(now());
  return timestamp.ok
    ? timestamp
    : err({
        kind: "internal-invariant-violated",
        message: `HITL clock returned an invalid timestamp: ${timestamp.error}`,
        context: {},
      });
};

/**
 * Whether a PERSISTED run-meta JSON string carries a terminal status. Defensive
 * and TOTAL: a parse failure yields `{ kind: "corrupt" }` with the parse error
 * so the caller can log a trail while STILL treating the corrupt member as
 * live (it stays counted, exactly as before) — fixing the terminal-index leak
 * must NOT introduce a new "one corrupt record blocks the whole gate" failure
 * mode, and the corruption must not vanish without a trace (house style:
 * `readMeta` and the prune failures below both log). Used only by the
 * active-index self-heal to spot a terminal run whose settle-time `sRem`
 * never landed.
 */
type PersistedStatusVerdict =
  | { readonly kind: "terminal" }
  | { readonly kind: "live" }
  | { readonly kind: "corrupt"; readonly parseError: string };

const parsePersistedStatus = (raw: string): PersistedStatusVerdict => {
  try {
    const parsed = RunMetaSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return { kind: "corrupt", parseError: parsed.error.message };
    }
    const kind = parsed.data.status.kind;
    return kind === "completed" || kind === "failed"
      ? { kind: "terminal" }
      : { kind: "live" };
  } catch (e) {
    return {
      kind: "corrupt",
      parseError: e instanceof Error ? e.message : String(e),
    };
  }
};

// ── In-Memory Adapter (tests/dev) ───────────────────────────────────────────

/**
 * In-memory run store. No Redis required. Exposes `_runs` for assertions.
 * Semantics match the Redis adapter (create is single-shot; checkpoint/status
 * are independent updates; an `active` index mirrors the non-terminal runs).
 */
export const createInMemoryRunStore = (
  now: () => number = Date.now,
): RunStorePort & {
  readonly _runs: ReadonlyMap<string, RunRecord>;
  readonly _active: ReadonlySet<string>;
} => {
  const runs = new Map<string, RunRecord>();
  // Mirrors the Redis active-run index SET (ADR-0074): run ids of non-terminal runs.
  const active = new Set<string>();
  return {
    _runs: runs,
    _active: active,
    async create(record) {
      if (runs.has(record.runId)) {
        return err({ kind: "internal-invariant-violated", message: `run '${record.runId}' already exists`, context: {} });
      }
      runs.set(record.runId, record);
      active.add(record.runId); // a fresh run is non-terminal — join the index
      return ok(undefined);
    },
    async get(runId) {
      return ok(runs.get(runId) ?? null);
    },
    async saveCheckpoint(lease, checkpoint) {
      if (lease.signal.aborted) return leaseLost(lease);
      const r = runs.get(lease.runId);
      if (!r) return err({ kind: "run-not-found", runId: lease.runId });
      runs.set(lease.runId, { ...r, checkpoint });
      return ok(undefined);
    },
    async setStatus(lease, status: RunStatus) {
      if (lease.signal.aborted) return leaseLost(lease);
      const r = runs.get(lease.runId);
      if (!r) return err({ kind: "run-not-found", runId: lease.runId });
      const updatedAtMs = readRunTimestamp(now);
      if (!updatedAtMs.ok) return updatedAtMs;
      runs.set(lease.runId, { ...r, status, updatedAtMs: updatedAtMs.value });
      if (isTerminalStatus(status)) active.delete(lease.runId); // settled → leave the index
      return ok(undefined);
    },
    async countActiveRuns() {
      // Self-heal (parity with the Redis adapter): drop any indexed id whose run
      // record no longer exists, then count the live remainder.
      for (const id of [...active]) {
        if (!runs.has(id)) active.delete(id);
      }
      return ok(active.size);
    },
    async listActiveRunIds() {
      for (const id of [...active]) {
        const record = runs.get(id);
        if (record === undefined || isTerminalStatus(record.status)) active.delete(id);
      }
      return ok([...active] as RunId[]);
    },
  };
};

// ── Redis Adapter (production) ───────────────────────────────────────────────

// The prefixes are derived from the bound `TenantId`, so every key a store
// instance emits is forced under `fugue:<tenant>:hitl:`. There is no code path
// that builds a run/checkpoint key without a tenant.
const runKey = (tenant: TenantId, runId: RunId): string => `fugue:${tenant}:hitl:run:${runId}`;
const ckptKey = (tenant: TenantId, runId: RunId): string => `fugue:${tenant}:hitl:ckpt:${runId}`;
const leaseKey = (tenant: TenantId, runId: RunId): string => `fugue:${tenant}:hitl:lock:${runId}`;
/**
 * The per-tenant active-run index SET (ADR-0074). Holds the run ids of all
 * non-terminal runs. Read via `sMembers` (NOT `scan`, which the per-tenant ACL
 * denies — ADR-0067) to count outstanding runs for the `maxQueuedRuns` gate. ONE
 * key under `~fugue:<tenant>:*`, so the ACL scopes it like every other run key.
 */
const activeKey = (tenant: TenantId): string => `fugue:${tenant}:hitl:active`;

/** The metadata half of a `RunRecord` (everything except the checkpoint string). */
type RunMeta = Omit<RunRecord, "checkpoint">;

interface RedisRunStoreConfig {
  /** TTL applied to run keys on every write, in seconds. Bounds storage growth. */
  readonly ttlSec: number;
  /** Wall-clock source (injected for tests). Defaults to `Date.now`. */
  readonly now?: () => number;
}

export const createRedisRunStore = (
  redis: HitlRedisPort,
  tenant: TenantId,
  config: RedisRunStoreConfig,
  logger?: LogPort,
): RunStorePort => {
  const expiry = { expiresInSec: config.ttlSec };
  const now = config.now ?? Date.now;

  const writeMeta = async (lease: RunLease, meta: RunMeta): Promise<Result<void, HostError>> => {
    const res = await redis.setIfValue(
      leaseKey(tenant, lease.runId),
      lease.ownerToken,
      runKey(tenant, lease.runId),
      JSON.stringify(meta),
      expiry,
    );
    if (!res.ok) return err(res.error);
    return res.value ? ok(undefined) : leaseLost(lease);
  };

  const compensateUnpublishedCreate = async (runId: RunId, checkpoint: string): Promise<void> => {
    const [index, preparedCheckpoint] = await Promise.all([
      redis.sRem(activeKey(tenant), runId),
      redis.compareAndDelete(ckptKey(tenant, runId), checkpoint),
    ]);
    if (!index.ok) {
      logWithoutThrowing(logger, "warn", "hitl: failed to remove active index after unpublished create", {
        runId,
        error: index.error.kind,
      });
    }
    if (!preparedCheckpoint.ok) {
      logWithoutThrowing(logger, "warn", "hitl: failed to remove checkpoint after unpublished create", {
        runId,
        error: preparedCheckpoint.error.kind,
      });
    }
  };

  const readMeta = async (runId: RunId): Promise<Result<RunMeta | null, HostError>> => {
    const res = await redis.get(runKey(tenant, runId));
    if (!res.ok) return err(res.error);
    if (res.value === null) return ok(null);
    let raw: unknown;
    try {
      raw = JSON.parse(res.value);
    } catch (e) {
      logWithoutThrowing(logger, "error", "hitl: corrupt run metadata in store (malformed JSON)", {
        runId,
        error: safeErrorMessage(e),
      });
      return err({ kind: "internal-invariant-violated", message: `corrupt run metadata for '${runId}'`, context: {} });
    }
    const parsed = RunMetaSchema.safeParse(raw);
    if (!parsed.success) {
      logWithoutThrowing(logger, "error", "hitl: corrupt run metadata in store (invalid shape)", {
        runId,
        error: parsed.error.message,
      });
      return err({ kind: "internal-invariant-violated", message: `corrupt run metadata for '${runId}'`, context: {} });
    }
    return ok(parsed.data as RunMeta);
  };

  const inspectActiveIndex = async (): Promise<Result<{
    readonly runIds: readonly RunId[];
    readonly conservativeCount: number;
  }, HostError>> => {
    const members = await redis.sMembers(activeKey(tenant));
    if (!members.ok) return err(members.error);

    const runIds: RunId[] = [];
    let conservativeCount = 0;
    for (const rawId of members.value) {
      const parsedId = tryRunId(rawId);
      if (!parsedId.ok) {
        const pruned = await redis.sRem(activeKey(tenant), rawId);
        if (!pruned.ok) {
          logWithoutThrowing(logger, "warn", "hitl: active-run index prune failed (invalid run id)", {
            runId: rawId,
            error: pruned.error.kind,
          });
        }
        continue;
      }

      const raw = await redis.get(runKey(tenant, parsedId.value));
      if (!raw.ok) return err(raw.error);
      if (raw.value === null) {
        // Metadata is the publication point. A live checkpoint with no metadata
        // is either an in-flight create or an unpublished remnant; keep its index
        // intent conservatively so a concurrent sweep cannot prune immediately
        // before publication. Once the checkpoint TTL expires too, prune.
        const checkpoint = await redis.get(ckptKey(tenant, parsedId.value));
        if (!checkpoint.ok) return err(checkpoint.error);
        if (checkpoint.value !== null) {
          conservativeCount++;
          continue;
        }
        const pruned = await redis.sRem(activeKey(tenant), rawId);
        if (!pruned.ok) {
          logWithoutThrowing(logger, "warn", "hitl: active-run index prune failed (leaked entry; count may over-report until next sweep)", {
            runId: rawId,
            error: pruned.error.kind,
          });
          conservativeCount++;
        }
        continue;
      }

      const verdict = parsePersistedStatus(raw.value);
      if (verdict.kind === "corrupt") {
        logWithoutThrowing(logger, "warn", "hitl: active-run index scan: unparseable run meta treated as live (count may over-report)", {
          runId: rawId,
          error: verdict.parseError,
        });
        conservativeCount++;
        continue;
      }
      if (verdict.kind === "terminal") {
        const pruned = await redis.sRem(activeKey(tenant), rawId);
        if (!pruned.ok) {
          logWithoutThrowing(logger, "warn", "hitl: active-run index prune failed (terminal entry; count may over-report until next sweep)", {
            runId: rawId,
            error: pruned.error.kind,
          });
          conservativeCount++;
        }
        continue;
      }
      runIds.push(parsedId.value);
      conservativeCount++;
    }
    return ok({ runIds, conservativeCount });
  };

  return {
    async create(record) {
      const { checkpoint, ...meta } = record;
      // Reject an already-published/torn legacy record before touching its
      // checkpoint. SET NX on the checkpoint remains the concurrent authority.
      const existing = await redis.get(runKey(tenant, record.runId));
      if (!existing.ok) return err(existing.error);
      if (existing.value !== null) {
        return err({ kind: "internal-invariant-violated", message: `run '${record.runId}' already exists`, context: {} });
      }
      // Publication protocol: prepare every byte needed to run BEFORE making the
      // metadata visible. Checkpoint/index remnants are non-runnable and the
      // active-index scan self-heals them; a visible queued run is complete.
      const ckpt = await redis.setNx(ckptKey(tenant, record.runId), checkpoint, expiry);
      if (!ckpt.ok) return err(ckpt.error);
      if (!ckpt.value) {
        return err({ kind: "internal-invariant-violated", message: `run '${record.runId}' already exists or has an unpublished checkpoint`, context: {} });
      }
      const idx = await redis.sAdd(activeKey(tenant), record.runId);
      if (!idx.ok) {
        await compensateUnpublishedCreate(record.runId, checkpoint);
        return err(idx.error);
      }
      // Metadata is the publication point and remains create-once with TTL.
      const published = await redis.setNx(runKey(tenant, record.runId), JSON.stringify(meta), expiry);
      if (!published.ok) {
        await compensateUnpublishedCreate(record.runId, checkpoint);
        return err(published.error);
      }
      if (!published.value) {
        await compensateUnpublishedCreate(record.runId, checkpoint);
        return err({ kind: "internal-invariant-violated", message: `run '${record.runId}' already exists`, context: {} });
      }
      return ok(undefined);
    },

    async get(runId) {
      const metaRes = await readMeta(runId);
      if (!metaRes.ok) return err(metaRes.error);
      if (metaRes.value === null) return ok(null);
      const ckptRes = await redis.get(ckptKey(tenant, runId));
      if (!ckptRes.ok) return err(ckptRes.error);
      if (ckptRes.value === null) {
        // Metadata without a checkpoint is a torn/expired record — surface it
        // rather than resuming from a missing state.
        return err({ kind: "internal-invariant-violated", message: `run '${runId}' has metadata but no checkpoint`, context: {} });
      }
      return ok({ ...metaRes.value, checkpoint: ckptRes.value });
    },

    async saveCheckpoint(lease, checkpoint) {
      if (lease.signal.aborted) return leaseLost(lease);
      const res = await redis.setIfValue(
        leaseKey(tenant, lease.runId),
        lease.ownerToken,
        ckptKey(tenant, lease.runId),
        checkpoint,
        expiry,
      );
      if (!res.ok) return err(res.error);
      return res.value ? ok(undefined) : leaseLost(lease);
    },

    async setStatus(lease, status) {
      if (lease.signal.aborted) return leaseLost(lease);
      const metaRes = await readMeta(lease.runId);
      if (!metaRes.ok) return err(metaRes.error);
      if (metaRes.value === null) return err({ kind: "run-not-found", runId: lease.runId });
      const updatedAtMs = readRunTimestamp(now);
      if (!updatedAtMs.ok) return updatedAtMs;
      const written = await writeMeta(lease, { ...metaRes.value, status, updatedAtMs: updatedAtMs.value });
      if (!written.ok) return written;
      if (isTerminalStatus(status)) {
        // Settled → leave the active-run index (ADR-0074). Idempotent (SREM of an
        // absent member is a no-op), so a re-settle never drifts the count.
        const idx = await redis.sRem(activeKey(tenant), lease.runId);
        if (!idx.ok) return err(idx.error);
      }
      return ok(undefined);
    },

    async countActiveRuns() {
      const active = await inspectActiveIndex();
      return active.ok ? ok(active.value.conservativeCount) : active;
    },

    async listActiveRunIds() {
      const active = await inspectActiveIndex();
      return active.ok ? ok(active.value.runIds) : active;
    },
  };
};
