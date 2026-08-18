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
import { ok, err, tryRunId, tryNodeId, tryDagId } from "@fuguejs/framework";
import type { Result, RunId } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import type { TenantId } from "../../domain/tenant.js";
import type { RedisPort, LogPort } from "../../ports.js";
import type { RunStorePort } from "../ports.js";
import type { RunRecord, RunStatus } from "../types.js";

// ── Persisted-shape validators (parse-don't-validate across the Redis boundary) ─
//
// The metadata half of a run is read back off the wire and then drives status
// projections and exhaustive `match`es on resume. Like the `tryRunId`/`tryNodeId`
// smart constructors guarding the HTTP/bot read paths, it must be PARSED, not
// `as`-cast: a value that parses as JSON but is structurally wrong (unknown
// status/identity `kind`, missing field) is rejected rather than flowing in to
// drive an exhaustive match off a corrupt discriminant. The `failed` error is
// kept loose (only its `kind` discriminant is asserted) so a `FrameworkError`
// shape change never trips the reader; all of its fields round-trip intact.
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

const RunStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("queued") }),
  z.object({ kind: z.literal("running") }),
  z.object({ kind: z.literal("suspended"), nodeId: brandedId(tryNodeId), prompt: z.string() }),
  z.object({ kind: z.literal("completed"), output: z.unknown() }),
  z.object({ kind: z.literal("failed"), error: z.looseObject({ kind: z.string() }) }),
]);

