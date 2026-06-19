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

// ── In-Memory Adapter (tests/dev) ───────────────────────────────────────────

/**
 * In-memory run store. No Redis required. Exposes `_runs` for assertions.
 * Semantics match the Redis adapter (create is single-shot; checkpoint/status
 * are independent updates).
 */
export const createInMemoryRunStore = (
  now: () => number = Date.now,
): RunStorePort & {
  readonly _runs: ReadonlyMap<string, RunRecord>;
} => {
  const runs = new Map<string, RunRecord>();
  return {
    _runs: runs,
    async create(record) {
      if (runs.has(record.runId)) {
        return err({ kind: "internal-invariant-violated", message: `run '${record.runId}' already exists`, context: {} });
      }
      runs.set(record.runId, record);
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
      return ok(undefined);
    },
  };
};

// ── Redis Adapter (production) ───────────────────────────────────────────────

// The prefixes are derived from the bound `TenantId`, so every key a store
// instance emits is forced under `fugue:<tenant>:hitl:`. There is no code path
// that builds a run/checkpoint key without a tenant.
const runKey = (tenant: TenantId, runId: RunId): string => `fugue:${tenant}:hitl:run:${runId}`;
const ckptKey = (tenant: TenantId, runId: RunId): string => `fugue:${tenant}:hitl:ckpt:${runId}`;

/** The metadata half of a `RunRecord` (everything except the checkpoint string). */
type RunMeta = Omit<RunRecord, "checkpoint">;

export interface RedisRunStoreConfig {
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
      return writeMeta(runId, { ...metaRes.value, status, updatedAtMs: now() });
    },
  };
};
