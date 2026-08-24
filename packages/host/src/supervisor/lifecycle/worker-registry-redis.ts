/**
 * Redis worker registry — the durable record of which tenant's worker is live,
 * its pid, UDS path, and health (AD-2). This is the source of truth a RESTARTED
 * supervisor reads to re-adopt still-live workers (multi-tenant spec SC-006, FR-019/FR-020): the
 * supervisor's in-memory lifecycle map does NOT survive its own restart, but the
 * workers (children of thin-init, not the supervisor — AD-2) keep running, so the
 * registry + a per-worker UDS liveness probe lets the new supervisor find them.
 *
 * KEY LAYOUT (AD-2): `fugue:supervisor:workers:<tenant>` → JSON
 *   `{ pid, udsPath, startedAt, health, eagerPin }`.
 *
 * `reconcileReadopt()` is the deterministic multi-tenant spec SC-006 reconcile:
 *   1. enumerate every registered worker entry,
 *   2. UDS-liveness-probe each one (injected `probe`),
 *   3. ADOPT the ones that answer (return their `AdoptableWorker` records), and
 *   4. PRUNE (delete) the dead entries so the registry self-heals.
 *
 * FAIL-CLOSED (reuse the established degraded semantics): failures of mandatory
 * Redis operations return the same `redis-unavailable` HostError as the other
 * adapters (→ 503) and invoke `onRedisDead`, so the existing `redisDied` machine
 * drives degraded state. Stale/corrupt-entry pruning during `get` and
 * `reconcileReadopt` is deliberately best-effort: failures are warning-logged
 * while the authoritative read/adoption result still succeeds.
 *
 * The enumeration uses `scan` over `fugue:supervisor:workers:*`, which is a
 * SUPERVISOR/admin keyspace (not tenant-scoped), so `scan` is permitted here
 * (see the SECURITY NOTE on `RedisPort.scan`) — exactly like the tenant-registry
 * hydrate. Per-tenant worker ACLs never touch this prefix.
 */

import { ok, err, safeErrorMessage } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { redisUnavailable } from "../../domain/host-error.js";
import type { HostError } from "../../domain/host-error.js";
import { tenantId } from "../../domain/tenant.js";
import type { TenantId } from "../../domain/tenant.js";
import type { WorkerPhase } from "./worker-lifecycle.js";
import type { RedisPort, LogPort } from "../../ports.js";

// ── Key layout (AD-2) ──────────────────────────────────────────────────────────

/** `fugue:supervisor:workers:<tenant>` — the per-tenant live-worker record. */
export const WORKER_KEY_PREFIX = "fugue:supervisor:workers:";
const workerKey = (tenant: TenantId): string => `${WORKER_KEY_PREFIX}${tenant}`;

// ── Record shape ─────────────────────────────────────────────────────────────

/**
 * The persisted worker health. DERIVED from the pure lifecycle ADT's phases
 * (`WorkerPhase` in `worker-lifecycle.ts`) via `Extract` rather than spelled out
 * independently, so the persisted enum can NEVER drift from the lifecycle phases
 * (C4): only the two phases that hold a live process + socket (`live`,
 * `draining`) are persistable here. Adding/removing a lifecycle phase that should
 * be persisted is a single-edit change at the source of truth.
 */
type WorkerHealth = Extract<WorkerPhase, "live" | "draining">;

/**
 * The persisted worker record. Carries ONLY routing/liveness metadata — never a
 * secret (the supervisor holds none; multi-tenant spec FR-005). `startedAt` lets
 * the new supervisor preserve original uptime and diagnostic continuity when it
 * re-adopts. Idle eviction uses `lastActivityAt`, which adoption intentionally
 * resets to the current clock.
 *
 * `eagerPin` (AD-7) is persisted as a BELT-AND-SUSPENDERS source for re-adoption:
 * the AUTHORITATIVE source on re-adoption is the live tenant registry config (so a
 * pin toggled while the supervisor was down is honoured), but persisting it here
 * means a re-adopt can still respect the pin even if the registry entry is briefly
 * unavailable. The lifecycle manager prefers the registry value and falls back to
 * this one.
 */
export interface WorkerRecord {
  readonly tenant: TenantId;
  readonly pid: number;
  readonly udsPath: string;
  readonly startedAt: number;
  readonly health: WorkerHealth;
  readonly eagerPin: boolean;
}

