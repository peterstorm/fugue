/**
 * Redis-backed spend ledger — the adapter that survives process death.
 *
 * Appends are LOCK-FREE, and that is a property of the encoding rather than a
 * risk taken. `domain/spend-record.ts` stores a run's spend as three numeric
 * sums plus a set of model names; `HINCRBY` and `SADD` are atomic, commutative,
 * and each independently correct under any interleaving, so two workers
 * appending to the same run cannot lose an increment or corrupt the record.
 * Nothing here does a read-modify-write, so there is nothing to race on.
 *
 * The three increments and the set-add are separately atomic but not atomic
 * TOGETHER. A crash between them leaves a run recorded as having spent tokens
 * without the matching cost, or vice versa — always UNDER-reporting one axis of
 * one call, never over-reporting and never corrupting. That window is bounded
 * by one call, the same magnitude as the documented overshoot-by-one allowance,
 * and erring toward under-reporting a single call is the correct direction for
 * a partial write: the alternative (a transaction) buys exactness at the price
 * of a round trip on every call and a failure mode — a half-applied MULTI — that
 * is strictly worse to reason about.
 *
 * @satisfies FR-B-006 — spend is durable per runId
 */

import type { DagId, RunId, Spend } from "@fuguejs/framework";
import { err, ok } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { RedisPort, SpendLedgerPort } from "../ports.js";
import type { HostError } from "../domain/host-error.js";
import { formatHostError } from "../domain/host-error.js";
import type { LogPort } from "../ports.js";
import { logWithoutThrowing } from "../hitl/diagnostic-logging.js";
import type { TenantId } from "../domain/tenant.js";
import { buildSpendKey, buildSpendUnpricedKey } from "../domain/cache-keys.js";
import { parseFigure, recordOf, spendOfRecord } from "../domain/spend-record.js";

/**
 * The Redis surface a ledger needs, proven present at CONSTRUCTION.
 *
 * `hIncrBy`/`hGetAll` are optional on `RedisPort` so unrelated fakes stay
 * valid. Parsing them once here — rather than null-checking per call — means a
 * host wired with a Redis adapter that cannot increment fails at boot with a
 * clear message, instead of at the first LLM call of the first budgeted run.
 */
export type SpendLedgerRedis = Pick<RedisPort, "sAdd" | "sMembers"> & {
  readonly hIncrBy: NonNullable<RedisPort["hIncrBy"]>;
  readonly hGetAll: NonNullable<RedisPort["hGetAll"]>;
  readonly expire: NonNullable<RedisPort["expire"]>;
};

/**
 * Narrow a `RedisPort` to the ledger surface, or say exactly what is missing.
 *
 * Parse, don't validate: the returned value is proof the methods exist, so the
 * adapter below never re-checks.
 */
export const spendLedgerRedis = (redis: RedisPort): Result<SpendLedgerRedis, HostError> => {
  // ONE list. The required set was previously spelled three times — in a
  // `missing` array, in the guarding condition, and again by field name in the
  // returned literal — so adding a fourth primitive meant three edits, and
  // missing one either narrowed the type without erroring or errored without
  // naming the field. Deriving all three from this list makes that impossible.
  const required = [
    ["hIncrBy", redis.hIncrBy],
    ["hGetAll", redis.hGetAll],
    ["expire", redis.expire],
  ] as const;
  const missing = required.filter(([, method]) => method === undefined).map(([name]) => name);
  if (redis.hIncrBy === undefined || redis.hGetAll === undefined || redis.expire === undefined) {
    return err({
      kind: "config-invalid",
      message:
        `Redis adapter cannot back the spend ledger — missing: ${missing.join(", ")}. ` +
        `A per-run LLM budget cannot be durable without them.`,
    });
  }
  return ok({
    sAdd: redis.sAdd,
    sMembers: redis.sMembers,
    expire: redis.expire,
    hIncrBy: redis.hIncrBy,
    hGetAll: redis.hGetAll,
  });
};

/** Hash field names — one place, so the reader and the writer cannot disagree. */
const FIELD = { tokens: "tokens", calls: "calls", micros: "micros" } as const;

export interface RedisSpendLedgerDeps {
  readonly redis: SpendLedgerRedis;
  readonly tenant: TenantId;
  readonly dagId: DagId;
  /**
   * Where a best-effort failure goes.
   *
   * The TTL refresh below deliberately does not fail the append — but "does not
   * fail" is not "is not worth knowing about". Without a logger this adapter was
   * structurally incapable of reporting an EXPIRE failure, and an EXPIRE that
   * quietly stops working lets a live run's spend record expire underneath it,
   * which reopens the refill-on-resume bug with no diagnostic trail at all.
   */
  readonly logger: LogPort;
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
  const { redis, tenant, dagId, ttlSec, logger } = deps;
  const keys = (runId: RunId) => ({
    hash: buildSpendKey(tenant, dagId, runId),
    unpriced: buildSpendUnpricedKey(tenant, dagId, runId),
  });

  return {
    read: async (runId: RunId): Promise<Result<Spend, HostError>> => {
      const { hash, unpriced } = keys(runId);
      const figures = await redis.hGetAll(hash);
      // An unreadable ledger must surface as an error, never as zero: the
      // caller fails the slice closed on it, because "we could not read what
      // this run has spent" and "this run has spent nothing" have to stay
      // distinguishable — collapsing them IS the refill-on-resume bug.
      if (!figures.ok) return err(figures.error);
      const models = await redis.sMembers(unpriced);
      if (!models.ok) return err(models.error);

      return ok(
        spendOfRecord({
          tokens: parseFigure(figures.value[FIELD.tokens]),
          calls: parseFigure(figures.value[FIELD.calls]),
          micros: parseFigure(figures.value[FIELD.micros]),
          unpricedModels: models.value,
        }),
      );
    },

    add: async (runId: RunId, delta: Spend): Promise<Result<void, HostError>> => {
      const { hash, unpriced } = keys(runId);
      const record = recordOf(delta);

      // Ordered cost-first: if the process dies mid-append, the axis most
      // likely to be under a tight ceiling is the one already recorded.
      for (const [field, by] of [
        [FIELD.micros, record.micros],
        [FIELD.tokens, record.tokens],
        [FIELD.calls, record.calls],
      ] as const) {
        // A zero increment is a no-op that would still cost a round trip.
        if (by === 0) continue;
        const incremented = await redis.hIncrBy(hash, field, by);
        if (!incremented.ok) return err(incremented.error);
      }

      for (const model of record.unpricedModels) {
        const added = await redis.sAdd(unpriced, model);
        if (!added.ok) return err(added.error);
      }

      // Refresh idleness on both keys. A failure here does NOT fail the append —
      // the spend is already recorded, and the only consequence is a key that
      // expires earlier than intended, which loses durability rather than money.
      // It IS logged: an EXPIRE that silently stops working lets a live run's
      // record expire underneath it, and that is the refill-on-resume bug again
      // with nothing to grep for. `warn`, matching the severity of what is lost.
      if (ttlSec !== undefined) {
        for (const key of [hash, unpriced]) {
          const refreshed = await redis.expire(key, ttlSec);
          if (!refreshed.ok) {
            logWithoutThrowing(logger, "warn", "spend-ledger.ttl-refresh-failed", {
              key,
              ttlSec,
              reason: formatHostError(refreshed.error),
              consequence: "this run's spend record may expire while the run is still active",
            });
          }
        }
      }
      return ok(undefined);
    },
  };
};
