/**
 * Supervisor core — the single inbound HTTP listener for the multi-tenant host
 * (multi-tenant spec FR-001). It is THIN: per request it authenticates the inbound identity →
 * resolves the `Tenant` at the boundary → admits the tenant for a NEW run →
 * routes (pure) → reverse-proxies over the owning worker's UDS with a SIGNED
 * `X-Fugue-Tenant` header. It performs NO DAG execution and holds NO tenant
 * secrets (multi-tenant spec FR-005).
 *
 * MIRRORS `createHost`: `createSupervisor(deps) => Result<SupervisorInstance,
 * HostError>`, same imperative-shell shape (mutable `let` state, a single
 * `Bun.serve`, a shutdown handle), and it REUSES the existing degraded machine
 * (`host-state.ts`) + Redis liveness probe (`redis-probe.ts`) rather than
 * inventing a parallel one.
 *
 * SECURITY POSTURE:
 *   - ZERO tenant secrets (multi-tenant spec FR-005). `SupervisorDeps` carries only auth material
 *     (admin token, optional realm-JWT verifier group), the tenant registry
 *     (config + a secrets REFERENCE, never a value), the worker-lifecycle port,
 *     routing config, and the INTERNAL HMAC key. There is structurally no
 *     channel through which a tenant secret could enter the supervisor — the
 *     registry holds `SecretsRef` (branded reference) only, and the worker is the
 *     sole dereferencer (AD-6). `assertNoTenantSecrets` documents/enforces this.
 *   - FAIL-CLOSED at every boundary: unknown identity → 401; unresolved tenant →
 *     404 (`tenant-unknown`, non-leaking); degraded registry → 404 for NEW runs
 *     (multi-tenant spec FR-022, via `resolveForNewRun`) while in-flight/status keep working
 *     (multi-tenant spec FR-023, `canServeRequests` NOT widened); worker down → 503 for that tenant.
 *   - No cross-tenant leakage (multi-tenant spec FR-040/041): the routing core only ever targets
 *     the resolved tenant's own socket, and every refusal error names at most the
 *     caller's OWN tenant.
 *
 * WORKER LIFECYCLE SEAM (T8): the supervisor does NOT spawn/evict/restart
 * workers. It depends on a minimal `WorkerLifecyclePort` — "ensure the worker for
 * this tenant is live and give me its socket, or tell me it's unavailable" —
 * which T8's lifecycle implements and which tests fake.
 */

import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostConfig } from "../domain/config.js";
import type { HostState } from "../domain/host-state.js";
import { booting, bootComplete, beginDrain, drainComplete, redisDied, redisRecovered, canServeRequests } from "../domain/host-state.js";
import { emptyRegistry } from "../domain/registry.js";
import { gitSha } from "@fuguejs/framework";
import type { HostError } from "../domain/host-error.js";
import { httpStatusFor, formatHostError, retryAfterSecondsFor } from "../domain/host-error.js";
import type { AuthIdentity } from "../domain/auth.js";
import { authenticateIdentity } from "../http/authenticate-identity.js";
import type { AuthDeps } from "../http/authenticate-identity.js";
import type { Tenant, TenantRegistryView } from "../domain/tenant.js";
import { resolveTenant } from "../domain/tenant.js";
import type { RedisConnectivityPort, LogPort } from "../ports.js";
import { startRedisProbe } from "../lifecycle/redis-probe.js";
import type { RedisProbeHandle } from "../lifecycle/redis-probe.js";
import { routeRequest, workerSocketForTenant } from "./routing.js";
import type { AdmissionDecision, WorkerPresence, RouteDecision } from "./routing.js";
import { proxyToWorker, bunUdsTransport } from "./uds-proxy.js";
import type { UdsTransport } from "./uds-proxy.js";
import { handleAdminTenants } from "../http/handlers/admin/tenants.js";
import type { AdminTenantsDeps } from "../http/handlers/admin/tenants.js";

// ── Worker lifecycle port (T8 owns the contract — spawn-port.ts) ─────────────

/**
 * The supervisor consumes T8's `WorkerLifecyclePort` (SHARED CONTRACT in
 * `lifecycle/spawn-port.ts`): `ensureWorker(tenant) => Result<EnsuredWorker,
 * HostError>` lazy-spawns the tenant's worker and hands back its UDS path, or
 * fails closed with `worker-unavailable`. The supervisor only ASKS; T8 owns all
 * lifecycle policy (spawn/evict/drain/crash-restart/re-adopt). The supervisor
 * maps the result into the pure router's `WorkerPresence` so routing never
 * branches on lifecycle internals — see `presenceFromEnsure`.
 */