/** A registered worker the reconcile confirmed is still alive (probe ok). */
interface AdoptableWorker {
  readonly record: WorkerRecord;
}

const serialize = (r: WorkerRecord): string =>
  JSON.stringify({ pid: r.pid, udsPath: r.udsPath, startedAt: r.startedAt, health: r.health, eagerPin: r.eagerPin });

/**
 * Parse a persisted record. Re-brands the tenant via `tenantId` (the value is the
 * key suffix, so it is supervisor-controlled, but we still validate the SHAPE).
 * Returns `undefined` for an unreadable/invalid record (caller treats as corrupt:
 * best-effort prune).
 */
const deserialize = (tenant: TenantId, raw: string): WorkerRecord | undefined => {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof obj !== "object" || obj === null) return undefined;
  const o = obj as Record<string, unknown>;
  // A pid must be a positive integer: 0 / negative are not real OS pids and a
  // process.kill(0, …) liveness probe against them is meaningless — treat as
  // corrupt (fail-closed).
  if (typeof o.pid !== "number" || !Number.isInteger(o.pid) || o.pid <= 0) return undefined;
  if (typeof o.udsPath !== "string" || o.udsPath.length === 0) return undefined;
  // startedAt must be a finite, non-negative instant — a NaN/Infinity/negative
  // value would poison the idle-evict math on re-adoption.
  if (typeof o.startedAt !== "number" || !Number.isFinite(o.startedAt) || o.startedAt < 0) return undefined;
  if (o.health !== "live" && o.health !== "draining") return undefined;
  // eagerPin is persisted (AD-7 belt-and-suspenders). A missing/non-boolean value
  // is coerced to false rather than rejected — an older record without the field
  // is still a valid, adoptable worker; the AUTHORITATIVE pin comes from the
  // tenant registry on re-adoption anyway.
  const eagerPin = o.eagerPin === true;
  return { tenant, pid: o.pid, udsPath: o.udsPath, startedAt: o.startedAt, health: o.health, eagerPin };
};

const tenantFromKey = (key: string): TenantId | undefined => {
  if (!key.startsWith(WORKER_KEY_PREFIX)) return undefined;
  const suffix = key.slice(WORKER_KEY_PREFIX.length);
  const parsed = tenantId(suffix);
  return parsed.ok ? parsed.value : undefined;
};

// ── Degraded hook (reuse, don't reinvent) ──────────────────────────────────────

interface WorkerRegistryHooks {
  readonly onRedisDead?: () => void;
  readonly onRedisAlive?: () => void;
}

const warnWithoutThrowing = (
  logger: LogPort | undefined,
  message: string,
  data?: Record<string, unknown>,
): void => {
  try {
    logger?.warn(message, data);
  } catch {
    // Diagnostics must never replace a typed or best-effort registry outcome.
  }
};

/**
 * A UDS liveness probe: "is the worker bound to `udsPath` answering?". Injected
 * so the registry stays pure-shell-over-port and the probe (an HTTP-over-UDS
 * health GET, T7) can be faked in tests. Returns true iff the worker is live.
 */
export type UdsLivenessProbe = (record: WorkerRecord) => Promise<boolean>;

// ── Port ───────────────────────────────────────────────────────────────────────

export interface WorkerRegistry {
  /** Write/overwrite a tenant's worker record (register on spawn, update on drain). */
  readonly put: (record: WorkerRecord) => Promise<Result<void, HostError>>;
  /** Read a tenant's worker record, or null if none. */
  readonly get: (tenant: TenantId) => Promise<Result<WorkerRecord | null, HostError>>;
  /** Delete a tenant's worker record (on crash/evict/prune). Idempotent. */
  readonly remove: (tenant: TenantId) => Promise<Result<void, HostError>>;
  /**
   * multi-tenant spec SC-006 reconcile on supervisor restart: enumerate all registered workers,
   * UDS-probe each, adopt the live ones, prune the dead ones. Deterministic.
   * Returns the adoptable (still-live) workers + the pruned (dead) tenants.
   */
  readonly reconcileReadopt: () => Promise<Result<{ readonly adopted: readonly AdoptableWorker[]; readonly pruned: readonly TenantId[] }, HostError>>;
}

