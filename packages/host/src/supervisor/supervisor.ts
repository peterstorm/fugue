/**
 * Supervisor core — the single inbound HTTP listener for the multi-tenant host
 * (FR-001). It is THIN: per request it authenticates the inbound identity →
 * resolves the `Tenant` at the boundary → admits the tenant for a NEW run →
 * routes (pure) → reverse-proxies over the owning worker's UDS with a SIGNED
 * `X-Fugue-Tenant` header. It performs NO DAG execution and holds NO tenant
 * secrets (FR-005).
 *
 * MIRRORS `createHost`: `createSupervisor(deps) => Result<SupervisorInstance,
 * HostError>`, same imperative-shell shape (mutable `let` state, a single
 * `Bun.serve`, a shutdown handle), and it REUSES the existing degraded machine
 * (`host-state.ts`) + Redis liveness probe (`redis-probe.ts`) rather than
 * inventing a parallel one.
 *
 * SECURITY POSTURE:
 *   - ZERO tenant secrets (FR-005). `SupervisorDeps` carries only auth material
 *     (admin token, optional realm-JWT verifier group), the tenant registry
 *     (config + a secrets REFERENCE, never a value), the worker-lifecycle port,
 *     routing config, and the INTERNAL HMAC key. There is structurally no
 *     channel through which a tenant secret could enter the supervisor — the
 *     registry holds `SecretsRef` (branded reference) only, and the worker is the
 *     sole dereferencer (AD-6). `assertNoTenantSecrets` documents/enforces this.
 *   - FAIL-CLOSED at every boundary: unknown identity → 401; unresolved tenant →
 *     404 (`tenant-unknown`, non-leaking); degraded registry → 404 for NEW runs
 *     (FR-022, via `resolveForNewRun`) while in-flight/status keep working
 *     (FR-023, `canServeRequests` NOT widened); worker down → 503 for that tenant.
 *   - No cross-tenant leakage (FR-040/041): the routing core only ever targets
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
import type { AuthIdentity, Team } from "../domain/auth.js";
import { constantTimeEqual, isJwtShape } from "../http/middleware/auth.js";
import type { RealmJwtDeps } from "../http/middleware/auth.js";
import { hashToken, isTeamTokenShape, markSubjectToken } from "../domain/auth.js";
import type { SignatureVerifiedClaims } from "../domain/auth.js";
import type { JwtVerifyError } from "../http/middleware/auth.js";
import { validateRealmJwtClaims } from "../domain/jwt-validation.js";
import type { Tenant, TenantRegistryView } from "../domain/tenant.js";
import { resolveTenant } from "../domain/tenant.js";
import type { TenantId } from "../domain/tenant.js";
import type { RedisConnectivityPort, TokenStorePort, LogPort } from "../ports.js";
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
export type { WorkerLifecyclePort } from "./lifecycle/spawn-port.js";
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

// ── New-run admission port (registry seam, FR-022) ───────────────────────────

/**
 * The OUTCOME of admitting a tenant for a NEW run. A successful admission
 * ACQUIRES a per-tenant concurrency slot (FR-032), so the port must hand back a
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
 * `resolveForNewRun` (which fails closed while Redis is degraded — FR-022) plus
 * the per-tenant ceiling check (FR-032 via `admitTenant`). Kept as a port so the
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

// ── Inbound identity authentication (framework-agnostic) ─────────────────────

/**
 * Authenticate an inbound bearer token to an `AuthIdentity`, REUSING the exact
 * primitives the Hono `auth.ts` middleware uses (constant-time admin compare,
 * JWT-shape pre-filter + injected verifier + claim validation, hashed team-token
 * lookup) — but without a Hono context, because the supervisor's listener is a
 * raw `Bun.serve` fetch handler. Same resolution ORDER and same fail-closed
 * semantics as the middleware:
 *   1. admin token (constant-time) → admin
 *   2. JWT-shaped + verifier configured → verify signature + validate claims → user
 *   3. team token (`fug_`) → hash → store lookup → team
 *   4. otherwise → unauthorized
 *
 * Returns `Result<AuthIdentity, HostError>` so the listener maps the error to a
 * status uniformly. An auth-infrastructure failure (JWKS/store outage) surfaces
 * as `redis-unavailable` (503) — the closest existing 503 host error — mirroring
 * the middleware's "auth-service-unavailable" branch, never a 401 that would
 * imply a bad credential.
 */
export interface AuthDeps {
  readonly adminToken: string;
  readonly tokenStore: TokenStorePort;
  readonly realmJwt?: RealmJwtDeps;
  readonly logger?: LogPort;
  /** UNIX-seconds clock for `exp` checks (testability); defaults to wall clock. */
  readonly now?: () => number;
}

