/**
 * Redis-backed tenant registry adapter — the IMPERATIVE SHELL around the pure
 * `tenant-registry.ts` core (FR-022, FR-023, FR-024, AD-5).
 *
 * RESPONSIBILITIES (I/O only; all decision logic stays in the pure core):
 *   - Persist each tenant's config under `fugue:tenants:<id>` as JSON (a secrets
 *     REFERENCE only — NEVER a secret value, AD-6 / FR-005).
 *   - On register / deregister / reconfigure, write Redis AND publish a
 *     lifecycle event on the `fugue:tenants:events` pub/sub channel so the
 *     supervisor (and, on its NEXT spawn, each worker) observes the change
 *     (AD-5). A reconfigure takes effect on the next spawn — this adapter only
 *     records state + announces it; it does NOT hot-swap a running worker.
 *   - Hydrate the in-memory registry from Redis on startup.
 *
 * FAIL-CLOSED WIRING (FR-022 / FR-023 — reuse the existing degraded machine):
 *   On ANY Redis failure (read, write, OR publish returning `!ok`, or a thrown
 *   error) the adapter:
 *     1. surfaces `redisUnavailable(...)` — the SAME `redis-unavailable`
 *        HostError every other Redis adapter returns, which maps to 503; and
 *     2. invokes the injected `onRedisDead` callback, which the host wires to the
 *        EXISTING `redisDied` transition (the `degraded:redis-disconnected`
 *        state in `host-state.ts`, driven elsewhere by `redis-probe.ts`). It
 *        does NOT build a parallel degraded state.
 *   A successful operation invokes `onRedisAlive` (wired to `redisRecovered`),
 *   mirroring the liveness probe's edge-agnostic callbacks. The supervisor then
 *   refuses to start NEW runs while degraded (FR-022) but does NOT tear down
 *   live workers — already-running workers keep serving in-flight work (FR-023),
 *   because this adapter NEVER kills a worker; it only writes/reads/publishes.
 *   It NEVER throws: a thrown Redis client error is caught and converted to the
 *   same fail-closed `redis-unavailable` Result.
 *
 * The pure core is the source of truth for idempotency (SC-009) and the
 * fail-closed unknown-tenant lookup (FR-022); this shell delegates every state
 * transition to it and only persists/announces the RESULT.
 */

import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { redisUnavailable } from "../../domain/host-error.js";
import type { HostError } from "../../domain/host-error.js";
import { tenantId, markSecretsRef } from "../../domain/tenant.js";
import type { TenantId } from "../../domain/tenant.js";
import type { RedisPort, RedisPubSubPort, LogPort } from "../../ports.js";
import { match } from "ts-pattern";
import {
  emptyRegistry,
  registryOf,
  tenantConfig,
  register as coreRegister,
  deregister as coreDeregister,
  reconfigure as coreReconfigure,
  lookup as coreLookup,
} from "./tenant-registry.js";
import type {
  ActiveTenantConfig,
  DeregisteredTenantConfig,
  TenantConfig,
  TenantRegistry,
} from "./tenant-registry.js";

// ── Redis key + channel layout (AD-5) ────────────────────────────────────────

/** `fugue:tenants:<id>` — the per-tenant config record. */
export const TENANT_KEY_PREFIX = "fugue:tenants:";
const tenantKey = (id: TenantId): string => `${TENANT_KEY_PREFIX}${id}`;

/** The pub/sub channel register/deregister/reconfigure announce on. */
export const TENANT_EVENTS_CHANNEL = "fugue:tenants:events";

// ── Pub/sub event payload (AD-5) ─────────────────────────────────────────────

/**
 * The lifecycle event published on `fugue:tenants:events`. Carries the tenant id
 * and the mutation kind only — NOT the config body, and NEVER a secret. A
 * subscriber re-reads `fugue:tenants:<id>` to pick up the new config, so the
 * channel only needs to say "this tenant changed, go re-read it" (smaller, and
 * keeps the secrets-reference invariant trivially: nothing sensitive on the bus).
 */
export interface TenantEvent {
  readonly kind: "registered" | "deregistered" | "reconfigured";
  readonly tenant: TenantId;
}