export const createWorkerRegistry = (
  redis: RedisPort,
  probe: UdsLivenessProbe,
  hooks: WorkerRegistryHooks = {},
  logger?: LogPort,
): WorkerRegistry => {
  const dead = (op: string): HostError => {
    hooks.onRedisDead?.();
    return redisUnavailable(op);
  };
  const alive = (): void => {
    hooks.onRedisAlive?.();
  };

  return {
    put: async (record) => {
      try {
        const r = await redis.set(workerKey(record.tenant), serialize(record));
        if (!r.ok) return err(dead("worker-registry-put"));
      } catch (e) {
        warnWithoutThrowing(logger, "[worker-registry] Redis set threw — treating as disconnected", {
          tenant: record.tenant,
          error: safeErrorMessage(e),
        });
        return err(dead("worker-registry-put"));
      }
      alive();
      return ok(undefined);
    },

    get: async (tenant) => {
      let r: Result<string | null, HostError>;
      try {
        r = await redis.get(workerKey(tenant));
      } catch (e) {
        warnWithoutThrowing(logger, "[worker-registry] Redis get threw — treating as disconnected", {
          tenant,
          error: safeErrorMessage(e),
        });
        return err(dead("worker-registry-get"));
      }
      if (!r.ok) return err(dead("worker-registry-get"));
      alive();
      if (r.value === null || r.value === "") return ok(null);
      const record = deserialize(tenant, r.value);
      if (record === undefined) {
        // Contract parity with `reconcileReadopt`: a corrupt persisted record is
        // surfaced (warn) and pruned best-effort — never silently indistinguishable
        // from a tenant that was never registered. The supervisor will lazy-spawn
        // a fresh worker for the tenant either way; the log line is what lets an
        // operator grep for WHY (truncated/half-written value, allocator fault).
        const key = workerKey(tenant);
        warnWithoutThrowing(logger, "[worker-registry] corrupt worker record — treating as absent, pruning", {
          tenant,
          key,
        });
        // Best-effort per the deserialize contract: a prune failure must not
        // fail the read — the record stays corrupt-and-untreated until the next
        // reconcile (which prunes on its own path). ONE log line per failed
        // prune, whichever way it failed: the throw path previously logged here
        // and again below, so a single fault read as two in the operator's log.
        let pruneFailure: string | undefined;
        try {
          const prune = await redis.del(key);
          if (!prune.ok) pruneFailure = "reported unavailable";
        } catch (e) {
          pruneFailure = `threw: ${safeErrorMessage(e)}`;
        }
        if (pruneFailure !== undefined) {
          warnWithoutThrowing(logger, "[worker-registry] corrupt-record prune failed — leaving to reconcile", {
            tenant,
            key,
            reason: pruneFailure,
          });
        }
        return ok(null);
      }
      // A non-corrupt record is served as-is — the supervisor's lazy-spawn
      // path is only for genuinely absent tenants.
      return ok(record);
    },

    remove: async (tenant) => {
      try {
        const r = await redis.del(workerKey(tenant));
        if (!r.ok) return err(dead("worker-registry-remove"));
      } catch (e) {
        warnWithoutThrowing(logger, "[worker-registry] Redis del threw — treating as disconnected", {
          tenant,
          error: safeErrorMessage(e),
        });
        return err(dead("worker-registry-remove"));
      }
      alive();
      return ok(undefined);
    },

    reconcileReadopt: async () => {
      // 1. Enumerate every registered worker entry (supervisor keyspace — scan ok).
      //    De-duplicate by tenant across SCAN cursor pages: SCAN may legitimately
      //    return the same key twice across pages, so keying by TenantId (last
      //    write wins) structurally prevents a double-adopt of one tenant.
      const recordsByTenant = new Map<TenantId, WorkerRecord>();
      const corruptKeys: string[] = [];
      let cursor = "0";
      const pattern = `${WORKER_KEY_PREFIX}*`;
      do {
        let scanR;
        try {
          scanR = await redis.scan(pattern, cursor);
        } catch (e) {
          warnWithoutThrowing(logger, "[worker-registry] Redis scan threw during reconcile — treating as disconnected", {
            error: safeErrorMessage(e),
          });
          return err(dead("worker-registry-reconcile"));
        }
        if (!scanR.ok) return err(dead("worker-registry-reconcile"));
        for (const key of scanR.value.keys) {
          const tenant = tenantFromKey(key);
          if (tenant === undefined) {
            warnWithoutThrowing(logger, "[worker-registry] pruning unparseable worker key", { key });
            corruptKeys.push(key);
            continue;
          }
          let valR;
          try {
            valR = await redis.get(key);
          } catch (e) {
            warnWithoutThrowing(logger, "[worker-registry] Redis get threw during reconcile — treating as disconnected", {
              key,
              error: safeErrorMessage(e),
            });
            return err(dead("worker-registry-reconcile"));
          }
          if (!valR.ok) return err(dead("worker-registry-reconcile"));
          if (valR.value === null || valR.value === "") continue;
          const record = deserialize(tenant, valR.value);
          if (record === undefined) {
            warnWithoutThrowing(logger, "[worker-registry] pruning corrupt worker record", { key });
            corruptKeys.push(key);
            continue;
          }
          recordsByTenant.set(record.tenant, record);
        }
        cursor = scanR.value.cursor;
      } while (cursor !== "0");

      // 2. UDS-probe each registered worker; 3. partition live vs dead.
      const adopted: AdoptableWorker[] = [];
      const pruned: TenantId[] = [];
      for (const record of recordsByTenant.values()) {
        let live = false;
        try {
          live = await probe(record);
        } catch (e) {
          // A probe error is treated as "not live" — fail-closed; the entry is
          // pruned and the supervisor lazy-spawns a fresh worker on next request.
          warnWithoutThrowing(logger, "[worker-registry] UDS probe threw — treating worker as dead", {
            tenant: record.tenant,
            error: safeErrorMessage(e),
          });
          live = false;
        }
        if (live) {
          adopted.push({ record });
        } else {
          pruned.push(record.tenant);
        }
      }

      // 4. Prune dead + corrupt entries so the registry self-heals (best-effort:
      // a prune failure does NOT abort the reconcile — adopted workers must still
      // be returned so live routing resumes, multi-tenant spec FR-020). A genuine Redis OUTAGE
      // would already have failed above on scan/get.
      const deleteKeys = [
        ...pruned.map((t) => workerKey(t)),
        ...corruptKeys,
      ];
      for (const key of deleteKeys) {
        try {
          const delR = await redis.del(key);
          if (!delR.ok) {
            warnWithoutThrowing(logger, "[worker-registry] prune del failed (continuing)", { key });
          }
        } catch (e) {
          warnWithoutThrowing(logger, "[worker-registry] prune del threw (continuing)", {
            key,
            error: safeErrorMessage(e),
          });
        }
      }

      alive();
      return ok({ adopted, pruned });
    },
  };
};

