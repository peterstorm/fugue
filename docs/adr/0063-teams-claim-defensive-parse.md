# ADR-0063: `teams` Claim Defensive Parse in the Pure Validator (no Zod)

> **Consolidated reference:** the live, end-to-end team-security picture this decision feeds into lives in [`docs/team-security-and-capabilities.md`](../team-security-and-capabilities.md). This ADR remains the immutable "why".

## Status

Accepted

## Date

2026-06-16

## Context

The two-path inbound auth boundary (ADR-0058) resolves a human-initiated run into
an `AuthIdentity` of kind `user`, carrying the realm JWT's verified subject. To
authorize *which* DAGs that user may run, the run-gate needs the user's team
memberships. The fugue-platform realm now emits those memberships as a
multi-valued `teams` claim on the access token — realm roles (one per team)
projected through an `oidc-usermodel-realm-role-mapper` (FR-020), derived
upstream from the user's Azure groups. The host must turn that claim into the
`readonly string[]` that `RealmJwtClaims.teams` / `AuthenticatedUser.teams`
promises, which `authorizeUserRun = (u, dagTeam) => u.teams.includes(dagTeam)`
(ADR-0058, FR-021) then consults inside `canAccessDag`.

The `teams` claim is **attacker-influenced input crossing a trust boundary**: it
is the load-bearing value that drives the user-run authorization decision. Even
though the JWKS verifier has already attested the *signature* before these claims
are inspected (the `SignatureVerifiedClaims` brand), the claim *values* are still
untrusted shape — a misconfigured realm mapper, a future schema drift, or an
unexpected encoding must not be silently coerced into a permissive or
ill-typed list. The downstream type `RealmJwtClaims.teams: readonly string[]`
must be *guaranteed* to hold an array of non-empty strings; anything else has to
fail closed at the boundary rather than flow into the membership check.

The question this ADR settles is narrow but security-load-bearing: **by what
mechanism, and in which module, is the `teams` claim parsed** — given that
`packages/host/src/domain/jwt-validation.ts` is a *pure domain module* that
already hand-parses `iss`/`aud`/`exp`/`sub`/`azp` defensively, while the codebase
already owns a runtime schema validator (Zod) used at the **config boundary**
(ADR-0042). Whether `teams` should drive authorization at all is settled upstream
(ADR-0058, FR-021); the open question is only the parse seam.

## Options Considered

1. **Defensive hand-parse inside the pure validator, mirroring the `aud`-array branch (chosen).**
   - Pros: keeps the entire realm-JWT parse in **one seam** — every claim
     (`iss`/`aud`/`exp`/`sub`/`azp`/`nbf`/`teams`) is parsed by the same pure,
     dependency-free mechanism in `validateRealmJwtClaims`, so a reader audits one
     place to know exactly what shape each claim is held to. Adds zero runtime
     dependency to the pure domain core. The `teams` branch is the same
     "array of non-empty strings, else `malformed`" check the validated `aud`
     array already uses, so the two are read and reviewed identically. The result
     is a validated `readonly string[]` carried on the branded `AuthenticatedUser`
     — illegal shapes are unrepresentable downstream.
   - Cons: a second hand-rolled parser to keep correct (versus delegating to a
     library); the array/element checks are enforced by unit tests rather than a
     declared schema.

2. **Zod schema for `teams` inside the validator.**
   - Pros: declarative shape; reuses a library the repo already depends on; one
     fewer hand-rolled predicate.
   - Cons: pulls a **runtime dependency into the pure domain core**, which is
     deliberately dependency-free (ADR-0042 confines Zod to the config boundary,
     not the functional core). It also **splits the parse seam**: `iss`/`aud`/`exp`/
     `sub`/`azp` would stay hand-parsed while `teams` alone went through Zod, so a
     future reader must reason about two parsing mechanisms in one module and two
     error-shaping paths (Zod's `ZodError` vs. the module's `AuthError` ADT). The
     gain — one declarative predicate — is small against an array-of-strings
     check the module can already express in three lines.

There was a genuine alternative here (the repo *does* own Zod), so this is not a
forced choice; it is a deliberate placement decision to keep the pure core pure
and the parse seam single.

## Decision

**Parse `teams` defensively inside `packages/host/src/domain/jwt-validation.ts`,
mirroring the existing validated-`aud`-array branch — an array of non-empty
strings, malformed shapes returning `err({ kind: "malformed", ... })`. No Zod in
this module.**