const RunMetaSchema = z.object({
  runId: brandedId(tryRunId),
  dagId: brandedId(tryDagId),
  input: z.unknown(),
  identity: PersistedIdentitySchema,
  status: RunStatusSchema,
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

// ── Active-run index (ADR-0074) ──────────────────────────────────────────────

/** A terminal run has left the active set; a non-terminal run still occupies a slot. */
const isTerminalStatus = (status: RunStatus): boolean =>
  status.kind === "completed" || status.kind === "failed";

/**
 * Whether a PERSISTED run-meta JSON string carries a terminal status. Defensive and
 * TOTAL: returns false on any parse/shape failure, so a corrupt member is never
 * pruned (it stays counted, exactly as before) — fixing the terminal-index leak must
 * NOT introduce a new "one corrupt record blocks the whole gate" failure mode. Used
 * only by the active-index self-heal to spot a terminal run whose settle-time `sRem`
 * never landed.
 */
const persistedStatusIsTerminal = (raw: string): boolean => {
  try {
    const obj = JSON.parse(raw) as { status?: { kind?: unknown } };
    const kind = obj?.status?.kind;
    return kind === "completed" || kind === "failed";
  } catch {
    return false;
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
    async saveCheckpoint(runId, checkpoint) {
      const r = runs.get(runId);
      if (!r) return err({ kind: "run-not-found", runId });
      runs.set(runId, { ...r, checkpoint });
      return ok(undefined);
    },
    async setStatus(runId, status: RunStatus) {
      const r = runs.get(runId);
      if (!r) return err({ kind: "run-not-found", runId });
      runs.set(runId, { ...r, status, updatedAtMs: now() });
      if (isTerminalStatus(status)) active.delete(runId); // settled → leave the index
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
  };
};

// ── Redis Adapter (production) ───────────────────────────────────────────────

// The prefixes are derived from the bound `TenantId`, so every key a store
// instance emits is forced under `fugue:<tenant>:hitl:`. There is no code path
// that builds a run/checkpoint key without a tenant.
const runKey = (tenant: TenantId, runId: RunId): string => `fugue:${tenant}:hitl:run:${runId}`;
const ckptKey = (tenant: TenantId, runId: RunId): string => `fugue:${tenant}:hitl:ckpt:${runId}`;
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
  redis: RedisPort,
  tenant: TenantId,
  config: RedisRunStoreConfig,
  logger?: LogPort,
): RunStorePort => {
  const expiry = { expiresInSec: config.ttlSec };
  const now = config.now ?? Date.now;

  const writeMeta = async (runId: RunId, meta: RunMeta): Promise<Result<void, HostError>> => {
    const res = await redis.set(runKey(tenant, runId), JSON.stringify(meta), expiry);
    if (!res.ok) return err(res.error);
    return ok(undefined);
  };

  const readMeta = async (runId: RunId): Promise<Result<RunMeta | null, HostError>> => {
    const res = await redis.get(runKey(tenant, runId));
    if (!res.ok) return err(res.error);
    if (res.value === null) return ok(null);
    let raw: unknown;
    try {
      raw = JSON.parse(res.value);
    } catch (e) {
      logger?.error?.("hitl: corrupt run metadata in store (malformed JSON)", { runId, error: e instanceof Error ? e.message : String(e) });
      return err({ kind: "internal-invariant-violated", message: `corrupt run metadata for '${runId}'`, context: {} });
    }
    const parsed = RunMetaSchema.safeParse(raw);
    if (!parsed.success) {
      logger?.error?.("hitl: corrupt run metadata in store (invalid shape)", { runId, error: parsed.error.message });
      return err({ kind: "internal-invariant-violated", message: `corrupt run metadata for '${runId}'`, context: {} });
    }
    return ok(parsed.data as RunMeta);
  };

  return {
    async create(record) {
      const { checkpoint, ...meta } = record;
      // Atomic create-once WITH TTL (SET NX EX): enforces create-once (a
      // duplicate run id is a caller bug) and never leaves a TTL-less meta key
      // if the process crashes between acquisition and expiry.
      const set = await redis.setNx(runKey(tenant, record.runId), JSON.stringify(meta), expiry);
      if (!set.ok) return err(set.error);
      if (!set.value) {
        return err({ kind: "internal-invariant-violated", message: `run '${record.runId}' already exists`, context: {} });
      }
      const ckpt = await redis.set(ckptKey(tenant, record.runId), checkpoint, expiry);
      if (!ckpt.ok) return err(ckpt.error);
      // Join the per-tenant active-run index (ADR-0074): a fresh run is non-terminal.
      // Idempotent (SADD of a present member is a no-op). Fail-closed on a Redis
      // error — consistent with the meta/ckpt writes above (the meta key's TTL
      // self-cleans any orphan if this is the op that fails).
      const idx = await redis.sAdd(activeKey(tenant), record.runId);
      if (!idx.ok) return err(idx.error);
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

    async saveCheckpoint(runId, checkpoint) {
      const res = await redis.set(ckptKey(tenant, runId), checkpoint, expiry);
      if (!res.ok) return err(res.error);
      return ok(undefined);
    },

    async setStatus(runId, status) {
      const metaRes = await readMeta(runId);
      if (!metaRes.ok) return err(metaRes.error);
      if (metaRes.value === null) return err({ kind: "run-not-found", runId });
      const written = await writeMeta(runId, { ...metaRes.value, status, updatedAtMs: now() });
      if (!written.ok) return written;
      if (isTerminalStatus(status)) {
        // Settled → leave the active-run index (ADR-0074). Idempotent (SREM of an
        // absent member is a no-op), so a re-settle never drifts the count.
        const idx = await redis.sRem(activeKey(tenant), runId);
        if (!idx.ok) return err(idx.error);
      }
      return ok(undefined);
    },

    async countActiveRuns() {
      // Read the per-tenant active-run index SET (ADR-0074) — `sMembers`, NOT
      // `scan` (the per-tenant ACL denies enumeration, ADR-0067).
      const members = await redis.sMembers(activeKey(tenant));
      if (!members.ok) return err(members.error);
      let live = 0;
      for (const id of members.value) {
        // SELF-HEAL of leaked index entries so the count never inflates beyond the
        // runs that ACTUALLY occupy a slot. A read failure IS surfaced (fail-closed)
        // so the gate never admits on a bad count; a prune failure is non-fatal.
        const raw = await redis.get(runKey(tenant, id as RunId));
        if (!raw.ok) return err(raw.error);
        if (raw.value === null) {
          // Meta absent (TTL-expired / hard-deleted) → leaked index entry; prune it.
          // Best-effort: a failed prune leaves the entry counted (conservative
          // over-count, never under-count, so no slot is wrongly freed) — but log
          // it, matching the house best-effort-with-log style. A persistently
          // failing prune would otherwise silently inflate the count toward
          // `maxQueuedRuns` and 429 legitimate startRun calls with no trail.
          const pruned = await redis.sRem(activeKey(tenant), id);
          if (!pruned.ok) {
            logger?.warn?.("hitl: active-run index prune failed (leaked entry; count may over-report until next sweep)", { runId: id, error: pruned.error.kind });
          }
          continue;
        }
        if (persistedStatusIsTerminal(raw.value)) {
          // TERMINAL but still indexed: the settle-time `sRem` did not land (a
          // transient Redis blip AFTER the terminal meta write). The meta key still
          // EXISTS, so the missing-meta prune above cannot catch it — `processRun`'s
          // terminal guard never re-issues the `sRem` either, so without pruning here
          // the run would leak a `maxQueuedRuns` slot for up to the run TTL (days).
          // Prune authoritatively on the persisted status. Idempotent. Best-effort
          // (a failed prune over-counts, never under-counts) but logged, as above.
          const pruned = await redis.sRem(activeKey(tenant), id);
          if (!pruned.ok) {
            logger?.warn?.("hitl: active-run index prune failed (terminal entry; count may over-report until next sweep)", { runId: id, error: pruned.error.kind });
          }
          continue;
        }
        live++;
      }
      return ok(live);
    },
  };
};