const parseEvent = (raw: string): TenantEvent | undefined => {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof obj !== "object" || obj === null) return undefined;
  const o = obj as Record<string, unknown>;
  if (o.kind !== "registered" && o.kind !== "deregistered" && o.kind !== "reconfigured") return undefined;
  if (typeof o.tenant !== "string") return undefined;
  const idR = tenantId(o.tenant);
  if (!idR.ok) return undefined;
  return { kind: o.kind, tenant: idR.value };
};

// ── Degraded-machine wiring (reuse, don't reinvent) ──────────────────────────

/**
 * The host's fail-closed seam. `onRedisDead` is wired to the EXISTING
 * `redisDied` transition; `onRedisAlive` to `redisRecovered`. The host attempts
 * the transition and treats an inapplicable rejection as a no-op (the
 * transitions return `err(invalidTransition)` when not applicable, which the host
 * wiring swallows — see host.ts), so the adapter may call them on every
 * operation, edge or not — exactly like `redis-probe.ts`. Defaulted to no-ops so
 * the adapter is usable in isolation.
 */
export interface RegistryDegradedHooks {
  readonly onRedisDead?: () => void;
  readonly onRedisAlive?: () => void;
}

// ── Serialization (secrets are a REFERENCE only) ─────────────────────────────

/**
 * The on-Redis JSON shape. Spelled out explicitly (rather than `JSON.stringify`
 * of the whole config) so it is OBVIOUS the persisted record carries
 * `secretsRef` (a reference string) and never anything else that could be a
 * secret — the serializer is the single seam where config becomes bytes on the
 * wire, so it is where the "reference, never a value" invariant is visible.
 */
const serialize = (cfg: TenantConfig): string => {
  const base = {
    status: cfg.status,
    id: cfg.id,
    team: cfg.team,
    keycloakClientMapping: cfg.keycloakClientMapping,
    fsRoot: cfg.fsRoot,
    secretsRef: cfg.secretsRef, // REFERENCE only
    admission: cfg.admission,
    eagerPin: cfg.eagerPin,
  };
  // The tombstone rides ONLY on the deregistered variant — an active record can
  // never carry a deregisteredAt because the union forbids it at the type level,
  // so the serialized active record is guaranteed tombstone-free.
  return JSON.stringify(
    match(cfg)
      .with({ status: "active" }, () => base)
      .with({ status: "deregistered" }, (d) => ({ ...base, deregisteredAt: d.deregisteredAt }))
      .exhaustive(),
  );
};

/**
 * Parse a persisted record back into a validated `TenantConfig` through the pure
 * core's smart constructor (parse-don't-validate). Re-brands `id` / `secretsRef`
 * via their canonical constructors. Returns `undefined` for an unreadable or
 * invalid record (the caller treats that as data corruption, best-effort skip).
 */
const deserialize = (raw: string): TenantConfig | undefined => {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof obj !== "object" || obj === null) return undefined;
  const o = obj as Record<string, unknown>;
  if (typeof o.id !== "string") return undefined;
  const idR = tenantId(o.id);
  if (!idR.ok) return undefined;
  if (typeof o.secretsRef !== "string") return undefined;
  // Fail-closed on the lifecycle discriminant: a record without a known `status`
  // is treated as corrupt (skip), consistent with every other corrupt-record
  // branch. An unknown/missing status NEVER silently round-trips as active.
  if (o.status !== "active" && o.status !== "deregistered") return undefined;
  // A deregistered record MUST carry a numeric tombstone, or it is corrupt.
  if (o.status === "deregistered" && typeof o.deregisteredAt !== "number") return undefined;
  const km = o.keycloakClientMapping as Record<string, unknown> | undefined;
  const adm = o.admission as Record<string, unknown> | undefined;
  if (!km || !adm) return undefined;
  // Build the validated ACTIVE config through the smart constructor (the parse
  // boundary), then promote to the deregistered variant if the record said so.
  const parsed = tenantConfig({
    id: idR.value,
    team: String(o.team ?? ""),
    keycloakClientMapping: {
      realm: String(km.realm ?? ""),
      clientId: String(km.clientId ?? ""),
      agentClientIdsByDag: (km.agentClientIdsByDag as Record<string, string> | undefined) ?? {},
    },
    fsRoot: String(o.fsRoot ?? ""),
    secretsRef: markSecretsRef(o.secretsRef),
    admission: {
      maxConcurrentRuns: Number(adm.maxConcurrentRuns),
      maxQueuedRuns: Number(adm.maxQueuedRuns),
    },
    eagerPin: Boolean(o.eagerPin),
  });
  if (!parsed.ok) return undefined;
  if (o.status === "active") return parsed.value;
  const tombstoned: DeregisteredTenantConfig = {
    ...parsed.value,
    status: "deregistered",
    deregisteredAt: o.deregisteredAt as number,
  };
  return tombstoned;
};

