# ADR-0058: Two-Path Inbound Host Auth (opaque `fug_` + `fugue-platform` JWT)

## Status

Accepted

## Date

2026-06-11

## Context

The host's inbound auth boundary historically resolved exactly two opaque-token
identities: the `ADMIN_TOKEN` env var (root of trust) and per-team `fug_` bearer
tokens validated against a hashed Redis store. Both are *opaque* — they carry no
verifiable claims; the host learns who the caller is only by looking the hash up
locally. That model has no concept of an authenticated human: a run triggered by
a person through the `fugue-platform` frontend arrived as a team token (or not at
all), so the downstream capability broker could never preserve the *user's*
identity when reaching Microsoft Graph / Dynamics. Every run was attributed to an
agent.

The identity-scoped-capabilities effort (US5, FR-W3-006/008/010) requires the
opposite: when a human initiates a run, the user's subject must survive all the
way down to the per-hop downstream token exchange so that resource-level
authorization (mailbox, site, record scoping) is evaluated *as the user*, not as
an over-broad agent service account. The broker built in the same effort
(`keycloak-broker.ts`, ADR-covered separately) already dispatches on
`InvocationOrigin.kind`: a `user` origin performs a Standard Token Exchange V2
(`sub` stays the user, `azp` becomes the agent) while an `agent` origin mints
direct `client_credentials`. But the broker can only act on a `user` origin if
one is *produced at the inbound boundary* — and the inbound boundary only knew
opaque tokens.

The forces:

- **User identity must enter the host as verifiable claims**, not an opaque
  reference, because the downstream V2 exchange needs the actual `sub`.
- **No regression for the existing opaque paths** — admin and team tokens, and
  agent-initiated (cron / autonomous) runs, must behave byte-identically.
- **Fail closed.** A token that *looks* authenticated but cannot be verified must
  401, never silently degrade to a weaker identity.
- **This effort owns the inbound path.** It cannot block on a separate frontend
  migration to deliver the `user` identity; the host must accept and validate
  `fugue-platform` JWTs itself (FR-W3-010).

## Decision

**Extend the inbound auth middleware to validate `fugue-platform` OIDC JWTs
(`iss` = realm issuer, `aud` contains `fugue-host`) as a first-class identity
mode *alongside* — not replacing — the existing opaque `fug_` / admin-token path,
and thread the resulting user `sub` through the run into the capability broker.**

Concretely, four seams change:

1. **`AuthIdentity` gains a `user` variant** carrying the verified subject
   (`packages/host/src/domain/auth.ts`):

   ```ts
   export type AuthIdentity =
     | { readonly kind: "admin" }
     | { readonly kind: "team"; readonly team: string; readonly label: string }
     | {
         readonly kind: "user";
         readonly sub: string;
         readonly azp: string;
         readonly canRunDag: (dagTeam: string) => boolean;
       };
   ```

   `sub` is the authenticated user; `azp` is the OIDC client that minted the
   token (the fugue-platform frontend SSO client — *not* the agent client; see
   item 3); `canRunDag` carries the user-run authorization decision made at the
   verifier wiring site (the required `authorizeUserRun` member of
   `RealmJwtDeps`, item 2). `canAccessDag` is exhaustive over the union — the
   `user` branch delegates to `canRunDag(dagTeam)`, which may refuse (the run
   handler 403s a refused user; a `user` is deliberately *not*
   admin-equivalent); downstream authorization is additionally enforced per-hop
   by the broker.

