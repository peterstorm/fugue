/**
 * @fuguejs/host — Supervisor binary entry point (multi-tenant single-host).
 *
 * Parses config, connects Redis, hydrates the tenant registry, wires the Redis
 * liveness probe + degraded machine through `createSupervisor`, and starts the
 * single inbound HTTP listener (FR-001). Side-effecting; never re-exported.
 *
 * SECURITY (FR-005): this binary wires the supervisor with auth material, the
 * tenant registry (config + secrets REFERENCES, never values), the worker
 * lifecycle seam, and the INTERNAL HMAC key. It NEVER reads a tenant secret —
 * dereferencing a `SecretsRef` is the worker's job (AD-6). The HMAC key is read
 * from `FUGUE_SUPERVISOR_HMAC_KEY` (a platform-internal integrity key) and is the
 * only credential the supervisor stamps on proxied requests.
 *
 * WORKER LIFECYCLE (T8): this binary composes the real `WorkerLifecyclePort` via
 * `createWorkerLifecycle` (lifecycle/worker-lifecycle-manager.ts) — wiring the
 * Bun spawn adapter, the Redis worker registry, a UDS liveness probe, and the
 * tenant registry (authoritative `eagerPin`/`secretsRef` source). It calls
 * `reconcileReadopt()` once at startup to re-adopt still-live workers before
 * serving (SC-006, FR-020).
 */

import path from "node:path";
import { rm } from "node:fs/promises";
import { parseHostConfig } from "./domain/config.js";
import { formatHostError, fsPurgeFailed } from "./domain/host-error.js";
import type { HostError } from "./domain/host-error.js";
import type { Result } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";
import type { RedisConnectivityPort, RedisPort, RedisPubSubPort, TokenStorePort, LogPort } from "./ports.js";
import { createSupervisor } from "./supervisor/supervisor.js";
import type { AdmissionPort, AdmissionOutcome, AuthDeps } from "./supervisor/supervisor.js";
import {
  initTenantConcurrency,
  withTenantLimit,
  admitTenant,
  releaseTenant,
} from "./supervisor/admission.js";
import type { TenantConcurrencyState } from "./supervisor/admission.js";
import { createRedisTenantRegistry } from "./supervisor/registry/redis-registry-adapter.js";
import { activeTenants } from "./supervisor/registry/tenant-registry.js";
import { markTenant, tenantId } from "./domain/tenant.js";
import type { Tenant, TenantId, TenantRegistryView } from "./domain/tenant.js";
import { createWorkerLifecycle } from "./supervisor/lifecycle/worker-lifecycle-manager.js";
import type { TenantSpawnConfig, TenantSpawnConfigView } from "./supervisor/lifecycle/worker-lifecycle-manager.js";
import { createBunSpawnAdapter } from "./supervisor/lifecycle/bun-spawn-adapter.js";
import { createWorkerRegistry } from "./supervisor/lifecycle/worker-registry-redis.js";
import type { UdsLivenessProbe } from "./supervisor/lifecycle/worker-registry-redis.js";
import { bunUdsTransport } from "./supervisor/uds-proxy.js";
import type { AdminTenantsDeps } from "./http/handlers/admin/tenants.js";
import {
  runGracePurgeSweep,
  purgeSucceeded,
} from "./supervisor/lifecycle/grace-window-purge.js";
import type { GracePurgeDeps } from "./supervisor/lifecycle/grace-window-purge.js";
import { revoke as revokeAclUser } from "./supervisor/secrets/redis-acl-provisioner.js";
import type { RedisAclAdminPort } from "./supervisor/secrets/redis-acl-provisioner.js";
import {
  createLogAuditSink,
  createRedisStreamAuditSink,
  createCompoundAuditSink,
} from "./supervisor/audit/audit-sink-log-redis.js";
import type { AuditStreamPort } from "./supervisor/audit/audit-sink-log-redis.js";
import type { AuditPort } from "./supervisor/audit/audit-port.js";
import { createRedisTokenStore } from "./adapters/token-store.js";
import { createRealmJwtVerifier } from "./adapters/realm-jwt-verifier.js";
import type { RealmJwtDeps } from "./http/middleware/auth.js";
import type { AuthenticatedUser } from "./domain/auth.js";