import type { WorkerLifecyclePort, EnsuredWorker } from "./lifecycle/spawn-port.js";

/**
 * Map T8's `ensureWorker` result into the pure router's `WorkerPresence`. A
 * fail-closed `worker-unavailable` (or any error) becomes `{ kind: "unavailable" }`
 * (→ 503 for THIS tenant); a live result carries the worker's UDS path. PURE +
 * total, so the success/failure → presence mapping is unit-testable in isolation.
 */
export const presenceFromEnsure = (
  result: Result<EnsuredWorker, HostError>,
): WorkerPresence =>
  result.ok ? { kind: "live", socketPath: result.value.udsPath } : { kind: "unavailable" };

// ── New-run admission port (registry seam, multi-tenant spec FR-022) ───────────────────────────

/**
 * The OUTCOME of admitting a tenant for a NEW run. A successful admission
 * ACQUIRES a per-tenant concurrency slot (multi-tenant spec FR-032), so the port must hand back a
 * `release` handle the supervisor invokes ONCE the proxied run completes — that
 * is the slot's counterpart `release`. For a REFUSED admission (over-quota /
 * unknown / unavailable) `release` is a no-op: nothing was acquired, so nothing
 * is freed. This acquire-on-admit / release-on-completion shape is what lets the
 * per-tenant ceiling actually bound in-flight runs rather than merely gate the
 * first request.
 *
 * `AdmissionDecision` (routing.ts) is UNCHANGED — `routeRequest` already folds
 * its `admitted`/`over-quota`/`unavailable`/`unknown` arms; this record simply
 * pairs the decision with its release counterpart.
 */
export interface AdmissionOutcome {
  readonly decision: AdmissionDecision;
  /**
   * Release the per-tenant slot acquired by THIS admit. A no-op for refusals.
   * MUST be called exactly once per admitted request (the supervisor calls it in
   * a `finally`, so it runs even if the proxy throws), and never for refusals.
   * Synchronous so each read-modify-write of admission state is atomic under
   * Bun.serve's single-thread async interleaving.
   */
  readonly release: () => void;
}

/**
 * The NEW-run admission gate. The supervisor binds this to the registry's
 * `resolveForNewRun` (which fails closed while Redis is degraded — multi-tenant spec FR-022) plus
 * the per-tenant ceiling check (multi-tenant spec FR-032 via `admitTenant`). Kept as a port so the
 * supervisor stays testable with a fake and so the "new-run uses
 * resolveForNewRun, NOT lookup" contract is enforced at the wiring site, not by
 * convention.
 *
 * `admit` ACQUIRES on success and returns the matching `release` handle (see
 * `AdmissionOutcome`); the supervisor releases after the proxy completes.
 */
export interface AdmissionPort {
  readonly admit: (tenant: Tenant) => AdmissionOutcome;
}

// ── Inbound identity authentication ──────────────────────────────────────────
// `authenticateIdentity` + `AuthDeps` were extracted to a shared leaf
// (`http/authenticate-identity.ts`) so the admin tenants handler can reuse the
// auth path WITHOUT importing this supervisor module (removing a handler→supervisor
// back-edge). Imported above for the listener's own use; re-exported here for the
// composition root and the tests that still import them from the supervisor.
export { authenticateIdentity };
export type { AuthDeps };

// ── Supervisor deps + instance ───────────────────────────────────────────────

/**
 * The supervisor's injected dependencies. NOTICE the absence of any tenant-
 * secret channel — only auth, registry (references), routing/admission, lifecycle.
 */
