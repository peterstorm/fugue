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
import { readFileSync } from "node:fs";
import { parseHostConfig } from "./domain/config.js";
import { formatHostError, fsPurgeFailed } from "./domain/host-error.js";
import type { HostError } from "./domain/host-error.js";
import type { Result } from "@fuguejs/framework";
import { ok, err, safeErrorMessage } from "@fuguejs/framework";
import type { RedisConnectivityPort, RedisPort, RedisPubSubPort, TokenStorePort } from "./ports.js";
import { createSupervisor, createTerminationHandler } from "./supervisor/supervisor.js";
import type { AdmissionPort, AdmissionOutcome, AuthDeps } from "./supervisor/supervisor.js";
import {
  initTenantConcurrency,
  withTenantLimit,
  admitTenant,
  releaseTenant,
  forgetTenant,
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
import { purgeTenantKeyspace } from "./supervisor/lifecycle/purge-keyspace.js";
import { makeBunUdsTransport, PROBE_UDS_TIMEOUT_MS, buildProbeRequest } from "./supervisor/uds-proxy.js";
import type { AdminTenantsDeps } from "./http/handlers/admin/tenants.js";
import {
  runGracePurgeSweep,
  purgeSucceeded,
} from "./supervisor/lifecycle/grace-window-purge.js";
import type { GracePurgeDeps } from "./supervisor/lifecycle/grace-window-purge.js";
import { apply as applyAclUser, revoke as revokeAclUser } from "./supervisor/secrets/redis-acl-provisioner.js";
import type { RedisAclAdminPort } from "./supervisor/secrets/redis-acl-provisioner.js";
import {
  createLogAuditSink,
  createRedisStreamAuditSink,
  createCompoundAuditSink,
} from "./supervisor/audit/audit-sink-log-redis.js";
import type { AuditStreamPort } from "./supervisor/audit/audit-sink-log-redis.js";
import type { AuditPort } from "./supervisor/audit/audit-port.js";
import { createRedisTokenStore } from "./adapters/token-store.js";
import { createIoredisRedisPort } from "./adapters/redis-connectivity.js";
import { runBootstrap } from "./supervisor/bootstrap/run-bootstrap.js";
import { createRealmJwtVerifier } from "./adapters/realm-jwt-verifier.js";
import type { RealmJwtDeps } from "./http/middleware/auth.js";
import type { AuthenticatedUser, Team } from "./domain/auth.js";
import {
  createJsonConsoleLogger,
  disconnectRedisClients,
  redisOperationFailure,
  redisUrlRedactions,
} from "./entrypoint-wiring.js";

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
    const redisRedactions = redisUrlRedactions(redisUrl);
    const redisFailure = (operation: string, error: unknown): HostError =>
      redisOperationFailure(operation, error, redisRedactions);

    const connectivity: RedisConnectivityPort = {
      ping: async () => {
        try {
          if (client.status === "wait") await client.connect();
          await client.ping();
          return ok(undefined);
        } catch (error) {
          return err(redisFailure("PING", error));
        }
      },
    };

    const redis = createIoredisRedisPort(client, redisFailure);

    const redisCall = async <T>(
      describe: () => string,
      run: () => Promise<T>,
    ): Promise<Result<T, HostError>> => {
      try {
        return ok(await run());
      } catch (error) {
        return err(redisFailure(describe(), error));
      }
    };

    const pubsub: RedisPubSubPort = {
      publish: (channel, message) =>
        redisCall(() => `PUBLISH ${channel}`, async () => { await client.publish(channel, message); }),
      subscribe: (channel, handler) =>
        redisCall(() => `SUBSCRIBE ${channel}`, async () => {
          if (subClient.status === "wait") await subClient.connect();
          subClient.on("message", (receivedChannel, message) => {
            if (receivedChannel === channel) handler(message);
          });
          await subClient.subscribe(channel);
          return { unsubscribe: async () => { await subClient.unsubscribe(channel); } };
        }),
    };

    const aclAdmin: RedisAclAdminPort = {
      setUser: async (username, rules) => {
        try {
          if (client.status === "wait") await client.connect();
          await client.call("ACL", "SETUSER", username, ...rules);
          return ok(undefined);
        } catch (error) {
          return err(redisFailure(`ACL SETUSER ${username}`, error));
        }
      },
      delUser: async (username) => {
        try {
          if (client.status === "wait") await client.connect();
          await client.call("ACL", "DELUSER", username);
          return ok(undefined);
        } catch (error) {
          return err(redisFailure(`ACL DELUSER ${username}`, error));
        }
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
      disconnect: () => disconnectRedisClients([
        { name: "command", quit: () => client.quit() },
        { name: "subscriber", quit: () => subClient.quit() },
      ]),
    });
  } catch (error) {
    return err(redisOperationFailure("Redis init", error, redisUrlRedactions(redisUrl)));
  }
};

