# ADR-0073: Tenant as a first-class branded principal, with an extended per-tenant error taxonomy

> **Consolidated reference:** the live, end-to-end multi-tenant supervisor picture this decision feeds into is being assembled under `.claude/specs/2026-06-18-multi-tenant-single-host/` (spec) and the matching plan. This ADR remains the immutable "why" for two coupled choices: how a tenant is *modelled* as a principal, and how the host's error taxonomy is *extended* to keep one tenant's failure from ever surfacing as another's.

## Status

Accepted

> **Amendment (2026-06-20, pass 9):** the `canAccessDagForTenant` authorization
> *extension* described below was designed but is **NOT wired** in the shipped
> single-host slice — it had zero production callers and has been removed. Tenant
> isolation for DAG execution is enforced **structurally** instead: the supervisor
> routes each caller to its OWN tenant's worker, and a worker serves exactly one
> tenant's DAGs, so a cross-tenant DAG is unreachable by construction; the
> per-request `canAccessDag` (identity→team) remains the operative DAG gate. The
> **error-taxonomy** half of this ADR (`tenant-unknown` / `tenant-over-quota` /
> `worker-unavailable`, their HTTP statuses, no-breaker-trip, and non-leaking
> bodies) ships and is used exactly as written. The branded `Tenant` principal
> itself is still load-bearing — for routing, the `fugue:<tenant>:*` keyspace, and
> the per-tenant Redis ACL (ADR-0067). Reintroduce a tenant-scoped conjunct if a
> future shared-worker / multi-DAG-per-worker topology needs per-request tenant
> scoping. References to `canAccessDagForTenant` below are retained as the original
> design rationale; read them subject to this amendment.

## Date

2026-06-19

## Context

The multi-tenant supervisor (US3) authenticates one inbound identity at a single
HTTP listener and must route it to *its own* tenant's worker before any tenant
work is dispatched (FR-002). The tenant is a first-class branded principal
threaded through routing and authz (FR-003). The thing being routed — the tenant
— is the load-bearing security boundary of the whole system: every key namespace
(`fugue:<tenant>:*`), every Redis ACL pattern (`~fugue:<tenant>:*`, ADR-0067),
the per-tenant worker socket, and every `canAccessDag` decision keys on it. If a
caller-influenced string can masquerade as "a tenant the supervisor resolved at
the boundary," the entire isolation story collapses into a stringly-typed
argument that any code path can fabricate, swap, or widen. The existing
identity→team auth (`AuthIdentity`, `canAccessDag`; ADR-0058) already arrives at
the boundary and must *keep* running — the tenant boundary has to **extend** it,
not replace it, so an authz "no" is still a "no" and a routed tenant is an
*additional*, narrower scope on top.

The second force is the failure surface. Once requests are interleaved across
tenants on one listener, the taxonomy of *how a request can fail* becomes a
cross-tenant information channel and a shared-fate hazard (FR-040, FR-041,
SC-012):

- An **unknown / unauthorized** caller must get a response (404/401) that does
  not reveal whether some *other* tenant exists or what state it is in — "no such
  tenant" and "not your tenant" must be indistinguishable.
- A tenant **over its own quota** must get 429 + retry-after scoped to itself,
  and that saturation must never consume or surface against another tenant.
- A tenant whose **worker is unavailable** must get 503 contained to that
  tenant, never bleeding into a neighbour's request path.

Two further hazards ride on the failure surface. First, these tenant-boundary
outcomes are *settled, correct host behaviour* (a quota refusal, an unknown-tenant
rejection) — if they were classified as host malfunctions they would trip the
per-tenant/per-DAG circuit breaker, so a burst of unknown-tenant probes or one
tenant hammering its own quota could OPEN a breaker, an availability self-inflicted
wound and a cross-tenant blast radius (the same regression class ADR-0036/ADR-0059
guard against for execution errors). Second, the *response body* itself must not
name a foreign tenant. The question this ADR settles: **how is a tenant
represented in the type system, and how is the host's error taxonomy extended so
these per-tenant outcomes map to precise statuses, are correctly excluded from
breaker counting, and carry non-leaking bodies?**

## Options Considered

### Tenant representation