// ── Port ─────────────────────────────────────────────────────────────────────

/**
 * The Redis tenant registry. Holds the in-memory `TenantRegistry` view (the pure
 * core's value) and keeps it in sync with Redis. Every mutating method:
 *   1. applies the PURE transition to compute the next registry (idempotency,
 *      validation, fail-closed all live in the core),
 *   2. persists the affected `fugue:tenants:<id>` record,
 *   3. publishes a `TenantEvent` on `fugue:tenants:events`,
 *   4. on Redis failure at step 2 or 3, fails closed (degraded machine) and
 *      does NOT advance the in-memory view (so memory never diverges from a
 *      write that didn't land).
 */
export interface RedisTenantRegistry {
  /** Current in-memory registry snapshot (the pure core value). */
  readonly snapshot: () => TenantRegistry;
  /**
   * SNAPSHOT read of an ACTIVE tenant's config; fail-closed for
   * unknown/deregistered. This is the IN-FLIGHT / read-only / status path: it
   * reads the in-memory snapshot and is NOT blocked while Redis is degraded, so
   * already-admitted work keeps resolving its tenant (FR-023). NEW-run admission
   * must NOT use this — it must use `resolveForNewRun` (see below, FR-022).
   */
  readonly lookup: (id: TenantId) => Result<ActiveTenantConfig, HostError>;
  /**
   * FAIL-CLOSED NEW-RUN resolution seam (FR-022). While Redis is degraded this
   * returns `redis-unavailable` so the supervisor refuses to start a NEW run on
   * possibly-stale config; otherwise it delegates to the fail-closed core lookup.
   *
   * The supervisor's NEW-run admission gate (the routing seam that builds the
   * `AdmissionDecision` fed to `routeRequest`) MUST call this — NOT `lookup` — so
   * a new run is never routed on last-known config after Redis
   * dies. In-flight / status paths keep using `lookup` (FR-023). Note that
   * `canServeRequests` (host-state.ts) must NOT be widened to block on this: it
   * intentionally returns true while degraded so cached/in-flight work keeps
   * being served (FR-023); only NEW-run admission fails closed here.
   */
  readonly resolveForNewRun: (id: TenantId) => Result<ActiveTenantConfig, HostError>;
  /**
   * INBOUND degraded signal (FR-022). The registry's own write/hydrate ops flip
   * `degraded` on Redis failure, but the SUPERVISOR's data path is read-only and
   * its Redis liveness PROBE (`redis-probe.ts`) is what first observes Redis
   * death/recovery. Wiring that probe to this method makes `resolveForNewRun`
   * fail closed (→ 503) the moment the probe sees Redis DOWN — so NEW runs are
   * refused while degraded even though no registry WRITE has occurred — and
   * recover when the probe sees Redis back. In-flight/status (`lookup`) and
   * `canServeRequests` are intentionally NOT affected (FR-023).
   */
  readonly markRedisDegraded: (dead: boolean) => void;
  readonly register: (cfg: ActiveTenantConfig, now: number) => Promise<Result<void, HostError>>;
  readonly deregister: (id: TenantId, now: number) => Promise<Result<void, HostError>>;
  readonly reconfigure: (cfg: ActiveTenantConfig, now: number) => Promise<Result<void, HostError>>;
  /**
   * HARD-DELETE a tenant's retained (tombstoned) record — the FINAL step of the
   * grace-window purge (T10, FR-030). Distinct from `deregister`, which only
   * tombstones-and-retains: this REMOVES the `fugue:tenants:<id>` key entirely and
   * advances the in-memory view, so the tenant no longer appears in the registry
   * at all. Idempotent (deleting an absent record is a no-op success) and
   * fail-closed (a Redis failure does not advance the in-memory view). Announces a
   * `deregistered` event so subscribers re-read and observe the absence.
   */
  readonly hardDelete: (id: TenantId) => Promise<Result<void, HostError>>;
  /** Re-read the whole registry from Redis (hydrate / resync). */
  readonly hydrate: () => Promise<Result<TenantRegistry, HostError>>;
}