Concretely, in `validateRealmJwtClaims` (after the `iss`/`aud`/`exp`/`sub`/`azp`
structural checks, before the issuer/audience/expiry policy checks):

- **Absent claim → empty list, fail-closed.** `c.teams === undefined` yields
  `teams = []`. A user in no team can run no team's DAGs, because
  `authorizeUserRun` evaluates `[].includes(dagTeam) === false`. Absence grants
  nothing.
- **Well-formed array → accepted.** `Array.isArray(c.teams) && c.teams.every(isNonEmptyString)`
  yields `teams = c.teams`. An empty array `[]` is well-formed and means exactly
  "no teams" — the same as absence. This reuses the very `isNonEmptyString`
  predicate the `aud`-array branch uses.
- **Present-but-malformed → reject the whole token.** Any other shape (not an
  array, or any element non-string/empty) returns
  `err({ kind: "malformed", reason: "non-array or non-string 'teams'" })`. A
  wrong-typed claim is **never** silently coerced to "no teams", because that
  could mask a misconfigured realm mapper and a misconfiguration must fail loud,
  not fail open into a different-but-plausible authorization outcome.

On success the validator returns the branded `AuthenticatedUser` carrying
`{ sub, azp, teams }` — the brand from `markAuthenticatedUser` is the only way to
obtain that type, so a bare `{ sub, azp, teams }` can never masquerade as an
authenticated principal, and `teams` reaching `canAccessDag` is, by construction,
a validated `readonly string[]`.

Key invariants:

- The realm-JWT parse stays in **one module and one mechanism** — pure,
  hand-rolled, returning the `AuthError` ADT. Zod stays at the config boundary
  (ADR-0042) and does not enter the functional core.
- `RealmJwtClaims.teams: readonly string[]` and `AuthenticatedUser.teams` are
  *always* an array of non-empty strings or empty — never `undefined`, never a
  mixed-type array — by the time any consumer reads them. Illegal states are
  unrepresentable downstream.
- The parse fails **closed**: absence → no membership; malformed → token
  rejected. There is no shape that yields a *permissive* `teams` the user did not
  legitimately carry.

## Consequences

**Positive:**

- The `teams` parse is consistent with the module's existing hand-parse style:
  one reviewer reads one seam to know how every realm-JWT claim is validated, in
  one error vocabulary (`AuthError`).
- The pure domain core stays dependency-free — no Zod import in
  `jwt-validation.ts`. The config boundary remains the single home of runtime
  schema validation (ADR-0042).
- This is the load-bearing parse of an attacker-influenced claim that drives
  `canAccessDag`; modelling absence as the empty list and rejecting any malformed
  shape makes the authorization input fail closed by construction — a
  misconfigured mapper cannot silently degrade into a wrong "no teams" allow/deny.
- Downstream code never re-validates: `authorizeUserRun` and `canAccessDag`
  receive a guaranteed `readonly string[]`, so the membership check is a plain
  `includes` with no defensive re-parsing.

**Negative:**

- A second hand-rolled parser lives in the module (the `teams` branch alongside
  the `aud`-array branch); its correctness rests on unit tests
  (valid / non-array / non-string / missing → fail-closed) rather than a declared
  schema. If the realm's `teams` shape ever grows richer than "array of
  strings", the hand-parse must be extended deliberately — there is no schema to
  evolve in one edit.
- The fail-closed missing-claim treatment (absent → `[]`) means a realm
  misconfiguration that *drops* the `teams` mapper does **not** error — it
  silently authorizes nothing. This is the safe failure direction, but it
  surfaces as "user can run no DAGs" rather than a loud parse error; the realm's
  golden export test (SC-008) is the guard that the mapper is actually present
  and multivalued.

## Related

- ADR-0058 — two-path inbound host auth: produces the `user` `AuthIdentity` and
  consumes the parsed `teams` via `authorizeUserRun` / `canAccessDag` (the
  consumer of this decision).
- ADR-0042 — config via Zod env/YAML: establishes Zod's home at the config
  boundary, which this ADR deliberately keeps it confined to.
- `packages/host/src/domain/jwt-validation.ts` — the `teams` parse branch (this
  decision in code).
- `packages/host/src/domain/auth.ts` — `RealmJwtClaims.teams` /
  `AuthenticatedUser.teams` and the `canAccessDag` consumption.