1. **`Tenant` / `TenantId` / `SecretsRef` as hard-branded principals with smart constructors and a strict id regex (chosen).**
   - Pros: "this object is a tenant the registry admitted under a shape-validated
     id" becomes *unforgeable* — a `unique symbol` brand (the established
     `RunId` / `SubjectToken` pattern in `auth.ts`) means a plain object or bare
     string does not inhabit `Tenant`, so it cannot be passed where a routed
     principal is required. The sole producer (`markTenant`) is a single,
     greppable seam; resolution (`resolveTenant`) is a pure lookup that *consumes*
     branded principals and never mints them. `TENANT_ID_REGEX` forbids `:` and
     glob metacharacters at the parse boundary, so a `TenantId` is always safe to
     interpolate into both the `fugue:<tenant>:*` key prefix and the
     `~fugue:<tenant>:*` Redis-ACL pattern (ADR-0067) without escaping — a crafted
     id can never widen its own keyspace/ACL over a neighbour's. `SecretsRef` is a
     disjoint brand so a secrets *reference* can never be coerced from or mistaken
     for a resolved secret value (the structural half of "supervisor never holds a
     secret"). Argument-swap and id-widening bugs become *compile errors*.
   - Cons: hand-rolled brands and a smart constructor to keep correct (versus a
     library); a second invariant re-assertion of the regex inside `markTenant`
     that exists only to catch a producer that bypassed the smart constructor with
     a cast.

2. **`Tenant` as a plain `string` (or plain object) threaded through routing/authz.**
   - Pros: zero ceremony; no brand, no smart constructor; any string flows freely.
   - Cons: loses parse-don't-validate entirely. *Any* string — including a
     caller-influenced team value — could be passed as a "resolved tenant," so an
     argument-swap (`canAccessDag(dagTeam, callerTeam)`-style transposition) or a
     widening bug (`fugue:*` instead of `fugue:<tenant>:*`) silently typechecks
     and ships. The strongest isolation invariant in the system would rest on
     reviewer vigilance, not the type system. Rejected: the boundary that gates
     every key, ACL, and authz decision is exactly where illegal states must be
     unrepresentable.

### Error taxonomy

3. **Extend the existing `HostError` union with `tenant-unknown` / `tenant-over-quota` / `worker-unavailable`, classified for HTTP + breaker in the existing classifier (chosen).**
   - Pros: the single `httpStatusFor` / `formatHostError` mapping stays the *one*
     authoritative, `.exhaustive()` source of status truth — a new tenant kind
     without a status case is a compile error. The supervisor-boundary
     classification (`classifyHostError`) sits beside `classifyFrameworkError`
     and reuses the same `{status, countsAsCircuitFailure, retryAfterSeconds}`
     contract, so the 403-vs-500-vs-breaker reasoning is one vocabulary. Bodies
     are shaped at this one seam to be non-leaking by construction.
   - Cons: the host union grows three more variants; the tenant-boundary kinds and
     the framework-execution kinds now both feed circuit-breaker decisions through
     parallel (though deliberately mirrored) classifiers.

4. **A separate supervisor error type, disjoint from `HostError`, with its own status mapping.**
   - Pros: keeps tenant-boundary errors out of the existing host union; a smaller,
     focused type.
   - Cons: splits the HTTP status mapping across *two* exhaustive matches that can
     drift — a tenant kind could end up with the wrong status, or worse, fall back
     to a generic 500 that trips the breaker and leaks "host malfunction" for what
     is actually a settled quota refusal. Reusing generic existing variants
     (`unauthorized`, `redis-unavailable`, the coarse `*-concurrency-exceeded`) is
     the same trap from the other direction: wrong status codes, wrong breaker
     behaviour, and messages that were never written to be tenant-non-leaking.
     Rejected: a divergent second mapping is exactly the information-leak and
     breaker-trip surface this ADR exists to close.

Both axes had genuine alternatives; neither is a forced choice. They are
deliberate placement decisions — keep the principal unforgeable in the type
system, and keep status/breaker/leakage decisions in one authoritative taxonomy.

## Decision

**Model `Tenant` (with `TenantId` and `SecretsRef`) as hard-branded principals
with smart constructors and a strict `TENANT_ID_REGEX`, resolve an
`AuthIdentity` to a `Tenant` at the supervisor boundary and thread it through
routing / keyspace / ACL alongside the existing `canAccessDag` auth (a
tenant-aware `canAccessDagForTenant` *extension* was designed but not wired — see
Amendment); and
extend the single `HostError` taxonomy with `tenant-unknown` (404/401),
`tenant-over-quota` (429 + retry-after), and `worker-unavailable` (503),
classified so over-quota/unknown never trip the breaker and all bodies are
non-leaking.**

Concretely:

- **`packages/host/src/domain/tenant.ts`** — `TenantId`, `Tenant`, and
  `SecretsRef` are `unique symbol`-branded. `tenantId(s)` is the
  parse-don't-validate smart constructor returning `Result<TenantId, HostError>`,
  rejecting anything that fails `TENANT_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/` with
  a `kind: "config-invalid"` HostError.
  `markTenant(id, team)` is the *sole* producer of `Tenant`, called once per
  registered tenant at registry construction; `resolveTenant(identity, registry)`
  is a pure boundary lookup that returns an already-branded principal or a uniform
  `tenant-unknown`. `markSecretsRef` mints the opaque reference the supervisor
  holds but cannot dereference.
- **`packages/host/src/domain/auth.ts`** — *(superseded — see Amendment.)* As
  originally designed, `canAccessDagForTenant(tenant, identity, dagTeam)` was the
  extension: it ran the existing `canAccessDag(identity, dagTeam)` AND additionally
  required `tenant.team === dagTeam`. In the shipped slice this conjunct is
  unnecessary — a worker only ever holds its own tenant's DAGs, so `canAccessDag`
  alone is the operative per-request gate — and the primitive was removed to avoid
  dead, ADR-blessed-but-unexercised code. The identity→team decision is unchanged.
- **`packages/host/src/domain/host-error.ts`** — the three variants live in the
  *same* `HostError` union. `httpStatusFor` maps `tenant-unknown`→404 (chosen
  over 401 so a response never confirms a tenant exists), `tenant-over-quota`→429,
  `worker-unavailable`→503. `retryAfterSecondsFor` advertises the per-tenant
  `tenant-over-quota.retryAfterSeconds` and a fixed worker-unavailable backoff
  from one place. `formatHostError` renders `tenant-unknown` as a fixed,
  tenant-agnostic `"tenant not found"`, and over-quota/worker-unavailable name
  **only the caller's own** `TenantId`.
- **`packages/host/src/domain/framework-error-http.ts`** — `classifyHostError`
  classifies the three supervisor-boundary kinds: `tenant-unknown` and
  `tenant-over-quota` are settled, correct host behaviour →
  `countsAsCircuitFailure: false`; `worker-unavailable` is a transient infra
  signal → `countsAsCircuitFailure: true` (mirroring `infra-unreachable`), and
  the breaker it feeds is per-tenant so it never bleeds across the boundary.
  Status is sourced from `httpStatusFor` so it cannot drift.

Key invariants:

- **Branded principal.** `Tenant` / `TenantId` / `SecretsRef` are inhabited only
  via their single producers (`markTenant` / `tenantId` / `markSecretsRef`). A
  plain string or object cannot be routed as a tenant, dereferenced as a secret,
  or swapped for a `TenantId` — argument-swap and widening bugs are compile
  errors.
- **Regex forbids `:` and glob.** A `TenantId` can never contain `:` (the Redis
  key delimiter) or `*`/`?`/`[`/`]` (glob metacharacters), so it is always safe
  in `fugue:<tenant>:*` keys and `~fugue:<tenant>:*` ACL patterns (ADR-0067)
  without escaping — no crafted id can widen its own namespace over a neighbour's.
  `markTenant` re-asserts the regex so even a cast that bypasses the smart
  constructor cannot mint a namespace-widening principal (it throws
  `internal-invariant-violated` → generic 500, raw id server-side only).
- **Illegal states unrepresentable.** A resolved-tenant request and an
  unresolved one are distinct types: there is no value that is "maybe a tenant."
  Resolution either yields a branded `Tenant` or the uniform `tenant-unknown`.
- **Status mapping is single-sourced.** `httpStatusFor` is the only authority
  (404/429/503); `classifyHostError` reads from it; a new tenant kind without a
  case fails to compile.
- **No breaker trip for over-quota / unknown.** `tenant-over-quota` and
  `tenant-unknown` are `countsAsCircuitFailure: false` — a quota refusal or an
  unknown-tenant probe is the host doing its job, never a malfunction, so it
  cannot open a breaker (and certainly not one affecting another tenant).
- **Non-leaking bodies.** `tenant-unknown` carries no tenant id and no
  discriminating field, rendered as a fixed `"tenant not found"` identical
  whether the tenant does not exist or the caller is unauthorized; over-quota and
  worker-unavailable name only the *caller's own* tenant. One tenant's failure
  can never surface, by id or by status, as another tenant's error (FR-041).

## Consequences

**Positive:**

- The strongest isolation invariant in the system — "this is a tenant the
  supervisor resolved at the boundary" — is enforced by the type system, not by
  reviewer vigilance. Routing, key-namespacing, and ACL scoping all consume the
  *same* unforgeable `Tenant`, and the brand is greppable to its single producer.
  (DAG-execution authz is *structural* in this slice — per-tenant worker routing —
  rather than a per-request tenant conjunct; see Amendment.)
- The tenant boundary stays additive by design: the identity→team `canAccessDag`
  decision (ADR-0058, ADR-0063) is unchanged and a tenant scope can only ever
  *narrow*, never widen, an authorization decision. (The `canAccessDagForTenant`
  conjunct that would have made this explicit per-request was not wired — see
  Amendment.)
- Status truth stays in one exhaustive mapping, so the per-tenant taxonomy can
  never drift from the rest of the host's HTTP behaviour, and the breaker
  decision for tenant-boundary outcomes is made in lockstep with framework
  execution outcomes.
- The non-leakage and no-breaker-trip guarantees are structural: a foreign tenant
  cannot be probed via existence, state, status code, or body, and a hostile or
  saturated tenant cannot degrade a neighbour's availability through the breaker.
  These are verified together under concurrency by
  `__tests__/integration/error-taxonomy-concurrent.test.ts` (SC-012): four
  tenants × four fault classes interleaved, each response asserted to be the
  status for *its own* tenant with a non-leaking body.

**Negative:**

- Hand-rolled brands and smart constructors carry their own correctness burden,
  enforced by unit tests (`__tests__/domain/tenant.test.ts`,
  `tenant-error-taxonomy.test.ts`, `tenant-header.test.ts`) rather than a library.
  The `markTenant` regex re-assertion is defensive redundancy that only fires on a
  programmer cast — dead under correct use, deliberately so.
- Circuit-breaker decisions now flow through two mirrored classifiers
  (`classifyHostError` for tenant-boundary kinds, `classifyFrameworkError` for
  execution kinds). They share the `{status, countsAsCircuitFailure, ...}`
  contract and single-source their status/backoff, but a future change to breaker
  policy must be made consciously in both, with the `.exhaustive()` guard as the
  backstop.
- `tenant-unknown`'s deliberate uniformity (no id, "no such tenant" ≡ "not your
  tenant") means a *legitimately* unauthorized caller gets a 404 that does not
  explain why — the safe failure direction for non-leakage, but operationally it
  pushes diagnosis to server-side logs rather than the client response.
- The `SecretsRef` brand is the structural half of "supervisor never holds a
  secret"; the behavioural half (the supervisor genuinely lacking the authority to
  dereference it) is owned by the secrets channel / `SecretsSource` port and is
  not guaranteed by this ADR alone.

