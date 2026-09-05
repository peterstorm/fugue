/**
 * Redis-backed spend ledger — the adapter that survives process death.
 *
 * Appends are one atomic `MULTI`/`EXEC` owned by the Redis adapter. The
 * transaction queues every unpriced-model hash marker first, then nonzero
 * numeric sums cost-first (`micros`, `tokens`, `calls`), then one retention
 * refresh when `ttlSec` is configured. Marker and values share one key, so split-read/expiry races and
 * standalone append command paths are unrepresentable.
 *
 * Concurrent appends use a locally serialized WATCH/read/MULTI/EXEC loop.
 * Serialization prevents commands sharing this connection from consuming one
 * another's WATCH state; WATCH still detects cross-process writers, and a null
 * EXEC retries from a fresh read. A process crash can still lose every
 * provider-settled append not acknowledged before death, and
 * a thrown/failed transaction acknowledgement is ambiguous. This adapter
 * returns one typed append failure and never claims that values committed or
 * retries an additive delta that may already have committed.
 *
 * @satisfies FR-B-006 — spend is durable per runId
 */

import type { DagId, RunId, Spend } from "@fuguejs/framework";
import { err, ok, safeErrorMessage } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { RedisPort, SpendLedgerPort } from "../ports.js";
import type { HostError } from "../domain/host-error.js";
import { internalInvariantViolated } from "../domain/host-error.js";
import type { TenantId } from "../domain/tenant.js";
import { buildSpendKey } from "../domain/cache-keys.js";
import { spendOfHash } from "../domain/spend-record.js";

/**
 * The Redis surface a ledger needs, proven present at CONSTRUCTION.
 *
 * `hGetAll`/`appendSpend` are optional on `RedisPort` so unrelated fakes stay
 * valid. Parsing them once here — rather than null-checking per call — means the
 * missing-capability case is decided in ONE place, and the resulting error
 * names exactly which methods are absent.
 *
 * A missing capability is a construction-time downgrade signal. The sole
 * caller (`createNodeContextForDag`) logs it and selects the in-process ledger
 * rather than turning a metering configuration gap into an outage.
 */
export type SpendLedgerRedis = {
  readonly hGetAll: NonNullable<RedisPort["hGetAll"]>;
  readonly appendSpend: NonNullable<RedisPort["appendSpend"]>;
  readonly commitCheckpointAndRetainSpend: NonNullable<
    RedisPort["commitCheckpointAndRetainSpend"]
  >;
};

/**
 * Narrow a `RedisPort` to the ledger surface, or say exactly what is missing.
 *
 * Parse, don't validate: the returned value is proof the methods exist, so the
 * adapter below never re-checks.
 */
export const spendLedgerRedis = (redis: RedisPort): Result<SpendLedgerRedis, HostError> => {
  // The DIAGNOSTIC is derived from this list; the GUARD below is not, and
  // cannot be. TypeScript will not narrow optional methods from a computed
  // `missing` array, so the explicit guard earns the assertion-free return.
  const required = [
    ["hGetAll", redis.hGetAll],
    ["appendSpend", redis.appendSpend],
    ["commitCheckpointAndRetainSpend", redis.commitCheckpointAndRetainSpend],
  ] as const;
  const missing = required.filter(([, method]) => method === undefined).map(([name]) => name);
  if (
    redis.hGetAll === undefined ||
    redis.appendSpend === undefined ||
    redis.commitCheckpointAndRetainSpend === undefined
  ) {
    return err({
      kind: "config-invalid",
      message:
        `Redis adapter cannot back the spend ledger — missing: ${missing.join(", ")}. ` +
        `A per-run LLM budget cannot be durable without them.`,
    });
  }
  return ok({
    hGetAll: redis.hGetAll.bind(redis),
    appendSpend: redis.appendSpend.bind(redis),
    commitCheckpointAndRetainSpend:
      redis.commitCheckpointAndRetainSpend.bind(redis),
  });
};

export interface RedisSpendLedgerDeps {
  readonly redis: SpendLedgerRedis;
  readonly tenant: TenantId;
  readonly dagId: DagId;
  /**
   * How long a run's spend record outlives its last write.
   *
   * Bounded for the same reason the checkpoint is: a run that finished and will
   * never resume must not keep a key forever. Refreshed on every append, so the
   * TTL measures idleness rather than age — a long-parked run that resumes
   * keeps its record as long as it stays active.
   *
   * ABSENT means no expiry, matching the checkpoint writer beside it: a
   * deployment that configured no checkpoint TTL has said it wants durable
   * state kept, and a spend record that expired while its checkpoint survived
   * would resume the run with a refilled budget — the exact bug this closes.
   */
  readonly ttlSec?: number;
}

/**
 * A Redis-backed `SpendLedgerPort` for one tenant + DAG.
 *
 * Constructed per NodeContext, like the namespaced cache and checkpoint writer
 * beside it, so the tenant and DAG namespace is bound once rather than passed
 * to every call.
 */
export const createRedisSpendLedger = (deps: RedisSpendLedgerDeps): SpendLedgerPort => {
  const { redis, tenant, dagId, ttlSec } = deps;
  const key = (runId: RunId): string => buildSpendKey(tenant, dagId, runId);

  return {
    metadata: Object.freeze({
      role: "authoritative",
      backend: "redis",
      durability: "restart",
    }),
    read: async (runId: RunId): Promise<Result<Spend, HostError>> => {
      try {
        const stored = await redis.hGetAll(key(runId));
        if (!stored.ok) return err(stored.error);

        const parsed = spendOfHash(stored.value);
        return parsed.ok
          ? parsed
          : err(internalInvariantViolated(
              "Stored Redis spend record is malformed",
              { field: parsed.error.field, reason: parsed.error.reason },
            ));
      } catch (error) {
        const message = safeErrorMessage(error);
        return err(internalInvariantViolated(
          `SpendLedgerRedis.hGetAll threw across the port boundary: ${message}`,
          { operation: "spend-ledger read", error: message },
        ));
      }
    },

    add: async (runId: RunId, delta: Spend): Promise<Result<void, HostError>> => {
      try {
        return await redis.appendSpend({
          key: key(runId),
          delta,
          ...(ttlSec !== undefined ? { ttlSec } : {}),
        });
      } catch (error) {
        const message = safeErrorMessage(error);
        // Same producer as `read`'s catch above — the hand-rolled literal this
        // replaced skipped the helper's freeze.
        return err(internalInvariantViolated(
          `SpendLedgerRedis.appendSpend threw across the port boundary: ${message}`,
          { operation: "spend-ledger append", error: message },
        ));
      }
    },
  };
};
