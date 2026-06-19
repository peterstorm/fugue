/**
 * Supervisor routing — the PURE core that decides where an inbound, already-
 * authenticated + already-tenant-resolved request goes (FR-004, US3).
 *
 * STRICTLY NO I/O. No Redis, no clock, no fs, no socket. Every input — the
 * resolved `Tenant`, the worker-presence view, the new-run admission decision —
 * is passed in; the output is a total, fail-closed `RouteDecision` ADT. That
 * keeps the boundary's "which worker, or which refusal" call trivially unit- and
 * property-testable, and keeps the imperative shell (`supervisor.ts`) free of
 * any branching logic that could drift between the tested core and the wire.
 *
 * SECURITY (FR-004, FR-008, FR-040/041 — no cross-tenant leakage):
 *   - A `route` decision ALWAYS targets the socket of the resolved tenant's OWN
 *     worker (`workerSocketPath(udsDir, tenant.id)`), computed from the branded,
 *     `:`/glob-free `TenantId` so the path can never escape `udsDir` into another
 *     tenant's socket (FR-004 — never route to a worker that does not own the
 *     tenant). There is NO code path that targets a different tenant's socket.
 *   - This core holds NO shared cross-tenant state (FR-008): it is a pure
 *     function of its arguments. The only tenant data it touches is the SINGLE
 *     resolved `Tenant` handed to it for THIS request.
 *   - Every refusal is one of the established host errors (`tenant-unknown` 404,
 *     `worker-unavailable` 503, `tenant-over-quota` 429), each of which is
 *     non-leaking by construction (see `host-error.ts`): `tenant-unknown` names
 *     no tenant, and the quota/worker errors name only the caller's OWN tenant.
 */

import { match } from "ts-pattern";
import type { Tenant } from "../domain/tenant.js";
import type { HostError } from "../domain/host-error.js";
import { workerUnavailable, tenantOverQuota } from "../domain/host-error.js";
import { workerSocketPath } from "../domain/config.js";

// ── Worker presence (injected, read-only) ────────────────────────────────────

/**
 * Whether the resolved tenant's worker is live and ready to receive a proxied
 * request. This is a VIEW the supervisor computes from the worker-lifecycle port
 * (T8); routing consumes it as plain data so the decision stays pure.
 *
 *   - `live`     — a worker for this tenant is up; route to its socket.
 *   - `unavailable` — the worker is crashed / draining / could-not-be-ensured.
 *     Fail closed to 503 for THIS tenant only (FR-041, AD-8).
 */
export type WorkerPresence =
  | { readonly kind: "live"; readonly socketPath: string }
  | { readonly kind: "unavailable" };

// ── New-run admission (injected, read-only) ──────────────────────────────────

/**
 * The outcome of the supervisor's NEW-run admission gate for this tenant
 * (registry `resolveForNewRun` + per-tenant ceiling). Passed in as data so the
 * pure router can fold it into the decision without performing the gate itself.
 *
 *   - `admitted`  — the tenant is active and under its admission ceiling.
 *   - `unknown`   — `resolveForNewRun` failed closed (unknown/deregistered
 *     tenant, OR Redis degraded — FR-022). Rendered as `tenant-unknown` (404)
 *     so a degraded-registry refusal is indistinguishable from an unknown
 *     tenant and leaks nothing about other tenants (FR-040).
 *   - `over-quota` — the tenant exceeded its OWN ceiling (SC-012). Carries the
 *     per-tenant backoff for the 429 Retry-After.
 *   - `unavailable` — admission could not be decided because the registry is
 *     fail-closed in a way that maps to a tenant-scoped 503. RESERVED, and it
 *     must STAY reserved for the degraded-registry case: INVARIANT (FR-040) — a
 *     DEGRADED registry (`resolveForNewRun` failing closed on a Redis outage)
 *     MUST map to `unknown` (404, non-leaking), NEVER `unavailable` (503). A 503
 *     would confirm the tenant EXISTS (only its worker is down), letting a caller
 *     probe other tenants' existence during an outage. A future implementer wiring
 *     a real producer of this arm must preserve that: emit `unavailable` only for
 *     a worker-scoped fault that has ALREADY passed admission, never for a
 *     registry-degraded admission failure.
 */
