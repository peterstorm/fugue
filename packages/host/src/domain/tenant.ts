/**
 * Tenant domain — the first-class, hard-branded security principal the
 * supervisor resolves an authenticated identity to at the request boundary,
 * BEFORE any tenant work is dispatched (FR-002).
 *
 * `Tenant` EXTENDS the existing identity→team auth model (`domain/auth.ts`),
 * it does NOT replace it: an `AuthIdentity` (admin / team / user) is still the
 * thing that arrives at the boundary; `resolveTenant` maps that identity to the
 * registered `Tenant` it owns. Authorization (`canAccessDag`) continues to run,
 * now additionally scoped to the resolved tenant's principal (see
 * `canAccessDagForTenant` in `auth.ts`) so an authz decision is ALWAYS made
 * against the caller's own tenant, never another tenant's data (FR-003, US3).
 *
 * All functions here are PURE — no I/O, no Redis, no clock. The registry is
 * passed in as an injected, read-only VIEW (`TenantRegistryView`) whose entries
 * are already-branded `Tenant` principals; resolution is a deterministic
 * lookup, so it is trivially unit-testable and fail-closed by construction.
 *
 * SECURITY — non-leakage (FR-040, FR-041, SC-012, US3):
 *   - An identity that maps to NO registered tenant resolves to a single
 *     `tenant-unknown` error. That error is INTENTIONALLY uniform: it carries
 *     no tenant id, no "did you mean", no count of tenants, nothing that
 *     distinguishes "this tenant does not exist" from "you are not authorized
 *     for it". The supervisor renders it as 404/401 so the existence or state
 *     of OTHER tenants can never be probed by a caller (FR-040).
 *   - `Tenant` is branded with a `unique symbol` (the established `RunId` /
 *     `SubjectToken` pattern), so "this object is a REGISTERED tenant principal"
 *     is unforgeable: a plain object cannot be passed where a routed `Tenant`
 *     principal is required. The SOLE producer is `markTenant`, and the trust
 *     seam where principals are MINTED is registry CONSTRUCTION — the T3 registry
 *     adapter (and the test fakes that stand in for it today) call `markTenant`
 *     once per registered tenant when they build the `TenantRegistryView`.
 *     `resolveTenant` does NOT mint principals: it is a pure boundary LOOKUP that
 *     hands back an already-branded `Tenant` from that view (or fails closed).
 *     `markTenant` re-asserts the `TenantId` shape on every call, so even a
 *     registry adapter that bypassed the `tenantId` smart constructor with a cast
 *     cannot mint a principal whose id could widen its own `fugue:<tenant>:*`
 *     key/ACL namespace.
 */

import { match } from "ts-pattern";
import type { AuthIdentity } from "./auth.js";
import type { HostError } from "./host-error.js";
import { tenantUnknown, internalInvariantViolated } from "./host-error.js";
import type { Result } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";

// ── Branded types ───────────────────────────────────────────────────────────

declare const __tenantIdBrand: unique symbol;
declare const __tenantBrand: unique symbol;
declare const __secretsRefBrand: unique symbol;

/**
 * A registered tenant's stable identifier. Hard-branded (a `unique symbol`,
 * like `RunId`/`DagId`): a plain `string` does NOT inhabit it, so an arbitrary
 * caller-supplied string can never be routed as a tenant id. Its sole producer
 * is `tenantId`, which validates the SHAPE (see `TENANT_ID_REGEX`); the brand
 * additionally encodes "passed shape validation at a parse boundary".
 *
 * The shape is deliberately Redis-key-safe: a `TenantId` becomes the
 * `fugue:<tenant>:*` key prefix and the `~fugue:<tenant>:*` Redis-ACL pattern
 * (AD-4), so it MUST NOT contain `:` (the key delimiter) or any glob
 * metacharacter — otherwise one tenant's id could be crafted to widen its own
 * ACL pattern over another tenant's keyspace.
 */
export type TenantId = string & { readonly [__tenantIdBrand]: void };

/**
 * The registered tenant security principal. Hard-branded so it cannot be
 * constructed by widening a plain object — only `markTenant` produces it, and
 * `markTenant` is called at registry CONSTRUCTION (the T3 registry adapter, and
 * test fakes today), once per registered tenant. That makes "this object is a
 * tenant that was admitted to the registry under a shape-validated id" an
 * unforgeable, single-producer guarantee (FR-002, FR-003). `resolveTenant`
 * consumes these principals; it never mints them.
 *
 * `team` is the tenant's owning team — the same team string the existing
 * identity→team auth and `canAccessDag` already key on. Threading it on the
 * principal lets authz be scoped to THIS tenant's team without a second
 * registry lookup at the authz site.
 */