// ── Logger (mirrors main.ts) ─────────────────────────────────────────────────

const safeStringify = (obj: unknown): string => {
  try { return JSON.stringify(obj); } catch { return `[unserializable: ${typeof obj}]`; }
};

const createLogger = (): LogPort => ({
  info: (msg, data) => console.info(safeStringify({ level: "info", msg, ...data, ts: new Date().toISOString() })),
  warn: (msg, data) => console.warn(safeStringify({ level: "warn", msg, ...data, ts: new Date().toISOString() })),
  error: (msg, data) => console.error(safeStringify({ level: "error", msg, ...data, ts: new Date().toISOString() })),
});

// ── Redis (connectivity + commands + pub/sub) ────────────────────────────────

interface RedisBundle {
  readonly connectivity: RedisConnectivityPort;
  readonly redis: RedisPort;
  readonly pubsub: RedisPubSubPort;
  /**
   * Privileged ACL admin port over the supervisor's admin connection — used by
   * the grace-window purge to `ACL DELUSER` a deregistered tenant's scoped user
   * (the per-tenant user cannot revoke itself). Distinct from the data-plane
   * `RedisPort` because ACL ops are privileged.
   */
  readonly aclAdmin: RedisAclAdminPort;
  /** Append-only audit stream (`XADD`) over the supervisor's admin connection. */
  readonly auditStream: AuditStreamPort;
  readonly disconnect: () => Promise<void>;
}

const createRedis = async (redisUrl: string): Promise<Result<RedisBundle, HostError>> => {
  try {
    const { Redis } = await import("ioredis");
    const client = new Redis(redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true });
    const subClient = new Redis(redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true });

    const connectivity: RedisConnectivityPort = {
      ping: async () => {
        try {
          if (client.status === "wait") await client.connect();
          await client.ping();
          return ok(undefined);
        } catch (e) {
          return err({ kind: "redis-unavailable" as const, operation: `PING (${e instanceof Error ? e.message : String(e)})` });
        }
      },
    };

    const redis: RedisPort = {
      get: async (key) => { try { return ok(await client.get(key)); } catch (e) { return err({ kind: "redis-unavailable" as const, operation: `GET ${key}` }); } },
      set: async (key, value, opts) => {
        try {
          const r = opts?.expiresInSec !== undefined ? await client.set(key, value, "EX", opts.expiresInSec) : await client.set(key, value);
          return ok(r);
        } catch { return err({ kind: "redis-unavailable" as const, operation: `SET ${key}` }); }
      },
      del: async (key) => { try { return ok(await client.del(key)); } catch { return err({ kind: "redis-unavailable" as const, operation: `DEL ${key}` }); } },
      scan: async (pattern, cursor = "0") => {
        try { const [c, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 100); return ok({ cursor: c, keys }); }
        catch { return err({ kind: "redis-unavailable" as const, operation: `SCAN ${pattern}` }); }
      },
      setNx: async (key, value, opts) => {
        try {
          if (opts?.expiresInSec !== undefined) { const r = await client.set(key, value, "EX", opts.expiresInSec, "NX"); return ok(r === "OK"); }
          return ok((await client.setnx(key, value)) === 1);
        } catch { return err({ kind: "redis-unavailable" as const, operation: `SETNX ${key}` }); }
      },
      sAdd: async (key, member) => { try { return ok(await client.sadd(key, member)); } catch { return err({ kind: "redis-unavailable" as const, operation: `SADD ${key}` }); } },
      sRem: async (key, member) => { try { return ok(await client.srem(key, member)); } catch { return err({ kind: "redis-unavailable" as const, operation: `SREM ${key}` }); } },
      sMembers: async (key) => { try { return ok(await client.smembers(key)); } catch { return err({ kind: "redis-unavailable" as const, operation: `SMEMBERS ${key}` }); } },
    };

    const pubsub: RedisPubSubPort = {
      publish: async (channel, message) => { try { await client.publish(channel, message); return ok(undefined); } catch { return err({ kind: "redis-unavailable" as const, operation: `PUBLISH ${channel}` }); } },
      subscribe: async (channel, handler) => {
        try {
          if (subClient.status === "wait") await subClient.connect();
          subClient.on("message", (ch, msg) => { if (ch === channel) handler(msg); });
          await subClient.subscribe(channel);
          return ok({ unsubscribe: async () => { await subClient.unsubscribe(channel); } });
        } catch { return err({ kind: "redis-unavailable" as const, operation: `SUBSCRIBE ${channel}` }); }
      },
    };

    const aclAdmin: RedisAclAdminPort = {
      setUser: async (username, rules) => {
        try {
          if (client.status === "wait") await client.connect();
          await client.call("ACL", "SETUSER", username, ...rules);
          return ok(undefined);
        } catch { return err({ kind: "redis-unavailable" as const, operation: `ACL SETUSER ${username}` }); }
      },
      delUser: async (username) => {
        try {
          if (client.status === "wait") await client.connect();
          await client.call("ACL", "DELUSER", username);
          return ok(undefined);
        } catch { return err({ kind: "redis-unavailable" as const, operation: `ACL DELUSER ${username}` }); }
      },
    };

    const auditStream: AuditStreamPort = {
      xAdd: async (streamKey, fields) => {
        if (client.status === "wait") await client.connect();
        const args: string[] = [];
        for (const [k, v] of Object.entries(fields)) { args.push(k, v); }
        const id = await client.xadd(streamKey, "*", ...args);
        return String(id);
      },
    };

    return ok({
      connectivity,
      redis,
      pubsub,
      aclAdmin,
      auditStream,
      disconnect: async () => { await client.quit().catch(() => {}); await subClient.quit().catch(() => {}); },
    });
  } catch (e) {
    return err({ kind: "redis-unavailable", operation: `Redis init: ${e instanceof Error ? e.message : String(e)}` });
  }
};