export const authenticateIdentity = async (
  deps: AuthDeps,
  authHeader: string | undefined,
): Promise<Result<AuthIdentity, HostError>> => {
  if (authHeader === undefined || !authHeader.startsWith("Bearer ")) {
    return err({ kind: "unauthorized", reason: "missing or malformed Authorization header" });
  }
  const token = authHeader.slice(7);
  if (token.length === 0) {
    return err({ kind: "unauthorized", reason: "empty bearer token" });
  }

  // Path 1: admin token (constant-time, no I/O).
  if (constantTimeEqual(token, deps.adminToken)) {
    return ok({ kind: "admin" });
  }

  // Path 2: fugue-platform OIDC JWT. Only when a verifier is wired AND the token
  // is JWT-shaped and NOT `fug_`-shaped. FAIL CLOSED — never falls through to the
  // team path on a verification/claim failure.
  if (deps.realmJwt && !isTeamTokenShape(token) && isJwtShape(token)) {
    const realmJwt = deps.realmJwt;
    let verified: Result<SignatureVerifiedClaims, JwtVerifyError>;
    try {
      verified = await realmJwt.verify(token);
    } catch (e) {
      deps.logger?.error("[supervisor] JWT verifier threw unexpectedly", {
        error: e instanceof Error ? e.message : String(e),
      });
      return err({ kind: "redis-unavailable", operation: "jwt-verify" });
    }
    if (!verified.ok) {
      if (verified.error.kind === "unavailable") {
        deps.logger?.error("[supervisor] JWT signature verification unavailable", { reason: verified.error.reason });
        return err({ kind: "redis-unavailable", operation: "jwt-verify" });
      }
      deps.logger?.warn("[supervisor] JWT signature verification rejected token", { reason: verified.error.reason });
      return err({ kind: "unauthorized", reason: "invalid token" });
    }
    const nowSeconds = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
    const claimsResult = validateRealmJwtClaims(verified.value, {
      expectedIss: realmJwt.expectedIss,
      expectedAud: realmJwt.expectedAud,
      now: nowSeconds,
    });
    if (!claimsResult.ok) {
      deps.logger?.warn("[supervisor] JWT claim validation failed");
      return err({ kind: "unauthorized", reason: "invalid token" });
    }
    const user = claimsResult.value;
    const subjectToken = markSubjectToken(token);
    return ok({
      kind: "user",
      sub: user.sub,
      azp: user.azp,
      canRunDag: (dagTeam: Team) => realmJwt.authorizeUserRun(user, dagTeam),
      subjectToken,
    });
  }

  // Path 3: team token — hash and look up.
  try {
    const hash = await hashToken(token);
    const resolveResult = await deps.tokenStore.resolve(hash);
    if (!resolveResult.ok) {
      deps.logger?.error("[supervisor] Token store unavailable", { errorKind: resolveResult.error.kind });
      return err({ kind: "redis-unavailable", operation: "token-resolve" });
    }
    const grant = resolveResult.value;
    if (!grant) {
      return err({ kind: "unauthorized", reason: "invalid token" });
    }
    return ok({ kind: "team", team: grant.team, label: grant.label });
  } catch (e) {
    deps.logger?.error("[supervisor] Token resolution failed unexpectedly", {
      error: e instanceof Error ? e.message : String(e),
    });
    return err({ kind: "redis-unavailable", operation: "token-resolve" });
  }
};

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
   * Admin tenant lifecycle API deps (FR-025). When wired, the single listener
   * DISPATCHES `/admin/tenants(/:id)` requests to `handleAdminTenants` BEFORE
   * tenant-resolution/proxy — so the admin API is reachable at runtime and an
   * admin request is never resolved as a tenant or proxied. Optional so tests
   * that exercise only the proxy path need not construct the admin handler.
   */
  readonly adminTenants?: AdminTenantsDeps;
  /** HTTP-over-UDS transport — Bun in prod, fake in tests. Defaults to Bun's. */
  readonly transport?: UdsTransport;
  /**
   * FR-022: invoked on every Redis liveness-probe edge (`dead=true` on DOWN,
   * `dead=false` on RECOVERED) so the binary can drive the registry's NEW-run
   * admission gate (`registry.markRedisDegraded`). The supervisor's data path is
   * read-only, so without this the registry's `degraded` flag would only flip on
   * a registry WRITE — and NEW runs would be admitted on stale config while Redis
   * is down. Wired here so new-run admission fails closed (503) the moment the
   * probe sees Redis die, and recovers when it sees Redis return. In-flight/status
   * (`lookup`) and `canServeRequests` are intentionally unaffected (FR-023).
   */
  readonly onRedisProbeEdge?: (dead: boolean) => void;
  readonly logger: LogPort;
  /** Called during graceful shutdown to clean up infrastructure (e.g., Redis). */
  readonly onShutdown?: () => Promise<void>;
}