## Related

- ADR-0058 — two-path inbound host auth: produces the `AuthIdentity` (admin /
  team / user) that `resolveTenant` consumes and that `canAccessDag` gates DAG
  access for (the auth this decision extends, not replaces; the designed-but-unwired
  tenant conjunct would have threaded the resolved `Tenant` alongside — see
  Amendment).
- ADR-0059 — capability failure taxonomy: the sibling fail-closed,
  distinct-typed error taxonomy whose 403-vs-500 + no-breaker-trip reasoning this
  ADR mirrors for the tenant boundary.
- ADR-0036 — layered error handling: the established discipline that each error
  kind maps to one status at one boundary, which the extended `HostError` union
  preserves.
- ADR-0067 — per-tenant Redis ACL isolation: relies on `TENANT_ID_REGEX`
  forbidding `:`/glob so a `TenantId` can scope `fugue:<tenant>:*` keys and
  `~fugue:<tenant>:*` ACL patterns without a namespace-widening escape.
- ADR-0066 — IPC over a Unix domain socket: carries the resolved `Tenant` as the
  signed `X-Fugue-Tenant` header (`packages/host/src/domain/tenant-header.ts`),
  feeding tenant resolution/verification at the worker; the principal this ADR
  brands is what that header transports.
- ADR-0072 — resource enforcement (single pod + supervisor admission + per-worker
  heap cap): the per-tenant admission/concurrency check that *produces*
  `tenant-over-quota` and surfaces `worker-unavailable`, classified here.
- `packages/host/src/domain/tenant.ts` — branded `Tenant`/`TenantId`/`SecretsRef`,
  `markTenant`, `resolveTenant`, `TENANT_ID_REGEX` (this decision in code).
- `packages/host/src/domain/host-error.ts` — the three tenant variants plus
  `httpStatusFor` / `formatHostError` / `retryAfterSecondsFor`.
- `packages/host/src/domain/framework-error-http.ts` — `classifyHostError`
  (no breaker trip for over-quota/unknown; 503 + breaker for worker-unavailable).
- `packages/host/src/domain/auth.ts` — `canAccessDag`, the identity→team authz
  decision (the operative DAG gate; the `canAccessDagForTenant` extension was
  designed here but removed — see Amendment).
- `packages/host/src/__tests__/integration/error-taxonomy-concurrent.test.ts` —
  SC-012: 429/503/404 under concurrent load, zero cross-tenant bleed,
  non-leaking bodies.