export interface SupervisorDeps {
  readonly config: HostConfig;
  /** Redis liveness — drives the degraded machine (reused, not reinvented). */
  readonly redis: RedisConnectivityPort;
  /** Inbound identity authentication material (admin token, optional realm JWT). */
  readonly auth: AuthDeps;
  /**
   * The tenant registry VIEW for boundary resolution (identity→Tenant). Holds
   * branded `Tenant` principals + config references only — never a secret.
   */
  readonly registryView: TenantRegistryView;
  /** NEW-run admission gate (registry `resolveForNewRun` + per-tenant ceiling). */
  readonly admission: AdmissionPort;
  /** Worker lifecycle seam (T8 implements; supervisor only asks). */
  readonly lifecycle: WorkerLifecyclePort;
  /**
   * Admin tenant lifecycle API deps (multi-tenant spec FR-025). When wired, the single listener
   * DISPATCHES `/admin/tenants(/:id)` requests to `handleAdminTenants` BEFORE
   * tenant-resolution/proxy — so the admin API is reachable at runtime and an
   * admin request is never resolved as a tenant or proxied. Optional so tests
   * that exercise only the proxy path need not construct the admin handler.
   */
  readonly adminTenants?: AdminTenantsDeps;
  /** HTTP-over-UDS transport — Bun in prod, fake in tests. Defaults to Bun's. */
  readonly transport?: UdsTransport;
  /**
   * multi-tenant spec FR-022: invoked on every Redis liveness-probe edge (`dead=true` on DOWN,
   * `dead=false` on RECOVERED) so the binary can drive the registry's NEW-run
   * admission gate (`registry.markRedisDegraded`). The supervisor's data path is
   * read-only, so without this the registry's `degraded` flag would only flip on
   * a registry WRITE — and NEW runs would be admitted on stale config while Redis
   * is down. Wired here so new-run admission fails closed (→ tenant-unknown, 404)
   * the moment the probe sees Redis die (the admission port collapses
   * `resolveForNewRun`'s error to `unknown`; see main-supervisor.ts), and recovers
   * when it sees Redis return. In-flight/status
   * (`lookup`) and `canServeRequests` are intentionally unaffected (multi-tenant spec FR-023).
   */
  readonly onRedisProbeEdge?: (dead: boolean) => void;
  readonly logger: LogPort;
  /**
   * Monotonic-ish wall clock (UNIX millis) used to stamp the supervisor's own
   * lifecycle transitions (boot/ready/redis-died/drain). Injected as a port so
   * the supervisor honors the repo-wide injected-clock discipline every sibling
   * module upholds (`worker-lifecycle-manager`, `admission`, `tenant-registry`,
   * `grace-window-purge`), making those transitions deterministic under test.
   * Defaults to `Date.now` at the composition root.
   */
  readonly clock?: () => number;
  /** Called during graceful shutdown to clean up infrastructure (e.g., Redis). */
  readonly onShutdown?: () => Promise<void>;
}

interface SupervisorInstance {
  readonly getState: () => HostState;
  /** Handle a single inbound request (exposed for tests; also the serve fetch). */
  readonly handle: (request: Request) => Promise<Response>;
  readonly shutdown: () => Promise<void>;
  readonly server: { port: number; stop: () => void } | null;
}

// ── multi-tenant spec FR-005 zero-secrets guard ────────────────────────────────────────────────

/**
 * A compile-time + runtime witness that the supervisor's deps carry NO tenant
 * secret. There is no `SecretsRef`-dereferencing capability, no secret value, and
 * no `secretsSource` in `SupervisorDeps` — the registry view exposes only
 * `tenantForTeam` returning a `Tenant` (id + team, no secret). This function is a
 * single greppable seam asserting that invariant; it is a no-op at runtime (the
 * guarantee is structural), kept so a future dep widening that smuggled a secret
 * channel would be an obvious, reviewable edit here.
 */
export const assertNoTenantSecrets = (_deps: SupervisorDeps): void => {
  // Intentionally empty: multi-tenant spec FR-005 is enforced by the SHAPE of SupervisorDeps
  // (no secret-bearing field exists). See module header + tenant.ts SecretsRef.
};

// ── Request pipeline (pure-ish orchestration) ────────────────────────────────

/** Render a HostError as a Response, attaching Retry-After where the error carries one. */
const errorToResponse = (error: HostError): Response => {
  const status = httpStatusFor(error);
  const headers = new Headers({ "Content-Type": "application/json" });
  const retryAfter = retryAfterSecondsFor(error);
  if (retryAfter !== undefined) headers.set("Retry-After", String(retryAfter));
  if (error.kind === "unauthorized") headers.set("WWW-Authenticate", "Bearer");
  // Client-facing body is the NON-LEAKING formatHostError message (tenant-unknown
  // names no tenant; quota/worker name only the caller's own tenant).
  return new Response(JSON.stringify({ error: formatHostError(error) }), { status, headers });
};

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/**
 * PURE: the unauthenticated `/health` LIVENESS response. ALWAYS 200 while the
 * listener is up — `"degraded"` (e.g. a Redis outage) still reports 200 so it
 * ALERTS via the body status WITHOUT triggering a restart-storm; every other phase
 * is `"ok"` because the listener being up IS liveness. Mirrors the worker's
 * `/health` (router.ts). Pure + exported so the degraded-vs-ok mapping is tested
 * across the full `HostState` ADT without booting a real supervisor.
 */