export interface SupervisorInstance {
  readonly getState: () => HostState;
  /** Handle a single inbound request (exposed for tests; also the serve fetch). */
  readonly handle: (request: Request) => Promise<Response>;
  readonly shutdown: () => Promise<void>;
  readonly server: { port: number; stop: () => void } | null;
}

// ── FR-005 zero-secrets guard ────────────────────────────────────────────────

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
  // Intentionally empty: FR-005 is enforced by the SHAPE of SupervisorDeps
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
  // FR-005: structurally assert no tenant-secret channel exists.
  assertNoTenantSecrets(deps);

  const transport: UdsTransport = deps.transport ?? bunUdsTransport;

  // ── Mutable state (imperative shell) ───────────────────────────────────────
  // The supervisor has no DAG registry of its own (it routes, it does not
  // execute), so it seeds the degraded machine with the empty registry purely to
  // reuse the existing `HostState` transitions (booting → ready → degraded). It
  // never reads DAGs out of it.
  let state: HostState = booting(Date.now());
  let redisProbe: RedisProbeHandle | null = null;
  let server: { port: number; stop: () => void } | null = null;

  // Boot → ready. The empty registry + a fixed boot sha satisfy the transition's
  // signature without implying the supervisor loads DAGs.
  const BOOT_SHA = gitSha("supervisor");
  const readyResult = bootComplete(state, emptyRegistry(), BOOT_SHA, Date.now());
  if (!readyResult.ok) {
    return err({ kind: "internal-invariant-violated", message: "supervisor boot → ready transition failed", context: { from: readyResult.error.from, to: readyResult.error.to } });
  }
  state = readyResult.value;

  // ── Request handler ────────────────────────────────────────────────────────
  const handle = async (request: Request): Promise<Response> => {
    // 0. ADMIN TENANT LIFECYCLE API (FR-025). Dispatch `/admin/tenants(/:id)` to
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

    // 2. Resolve the Tenant at the boundary (FR-002). Fail-closed + non-leaking:
    //    an identity that maps to no registered tenant → tenant-unknown (404).
    const tenantResult = resolveTenant(identity, deps.registryView);
    if (!tenantResult.ok) {
      return errorToResponse(tenantResult.error);
    }
    const tenant: Tenant = tenantResult.value;

    // 3. NEW-run admission gate (FR-022). Uses the registry's resolveForNewRun
    //    seam, which fails closed (→ tenant-unknown) while Redis is degraded —
    //    new runs refuse, but in-flight/status keep working (FR-023). Note we do
    //    NOT consult canServeRequests here to BLOCK: it stays true while degraded
    //    by design so cached/in-flight work is unaffected; only NEW-run admission
    //    fails closed, exactly as the registry seam dictates.
    //    ACQUIRE-ON-ADMIT: a successful admit claims a per-tenant slot (FR-032)
    //    and hands back `release`, which we MUST call exactly once after the
    //    proxy completes (a `finally` below, so it runs even if proxyToWorker
    //    throws). A refused admit returns a no-op release — nothing acquired,
    //    nothing freed — so we can call `release` unconditionally in the finally.
    const admission: AdmissionOutcome = deps.admission.admit(tenant);

    // 4. Ensure the owning worker is live (T8 seam) and derive its presence.
    //    The socket on a live presence is ALWAYS the resolved tenant's own
    //    socket (FR-004) — re-derived here defensively so a lifecycle that
    //    returned a mismatched socket cannot cause cross-tenant routing.
    let presence: WorkerPresence;
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
        logger.error("[supervisor] lifecycle returned a non-owning socket — refusing (FR-004)", {
          tenant: tenant.id,
        });
        presence = { kind: "unavailable" };
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

  // ── HTTP server (single listener — FR-001) ─────────────────────────────────
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
        // FR-022: drive the registry's NEW-run admission gate closed FIRST, on
        // every dead tick (idempotent), so a new run is refused the moment the
        // probe sees Redis down — even before/without any registry write.
        deps.onRedisProbeEdge?.(true);
        const r = redisDied(state, Date.now());
        if (r.ok) {
          state = r.value;
          logger.warn("[supervisor] Redis probe failed — degraded (redis-disconnected)");
        } else if (state.phase !== "degraded") {
          logger.warn("[supervisor] redisDied transition unexpectedly rejected", { currentPhase: state.phase });
        }
      },
      onAlive: () => {
        // FR-022: re-open the NEW-run gate on recovery (idempotent every tick).
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
    const drainResult = beginDrain(state, 0, Date.now());
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

// Re-export so the binary's wiring can reference the canServeRequests contract
// without reaching back into host-state.ts (and to document that NEW-run
// admission fail-closure lives in the registry seam, NOT in canServeRequests).
export { canServeRequests };