2. **Two-path resolution in the middleware**
   (`packages/host/src/http/middleware/auth.ts`), in fail-safe order:
   1. constant-time compare against `adminToken` → `{ kind: "admin" }`;
   2. JWT path — *only* entered when a `verifyRealmJwt` verifier is configured,
      the token does **not** have the `fug_` team-token shape (the explicit
      `!isTeamTokenShape(token)` guard in `auth.ts`), **and** the token matches
      the JWT compact-serialization shape
      (`isJwtShape`). Signature is verified by the **injected** `verifyRealmJwt`
      port (JWKS-backed in prod, fake in tests); claims are then checked by the
      pure `validateRealmJwtClaims` against `expectedIss` / `expectedAud`. Only
      on full success does it resolve `{ kind: "user", sub, azp }`;
   3. opaque `fug_` team path — hashed Redis lookup, unchanged.

   The explicit `!isTeamTokenShape` guard — an enforced precondition, not an
   incidental shape property — keeps the team path untouched: generated `fug_`
   tokens happen to be dot-free (never JWT-shaped) today, but the guard enforces
   the routing even for a future `fug_` token that would otherwise match the
   JWT shape. A
   JWT-shaped token with no verifier wired, or with a bad signature / wrong
   `iss`/`aud`/`exp`, **401s** — it never falls through to a weaker identity.
   The JWT path's dependencies travel as ONE grouped, optional `realmJwt` dep
   (`RealmJwtDeps`: the `verify` signature verifier + `expectedIss`/`expectedAud`
   policy + the required `authorizeUserRun` user-run authorization policy,
   inseparable — half-wired states are unrepresentable, the same pairing move as
   the framework's `MintingAuthority`). The group is intentionally left wholly
   absent on this branch (a later wave supplies the JWKS adapter), so the JWT
   path is disabled-by-omission and fails closed; the `iss`/`aud` values are
   parsed and validated in config (`REALM_JWT_ISSUER` / `REALM_JWT_AUDIENCE`),
   ready to construct the group when the verifier lands.

3. **`sub` threads into `Invocation.origin`** via the pure, exported
   `invocationOriginForIdentity` (`domain/run-context.ts` — the domain-owned
   contract; `node-context-factory.ts` keeps a backward-compat re-export),
   exhaustive over `AuthIdentity`:
   - `user`  → `{ kind: "user", sub, agentClientId: dagId }`. `agentClientId`
     is the AGENT the user acts THROUGH — the DAG's agent-type Keycloak client
     (the same `dagId` placeholder the agent path uses, until the
     dagId→real-client-id mapping lands) — **never** the inbound token's `azp`
     (the frontend SSO client that minted the user's login token). The broker
     gates a user hop with `assignedScopes(agentClientId)`, which must consult
     the *agent's* realm policy, not the frontend's: keying on `azp` would
     (a) gate against the wrong client and (b) let a future token exchange set
     `azp` to the frontend (ADR-0056, review I3);
   - `team` / `admin` → `{ kind: "agent", agentClientId: dagId }` (the
     pre-existing agent placeholder; no user subject exists for these).

   `host.ts` `createContext` threads the resolved `AuthIdentity` into
   `createNodeContextForDag`, which builds the `Invocation` carried into
   `broker.mintFor`.

4. **Origin-dispatched downstream authority** in `keycloak-broker.ts`:
   - `user`  → Standard Token Exchange V2 per hop (`exchangeV2`), `sub` stays
     the user, `azp` becomes the agent (FR-W3-008 / SC-010);
   - `agent` → direct `client_credentials` (`mintClientCredentials`), **no
     exchange** (FR-W3-009 / SC-010).

   The cache-dedup identity follows the origin — the pair
   `(sub, agentClientId)` for a user hop (so distinct agents never share a
   user's token; `sub` alone would alias them — review I3), the agent client
   alone otherwise — and the audited `via` tag witnesses the branch actually
   taken; it is not a parallel re-derivation off `origin.kind`.

**Invariant:** an authenticated identity enters the host *only* as either a
locally-resolvable opaque token (admin/team) or a fully signature-and-claims
verified realm JWT (user). There is no third, weaker path; a structurally-valid
but unverifiable JWT is rejected, not downgraded.

## Consequences

**Positive:**

- User identity is preserved end-to-end: a human-initiated run reaches Microsoft
  Graph / Dynamics *as the user* via V2 exchange, satisfying US5 and the SC-010
  origin-dispatch requirement.
- The host owns its own inbound path (FR-W3-010) — no dependency on a separate
  frontend migration to start producing `user` identities.
- Additive, zero-regression: the admin / team / agent paths are byte-identical;
  only attribution of human-initiated runs changes (from a mislabelled `agent`
  to an honest `user`).
- Fail-closed by construction — the `user` path is gated on an injected verifier
  and is disabled-by-omission until JWKS is wired, so the partial state on this
  branch is safe (a JWT-shaped token 401s) rather than silently permissive.
- The `AuthIdentity` and `InvocationOrigin` unions are exhaustively matched, so a
  future identity kind is a compile error at every dispatch site.

**Negative:**

- The host now carries OIDC verification responsibility (JWKS fetch/cache,
  `iss`/`aud`/`exp` policy) — more surface than opaque-token lookup, and a live
  JWKS verifier adapter is still owed by a later wave; until then the user path
  is inert.
- Token-shape discrimination (admin → JWT-shape → `fug_`) is ordering-sensitive;
  the fail-safe ordering is load-bearing and must be preserved by future edits.
- The inbound run-gate decision for a `user` is delegated to the wiring site:
  `canAccessDag` calls the identity's carried `canRunDag(dagTeam)` policy, and
  constructing `RealmJwtDeps` structurally forces an `authorizeUserRun` choice
  (no policy, no JWT path). The mechanism is therefore in place; what remains
  deferred to the JWKS wave is the live verifier and with it the *concrete*
  policy choice (e.g. a realm/role check vs. allow-all) — the host cannot ship
  a default because the right policy is a deployment decision.
- Delegation is modelled as `sub` + `azp` + audit traces rather than an in-token
  `act` claim (see Rejected Alternatives), so the chain-of-custody is
  reconstructed from correlated audit records, not asserted inside one token.

## Rejected Alternatives

1. **A single unified inbound token format** (collapse opaque and JWT into one
   scheme — e.g. mint realm JWTs for teams/agents too, or wrap JWTs as opaque
   references).
   - Pros: one validation path; conceptually tidy.
   - Cons: forces a migration of every existing `fug_`/admin caller and the
     provisioning flow that issues them, for no functional gain on those paths;
     the opaque store is the right model for non-human callers (no claims to
     verify, instant revocation by hash deletion). Rejected: the cost is a
     wholesale migration of shipped, working auth to satisfy a uniformity that
     buys nothing.

2. **Exchange on every hop regardless of origin** (run the V2 token exchange for
   agent-initiated runs too, treating the agent as the subject).
   - Pros: a single broker code path; no origin branch.
   - Cons: an agent has no end-user subject to exchange — `client_credentials` is
     the correct, simpler grant for an autonomous/cron run, and routing it
     through an exchange adds a pointless hop and mis-shapes the audit (`sub`
     would be spurious). Violates SC-010, which explicitly requires
     `client_credentials` for agent origin and V2 exchange for user origin.
     Rejected: it conflates two genuinely different authority shapes.

3. **Depend on an external frontend migration to deliver the inbound user path.**
   - Pros: the host would not need OIDC verification logic.
   - Cons: blocks this effort on out-of-team work and leaves the host unable to
     accept a human identity until that lands. FR-W3-010 assigns inbound
     ownership to this effort. Rejected: this effort owns the inbound path.

4. **`act`-claim in-token delegation** (Keycloak emits a token whose `act`
   actor-claim encodes the agent acting on behalf of the user).
   - Pros: standards-aligned, self-describing delegation chain inside one token.
   - Cons: on the Keycloak roadmap, not available for v1. Rejected as out of
     scope; the `sub` + `azp` + correlated audit traces are the v1 substitute
     that delivers the same end-to-end attribution today.

## Amendment — subject-token threading for the live V2 exchange (2026-06-12)

**Status:** Accepted. Decides a gap the original decision left implicit.

The decision above threads the user's `sub` into `InvocationOrigin`, and the
`exchangeV2` port (`adapters/keycloak-token-endpoint.ts`) carries only
`userSub: string`. But a *real* Standard Token Exchange (RFC 8693 / Keycloak
Token Exchange V2) requires presenting the user's actual verified JWT as the
`subject_token` proof — and no value in the current chain carries it: the auth
middleware verifies the inbound bearer and then deliberately discards it,
keeping only `sub`/`azp` on `AuthIdentity`. Today this is masked because the
endpoint is the fail-closed unwired default; the live exchange cannot reach the
gap.

**Decision for the JWKS wave** (recorded now so it is not re-litigated, or
"solved" with impersonation, under delivery pressure):

- The verified subject token threads **host-side only**: the middleware retains
  the raw verified bearer as a branded, opaque reference (e.g.
  `VerifiedSubjectToken` — branded so it stays out of logs and audit payloads
  by convention, mirroring how `canRunDag` carries a capability rather than
  data) carried on the host's run context next to the identity, and injected
  into the broker deps at the wiring site.
- The framework seam (`InvocationOrigin`) stays exactly as shipped —
  provider-agnostic strings, no bearer credential. Widening it would leak a
  host auth concern through the framework port (FR-W2-004 tension) and is
  rejected.
- `ExchangeV2Request` gains the subject-token field in the same change that
  wires the live endpoint; the unwired default keeps failing closed until then.
- An impersonation-style fallback (minting a token that *claims* `sub` without
  presenting the user's token as proof) is explicitly rejected: it would
  silently weaken the sub-preserving invariant this ADR documents while leaving
  every test green.

Until that wave lands, the gap is documented at the port
(`ExchangeV2Request` JSDoc) and is unreachable by construction.