export type Tenant = {
  readonly id: TenantId;
  readonly team: string;
} & { readonly [__tenantBrand]: void };

/**
 * An OPAQUE reference to a tenant's secrets — NOT the secrets themselves
 * (AD-6, FR-005/FR-006, SC-002). The supervisor holds only this reference and
 * lacks the authority (token / fs read perm) to dereference it; the WORKER is
 * the only process that resolves it (via the `SecretsSource` port, a later
 * task). Branded so a `SecretsRef` can never be mistaken for — or coerced from
 * — a resolved secret value: the type system keeps "reference" and "secret"
 * disjoint, which is the structural half of FR-005's "supervisor never holds a
 * secret" guarantee.
 */
export type SecretsRef = string & { readonly [__secretsRefBrand]: void };

// ── Registry view (injected, read-only) ─────────────────────────────────────

/**
 * The minimal, READ-ONLY projection of the tenant registry that resolution
 * needs. The full registry ADT (register/deregister/reconfigure, Redis
 * adapter, pub/sub) lands in a later task (T3); `resolveTenant` depends only on
 * this narrow view so it stays a pure lookup and so the registry implementation
 * can evolve without touching the boundary parse.
 *
 * `tenantForTeam(team)` returns the registered principal for that owning team,
 * or `undefined` for an unknown team — first-class ABSENCE, never a thrown error
 * or a fabricated principal (fail-closed). The principals it returns were minted
 * by `markTenant` at registry construction.
 *
 * SECURITY CONTRACT for implementations (T3 adapter + test fakes):
 *   - `tenantForTeam` MUST resolve against OWN properties only. If the registry
 *     is backed by a plain object keyed on team, it MUST guard every lookup with
 *     `Object.prototype.hasOwnProperty.call(...)` (mirroring `agentClientIdForDag`
 *     in `auth.ts`), so an inherited / prototype key — `__proto__`, `toString`,
 *     `constructor`, … — can NEVER resolve to a tenant. A team string is
 *     caller-influenced (it rides in on the auth identity); without this guard a
 *     crafted team like `toString` would map to a function-valued "tenant" and
 *     fail OPEN. Fail-closed (return `undefined`) on any non-own key.
 *   - Every returned `Tenant` MUST have been produced by `markTenant` (so its id
 *     is shape-validated and the brand is genuine); the view never fabricates or
 *     widens a principal.
 */
export interface TenantRegistryView {
  /** Resolve an identity's owning team to its registered tenant, if any. */
  readonly tenantForTeam: (team: string) => Tenant | undefined;
}

// ── Smart constructors ──────────────────────────────────────────────────────

/**
 * Shape of a tenant id. Stricter than the general framework id regex: NO `:`
 * (Redis key delimiter) and NO glob metacharacters (`*`, `?`, `[`, `]`), so a
 * `TenantId` is always safe to interpolate into both a `fugue:<tenant>:*` key
 * and a `~fugue:<tenant>:*` Redis-ACL pattern without escaping. Lowercasing is
 * NOT enforced here (registration owns canonicalization); the regex only
 * guarantees the value can never widen a key/ACL namespace.
 */
export const TENANT_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Parse-don't-validate constructor for `TenantId`. Returns a `Result` rather
 * than throwing, since tenant ids arrive from config/registration data at a
 * parse boundary. A value with a `:` or glob metacharacter is REJECTED — that
 * is the invariant the `~fugue:<tenant>:*` ACL scoping (AD-4, SC-001) relies
 * on, so it is enforced in types here, not assumed downstream.
 */
export const tenantId = (s: string): Result<TenantId, HostError> =>
  TENANT_ID_REGEX.test(s)
    ? ok(s as TenantId)
    : err({
        kind: "config-invalid",
        message: `invalid tenant id "${s}": must match ${TENANT_ID_REGEX.source} (no ':' or glob metacharacters — required for Redis key/ACL scoping)`,
      });

/**
 * @internal Brand a tenant principal. The single PRODUCER of `Tenant`, called at
 * registry construction — the T3 registry adapter (and the test fakes that stand
 * in for it today) invoke it once per registered tenant while building the
 * `TenantRegistryView`. `resolveTenant` does NOT call it; it only LOOKS UP
 * already-branded principals. Calling it on an arbitrary pair is a deliberate
 * forgery of the brand — visible in review, never accidental (mirrors
 * `markSignatureVerified` / `markSubjectToken`).
 *
 * INVARIANT (enforced, not just documented): re-asserts `TENANT_ID_REGEX` on the
 * id. A branded `TenantId` is supposed to have passed `tenantId`'s shape check,
 * so a value reaching here that FAILS the regex means a producer bypassed the
 * smart constructor with a cast — an INTERNAL invariant violation, not a user
 * error. We THROW (not `Result`) because, like every other post-brand violation
 * in the host (e.g. `host.ts` / `graph-capability.ts`), it is unrecoverable
 * programmer error, not a parse outcome. This closes the fail-open gate for the
 * T3 registry: a malformed id can never become a branded principal that would
 * widen its own `fugue:<tenant>:*` key / `~fugue:<tenant>:*` ACL namespace.
 */
