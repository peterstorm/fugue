/**
 * RunStore adapters (ADR-0060) — in-memory (tests/dev) and Redis (production).
 *
 * The run store is the DURABLE source of truth for a HITL run: its metadata
 * (dag, input, identity, status, timestamps) and the serialized `{state,
 * context}` checkpoint. The queue backend is only a wake-up trigger, so a run
 * survives queue retention and resumes from here.
 *
 * Redis key layout (checkpoint split from metadata so per-transition checkpoint
 * writes never race the status writes):
 *   fugue:hitl:run:<runId>   →  JSON RunMeta (record minus checkpoint)
 *   fugue:hitl:ckpt:<runId>  →  checkpoint string (framework `toJson`)
 */

import { ok, err } from "@fuguejs/framework";
import type { Result, RunId } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import type { RedisPort, LogPort } from "../../ports.js";
import type { RunStorePort } from "../ports.js";
import type { RunRecord, RunStatus } from "../types.js";

// ── In-Memory Adapter (tests/dev) ───────────────────────────────────────────

/**
 * In-memory run store. No Redis required. Exposes `_runs` for assertions.
 * Semantics match the Redis adapter (create is single-shot; checkpoint/status
 * are independent updates).
 */
export const createInMemoryRunStore = (): RunStorePort & {
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
      runs.set(runId, { ...r, status });
      return ok(undefined);
    },
  };
};

// ── Redis Adapter (production) ───────────────────────────────────────────────

const RUN_KEY_PREFIX = "fugue:hitl:run:";
const CKPT_KEY_PREFIX = "fugue:hitl:ckpt:";

const runKey = (runId: RunId): string => `${RUN_KEY_PREFIX}${runId}`;
const ckptKey = (runId: RunId): string => `${CKPT_KEY_PREFIX}${runId}`;

/** The metadata half of a `RunRecord` (everything except the checkpoint string). */
type RunMeta = Omit<RunRecord, "checkpoint">;

export interface RedisRunStoreConfig {
  /** TTL applied to run keys on every write, in seconds. Bounds storage growth. */
  readonly ttlSec: number;
}

export const createRedisRunStore = (
  redis: RedisPort,
  config: RedisRunStoreConfig,
  logger?: LogPort,
): RunStorePort => {
  const expiry = { expiresInSec: config.ttlSec };

  const writeMeta = async (runId: RunId, meta: RunMeta): Promise<Result<void, HostError>> => {
    const res = await redis.set(runKey(runId), JSON.stringify(meta), expiry);
    if (!res.ok) return err(res.error);
    return ok(undefined);
  };

  const readMeta = async (runId: RunId): Promise<Result<RunMeta | null, HostError>> => {
    const res = await redis.get(runKey(runId));
    if (!res.ok) return err(res.error);
    if (res.value === null) return ok(null);
    try {
      return ok(JSON.parse(res.value) as RunMeta);
    } catch (e) {
      logger?.error?.("hitl: corrupt run metadata in store", { runId, error: e instanceof Error ? e.message : String(e) });
      return err({ kind: "internal-invariant-violated", message: `corrupt run metadata for '${runId}'`, context: {} });
    }
  };

  return {
    async create(record) {
      const { checkpoint, ...meta } = record;
      // Atomic create-once WITH TTL (SET NX EX): enforces create-once (a
      // duplicate run id is a caller bug) and never leaves a TTL-less meta key
      // if the process crashes between acquisition and expiry.
      const set = await redis.setNx(runKey(record.runId), JSON.stringify(meta), expiry);
      if (!set.ok) return err(set.error);
      if (!set.value) {
        return err({ kind: "internal-invariant-violated", message: `run '${record.runId}' already exists`, context: {} });
      }
      const ckpt = await redis.set(ckptKey(record.runId), checkpoint, expiry);
      if (!ckpt.ok) return err(ckpt.error);
      return ok(undefined);
    },

    async get(runId) {
      const metaRes = await readMeta(runId);
      if (!metaRes.ok) return err(metaRes.error);
      if (metaRes.value === null) return ok(null);
      const ckptRes = await redis.get(ckptKey(runId));
      if (!ckptRes.ok) return err(ckptRes.error);
      if (ckptRes.value === null) {
        // Metadata without a checkpoint is a torn/expired record — surface it
        // rather than resuming from a missing state.
        return err({ kind: "internal-invariant-violated", message: `run '${runId}' has metadata but no checkpoint`, context: {} });
      }
      return ok({ ...metaRes.value, checkpoint: ckptRes.value });
    },

    async saveCheckpoint(runId, checkpoint) {
      const res = await redis.set(ckptKey(runId), checkpoint, expiry);
      if (!res.ok) return err(res.error);
      return ok(undefined);
    },

    async setStatus(runId, status) {
      const metaRes = await readMeta(runId);
      if (!metaRes.ok) return err(metaRes.error);
      if (metaRes.value === null) return err({ kind: "run-not-found", runId });
      return writeMeta(runId, { ...metaRes.value, status, updatedAtMs: metaRes.value.updatedAtMs });
    },
  };
};