// ── Main ─────────────────────────────────────────────────────────────────────

const main = async () => {
  const logger = createLogger();

  logger.info("[supervisor] parsing configuration");
  const configResult = parseHostConfig(process.env as Record<string, string | undefined>);
  if (!configResult.ok) {
    logger.error(`[supervisor] configuration error: ${formatHostError(configResult.error)}`);
    process.exit(1);
  }
  const config = configResult.value;

  const redisResult = await createRedis(config.REDIS_URL);
  if (!redisResult.ok) {
    logger.error(`[supervisor] Redis connectivity failed: ${formatHostError(redisResult.error)}`);
    process.exit(1);
  }
  const { connectivity, redis, pubsub, aclAdmin, auditStream, disconnect } = redisResult.value;

  // Tenant registry (config + secrets REFERENCES only — never a secret value).
  const registry = createRedisTenantRegistry(redis, pubsub, {}, logger);
  const hydrateResult = await registry.hydrate();
  if (!hydrateResult.ok) {
    logger.error(`[supervisor] tenant registry hydrate failed: ${formatHostError(hydrateResult.error)}`);
    await disconnect();
    process.exit(1);
  }

  // Boundary registry VIEW: resolve an identity's owning team → its branded
  // Tenant principal. Own-property safe (the registry is a Map keyed by id, and
  // we scan ACTIVE entries by team). Mints the principal via `markTenant` — the
  // single producer — at the trust seam (registry construction view).
  const registryView: TenantRegistryView = {
    tenantForTeam: (team: string): Tenant | undefined => {
      const active = activeTenants(registry.snapshot());
      const cfg = active.find((c) => c.team === team);
      return cfg ? markTenant(cfg.id, cfg.team) : undefined;
    },
  };

  // NEW-run admission gate (FR-022 + FR-032/FR-038, AD-9): registry
  // `resolveForNewRun` fails closed while degraded (→ unknown/404), AND the
  // per-tenant concurrency ceiling is enforced through the pure `admitTenant`
  // ADT (acquire-on-admit / release-on-completion), so a single tenant can no
  // longer submit unbounded concurrent runs and an over-quota request yields a
  // reachable 429 + per-tenant Retry-After.
  //
  // SINGLE LIVE-WORKER COUNTER (no double-count): the worker-lifecycle manager
  // is the SOLE live-worker enforcement point (FR-033, via its own
  // maxLiveWorkers → 503 worker-unavailable). Admission therefore sizes its
  // live-worker bound effectively unbounded so it NEVER returns
  // worker-unavailable — admission adds ONLY the per-tenant ceiling (429).
  //
  // CEILING READ LIVE PER ADMIT: each admit refreshes the tenant's ceiling from
  // the ACTIVE registry config (`admission.maxConcurrentRuns`) via
  // `withTenantLimit`, so a reconfigure takes effect on the next admit with no
  // separate reconciliation listener.
  //
  // ATOMICITY: Bun.serve interleaves requests on a single thread; the admit body
  // and every release closure are fully SYNCHRONOUS (no await between reading and
  // writing `tenantConc`), so each read-modify-write of the admission state is
  // atomic. `Date.now()` is acceptable here in the imperative shell (parity with
  // the lifecycle's `clock: () => Date.now()`).
  // Every resolved tenant carries an explicit `admission.maxConcurrentRuns`,
  // refreshed onto state via `withTenantLimit` before each `admitTenant`, so the
  // `defaultTenantMax` fallback is never the binding ceiling here. The
  // live-worker bound is sized effectively non-binding so the lifecycle manager
  // stays the SOLE live-worker enforcement point (FR-033) — admission adds only
  // the per-tenant ceiling (FR-032).
  let tenantConc: TenantConcurrencyState = initTenantConcurrency({
    maxLiveWorkers: Number.MAX_SAFE_INTEGER,
  });
  const noopRelease = (): void => {};
  const admission: AdmissionPort = {
    admit: (tenant: Tenant): AdmissionOutcome => {
      // a. Fail closed while degraded / unknown (FR-022). No slot acquired.
      const resolved = registry.resolveForNewRun(tenant.id);
      if (!resolved.ok) return { decision: { kind: "unknown" }, release: noopRelease };

      // b. Refresh THIS tenant's ceiling from live config before admitting.
      const ceiling = resolved.value.admission.maxConcurrentRuns;
      tenantConc = withTenantLimit(tenantConc, tenant.id, ceiling);

      // c. Per-tenant admission (pure ADT). Synchronous read-modify-write.
      const r = admitTenant(tenantConc, tenant.id, Date.now());
      if (r.ok) {
        // d. Admitted — commit the new state and hand back the release closure
        //    that frees THIS slot exactly once when the run completes.
        tenantConc = r.value.state;
        const token = r.value.token;
        return {
          decision: { kind: "admitted" },
          release: () => {
            tenantConc = releaseTenant(tenantConc, token);
          },
        };
      }
      // e/f. Refused — map the host error to its admission decision. No slot
      //      acquired, so release is a no-op.
      if (r.error.kind === "tenant-over-quota") {
        return {
          decision: { kind: "over-quota", retryAfterSeconds: r.error.retryAfterSeconds },
          release: noopRelease,
        };
      }
      // worker-unavailable should not occur given the non-binding live-worker
      // bound (constraint 2), but handle exhaustively/defensively → 503.
      return { decision: { kind: "unavailable" }, release: noopRelease };
    },
  };

  // ── Worker lifecycle (T8): compose the real createWorkerLifecycle ──────────
  // The UDS liveness probe: an HTTP GET to the worker's /healthz over its socket.
  // Any non-2xx / transport failure → not live (fail-closed).
  const udsProbe: UdsLivenessProbe = async (record) => {
    const req = new Request("http://uds.fugue.internal/healthz", { method: "GET" });
    const r = await bunUdsTransport(record.udsPath, req);
    return r.ok && r.value.status >= 200 && r.value.status < 300;
  };

  // The worker registry (durable record of live workers; SC-006 re-adoption).
  const workerRegistry = createWorkerRegistry(redis, udsProbe, {}, logger);

  // The Bun spawn adapter (the only seam that creates a child process).
  const spawnAdapter = createBunSpawnAdapter(process.env as Record<string, string | undefined>, logger);

  // Authoritative per-tenant spawn config (secretsRef + eagerPin, AD-7/C3):
  // sourced from the ACTIVE tenant registry — eagerPin is NEVER defaulted.
  const spawnConfigView: TenantSpawnConfigView = {
    spawnConfigFor: (tenant: TenantId): TenantSpawnConfig | undefined => {
      const active = activeTenants(registry.snapshot());
      const cfg = active.find((c) => c.id === tenant);
      if (cfg === undefined) return undefined;
      return { secretsRef: cfg.secretsRef, eagerPin: cfg.eagerPin };
    },
  };

  // The worker entrypoint the spawn adapter runs (`bun run <entry>`). Resolved
  // next to this binary (worker-main.ts is its sibling in src/ / dist/).
  const workerEntry = path.join(path.dirname(process.argv[1] ?? ""), "worker-main.ts");

  const lifecycle = createWorkerLifecycle({
    spawn: spawnAdapter,
    proc: spawnAdapter,
    registry: workerRegistry,
    probe: udsProbe,
    tenants: spawnConfigView,
    clock: () => Date.now(),
    config: {
      udsDir: config.WORKER_UDS_DIR,
      workerEntry,
      idleEvictMs: config.WORKER_IDLE_EVICT_MS,
      ...(config.WORKER_HEAP_CAP_MB !== undefined ? { heapCapMb: config.WORKER_HEAP_CAP_MB } : {}),
      ...(config.SUPERVISOR_MAX_LIVE_WORKERS !== undefined ? { maxLiveWorkers: config.SUPERVISOR_MAX_LIVE_WORKERS } : {}),
      spawnReadyTimeoutMs: 10_000,
      spawnReadyPollMs: 100,
    },
    logger,
  });

  // ── Idle-evict sweep timer (AD-7/FR-017) ───────────────────────────────────
  // The lifecycle owns the eviction POLICY (idleEvictSweep respects eager-pin +
  // TTL); the binary owns the SCHEDULE. Sweep at a fraction of the idle TTL so an
  // idle worker is reclaimed within ~one extra sweep of crossing its TTL (a
  // coarser interval would let workers linger up to one whole TTL past expiry).
  // Clamp to a sane floor so a tiny configured TTL cannot busy-loop the sweep.
  const sweepIntervalMs = Math.max(1000, Math.floor(config.WORKER_IDLE_EVICT_MS / 4));
  const idleSweepTimer = setInterval(() => {
    void lifecycle.idleEvictSweep().catch((e) => {
      logger.error("[supervisor] idle-evict sweep threw", { error: e instanceof Error ? e.message : String(e) });
    });
  }, sweepIntervalMs);
  // Don't let the sweep timer keep the process alive on its own.
  if (typeof idleSweepTimer.unref === "function") idleSweepTimer.unref();
  logger.info("[supervisor] idle-evict sweep started", { intervalMs: sweepIntervalMs });

  // SC-006 / FR-020: re-adopt still-live workers BEFORE serving.
  const readopt = await lifecycle.reconcileReadopt();
  if (!readopt.ok) {
    // FAIL-CLOSED (consistent with the `registry.hydrate()` guard above, which
    // exits on Redis-down). A failed re-adoption means we do NOT know which
    // workers survived the restart. Serving with an empty in-memory map would let
    // the first per-tenant request lazy-spawn a NEW worker that binds the SAME
    // 0600 UDS a still-live re-parented worker already holds — split-brain that
    // abandons in-flight runs (violating SC-006's survival intent). Exit instead:
    // thin-init restarts the supervisor and retries the readopt once Redis is
    // healthy again, bounded by the supervisor restart budget.
    logger.error(`[supervisor] worker re-adoption failed — exiting fail-closed (thin-init will restart and retry): ${formatHostError(readopt.error)}`);
    await disconnect();
    process.exit(1);
  }
  if (readopt.value.adopted.length > 0 || readopt.value.pruned.length > 0) {
    logger.info("[supervisor] worker re-adoption complete", {
      adopted: readopt.value.adopted.length,
      pruned: readopt.value.pruned.length,
    });
  }

  // Auth material — admin token (always) + optional realm-JWT verifier group.
  // The supervisor's team-token store is keyed under a reserved platform tenant
  // (`platform`) — team-token→team resolution at the boundary is a supervisor
  // concern; the resolved team is then mapped to its owning tenant by the
  // registry view. (T8/later waves reconcile per-tenant token keying.)
  const platformTenant = tenantId("platform");
  if (!platformTenant.ok) {
    logger.error("[supervisor] unreachable: 'platform' failed tenant-id validation");
    await disconnect();
    process.exit(1);
  }
  const tokenStore: TokenStorePort = createRedisTokenStore(redis, platformTenant.value, logger);
  const realmJwt: RealmJwtDeps | undefined =
    config.REALM_JWT_ISSUER !== undefined
      ? {
          verify: createRealmJwtVerifier({ issuer: config.REALM_JWT_ISSUER }),
          expectedIss: config.REALM_JWT_ISSUER,
          expectedAud: config.REALM_JWT_AUDIENCE,
          authorizeUserRun: (user: AuthenticatedUser, dagTeam: string): boolean => user.teams.includes(dagTeam),
        }
      : undefined;
  const auth: AuthDeps = {
    adminToken: config.ADMIN_TOKEN,
    tokenStore,
    ...(realmJwt !== undefined ? { realmJwt } : {}),
    logger,
  };

  if (config.FUGUE_SUPERVISOR_HMAC_KEY === undefined) {
    logger.warn("[supervisor] FUGUE_SUPERVISOR_HMAC_KEY unset — relying on 0600 socket isolation; no X-Fugue-Tenant header will be signed");
  }

  // ── Audit sink (FR-028, SC-008) ────────────────────────────────────────────
  // Compound sink: a resilient structured-log floor + a queryable Redis stream.
  // Never-throws (each sink swallows its own failure) so it cannot crash the
  // admin request path.
  const audit: AuditPort = createCompoundAuditSink(
    [createLogAuditSink(logger), createRedisStreamAuditSink(auditStream, logger)],
    logger,
  );

  // ── Admin tenant lifecycle API deps (FR-025) ───────────────────────────────
  // Reuses the SAME admin-token auth path (`auth`) the data plane uses; the
  // supervisor dispatches `/admin/tenants(/:id)` to `handleAdminTenants` BEFORE
  // tenant-resolution/proxy. No tenant secret is threaded — register accepts a
  // secrets REFERENCE only (AD-6).
  const adminTenants: AdminTenantsDeps = {
    auth,
    registry,
    lifecycle,
    tokenStore,
    audit,
    now: () => Date.now(),
    logger,
  };

  // ── Grace-window auto-purge footprint ports (FR-030, SC-010) ───────────────
  // Wire each footprint step to its REAL adapter over the supervisor's admin
  // connection. Every step is idempotent so a retried sweep is safe.
  const gracePurgeDeps: GracePurgeDeps = {
    // ACL revoke (ACL DELUSER) — reuses the provisioner's revoke over the
    // privileged admin port (the per-tenant user cannot delete itself).
    acl: { revokeAcl: (tenant) => revokeAclUser(aclAdmin, tenant) },
    // Worker-registry record removal — the registry's own `remove` seam.
    workerRegistry: { remove: (tenant) => workerRegistry.remove(tenant) },
    // Tenant keyspace purge — scan + delete every `fugue:<tenant>:*` key over the
    // admin connection (the scoped tenant user is being revoked alongside).
    keyspace: {
      purgeKeyspace: async (tenant) => {
        const pattern = `fugue:${tenant}:*`;
        let cursor = "0";
        let deleted = 0;
        do {
          const scanR = await redis.scan(pattern, cursor);
          if (!scanR.ok) return err(scanR.error);
          for (const key of scanR.value.keys) {
            const delR = await redis.del(key);
            if (!delR.ok) return err(delR.error);
            deleted += delR.value;
          }
          cursor = scanR.value.cursor;
        } while (cursor !== "0");
        return ok(deleted);
      },
    },
    // Filesystem mount removal — recursive + force (idempotent: removing an
    // absent path is a no-op success).
    fs: {
      removeMount: async (fsRoot) => {
        try {
          if (fsRoot.length > 0) await rm(fsRoot, { recursive: true, force: true });
          return ok(undefined);
        } catch (e) {
          // A local-fs fault (EPERM/EBUSY/ENOENT) — NOT a Redis outage. Mapping
          // it to `fs-purge-failed` (500) keeps `redis-unavailable` alerts honest.
          return err(fsPurgeFailed(e instanceof Error ? e.message : String(e)));
        }
      },
    },
    // Registry hard-delete — the FINAL step (tombstone → fully removed).
    registry: { hardDelete: (tenant) => registry.hardDelete(tenant) },
  };

  // ── Grace-window auto-purge sweep timer (FR-030, SC-010) ───────────────────
  // The binary owns the SCHEDULE; the policy (which tenants are due) lives in the
  // pure `selectPurgeable`. Each tick purges deregistered tenants whose grace
  // window elapsed. Idempotent, so a missed/coarse tick only delays reclamation.
  const gracePurgeTimer = setInterval(() => {
    void (async () => {
      try {
        const outcomes = await runGracePurgeSweep(
          gracePurgeDeps,
          registry.snapshot(),
          config.SUPERVISOR_GRACE_WINDOW_MS,
          Date.now(),
          logger,
        );
        const purged = outcomes.filter(purgeSucceeded).length;
        if (outcomes.length > 0) {
          logger.info("[supervisor] grace-window purge sweep complete", {
            attempted: outcomes.length,
            purged,
            partial: outcomes.length - purged,
          });
        }
      } catch (e) {
        logger.error("[supervisor] grace-window purge sweep threw", { error: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, config.SUPERVISOR_GRACE_PURGE_INTERVAL_MS);
  if (typeof gracePurgeTimer.unref === "function") gracePurgeTimer.unref();
  logger.info("[supervisor] grace-window purge sweep started", {
    intervalMs: config.SUPERVISOR_GRACE_PURGE_INTERVAL_MS,
    graceWindowMs: config.SUPERVISOR_GRACE_WINDOW_MS,
  });

  const supervisorResult = await createSupervisor({
    config,
    redis: connectivity,
    auth,
    registryView,
    admission,
    lifecycle,
    // FR-025: the single listener dispatches /admin/tenants(/:id) to this handler
    // BEFORE tenant-resolution/proxy, so the admin API is reachable at runtime.
    adminTenants,
    // FR-022: the Redis liveness probe drives the registry's NEW-run admission
    // gate. On DOWN, resolveForNewRun fails closed (→ tenant-unknown 404) so NEW
    // runs are refused on stale config; on RECOVERY the gate re-opens. In-flight
    // (lookup) + canServeRequests are unaffected (FR-023).
    onRedisProbeEdge: (dead: boolean) => registry.markRedisDegraded(dead),
    logger,
    // Shutdown cleanup: stop the idle-evict sweep, then disconnect Redis.
    //
    // DELIBERATE NO-DRAIN ON SUPERVISOR SHUTDOWN (AD-2): we do NOT blanket-drain
    // workers here. Workers are reparented to thin-init (PID 1, see thin-init.ts)
    // and SURVIVE a supervisor restart so in-flight tenant work is not killed by
    // a routine supervisor bounce — on restart `reconcileReadopt()` re-adopts the
    // still-live workers. Graceful per-tenant drain (FR-017) is driven by
    // reconfigure/deregister/idle-evict, NOT by supervisor shutdown. So all we do
    // on shutdown is clear the sweep timer (stop reclaiming) + release Redis.
    onShutdown: async () => {
      clearInterval(idleSweepTimer);
      clearInterval(gracePurgeTimer);
      await disconnect();
    },
  });

  if (!supervisorResult.ok) {
    logger.error(`[supervisor] failed to start: ${formatHostError(supervisorResult.error)}`);
    await disconnect();
    process.exit(1);
  }

  const supervisor = supervisorResult.value;
  const onSignal = () => { void supervisor.shutdown().then(() => process.exit(0)); };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  logger.info("[supervisor] running");
};

main().catch((e) => {
  console.error("Fatal error during supervisor startup:", e);
  process.exit(1);
});