export const createRedisTenantRegistry = (
  redis: RedisPort,
  pubsub: RedisPubSubPort,
  hooks: RegistryDegradedHooks = {},
  logger?: LogPort,
  seed: TenantRegistry = emptyRegistry,
): RedisTenantRegistry => {
  let registry = seed;
  // Local mirror of the host's degraded edge, kept in lock-step with the
  // onRedisDead/onRedisAlive hooks. This is what `resolveForNewRun` consults to
  // fail closed (FR-022) WITHOUT reaching back into host-state.ts — the adapter
  // owns the seam the supervisor's NEW-run admission gate consumes.
  let degraded = false;

  const dead = (operation: string): HostError => {
    degraded = true;
    hooks.onRedisDead?.();
    return redisUnavailable(operation);
  };
  const alive = (): void => {
    degraded = false;
    hooks.onRedisAlive?.();
  };

  /** Persist a config + publish its event. Fails closed on any Redis failure. */
  const persistAndAnnounce = async (
    cfg: TenantConfig,
    event: TenantEvent,
    op: string,
  ): Promise<Result<void, HostError>> => {
    // Step 1: persist the record. Catch a thrown client error → fail closed.
    let setResult: Result<string | null, HostError>;
    try {
      setResult = await redis.set(tenantKey(cfg.id), serialize(cfg));
    } catch (e) {
      logger?.warn("[tenant-registry] Redis set threw — treating as disconnected", {
        op,
        error: e instanceof Error ? e.message : String(e),
      });
      return err(dead(op));
    }
    if (!setResult.ok) {
      return err(dead(op));
    }

    // Step 2: announce on the pub/sub channel. A publish failure is also a Redis
    // outage — fail closed (do NOT advance the in-memory view).
    let pubResult: Result<void, HostError>;
    try {
      pubResult = await pubsub.publish(TENANT_EVENTS_CHANNEL, JSON.stringify(event));
    } catch (e) {
      logger?.warn("[tenant-registry] Redis publish threw — treating as disconnected", {
        op,
        error: e instanceof Error ? e.message : String(e),
      });
      return err(dead(op));
    }
    if (!pubResult.ok) {
      return err(dead(op));
    }

    alive();
    return ok(undefined);
  };

  return {
    snapshot: () => registry,

    lookup: (id) => coreLookup(registry, id),

    resolveForNewRun: (id) =>
      // FR-022 fail-closed: refuse to resolve a NEW run on possibly-stale config
      // while Redis is down; otherwise delegate to the fail-closed core lookup.
      degraded ? err(redisUnavailable("tenant-resolve")) : coreLookup(registry, id),

    markRedisDegraded: (isDead) => {
      // Drive the SAME `degraded` flag `resolveForNewRun` consults, so the
      // supervisor's liveness probe gates NEW-run admission (FR-022) without a
      // registry write. We do NOT fire the onRedisDead/onRedisAlive hooks here:
      // those drive the host-state degraded MACHINE, which the supervisor's probe
      // already drives directly (avoiding a double-transition). This only flips
      // the new-run gate.
      degraded = isDead;
    },

    register: async (cfg, now) => {
      // Pure core: validate + idempotent transition.
      const next = coreRegister(registry, cfg, now);
      if (!next.ok) return err(next.error);
      // Idempotent no-op: the core returned the SAME registry reference (identical
      // end state), so there is nothing new to persist. Suppress the redundant
      // re-persist + duplicate `registered` event — mirrors how the absent-tenant
      // deregister suppresses its no-op event. State stays idempotent.
      if (next.value === registry) return ok(undefined);
      // Persist the entry the core actually COMMITTED (always the active variant),
      // never the raw caller input — so what lands in Redis is exactly the
      // core-normalized record.
      const committed = next.value.entries.get(cfg.id)!;
      const persisted = await persistAndAnnounce(committed, { kind: "registered", tenant: cfg.id }, "tenant-register");
      if (!persisted.ok) return persisted; // fail closed — memory NOT advanced
      registry = next.value;
      return ok(undefined);
    },

    deregister: async (id, now) => {
      const next = coreDeregister(registry, id, now);
      if (!next.ok) return err(next.error);
      // Same-reference return covers BOTH no-op cases (absent tenant, and
      // already-deregistered): nothing changed, so no write and no event — there
      // is nothing to persist or announce, and announcing a no-op would be noise.
      if (next.value === registry) return ok(undefined);
      // Persist the entry the core committed — the deregistered (tombstoned) variant.
      const committed = next.value.entries.get(id)!;
      const persisted = await persistAndAnnounce(committed, { kind: "deregistered", tenant: id }, "tenant-deregister");
      if (!persisted.ok) return persisted;
      registry = next.value;
      return ok(undefined);
    },

    reconfigure: async (cfg, now) => {
      const next = coreReconfigure(registry, cfg, now);
      if (!next.ok) return err(next.error); // tenant-unknown (fail-closed) etc.
      // Idempotent no-op: identical config → same reference → suppress re-persist
      // + duplicate `reconfigured` event.
      if (next.value === registry) return ok(undefined);
      // Persist the committed (active) entry, not the raw input.
      const committed = next.value.entries.get(cfg.id)!;
      const persisted = await persistAndAnnounce(committed, { kind: "reconfigured", tenant: cfg.id }, "tenant-reconfigure");
      if (!persisted.ok) return persisted;
      registry = next.value;
      return ok(undefined);
    },

    hardDelete: async (id) => {
      const existing = registry.entries.get(id);
      // Idempotent no-op: nothing to delete → success, no write, no event.
      if (existing === undefined) return ok(undefined);
      // Delete the persisted record FIRST; fail closed (do NOT advance memory) on
      // any Redis failure so the in-memory view never diverges from a delete that
      // did not land.
      let delResult: Result<number, HostError>;
      try {
        delResult = await redis.del(tenantKey(id));
      } catch (e) {
        logger?.warn("[tenant-registry] Redis del threw during hardDelete — treating as disconnected", {
          tenant: id,
          error: e instanceof Error ? e.message : String(e),
        });
        return err(dead("tenant-hard-delete"));
      }
      if (!delResult.ok) return err(dead("tenant-hard-delete"));
      // Announce the absence so subscribers re-read (and observe the tenant gone).
      let pubResult: Result<void, HostError>;
      try {
        pubResult = await pubsub.publish(TENANT_EVENTS_CHANNEL, JSON.stringify({ kind: "deregistered", tenant: id }));
      } catch (e) {
        logger?.warn("[tenant-registry] Redis publish threw during hardDelete — treating as disconnected", {
          tenant: id,
          error: e instanceof Error ? e.message : String(e),
        });
        return err(dead("tenant-hard-delete"));
      }
      if (!pubResult.ok) return err(dead("tenant-hard-delete"));
      // Advance the in-memory view: drop the entry entirely.
      const next = new Map(registry.entries);
      next.delete(id);
      registry = { entries: next };
      alive();
      return ok(undefined);
    },

    hydrate: async () => {
      const configs: TenantConfig[] = [];
      let cursor = "0";
      const pattern = `${TENANT_KEY_PREFIX}*`;
      do {
        let scanResult;
        try {
          scanResult = await redis.scan(pattern, cursor);
        } catch (e) {
          logger?.warn("[tenant-registry] Redis scan threw during hydrate — treating as disconnected", {
            error: e instanceof Error ? e.message : String(e),
          });
          return err(dead("tenant-hydrate"));
        }
        if (!scanResult.ok) {
          return err(dead("tenant-hydrate"));
        }
        for (const key of scanResult.value.keys) {
          let valR;
          try {
            valR = await redis.get(key);
          } catch (e) {
            logger?.warn("[tenant-registry] Redis get threw during hydrate — treating as disconnected", {
              key,
              error: e instanceof Error ? e.message : String(e),
            });
            return err(dead("tenant-hydrate"));
          }
          if (!valR.ok) return err(dead("tenant-hydrate"));
          if (valR.value === null || valR.value === "") continue;
          const cfg = deserialize(valR.value);
          if (cfg === undefined) {
            logger?.warn("[tenant-registry] Skipping corrupt tenant config record", { key });
            continue;
          }
          configs.push(cfg);
        }
        cursor = scanResult.value.cursor;
      } while (cursor !== "0");

      registry = registryOf(configs);
      alive();
      return ok(registry);
    },
  };
};