export type AdmissionDecision =
  | { readonly kind: "admitted" }
  | { readonly kind: "unknown" }
  | { readonly kind: "over-quota"; readonly retryAfterSeconds: number }
  | { readonly kind: "unavailable" };

// ── Route decision ADT ───────────────────────────────────────────────────────

/**
 * The total, fail-closed routing outcome. Either route to a concrete worker
 * socket, or refuse with a specific host error. There is deliberately no
 * "route to a fallback / default / other tenant" arm — a request that cannot be
 * positively routed to its OWN tenant's worker is refused, never re-homed.
 */
export type RouteDecision =
  | { readonly kind: "route"; readonly tenant: Tenant; readonly socketPath: string }
  | { readonly kind: "refuse"; readonly error: HostError };

// ── Pure routing ─────────────────────────────────────────────────────────────

/**
 * Decide where a request for the resolved `tenant` goes (FR-004, FR-008).
 *
 * PURE + TOTAL + FAIL-CLOSED. The order is admission FIRST, then worker
 * presence:
 *   1. Admission `unknown`     → refuse `tenant-unknown` (404, non-leaking).
 *   2. Admission `over-quota`  → refuse `tenant-over-quota` (429 + Retry-After).
 *   3. Admission `unavailable` → refuse `worker-unavailable` (503, this tenant).
 *   4. Admitted, but worker not live → refuse `worker-unavailable` (503).
 *   5. Admitted AND worker live → route to THIS tenant's socket.
 *
 * The socket path on a `route` is taken from the live worker presence, which the
 * supervisor derives via `workerSocketForTenant` (below) so the target is always
 * the resolved tenant's own `workerSocketPath` — never another tenant's.
 */
export const routeRequest = (
  tenant: Tenant,
  admission: AdmissionDecision,
  presence: WorkerPresence,
): RouteDecision =>
  match(admission)
    .with({ kind: "unknown" }, (): RouteDecision => ({
      kind: "refuse",
      // tenant-unknown carries NO id — a degraded/unknown refusal cannot be
      // distinguished from "not your tenant", so no other tenant is probeable.
      error: { kind: "tenant-unknown" },
    }))
    .with({ kind: "over-quota" }, (a): RouteDecision => ({
      kind: "refuse",
      error: tenantOverQuota(tenant.id, a.retryAfterSeconds),
    }))
    .with({ kind: "unavailable" }, (): RouteDecision => ({
      kind: "refuse",
      // RESERVED arm (see `AdmissionDecision.unavailable`): only ever a
      // worker-scoped 503 for a tenant that PASSED admission — never a degraded-
      // registry refusal, which must stay `unknown`/404 per FR-040.
      error: workerUnavailable(tenant.id),
    }))
    .with({ kind: "admitted" }, (): RouteDecision =>
      match(presence)
        .with({ kind: "live" }, (p): RouteDecision => ({
          kind: "route",
          tenant,
          socketPath: p.socketPath,
        }))
        .with({ kind: "unavailable" }, (): RouteDecision => ({
          kind: "refuse",
          error: workerUnavailable(tenant.id),
        }))
        .exhaustive(),
    )
    .exhaustive();

/**
 * The canonical owning-worker socket for a resolved tenant (FR-004). A thin,
 * pure wrapper over `workerSocketPath` that takes the BRANDED `Tenant` (so the
 * id is guaranteed `:`/glob-free and the path cannot escape `udsDir`). The
 * supervisor uses this to build the `live` `WorkerPresence` it feeds back into
 * `routeRequest`, guaranteeing a routed request can only ever target the
 * resolved tenant's own socket — never a path derived from caller input.
 */
export const workerSocketForTenant = (udsDir: string, tenant: Tenant): string =>
  workerSocketPath(udsDir, tenant.id);
