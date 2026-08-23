/**
 * Redis-backed tenant registry adapter — the IMPERATIVE SHELL around the pure
 * `tenant-registry.ts` core (multi-tenant spec FR-022, FR-023, FR-024, AD-5).
 *
 * RESPONSIBILITIES (I/O only; all decision logic stays in the pure core):
 *   - Persist each tenant's config under `fugue:tenants:<id>` as JSON (a secrets
 *     REFERENCE only — NEVER a secret value, AD-6 / multi-tenant spec FR-005).
 *   - On register / deregister / reconfigure, write Redis AND publish a
 *     lifecycle event on the `fugue:tenants:events` pub/sub channel so the
 *     supervisor (and, on its NEXT spawn, each worker) observes the change
 *     (AD-5). A reconfigure takes effect on the next spawn — this adapter only
 *     records state + announces it; it does NOT hot-swap a running worker.
 *   - Hydrate the in-memory registry from Redis on startup.
 *
 * FAIL-CLOSED WIRING (multi-tenant spec FR-022 / FR-023 — reuse the existing degraded machine):
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
 *   refuses to start NEW runs while degraded (multi-tenant spec FR-022) but does NOT tear down
 *   live workers — already-running workers keep serving in-flight work (multi-tenant spec FR-023),
 *   because this adapter NEVER kills a worker; it only writes/reads/publishes.
 *   It NEVER throws: a thrown Redis client error is caught and converted to the
 *   same fail-closed `redis-unavailable` Result.
 *
 * The pure core is the source of truth for idempotency (multi-tenant spec SC-009) and the
 * fail-closed unknown-tenant lookup (multi-tenant spec FR-022); this shell delegates every state
 * transition to it and only persists/announces the RESULT.
 */