// ── Subscriber wiring (AD-5) ─────────────────────────────────────────────────

/**
 * Subscribe to `fugue:tenants:events` and invoke `onEvent` for each well-formed
 * `TenantEvent`. The supervisor uses this to re-read a changed tenant's config
 * (workers pick up changes on their NEXT spawn, AD-5). Malformed messages are
 * dropped (logged), never thrown — a poisoned bus message must not crash the
 * subscriber. A subscribe failure fails closed via the degraded hook.
 */
export const subscribeTenantEvents = async (
  pubsub: RedisPubSubPort,
  onEvent: (event: TenantEvent) => void,
  hooks: RegistryDegradedHooks = {},
  logger?: LogPort,
): Promise<Result<{ readonly unsubscribe: () => Promise<void> }, HostError>> => {
  let sub;
  try {
    sub = await pubsub.subscribe(TENANT_EVENTS_CHANNEL, (raw) => {
      const event = parseEvent(raw);
      if (event === undefined) {
        logger?.warn("[tenant-registry] Dropping malformed tenant event", { raw: raw.slice(0, 120) });
        return;
      }
      onEvent(event);
    });
  } catch (e) {
    logger?.warn("[tenant-registry] Redis subscribe threw — treating as disconnected", {
      error: e instanceof Error ? e.message : String(e),
    });
    hooks.onRedisDead?.();
    return err(redisUnavailable("tenant-subscribe"));
  }
  if (!sub.ok) {
    hooks.onRedisDead?.();
    return err(redisUnavailable("tenant-subscribe"));
  }
  hooks.onRedisAlive?.();
  return ok(sub.value);
};