export const buildLivenessResponse = (state: HostState): Response =>
  new Response(JSON.stringify({ status: state.phase === "degraded" ? "degraded" : "ok" }), {
    status: 200,
    headers: JSON_HEADERS,
  });

/**
 * PURE: the unauthenticated `/readiness` response that gates k8s traffic. 200 iff
 * the supervisor `canServeRequests` (ready/degraded/syncing), else 503 (booting/
 * draining/stopped) so an unready pod is kept OUT of the load-balancer. Pure +
 * exported so the 503 branch — the operationally critical one — is tested directly.
 */
export const buildReadinessResponse = (state: HostState): Response => {
  const ready = canServeRequests(state);
  return new Response(JSON.stringify({ ready, phase: state.phase }), {
    status: ready ? 200 : 503,
    headers: JSON_HEADERS,
  });
};

// ── Process termination ──────────────────────────────────────────────────────

/**
 * Build the SIGTERM/SIGINT termination handler. ALWAYS terminates: a `shutdown()`
 * rejection must NOT leave the pod hanging on the signal until the orchestrator
 * SIGKILLs it. A clean shutdown exits 0; a failed one logs the cause and exits
 * non-zero so it is visible. A pure factory over injected `shutdown`/`logger`/
 * `exit` so BOTH paths — including the exit(1) failure branch — are unit-testable
 * without sending a real signal or actually exiting the process.
 */
export const createTerminationHandler = (deps: {
  readonly shutdown: () => Promise<void>;
  readonly logger: Pick<LogPort, "error">;
  readonly exit: (code: number) => void;
}): (() => Promise<void>) => async () => {
  try {
    await deps.shutdown();
    deps.exit(0);
  } catch (e) {
    deps.logger.error("[supervisor] shutdown failed during signal handling — forcing exit", {
      error: e instanceof Error ? e.message : String(e),
      // Include the stack: a shutdown that fails inside a signal handler is
      // inherently hard to reproduce, so the trace is the difference between a
      // 5-minute and a 2-hour diagnosis.
      stack: e instanceof Error ? e.stack : undefined,
    });
    deps.exit(1);
  }
};

// ── Supervisor factory ───────────────────────────────────────────────────────

/**
 * Create and boot the supervisor. Mirrors `createHost`: returns
 * `Result<SupervisorInstance, HostError>`, owns mutable state, starts one
 * `Bun.serve`, wires the Redis probe to the degraded machine, and registers a
 * shutdown handle.
 */