import { ok, err, safeErrorMessage } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { redisUnavailable } from "../../domain/host-error.js";
import type { HostError } from "../../domain/host-error.js";
import { tenantId, markSecretsRef } from "../../domain/tenant.js";
import type { TenantId } from "../../domain/tenant.js";
import { markTeam } from "../../domain/auth.js";
import type { RedisPort, RedisPubSubPort, LogPort } from "../../ports.js";
import { match } from "ts-pattern";
import {
  emptyRegistry,
  registryOf,
  removeRetainedEntry,
  tenantConfig,
  register as coreRegister,
  deregister as coreDeregister,
  reconfigure as coreReconfigure,
  lookup as coreLookup,
} from "./tenant-registry.js";
import type {
  ActiveTenantConfig,
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
interface TenantEvent {
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
interface RegistryDegradedHooks {
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
    // Diagnostics must never replace a typed adapter outcome.
  }
};

const callHookWithoutThrowing = (hook: (() => void) | undefined): void => {
  try {
    hook?.();
  } catch {
    // Host-state diagnostics are advisory; the adapter's own gate is authoritative.
  }
};

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
    dagsRoot: cfg.dagsRoot,
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

/** Persisted tenant corruption is data, not an erased `undefined`. */
type CorruptTenantRecord = {
  readonly kind: "corrupt-tenant-record";
  readonly reason: string;
};

const corruptTenantRecord = (reason: string): Result<never, CorruptTenantRecord> =>
  err({ kind: "corrupt-tenant-record", reason });

/** Parse persisted bytes into the validated tenant ADT or a typed corruption. */
const deserialize = (raw: string): Result<TenantConfig, CorruptTenantRecord> => {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return corruptTenantRecord("invalid JSON");
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return corruptTenantRecord("record must be an object");
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.id !== "string") return corruptTenantRecord("id must be a string");
  const idR = tenantId(o.id);
  if (!idR.ok) return corruptTenantRecord("id is invalid");
  if (typeof o.secretsRef !== "string" || o.secretsRef.trim() === "") {
    return corruptTenantRecord("secretsRef must be a non-blank string");
  }
  if (o.status !== "active" && o.status !== "deregistered") {
    return corruptTenantRecord("status must be active or deregistered");
  }
  if (o.status === "deregistered" && typeof o.deregisteredAt !== "number") {
    return corruptTenantRecord("deregisteredAt must be numeric for a deregistered tenant");
  }
  if (typeof o.keycloakClientMapping !== "object" || o.keycloakClientMapping === null || Array.isArray(o.keycloakClientMapping)) {
    return corruptTenantRecord("keycloakClientMapping must be an object");
  }
  if (typeof o.admission !== "object" || o.admission === null || Array.isArray(o.admission)) {
    return corruptTenantRecord("admission must be an object");
  }
  const km = o.keycloakClientMapping as Record<string, unknown>;
  const adm = o.admission as Record<string, unknown>;
  const rawTeam = o.team;
  const rawRealm = km.realm;
  const rawClientId = km.clientId;
  const rawFsRoot = o.fsRoot;
  const rawDagsRoot = o.dagsRoot;
  if (
    typeof rawTeam !== "string" ||
    typeof rawRealm !== "string" ||
    typeof rawClientId !== "string" ||
    typeof rawFsRoot !== "string" ||
    typeof rawDagsRoot !== "string"
  ) {
    return corruptTenantRecord("team, realm, clientId, fsRoot, and dagsRoot must be strings");
  }
  const rawAgentMap = km.agentClientIdsByDag;
  if (typeof rawAgentMap !== "object" || rawAgentMap === null || Array.isArray(rawAgentMap)) {
    return corruptTenantRecord("agentClientIdsByDag must be an object");
  }
  const agentClientIdsByDag: Record<string, string> = {};
  for (const [dag, value] of Object.entries(rawAgentMap as Record<string, unknown>)) {
    if (typeof value !== "string") {
      return corruptTenantRecord("agentClientIdsByDag values must be strings");
    }
    agentClientIdsByDag[dag] = value;
  }
  const rawMaxConcurrentRuns = adm.maxConcurrentRuns;
  const rawMaxQueuedRuns = adm.maxQueuedRuns;
  if (typeof rawMaxConcurrentRuns !== "number" || typeof rawMaxQueuedRuns !== "number") {
    return corruptTenantRecord("admission limits must be numbers");
  }
  if (typeof o.eagerPin !== "boolean") {
    return corruptTenantRecord("eagerPin must be a boolean");
  }
  const parsed = tenantConfig({
    id: idR.value,
    team: markTeam(rawTeam),
    keycloakClientMapping: {
      realm: rawRealm,
      clientId: rawClientId,
      agentClientIdsByDag,
    },
    fsRoot: rawFsRoot,
    dagsRoot: rawDagsRoot,
    secretsRef: markSecretsRef(o.secretsRef),
    admission: {
      maxConcurrentRuns: rawMaxConcurrentRuns,
      maxQueuedRuns: rawMaxQueuedRuns,
    },
    eagerPin: o.eagerPin,
  });
  if (!parsed.ok) return corruptTenantRecord("record violates tenant configuration invariants");
  if (o.status === "active") return ok(parsed.value);
  return ok({
    ...parsed.value,
    status: "deregistered",
    deregisteredAt: o.deregisteredAt as number,
  });
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
   * already-admitted work keeps resolving its tenant (multi-tenant spec FR-023). NEW-run admission
   * must NOT use this — it must use `resolveForNewRun` (see below, multi-tenant spec FR-022).
   */
  readonly lookup: (id: TenantId) => Result<ActiveTenantConfig, HostError>;
  /**
   * FAIL-CLOSED NEW-RUN resolution seam (multi-tenant spec FR-022). While Redis is degraded this
   * returns `redis-unavailable` so the supervisor refuses to start a NEW run on
   * possibly-stale config; otherwise it delegates to the fail-closed core lookup.
   *
   * The supervisor's NEW-run admission gate (the routing seam that builds the
   * `AdmissionDecision` fed to `routeRequest`) MUST call this — NOT `lookup` — so
   * a new run is never routed on last-known config after Redis
   * dies. In-flight / status paths keep using `lookup` (multi-tenant spec FR-023). Note that
   * `canServeRequests` (host-state.ts) must NOT be widened to block on this: it
   * intentionally returns true while degraded so cached/in-flight work keeps
   * being served (multi-tenant spec FR-023); only NEW-run admission fails closed here.
   */
  readonly resolveForNewRun: (id: TenantId) => Result<ActiveTenantConfig, HostError>;
  /**
   * INBOUND degraded signal (multi-tenant spec FR-022). The registry's own write/hydrate ops flip
   * `degraded` on Redis failure, but the SUPERVISOR's data path is read-only and
   * its Redis liveness PROBE (`redis-probe.ts`) is what first observes Redis
   * death/recovery. Wiring that probe to this method makes `resolveForNewRun`
   * fail closed (→ 503) the moment the probe sees Redis DOWN — so NEW runs are
   * refused while degraded even though no registry WRITE has occurred — and
   * recover when the probe sees Redis back. In-flight/status (`lookup`) and
   * `canServeRequests` are intentionally NOT affected (multi-tenant spec FR-023).
   */
  readonly markRedisDegraded: (dead: boolean) => void;
  readonly register: (cfg: ActiveTenantConfig, now: number) => Promise<Result<void, HostError>>;
  readonly deregister: (id: TenantId, now: number) => Promise<Result<void, HostError>>;
  readonly reconfigure: (cfg: ActiveTenantConfig, now: number) => Promise<Result<void, HostError>>;
  /**
   * HARD-DELETE a tenant's retained (tombstoned) record — the FINAL step of the
   * grace-window purge (T10, multi-tenant spec FR-030). Distinct from `deregister`, which only
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
  seed: TenantRegistry = emptyRegistry(),
): RedisTenantRegistry => {
  let registry = seed;
  // The host's degraded edge, mirrored here so `resolveForNewRun` can fail closed
  // (multi-tenant spec FR-022) WITHOUT reaching back into host-state.ts. It is split by SIGNAL SOURCE:
  //   - `writeDegraded` is SET by the write/hydrate path (`dead()`) on a Redis write
  //     failure and cleared by `alive()` on the next SUCCESSFUL write/hydrate.
  //   - `probeDegraded` is owned by the liveness-probe edge (`markRedisDegraded`),
  //     which flips continuously every probe tick.
  // `resolveForNewRun` gates on EITHER. The clearing rules are ASYMMETRIC ON PURPOSE:
  //   - A successful WRITE clears only `writeDegraded` — it must NOT clear a
  //     probe-asserted outage (a write can momentarily succeed mid-outage).
  //   - A probe-confirmed RECOVERY (`markRedisDegraded(false)`) clears BOTH flags:
  //     the liveness probe is the authoritative CONTINUOUS Redis-health signal, so a
  //     confirmed-alive Redis re-opens the new-run gate regardless of which leg
  //     latched it. Without this, a transient write blip with no subsequent write
  //     would wedge `writeDegraded` set forever (it has no other continuous clearer),
  //     refusing every tenant's NEW runs indefinitely while liveness shows green.
  let writeDegraded = false;
  let probeDegraded = false;

  const dead = (operation: string): HostError => {
    // Latch first: no diagnostic or host-state callback can leave the local
    // new-run gate stale after Redis failed.
    writeDegraded = true;
    callHookWithoutThrowing(hooks.onRedisDead);
    return redisUnavailable(operation);
  };
  const alive = (): void => {
    writeDegraded = false;
    callHookWithoutThrowing(hooks.onRedisAlive);
  };

  /** Persist a config + publish its event. Fails closed on any Redis failure. */
  /**
   * Run one Redis step of a write: a THROW and a `!ok` Result are the SAME
   * condition here — Redis is unreachable — so both collapse to the fail-closed
   * `dead(op)` failure, and only the throw path needs a log (a typed `!ok`
   * already carries its own diagnosis).
   *
   * ONE definition for the steps of this two-phase write. The invariant it
   * protects is that the in-memory view is NEVER advanced on a partial write:
   * every step must fail closed the same way, and a step that handled only one
   * of the two failure channels would let a half-applied write look successful.
   */
  const redisStep = async <T>(
    op: string,
    threwMessage: string,
    run: () => Promise<Result<T, HostError>>,
  ): Promise<Result<T, HostError>> => {
    try {
      const result = await run();
      return result.ok ? result : err(dead(op));
    } catch (e) {
      const failure = dead(op);
      warnWithoutThrowing(logger, threwMessage, { op, error: safeErrorMessage(e) });
      return err(failure);
    }
  };

  const persistAndAnnounce = async (
    cfg: TenantConfig,
    event: TenantEvent,
    op: string,
  ): Promise<Result<void, HostError>> => {
    // Step 1: persist the record. Catch a thrown client error → fail closed.
    const setResult = await redisStep(
      op,
      "[tenant-registry] Redis set threw — treating as disconnected",
      () => redis.set(tenantKey(cfg.id), serialize(cfg)),
    );
    if (!setResult.ok) {
      return err(setResult.error);
    }

    // Step 2: announce on the pub/sub channel. A publish failure is also a Redis
    // outage — fail closed (do NOT advance the in-memory view).
    const pubResult = await redisStep(
      op,
      "[tenant-registry] Redis publish threw — treating as disconnected",
      () => pubsub.publish(TENANT_EVENTS_CHANNEL, JSON.stringify(event)),
    );
    if (!pubResult.ok) {
      return err(pubResult.error);
    }

    alive();
    return ok(undefined);
  };

  // Serialize every in-memory `registry` mutation onto a single promise chain. Each
  // mutator is a read-modify-write — snapshot `registry`, `await` Redis I/O, then
  // commit `registry = next` — so two concurrent mutations for DIFFERENT tenants
  // would otherwise both snapshot the same base map and the second commit would drop
  // the first's tenant from the in-memory view (the supervisor's new-run admission
  // source) until the next process restart. Chaining guarantees each mutator reads
  // `registry` only AFTER the prior one has committed. Admin mutations are infrequent,
  // so the serialization is effectively free; correctness is the point. A failing op
  // does not break the chain (its outcome is swallowed for the NEXT link only — the
  // caller still receives the real Result).
  let mutationGate: Promise<unknown> = Promise.resolve();
  const serializeMutation = <T>(op: () => Promise<T>): Promise<T> => {
    const result = mutationGate.then(op, op);
    mutationGate = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    snapshot: () => registry,

    lookup: (id) => coreLookup(registry, id),

    resolveForNewRun: (id) =>
      // multi-tenant spec FR-022 fail-closed: refuse to resolve a NEW run on possibly-stale config
      // while Redis is down (per EITHER signal); else delegate to the core lookup.
      writeDegraded || probeDegraded
        ? err(redisUnavailable("tenant-resolve"))
        : coreLookup(registry, id),

    markRedisDegraded: (isDead) => {
      // Drive the probe-owned `probeDegraded` flag `resolveForNewRun` also consults,
      // so the supervisor's liveness probe gates NEW-run admission (multi-tenant spec FR-022) without a
      // registry write. We do NOT fire the onRedisDead/onRedisAlive hooks here:
      // those drive the host-state degraded MACHINE, which the supervisor's probe
      // already drives directly (avoiding a double-transition).
      probeDegraded = isDead;
      // A probe-confirmed RECOVERY also clears the write leg: the liveness probe is
      // the authoritative CONTINUOUS Redis-health signal, whereas `writeDegraded` is
      // otherwise cleared ONLY by a successful write/hydrate (event-driven). A
      // transient write blip followed by no further writes would otherwise wedge the
      // new-run gate fail-closed for ALL tenants indefinitely even after Redis heals.
      // If writes are in fact still failing, the next write re-latches `writeDegraded`.
      if (!isDead) writeDegraded = false;
    },

    register: (cfg, now) =>
      serializeMutation(async () => {
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
      }),

    deregister: (id, now) =>
      serializeMutation(async () => {
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
      }),

    reconfigure: (cfg, now) =>
      serializeMutation(async () => {
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
      }),

    hardDelete: (id) =>
      serializeMutation(async () => {
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
          const failure = dead("tenant-hard-delete");
          warnWithoutThrowing(logger, "[tenant-registry] Redis del threw during hardDelete — treating as disconnected", {
            tenant: id,
            error: safeErrorMessage(e),
          });
          return err(failure);
        }
        if (!delResult.ok) return err(dead("tenant-hard-delete"));
        // Announce the absence so subscribers re-read (and observe the tenant gone).
        let pubResult: Result<void, HostError>;
        try {
          pubResult = await pubsub.publish(TENANT_EVENTS_CHANNEL, JSON.stringify({ kind: "deregistered", tenant: id }));
        } catch (e) {
          const failure = dead("tenant-hard-delete");
          warnWithoutThrowing(logger, "[tenant-registry] Redis publish threw during hardDelete — treating as disconnected", {
            tenant: id,
            error: safeErrorMessage(e),
          });
          return err(failure);
        }
        if (!pubResult.ok) return err(dead("tenant-hard-delete"));
        // Advance through the pure core so hard deletion preserves the same
        // runtime-read-only facade as every other registry transition.
        registry = removeRetainedEntry(registry, id);
        alive();
        return ok(undefined);
      }),

    hydrate: () => serializeMutation(async () => {
      const configs: TenantConfig[] = [];
      let cursor = "0";
      const pattern = `${TENANT_KEY_PREFIX}*`;
      do {
        let scanResult;
        try {
          scanResult = await redis.scan(pattern, cursor);
        } catch (e) {
          const failure = dead("tenant-hydrate");
          warnWithoutThrowing(logger, "[tenant-registry] Redis scan threw during hydrate — treating as disconnected", {
            error: safeErrorMessage(e),
          });
          return err(failure);
        }
        if (!scanResult.ok) {
          return err(dead("tenant-hydrate"));
        }
        for (const key of scanResult.value.keys) {
          let valR;
          try {
            valR = await redis.get(key);
          } catch (e) {
            const failure = dead("tenant-hydrate");
            warnWithoutThrowing(logger, "[tenant-registry] Redis get threw during hydrate — treating as disconnected", {
              key,
              error: safeErrorMessage(e),
            });
            return err(failure);
          }
          if (!valR.ok) return err(dead("tenant-hydrate"));
          if (valR.value === null || valR.value === "") continue;
          const parsed = deserialize(valR.value);
          if (!parsed.ok) {
            try {
              logger?.warn("[tenant-registry] Corrupt tenant config aborted hydrate", {
                key,
                reason: parsed.error.reason,
              });
            } catch {
              // Diagnostic failure must not replace the typed corruption result.
            }
            return err({
              kind: "config-invalid",
              message: `persisted tenant registry contains a corrupt record at '${key}': ${parsed.error.reason}`,
            });
          }
          configs.push(parsed.value);
        }
        cursor = scanResult.value.cursor;
      } while (cursor !== "0");

      // Hydration is one serialized snapshot replacement, including scan/read.
      // Keeping the reads inside the mutation gate prevents a successful register
      // from committing between a stale scan and this replacement commit.
      const hydrated = registryOf(configs);
      if (!hydrated.ok) return hydrated;
      registry = hydrated.value;
      alive();
      return ok(registry);
    }),
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
  onEvent: (event: TenantEvent) => void | Promise<void>,
  hooks: RegistryDegradedHooks = {},
  logger?: LogPort,
): Promise<Result<{ readonly unsubscribe: () => Promise<void> }, HostError>> => {
  const reportHandlerFailure = (event: TenantEvent, error: unknown): void => {
    let message: string;
    try {
      message = error instanceof Error ? error.message : String(error);
    } catch {
      message = "<unprintable tenant-event handler failure>";
    }
    try {
      logger?.error("[tenant-registry] Tenant event handler failed — event isolated", {
        kind: event.kind,
        tenant: event.tenant,
        error: message,
      });
    } catch {
      // A diagnostic sink must not turn an already-isolated callback failure
      // into an unhandled pub/sub exception.
    }
  };

  const dispatchEvent = (event: TenantEvent): void => {
    try {
      void Promise.resolve(onEvent(event)).catch((error: unknown) => {
        reportHandlerFailure(event, error);
      });
    } catch (error) {
      reportHandlerFailure(event, error);
    }
  };

  let sub;
  try {
    sub = await pubsub.subscribe(TENANT_EVENTS_CHANNEL, (raw) => {
      const event = parseEvent(raw);
      if (event === undefined) {
        warnWithoutThrowing(logger, "[tenant-registry] Dropping malformed tenant event", { raw: raw.slice(0, 120) });
        return;
      }
      dispatchEvent(event);
    });
  } catch (e) {
    warnWithoutThrowing(logger, "[tenant-registry] Redis subscribe threw — treating as disconnected", {
      error: safeErrorMessage(e),
    });
    callHookWithoutThrowing(hooks.onRedisDead);
    return err(redisUnavailable("tenant-subscribe"));
  }
  if (!sub.ok) {
    callHookWithoutThrowing(hooks.onRedisDead);
    return err(redisUnavailable("tenant-subscribe"));
  }
  callHookWithoutThrowing(hooks.onRedisAlive);
  return ok(sub.value);
};

// ── In-memory fake (tests) ───────────────────────────────────────────────────

/**
 * In-memory `RedisPort` + `RedisPubSubPort` fake for adapter tests (mirrors
 * token-store's in-memory store). Exposes the backing map and a captured-events
 * log for assertions, plus a `fail` switch that flips every Redis op to `!ok` so
 * tests can drive the fail-closed path WITHOUT a real Redis.
 */
interface InMemoryRedisFake {
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
    compareAndDelete: async (key, expected) => {
      if (failing) return failErr("compareAndDelete");
      if (store.get(key) !== expected) return ok(false);
      store.delete(key);
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