// ── In-memory fake (tests) ───────────────────────────────────────────────────

/**
 * In-memory `RedisPort` + `RedisPubSubPort` fake for adapter tests (mirrors
 * token-store's in-memory store). Exposes the backing map and a captured-events
 * log for assertions, plus a `fail` switch that flips every Redis op to `!ok` so
 * tests can drive the fail-closed path WITHOUT a real Redis.
 */
export interface InMemoryRedisFake {
  readonly redis: RedisPort;
  readonly pubsub: RedisPubSubPort;
  /** Backing key→value store (for round-trip assertions). */
  readonly store: Map<string, string>;
  /** Every message published, in order (for pub/sub assertions). */
  readonly published: Array<{ channel: string; message: string }>;
  /** Flip to `true` to make every Redis op return `!ok` (outage simulation). */
  setFail: (fail: boolean) => void;
}

export const createInMemoryRedisFake = (): InMemoryRedisFake => {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const published: Array<{ channel: string; message: string }> = [];
  const subscribers = new Map<string, Set<(m: string) => void>>();
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
      // Single-shot scan: return all matching keys, cursor "0" (done).
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
    sAdd: async (key, member) => {
      if (failing) return failErr("sAdd");
      const set = sets.get(key) ?? new Set<string>();
      const had = set.has(member);
      set.add(member);
      sets.set(key, set);
      return ok(had ? 0 : 1);
    },
    sRem: async (key, member) => {
      if (failing) return failErr("sRem");
      const set = sets.get(key);
      if (!set || !set.has(member)) return ok(0);
      set.delete(member);
      return ok(1);
    },
    sMembers: async (key) => {
      if (failing) return failErr("sMembers");
      return ok(Array.from(sets.get(key) ?? []));
    },
  };

  const pubsub: RedisPubSubPort = {
    publish: async (channel, message) => {
      if (failing) return failErr("publish");
      published.push({ channel, message });
      const subs = subscribers.get(channel);
      if (subs) for (const h of subs) h(message);
      return ok(undefined);
    },
    subscribe: async (channel, handler) => {
      if (failing) return failErr("subscribe");
      let set = subscribers.get(channel);
      if (!set) {
        set = new Set();
        subscribers.set(channel, set);
      }
      set.add(handler);
      return ok({
        unsubscribe: async () => {
          set?.delete(handler);
        },
      });
    },
  };

  return {
    redis,
    pubsub,
    store,
    published,
    setFail: (fail) => {
      failing = fail;
    },
  };
};