export const createSupervisor = async (
  deps: SupervisorDeps,
): Promise<Result<SupervisorInstance, HostError>> => {
  const { config, redis, logger } = deps;
  // Injected clock (repo-wide discipline — NEVER bare Date.now() in the shell's
  // own state transitions). Defaults to Date.now at this composition seam.
  const clock = deps.clock ?? Date.now;
  // multi-tenant spec FR-005: structurally assert no tenant-secret channel exists.
  assertNoTenantSecrets(deps);

  const transport: UdsTransport = deps.transport ?? bunUdsTransport;

  // ── Mutable state (imperative shell) ───────────────────────────────────────
  // The supervisor has no DAG registry of its own (it routes, it does not
  // execute), so it seeds the degraded machine with the empty registry purely to
  // reuse the existing `HostState` transitions (booting → ready → degraded). It
  // never reads DAGs out of it.
  let state: HostState = booting(clock());
  let redisProbe: RedisProbeHandle | null = null;
  let server: { port: number; stop: () => void } | null = null;

  // Boot → ready. The empty registry + a fixed boot sha satisfy the transition's
  // signature without implying the supervisor loads DAGs.
  const BOOT_SHA = gitSha("supervisor");
  const readyResult = bootComplete(state, emptyRegistry(), BOOT_SHA, clock());
  if (!readyResult.ok) {
    return err({ kind: "internal-invariant-violated", message: "supervisor boot → ready transition failed", context: { from: readyResult.error.from, to: readyResult.error.to } });
  }
  state = readyResult.value;

  // ── Request handler ────────────────────────────────────────────────────────
  const handle = async (request: Request): Promise<Response> => {
    // 0a. LIVENESS / READINESS (unauthenticated — k8s probes + Docker HEALTHCHECK).
    //     The supervisor owns the single inbound listener (multi-tenant spec FR-001) and there is no
    //     Hono router in this path, so these MUST be served HERE, and BEFORE admin
    //     dispatch / auth / tenant-resolution — otherwise an unauthenticated GET
    //     /health is rejected 401 and the container is reported permanently
    //     unhealthy. Mirrors the worker's /health + /readiness (router.ts): /health
    //     is liveness (always 200 while the listener is up; "degraded" still 200 so
    //     a Redis outage alerts WITHOUT a restart), /readiness gates on canServeRequests.
    if (request.method === "GET") {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/health") return buildLivenessResponse(state);
      if (pathname === "/readiness") return buildReadinessResponse(state);
    }

    // 0. ADMIN TENANT LIFECYCLE API (multi-tenant spec FR-025). Dispatch `/admin/tenants(/:id)` to
    //    the admin handler BEFORE any tenant-resolution/proxy logic, so an admin
    //    request is NEVER resolved as a tenant or reverse-proxied. The handler
    //    enforces its OWN admin-token authz (and audits refusals); a non-admin
    //    token gets 401/403 there. It returns `undefined` only when the path is
    //    not an admin-tenants route — then we fall through to normal routing.
    if (deps.adminTenants) {
      const adminResponse = await handleAdminTenants(deps.adminTenants, request);
      if (adminResponse !== undefined) return adminResponse;
    }

    // 1. Authenticate inbound identity (admin / user-JWT / team).
    const identityResult = await authenticateIdentity(deps.auth, request.headers.get("Authorization") ?? undefined);
    if (!identityResult.ok) {
      return errorToResponse(identityResult.error);
    }
    const identity: AuthIdentity = identityResult.value;

    // 2. Resolve the Tenant at the boundary (multi-tenant spec FR-002). Fail-closed + non-leaking:
    //    an identity that maps to no registered tenant → tenant-unknown (404).
    const tenantResult = resolveTenant(identity, deps.registryView);
    if (!tenantResult.ok) {
      return errorToResponse(tenantResult.error);
    }
    const tenant: Tenant = tenantResult.value;

    // 3. NEW-run admission gate (multi-tenant spec FR-022). Uses the registry's resolveForNewRun
    //    seam, which fails closed (→ tenant-unknown) while Redis is degraded —
    //    new runs refuse, but in-flight/status keep working (multi-tenant spec FR-023). Note we do
    //    NOT consult canServeRequests here to BLOCK: it stays true while degraded
    //    by design so cached/in-flight work is unaffected; only NEW-run admission
    //    fails closed, exactly as the registry seam dictates.
    //    ACQUIRE-ON-ADMIT: a successful admit claims a per-tenant slot (multi-tenant spec FR-032)
    //    and hands back `release`, which we MUST call exactly once after the
    //    proxy completes (a `finally` below, so it runs even if proxyToWorker
    //    throws). A refused admit returns a no-op release — nothing acquired,
    //    nothing freed — so we can call `release` unconditionally in the finally.
    const admission: AdmissionOutcome = deps.admission.admit(tenant);

    // 4. Ensure the owning worker is live (T8 seam) and derive its presence — but
    //    ONLY when admission ADMITTED the request. The socket on a live presence is
    //    ALWAYS the resolved tenant's own socket (multi-tenant spec FR-004) — re-derived defensively so
    //    a lifecycle that returned a mismatched socket cannot cause cross-tenant routing.
    let presence: WorkerPresence;
    if (admission.decision.kind !== "admitted") {
      // Admission already refused this request (unknown / over-quota / unavailable),
      // and `routeRequest` folds the admission decision FIRST — it refuses regardless
      // of presence. So DO NOT ensure (cold-spawn) a worker here: it is wasted work
      // for a request that will be refused anyway, and during a Redis outage — where
      // `resolveForNewRun` fails closed to `unknown` for every active tenant — it
      // would cold-spawn a worker PER request that then cannot reach Redis at boot and
      // is SIGKILLed (fault amplification under the exact condition the box is already
      // stressed). Mark unavailable; the pure router produces the correct refusal.
      presence = { kind: "unavailable" };
    } else {
      try {
        presence = presenceFromEnsure(await deps.lifecycle.ensureWorker(tenant.id));
      } catch (e) {
        logger.warn("[supervisor] ensureWorker threw — worker unavailable", {
          tenant: tenant.id,
          error: e instanceof Error ? e.message : String(e),
        });
        presence = { kind: "unavailable" };
      }
      // Defensive re-pin: a `live` presence MUST point at THIS tenant's own socket.
      if (presence.kind === "live") {
        const expected = workerSocketForTenant(config.WORKER_UDS_DIR, tenant);
        if (presence.socketPath !== expected) {
          logger.error("[supervisor] lifecycle returned a non-owning socket — refusing (multi-tenant spec FR-004)", {
            tenant: tenant.id,
          });
          presence = { kind: "unavailable" };
        }
      }
    }

    // 5. Pure routing decision.
    const decision: RouteDecision = routeRequest(tenant, admission.decision, presence);
    if (decision.kind === "refuse") {
      // A refusal means the admit either refused (release is a no-op) OR admit
      // succeeded but worker presence forced a refuse — in the latter case the
      // acquired slot MUST be released so a worker-down request never leaks a
      // per-tenant slot. Release is idempotent-safe for the no-op case.
      admission.release();
      return errorToResponse(decision.error);
    }
    // 6. Reverse-proxy to the owning worker over its UDS with the SIGNED
    //    X-Fugue-Tenant header (the internal HMAC key — never a tenant secret).
    //    The acquired per-tenant slot is released in `finally` so it is freed on
    //    EVERY admitted request exactly once, even if proxyToWorker throws.
    try {
      const proxied = await proxyToWorker(
        { hmacKey: config.FUGUE_SUPERVISOR_HMAC_KEY, transport, logger },
        request,
        decision.tenant,
        decision.socketPath,
      );
      return proxied.ok ? proxied.value : errorToResponse(proxied.error);
    } finally {
      admission.release();
    }
  };

  // ── HTTP server (single listener — multi-tenant spec FR-001) ─────────────────────────────────
  let bunServer;
  try {
    bunServer = Bun.serve({
      fetch: handle,
      port: config.PORT,
      maxRequestBodySize: 10 * 1024 * 1024,
    });
  } catch (e) {
    if (deps.onShutdown) {
      await deps.onShutdown().catch((cleanupErr) => {
        logger.error("[supervisor] cleanup after port-bind failure failed", {
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      });
    }
    return err({
      kind: "internal-invariant-violated",
      message: `supervisor failed to bind HTTP server on port ${config.PORT}: ${e instanceof Error ? e.message : String(e)}`,
      context: { port: config.PORT },
    });
  }
  server = { port: bunServer.port ?? config.PORT, stop: () => bunServer.stop() };
  logger.info(`[supervisor] HTTP listener on port ${bunServer.port}`);

  // ── Redis liveness probe → degraded machine (reused) ───────────────────────
  redisProbe = startRedisProbe(
    redis,
    config.REDIS_PROBE_INTERVAL_MS,
    {
      onDead: () => {
        // multi-tenant spec FR-022: drive the registry's NEW-run admission gate closed FIRST, on
        // every dead tick (idempotent), so a new run is refused the moment the
        // probe sees Redis down — even before/without any registry write.
        deps.onRedisProbeEdge?.(true);
        const r = redisDied(state, clock());
        if (r.ok) {
          state = r.value;
          logger.warn("[supervisor] Redis probe failed — degraded (redis-disconnected)");
        } else if (state.phase !== "degraded") {
          logger.warn("[supervisor] redisDied transition unexpectedly rejected", { currentPhase: state.phase });
        }
      },
      onAlive: () => {
        // multi-tenant spec FR-022: re-open the NEW-run gate on recovery (idempotent every tick).
        deps.onRedisProbeEdge?.(false);
        if (state.phase === "degraded" && state.reason === "redis-disconnected") {
          const r = redisRecovered(state);
          if (r.ok) {
            state = r.value;
            logger.info("[supervisor] Redis recovered — ready");
          }
        }
      },
    },
    logger,
  );

  // ── Shutdown ───────────────────────────────────────────────────────────────
  const shutdown = async () => {
    logger.info("[supervisor] shutdown initiated");
    if (redisProbe) { redisProbe.stop(); redisProbe = null; }
    const drainResult = beginDrain(state, 0, clock());
    if (drainResult.ok) state = drainResult.value;
    if (server) { server.stop(); server = null; }
    if (deps.onShutdown) {
      try { await deps.onShutdown(); }
      catch (e) { logger.error("[supervisor] infrastructure cleanup failed", { error: e instanceof Error ? e.message : String(e) }); }
    }
    const stoppedResult = drainComplete(state);
    if (stoppedResult.ok) state = stoppedResult.value;
    logger.info("[supervisor] stopped");
  };

  return ok({
    getState: () => state,
    handle,
    shutdown,
    get server() { return server; },
  });
};