// ── Main ─────────────────────────────────────────────────────────────────────

const main = async () => {
  const logger = createJsonConsoleLogger();

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

  /**
   * THE one fail-closed exit for a boot step that cannot proceed. Every such
   * step owes the SAME three things in the SAME order: say why, release the
   * Redis connection, exit non-zero so thin-init restarts and retries. A site
   * that skipped the disconnect would leak a connection on every restart loop.
   * Only reachable once `disconnect` exists — the two earlier boot failures
   * (config parse, Redis connect) have nothing to release.
   */
  const failClosed = async (message: string): Promise<never> => {
    logger.error(message);
    await disconnect();
    process.exit(1);
  };

  // Tenant registry (config + secrets REFERENCES only — never a secret value).
  const registry = createRedisTenantRegistry(redis, pubsub, {}, logger);
  const hydrateResult = await registry.hydrate();
  if (!hydrateResult.ok) {
    await failClosed(`[supervisor] tenant registry hydrate failed: ${formatHostError(hydrateResult.error)}`);
    return;
  }

  // NOTE (single-supervisor topology, ADR-0064): we hydrate the registry once at
  // boot but deliberately do NOT call `subscribeTenantEvents`. In a single-pod /
  // single-supervisor model the sole supervisor mutates its own in-memory snapshot
  // in-process via the admin handler, and workers re-read config on next spawn — so
  // there is no peer whose mutations we'd need to learn about over pub/sub. The
  // `fugue:tenants:events` publish + `subscribeTenantEvents` are forward-infra for a
  // future multi-supervisor topology.

  // Boundary registry VIEW: resolve an identity's owning team → its branded
  // Tenant principal. Own-property safe (the registry is a Map keyed by id, and
  // we scan ACTIVE entries by team). Mints the principal via `markTenant` — the
  // single producer — at the trust seam (registry construction view).
  // Team→Tenant index, reference-memoized on the registry snapshot. Registry
  // transitions are immutable (a NEW snapshot reference on every change, the SAME
  // reference on an idempotent no-op), so caching by snapshot identity makes the
  // boundary team lookup amortized O(1) instead of an O(N-tenants) rescan +
  // fresh-array allocation on every inbound request. The principal is minted via
  // `markTenant` (the single producer) at index-build time; first-writer-wins
  // preserves the prior `.find` semantics if two active tenants ever shared a team.
  let teamIndex: { snap: ReturnType<typeof registry.snapshot>; map: Map<Team, Tenant> } | undefined;
  const teamToTenant = (): Map<Team, Tenant> => {
    const snap = registry.snapshot();
    if (teamIndex && teamIndex.snap === snap) return teamIndex.map;
    // Keyed by the branded `Team` end-to-end (not bare string): makes the
    // `TenantRegistryView.tenantForTeam(team: Team)` contract a compile-time type
    // obligation. (Prototype-key safety at runtime comes from `Map` itself — a
    // `Map.get` with a string key never walks the prototype chain — independent of
    // the brand.) `cfg.team` is already a `Team`.
    const map = new Map<Team, Tenant>();
    for (const cfg of activeTenants(snap)) {
      if (!map.has(cfg.team)) map.set(cfg.team, markTenant(cfg.id, cfg.team));
    }
    teamIndex = { snap, map };
    return map;
  };
  const registryView: TenantRegistryView = {
    tenantForTeam: (team: Team): Tenant | undefined => teamToTenant().get(team),
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
  // maxLiveWorkers → 503 worker-unavailable). Admission does NOT model a
  // live-worker bound at all — it adds ONLY the per-tenant ceiling (429), so
  // there is no second, drift-prone counter to keep in sync.
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
  // `defaultTenantMax` fallback is never the binding ceiling here.
  let tenantConc: TenantConcurrencyState = initTenantConcurrency();
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
      // admitTenant only returns tenant-over-quota (above) or, defensively, an
      // internal-invariant-violated if the non-binding inner global ever rejected
      // (it cannot in practice). Map that residual to a 503 unavailable.
      return { decision: { kind: "unavailable" }, release: noopRelease };
    },
  };

  // ── Worker lifecycle (T8): compose the real createWorkerLifecycle ──────────
  // The UDS liveness probe: an HTTP GET to the worker's `/health` route over its
  // socket, carrying the SIGNED tenant header (when an HMAC key is set) — the path
  // and the signature are BOTH load-bearing (see buildProbeRequest): a wrong path
  // 404s and an unsigned probe is rejected 401, either of which would make every
  // live worker read as dead → SIGKILL → 503. Any non-2xx / transport failure →
  // not live (fail-closed).
  // The probe carries its OWN short deadline (PROBE_UDS_TIMEOUT_MS), not the data
  // path's: a worker that cannot answer `/health` promptly is, for routing
  // purposes, indistinguishable from dead — and an unbounded probe would stall
  // the liveness sweep itself on exactly the wedged worker it exists to detect.
  const probeTransport = makeBunUdsTransport(PROBE_UDS_TIMEOUT_MS);
  const udsProbe: UdsLivenessProbe = async (record) => {
    const req = buildProbeRequest(config.FUGUE_SUPERVISOR_HMAC_KEY, record.tenant);
    const r = await probeTransport(record.udsPath, req);
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
      // Direct id-keyed lookup (O(1)): the registry map is keyed by tenant id, so
      // there is no need to materialize + scan the active list on every spawn.
      const cfg = registry.snapshot().entries.get(tenant);
      if (cfg === undefined || cfg.status !== "active") return undefined;
      // ADR-0074: carry the tenant's HITL queue-depth ceiling so the lifecycle
      // manager injects FUGUE_MAX_QUEUED_RUNS into the worker spawn env. ADR-0061:
      // carry the tenant's DAG root so the manager injects DAGS_LOCAL_PATH — the
      // worker discovers ONLY this team's staged DAG bundle (at-rest isolation).
      return {
        secretsRef: cfg.secretsRef,
        eagerPin: cfg.eagerPin,
        maxQueuedRuns: cfg.admission.maxQueuedRuns,
        dagsRoot: cfg.dagsRoot,
      };
    },
  };

  // The worker entrypoint the spawn adapter runs (`bun run <entry>`). Resolved
  // next to this binary (worker-main.ts is its sibling in src/ / dist/).
  const workerEntry = path.join(path.dirname(process.argv[1] ?? ""), "worker-main.ts");

  const lifecycle = createWorkerLifecycle({
    // `spawn` and `proc` are TWO narrow ports (the testing seam — a test can inject
    // a fake `proc` whose `isAlive` disagrees with `spawn`), but in production they
    // are the SAME `createBunSpawnAdapter` instance: one Bun adapter naturally owns
    // both spawn and signal/liveness capabilities.
    spawn: spawnAdapter,
    proc: spawnAdapter,
    registry: workerRegistry,
    probe: udsProbe,
    tenants: spawnConfigView,
    clock: () => Date.now(),
    // ADR-0067: when per-tenant Redis ACL isolation is enabled, mint a fresh
    // scoped credential per spawn over the admin connection and hand it to the
    // worker (the manager injects it into the spawn env). `revoke` is already
    // wired into the grace purge below. Randomness is the CSPRNG seam the
    // provisioner expects (256-bit password). Off → no provisioning (the worker
    // uses the shared REDIS_URL credential; key-prefix isolation only).
    ...(config.SUPERVISOR_REDIS_ACL_ENABLED
      ? {
          provisionRedisAcl: (tenant: TenantId) =>
            applyAclUser(aclAdmin, tenant, { generateRandomBytes: () => crypto.getRandomValues(new Uint8Array(32)) }),
        }
      : {}),
    config: {
      udsDir: config.WORKER_UDS_DIR,
      workerEntry,
      idleEvictMs: config.WORKER_IDLE_EVICT_MS,
      ...(config.WORKER_HEAP_CAP_MB !== undefined ? { heapCapMb: config.WORKER_HEAP_CAP_MB } : {}),
      ...(config.SUPERVISOR_MAX_LIVE_WORKERS !== undefined ? { maxLiveWorkers: config.SUPERVISOR_MAX_LIVE_WORKERS } : {}),
      spawnReadyTimeoutMs: 10_000,
      spawnReadyPollMs: 100,
      maxRestartsPerWindow: config.SUPERVISOR_MAX_WORKER_RESTARTS,
      restartWindowMs: config.SUPERVISOR_WORKER_RESTART_WINDOW_MS,
    },
    logger,
  });

  /**
   * Start one unref'd background sweep. ONE encoding (round-38 cs-20) of the
   * schedule skeleton both sweeps need: the sweep POLICY lives in the
   * lifecycle, the binary owns the schedule, a throw inside a sweep is logged
   * and never allowed to reject unhandled, and the timer must not keep the
   * process alive by itself.
   */
  const startSweep = (
    label: string,
    intervalMs: number,
    sweep: () => Promise<unknown>,
  ): ReturnType<typeof setInterval> => {
    const timer = setInterval(() => {
      void sweep().catch((error) => {
        try {
          logger.error(`[supervisor] ${label} threw`, { error: safeErrorMessage(error) });
        } catch {
          // The sweep rejection remains contained when diagnostics fail.
        }
      });
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    logger.info(`[supervisor] ${label} started`, { intervalMs });
    return timer;
  };

  // ── Idle-evict sweep timer (AD-7/FR-017) ───────────────────────────────────
  // The lifecycle owns the eviction POLICY (idleEvictSweep respects eager-pin +
  // TTL); the binary owns the SCHEDULE. Sweep at a fraction of the idle TTL so an
  // idle worker is reclaimed within ~one extra sweep of crossing its TTL (a
  // coarser interval would let workers linger up to one whole TTL past expiry).
  // Clamp to a sane floor so a tiny configured TTL cannot busy-loop the sweep.
  const sweepIntervalMs = Math.max(1000, Math.floor(config.WORKER_IDLE_EVICT_MS / 4));
  const idleSweepTimer = startSweep("idle-evict sweep", sweepIntervalMs, () => lifecycle.idleEvictSweep());

  // ── Liveness sweep timer (SC-006, FR-014/FR-015) ───────────────────────────
  // Crash-detection SAFETY NET for RE-ADOPTED workers. A worker spawned by THIS
  // supervisor carries a `handle.exited` crash watcher; a worker re-adopted across
  // a restart (reconcileReadopt below) does NOT — its process was re-parented to
  // thin-init, so this process has no exit handle to await. Without this poll a
  // re-adopted worker that later crashes (OOM, AD-9) would wedge its tenant at 503
  // forever. The policy (who is watcher-covered) lives in the lifecycle; the binary
  // owns the schedule. Watcher-covered workers are skipped, so this is a no-op once
  // every adopted worker has been replaced by a spawned (watched) one.
  const livenessSweepTimer = startSweep("liveness sweep", config.WORKER_LIVENESS_SWEEP_MS, () => lifecycle.livenessSweep());

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
    await failClosed(`[supervisor] worker re-adoption failed — exiting fail-closed (thin-init will restart and retry): ${formatHostError(readopt.error)}`);
    return;
  }
  if (readopt.value.adopted.length > 0 || readopt.value.pruned.length > 0) {
    logger.info("[supervisor] worker re-adoption complete", {
      adopted: readopt.value.adopted.length,
      pruned: readopt.value.pruned.length,
    });
  }

  // Auth material — admin token (always) + optional realm-JWT verifier group.
  // The supervisor's team-token store is intentionally keyed under the reserved
  // platform tenant: token→team resolution is a platform-boundary concern, while
  // the resolved team is mapped to its owning tenant by the registry view. Worker
  // re-authentication separately uses each tenant's scoped token store.
  const platformTenant = tenantId("platform");
  if (!platformTenant.ok) {
    await failClosed("[supervisor] unreachable: 'platform' failed tenant-id validation");
    return;
  }
  const tokenStore: TokenStorePort = createRedisTokenStore(redis, platformTenant.value, logger);

  // ── Declarative bootstrap (ADR-0064; GitOps, no admin API / no exec) ───────
  // Seed tenants + team tokens from mounted files (ConfigMap + SealedSecret) so
  // the host comes up fully provisioned without a `POST /admin/tenants(/teams)`
  // call — the locked-down-namespace blocker. IDEMPOTENT (safe every boot) and
  // FAIL-CLOSED: a read/parse/apply error exits non-zero so the pod restarts
  // rather than serving a half-seeded host. Tenant bootstrap needs the registry
  // (hydrated above); token bootstrap needs `tokenStore` (just built) and the
  // post-seed registry snapshot — so both run here, after `tokenStore`.
  const bootstrapResult = await runBootstrap(
    {
      registry,
      // Supervisor routing resolves the token here (platform-keyed)…
      platformTokenStore: tokenStore,
      // …and the worker re-auths against its own per-tenant store, so seed both.
      tenantTokenStore: (t: TenantId) => createRedisTokenStore(redis, t, logger),
      now: () => Date.now(),
      // Mounted-file read authority lives HERE in the shell (fail-closed),
      // mirroring the env-file secrets source: any read failure is a Left.
      readFile: (p: string): Result<string, HostError> => {
        try {
          return ok(readFileSync(p, "utf8"));
        } catch (e) {
          const code =
            typeof e === "object" && e !== null && "code" in e && typeof (e as { code?: unknown }).code === "string"
              ? (e as { code: string }).code
              : "unknown";
          return err({ kind: "config-invalid", message: `bootstrap file '${p}' unreadable (${code})` });
        }
      },
      logger,
    },
    {
      ...(config.TENANTS_BOOTSTRAP_PATH !== undefined ? { tenantsPath: config.TENANTS_BOOTSTRAP_PATH } : {}),
      ...(config.TENANTS_BOOTSTRAP !== undefined ? { tenantsInline: config.TENANTS_BOOTSTRAP } : {}),
      ...(config.TEAM_TOKENS_BOOTSTRAP_PATH !== undefined ? { teamTokensPath: config.TEAM_TOKENS_BOOTSTRAP_PATH } : {}),
      ...(config.TEAM_TOKENS_BOOTSTRAP !== undefined ? { teamTokensInline: config.TEAM_TOKENS_BOOTSTRAP } : {}),
    },
  );
  if (!bootstrapResult.ok) {
    await failClosed(`[supervisor] declarative bootstrap failed — exiting fail-closed: ${formatHostError(bootstrapResult.error)}`);
    return;
  }
  if (bootstrapResult.value.tenantsApplied > 0 || bootstrapResult.value.teamTokensApplied > 0) {
    logger.info("[supervisor] declarative bootstrap complete", {
      tenants: bootstrapResult.value.tenantsApplied,
      teamTokens: bootstrapResult.value.teamTokensApplied,
    });
  }

  const realmJwt: RealmJwtDeps | undefined =
    config.REALM_JWT_ISSUER !== undefined
      ? {
          verify: createRealmJwtVerifier({ issuer: config.REALM_JWT_ISSUER }),
          expectedIss: config.REALM_JWT_ISSUER,
          expectedAud: config.REALM_JWT_AUDIENCE,
          authorizeUserRun: (user: AuthenticatedUser, dagTeam: Team): boolean => user.teams.includes(dagTeam),
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
      // Scan + delete every `fugue:<tenant>:*` key over the admin connection. The
      // best-effort enumeration invariant (one failing `del` must not abort the
      // rest) lives in the unit-tested `purgeTenantKeyspace` leaf.
      purgeKeyspace: (tenant) => purgeTenantKeyspace(redis, tenant),
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
    // Registry hard-delete — the FINAL step (tombstone → fully removed). On
    // success, reclaim the tenant's admission state in lockstep (FR-032): the
    // hard-delete runs only post-grace with the tenant fully retired, so its
    // in-flight count is 0 and `forgetTenant`'s guard passes; the guard makes any
    // residual open slot a safe no-op the next sweep retries. Without this, the
    // per-tenant admission counters would leak one entry per purged tenant id.
    registry: {
      beginPurge: (tombstone) => registry.beginPurge(tombstone),
      hardDelete: async (lease) => {
        const r = await registry.hardDelete(lease);
        // Reclaim admission state only when the fenced record was genuinely
        // removed; a superseded refusal keeps the tenant's bookkeeping.
        if (r.ok && r.value === "deleted") tenantConc = forgetTenant(tenantConc, lease.tenant);
        return r;
      },
      releasePurge: (lease) => registry.releasePurge(lease),
    },
  };

  // ── Grace-window auto-purge sweep timer (FR-030, SC-010) ───────────────────
  // The binary owns the SCHEDULE; the policy (which tenants are due) lives in the
  // pure `selectPurgeable`. Each tick purges deregistered tenants whose grace
  // window elapsed. Idempotent, so a missed/coarse tick only delays reclamation.
  // Schedules go through `startSweep` — the ONE schedule skeleton (interval,
  // unref so a timer never holds the process open, throw-to-log, start log) that
  // every sweep in this binary shares.
  const gracePurgeTimer = startSweep(
    "grace-window purge sweep",
    config.SUPERVISOR_GRACE_PURGE_INTERVAL_MS,
    async () => {
      const outcomes = await runGracePurgeSweep(
        gracePurgeDeps,
        registry.snapshot(),
        config.SUPERVISOR_GRACE_WINDOW_MS,
        Date.now(),
        logger,
      );
      if (outcomes.length === 0) return;
      const purged = outcomes.filter(purgeSucceeded).length;
      const superseded = outcomes.filter((o) => o.kind === "superseded").length;
      logger.info("[supervisor] grace-window purge sweep complete", {
        attempted: outcomes.length,
        purged,
        // Revived mid-purge — abandoned on purpose, NOT a partial failure the
        // next tick should retry.
        superseded,
        partial: outcomes.length - purged - superseded,
      });
    },
  );

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
    // Inject the wall clock at the composition root (parity with the lifecycle
    // manager's `clock: () => Date.now()`); the supervisor reads no bare Date.now().
    clock: () => Date.now(),
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
      clearInterval(livenessSweepTimer);
      clearInterval(gracePurgeTimer);
      await disconnect();
    },
  });

  if (!supervisorResult.ok) {
    await failClosed(`[supervisor] failed to start: ${formatHostError(supervisorResult.error)}`);
    return;
  }

  const supervisor = supervisorResult.value;
  // Always terminate on signal: a shutdown() rejection must NOT leave the pod
  // hanging on SIGTERM until the orchestrator SIGKILLs it (see
  // `createTerminationHandler` — the testable seam for both exit paths).
  const onSignal = createTerminationHandler({
    shutdown: () => supervisor.shutdown(),
    logger,
    exit: (code) => process.exit(code),
  });
  process.on("SIGTERM", () => void onSignal());
  process.on("SIGINT", () => void onSignal());

  logger.info("[supervisor] running");
};

main().catch((e) => {
  console.error("Fatal error during supervisor startup:", e);
  process.exit(1);
});