export const markTenant = (id: TenantId, team: string): Tenant => {
  if (!TENANT_ID_REGEX.test(id)) {
    // Thrown HostError — the error-handler middleware unwraps `internal-
    // invariant-violated` to a generic 500 and logs detail server-side; the
    // raw (forged) id is kept in `context` for the server log, never the client.
    throw internalInvariantViolated(
      `markTenant called with a TenantId that violates TENANT_ID_REGEX — a producer bypassed the tenantId() smart constructor with a cast`,
      { id, team },
    );
  }
  return { id, team } as Tenant;
};

/**
 * @internal Brand an opaque secrets reference. Producer of `SecretsRef` — the
 * registry adapter (T3) calls it when reading a tenant config's stored
 * reference. Branding a plain string here does NOT grant the holder the
 * authority to dereference it; that authority lives in the worker's
 * `SecretsSource` (AD-6). Kept as a single named seam so every place a raw
 * reference becomes a `SecretsRef` is greppable.
 */
export const markSecretsRef = (ref: string): SecretsRef => ref as SecretsRef;

// ── Resolution (pure boundary parse) ────────────────────────────────────────

/**
 * The owning team an inbound identity claims, for the purpose of tenant
 * resolution.
 *
 * - `admin` — the root-of-trust ADMIN_TOKEN. It is NOT bound to a single
 *   tenant: an admin identity is a SUPERVISOR/platform principal, not a routed
 *   tenant, so it has no owning team to resolve and `resolveTenant` returns
 *   `tenant-unknown` (an admin acts through the admin lifecycle API, not the
 *   tenant data plane — keeping the data-plane parse fail-closed for a non-
 *   tenant principal rather than silently routing root to some tenant).
 * - `team` — the team token's team IS the tenant's owning team.
 * - `user` — a fugue-platform OIDC user is not itself a single tenant's
 *   principal at resolution time (a user may belong to several teams); the user
 *   data plane resolves the tenant from the run's target, not from the identity
 *   alone, so it is out of scope for the identity→tenant boundary parse and
 *   resolves to `tenant-unknown` here (fail-closed; never cross-tenant).
 */
const owningTeamForIdentity = (identity: AuthIdentity): string | undefined =>
  match(identity)
    .with({ kind: "admin" }, () => undefined)
    .with({ kind: "team" }, (t) => t.team)
    .with({ kind: "user" }, () => undefined)
    .exhaustive();

/**
 * Resolve an authenticated `AuthIdentity` to its registered `Tenant` principal
 * at the request boundary (FR-002, FR-003, US3) — the seam where an authenticated
 * identity is routed to the tenant it owns.
 *
 * PURE LOOKUP: maps the identity to its owning team, then returns the
 * already-branded `Tenant` the injected registry view holds for that team. It
 * does NOT mint principals (that happened at registry construction, via
 * `markTenant`) and does no I/O.
 *
 * FAIL-CLOSED + NON-LEAKING (FR-040, FR-041, SC-012):
 *   - An identity with no owning team (admin / user — see
 *     `owningTeamForIdentity`), or whose team maps to no registered tenant,
 *     resolves to a SINGLE uniform `tenant-unknown` error. The error is
 *     deliberately identical in both cases and carries no tenant id, so a
 *     caller cannot distinguish "no such tenant" from "not your tenant" and so
 *     cannot probe the existence or state of any other tenant (FR-040).
 *   - On success the returned principal is the unforgeable `Tenant` the registry
 *     branded for THIS caller's team — never another tenant's (US3). The
 *     registry view's own-property contract (above) guarantees a crafted team
 *     string cannot resolve via a prototype key.
 */
export const resolveTenant = (
  identity: AuthIdentity,
  registry: TenantRegistryView,
): Result<Tenant, HostError> => {
  const team = owningTeamForIdentity(identity);
  if (team === undefined) {
    return err(tenantUnknown());
  }
  const tenant = registry.tenantForTeam(team);
  if (tenant === undefined) {
    return err(tenantUnknown());
  }
  return ok(tenant);
};