// ── In-memory fake (tests) ───────────────────────────────────────────────────

/**
 * In-memory `RedisPort` fake scoped to the worker-registry's needs (mirrors the
 * tenant-registry fake). Exposes the backing store and a `setFail` switch to
 * drive the fail-closed path without a real Redis.
 */
interface InMemoryWorkerRedisFake {
  readonly redis: RedisPort;
  readonly store: Map<string, string>;
  setFail: (fail: boolean) => void;
}

export const createInMemoryWorkerRedisFake = (): InMemoryWorkerRedisFake => {
  const store = new Map<string, string>();
  let failing = false;
  const failErr = (op: string): Result<never, HostError> => err(redisUnavailable(op));

  const redis: RedisPort = {
    get: async (key) => (failing ? failErr("get") : ok(store.get(key) ?? null)),
    set: async (key, value) => {
      if (failing) return failErr("set");
      store.set(key, value);
      return ok(null);
    },
    del: async (key) => {
      if (failing) return failErr("del");
      const had = store.delete(key);
      return ok(had ? 1 : 0);
    },
    scan: async (pattern, cursor = "0") => {
      if (failing) return failErr("scan");
      void cursor;
      const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
      const keys = Array.from(store.keys()).filter((k) => k.startsWith(prefix));
      return ok({ cursor: "0", keys });
    },
    setNx: async (key, value) => {
      if (failing) return failErr("setNx");
      if (store.has(key)) return ok(false);
      store.set(key, value);
      return ok(true);
    },
    compareAndDelete: async (key, expected) => {
      if (failing) return failErr("compareAndDelete");
      if (store.get(key) !== expected) return ok(false);
      store.delete(key);
      return ok(true);
    },
    sAdd: async () => (failing ? failErr("sAdd") : ok(1)),
    sRem: async () => (failing ? failErr("sRem") : ok(1)),
    sMembers: async () => (failing ? failErr("sMembers") : ok([])),
  };

  return {
    redis,
    store,
    setFail: (fail) => {
      failing = fail;
    },
  };
};
