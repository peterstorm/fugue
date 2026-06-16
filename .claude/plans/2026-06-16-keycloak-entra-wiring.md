# Plan: Keycloak/Entra Capability-Broker Wiring

**Spec:** `.claude/specs/2026-06-16-keycloak-entra-wiring/spec.md`
**Architecture:** `.claude/specs/2026-06-16-keycloak-entra-wiring/architecture.md`
**Canonical design:** `docs/team-security-and-capabilities.md` (§4/§5/§7), ADRs 0051–0061
**Created:** 2026-06-16

## Summary

Additive wiring of the already-merged (PRs #16/#17), fail-closed pure core into
live security paths across two repos: `packages/host` (TypeScript) and the
`fugueplatform` realm config-as-code (`~/dev/java/keycloakConfigAsCode`, Java).
Every new piece is an **adapter implementing an existing port** or a
**claim/config addition** — no rewrite of the functional core. The governing
invariant is *config-presence gating* (AD-3): each leg goes live only when its
config is present, otherwise the fail-closed stub stays, preserving SC-001
(zero-regression boot) at every step.

---

## Architectural Decisions

### AD-1: Team modeling = realm roles (role name == team name) [M1]

**Choice:** Model teams as realm **roles** (role name == team name, e.g.
`business-sales`). Reuse the existing `IdpPlanBuilder.claimToRoleMapper` (Azure
group GUID → realm role), plus a single `oidc-usermodel-realm-role-mapper`
protocol mapper emitting `teams: string[]` (multivalued, access-token-only).
**Why:** `fugueplatform` is a greenfield realm whose realm-role namespace is
**reserved for teams** — the role mapper emits all realm roles, which are all
teams. Reuses already-shipped toolbox machinery.
**Escape hatch:** if non-team realm roles ever appear, switch the `teams` claim
to a group-membership mapper (groups model membership more precisely) — a
localized change to one mapper + the IdP join mapper, no host change.
**Rejected:**
- Realm groups for the primary model — heavier config-as-code for no benefit
  while the role namespace is reserved; kept as the documented escape hatch.

### AD-2: Transport sharing — one shared `HttpPost`

**Choice:** One `createFetchHttpPost(): HttpPost` reused by both Keycloak and
Entra; Graph gets its own `createFetchGraphHttp(): GraphHttp`.
**Why:** Both Keycloak and Entra POST `application/x-www-form-urlencoded` and
consume `{status, json}` — one place for timeout/retry/TLS. Graph differs
(bearer, GET/POST, absolute URL) so it warrants its own transport.
**Rejected:**
- Per-adapter inline `fetch` — breaks the injected-port invariant that keeps
  tests network-free.

### AD-3: Config-presence gating vs feature flag

**Choice:** Each leg lights up independently iff its config is present; every
partial state stays provably fail-closed. No single global enable flag.
**Why:** Each leg can be provisioned and switched on independently as the
four-spike gate clears; partial states must stay fail-closed (FR-011).
**Rejected:**
- A single `CAPABILITY_MINTING_ENABLED` flag — forces all egresses live at once,
  which the four-spike gate forbids.

### AD-4: Realm JWT verifier = signature-only, mirror the Bot verifier

**Choice:** `createRealmJwtVerifier({issuer}): VerifyRealmJwt` via
`jose.createRemoteJWKSet` → `markSignatureVerified`. Verifies **signature only**;
issuer/audience/expiry stay in the existing pure claim validator.
**Why:** Keeps the parse-don't-validate seam in the pure `jwt-validation.ts`
module; signature is the only piece that needs I/O. Mirrors the proven
`hitl/adapters/bot/verify.ts`.
**Rejected:**
- Full validation in the adapter — duplicates pure-validator logic and pulls
  claim policy into the I/O boundary.

### AD-5: `authorizeUserRun` is a required member of `routerDeps.realmJwt`

**Choice:** The user-authorization decision (`(u, dagTeam) => u.teams.includes(dagTeam)`)
is a **required**, non-optional, non-defaultable member of the realmJwt deps —
the compiler forces the decision to be made when wiring the user path.
**Why:** FR-021 makes the authz decision a required part of wiring the user path;
making it optional/defaultable would allow a silent insecure default.
**Rejected:**
- Optional with a permissive default — invites accidental allow-all.

### AD-6: Subject token is a host-side side-channel

**Choice:** The verified user JWT (`SubjectToken`, branded) is captured on the
`user` `AuthIdentity` and threaded host-side only (`runId → SubjectToken` in the
run-context factory; resolved via `resolveSubjectToken` on the broker deps). The
framework `InvocationOrigin` stays string-only.
**Why:** FR-032 — the token must never cross the framework port / framework
invocation origin. Keeping it a side-channel preserves that boundary while still
enabling proof-bearing RFC 8693 exchange.
**Rejected:**
- Threading the token through the framework `InvocationOrigin` — violates FR-032
  and widens the framework trust surface.

### AD-7: `teams` parsing = defensive parse in the pure validator, no Zod

**Choice:** Parse `teams` defensively inside `domain/jwt-validation.ts`,
mirroring the existing `aud`-array branch (array of non-empty strings; malformed
→ `err({kind:"malformed"})`). No Zod in this module.
**Why:** `jwt-validation.ts` is a pure domain module that already hand-parses
`iss/aud/exp/sub/azp`. Zod lives at the config boundary, not here — keeps the
module dependency-free and the parse seam in one place.
**Rejected:**
- Zod schema in the validator — pulls a runtime dependency into the pure core
  and splits the parse seam.

### AD-8: First-cohort roster = seed `business-sales`, team→group map is per-env config [M2]

**Choice:** Seed exactly one team (`business-sales`). The team→Azure-group GUID
map is **per-environment config** (mirroring `azureConfig.adminGroupId()`), not
hardcoded. Builder + golden test designed for N teams; one seeded.
**Why:** Only `business-sales` is authoritative at authoring time; per-env config
keeps GUIDs out of source and supports additional teams without code change.
**Rejected:**
- Hardcoding the team→GUID map in source — leaks environment-specific GUIDs and
  forces a code change per team.

---

## File Structure

### Host — Phase 0 Foundations (`packages/host/src`)

```
domain/config.ts                          — add ENTRA_TENANT_ID, ENTRA_CLIENT_ID,
                                            KEYCLOAK_TOKEN_URL?, KEYCLOAK_AGENT_CLIENT_CREDENTIALS (JSON, sensitive),
                                            DYNAMICS_ORG_HOST?; Zod superRefine pairs tenant+client
adapters/fetch-http-post.ts               — createFetchHttpPost(): HttpPost (shared Keycloak+Entra)
adapters/fetch-http-post.test.ts          — tests
adapters/fetch-graph-http.ts              — createFetchGraphHttp(): GraphHttp (bearer GET/POST)
adapters/fetch-graph-http.test.ts         — tests
adapters/realm-jwt-verifier.ts            — createRealmJwtVerifier({issuer}): VerifyRealmJwt (jose JWKS, signature-only)
adapters/realm-jwt-verifier.test.ts       — tests
adapters/agent-client-credentials.ts      — AgentClientCredentials port + env-map adapter
adapters/agent-client-credentials.test.ts — tests
.env.example                              — all Entra/Keycloak/Bot/HITL vars + comments
```

### Host — Phase 1 Agent path (`packages/host/src`)

```
adapters/keycloak-token-endpoint-http.ts       — createKeycloakTokenEndpoint(deps): KeycloakTokenEndpoint;
                                                 pure helpers buildClientCredentialsBody/buildExchangeV2Body/mapKeycloakTokenResponse
adapters/keycloak-token-endpoint-http.test.ts  — tests
host.ts                                         — selectCapabilityBroker: AD-3 config-gated swap of stubs for live adapters
```

### Host — Phase 2 User inbound (`packages/host/src`)

```
domain/auth.ts             — add `readonly teams: readonly string[]` to RealmJwtClaims
domain/jwt-validation.ts   — defensive parse of `teams` in validateRealmJwtClaims (mirror aud-array)
host.ts                    — routerDeps.realmJwt = { verify, expectedIss, expectedAud,
                             authorizeUserRun: (u, dagTeam) => u.teams.includes(dagTeam) } (required)
domain/__tests__/          — teams parse + authorizeUserRun tests
```

### Host — Phase 3 User downstream exchange (`packages/host/src`)

```
domain/auth.ts                       — add `subjectToken: SubjectToken` to user AuthIdentity; brand verified JWT
domain/run-context.ts                — store runId → SubjectToken when shell builds context
adapters/keycloak-broker.ts          — KeycloakBrokerDeps gains resolveSubjectToken; user branch of saDispatch passes it
adapters/keycloak-token-endpoint.ts  — ExchangeV2Request gains required subjectToken
adapters/keycloak-token-endpoint-http.ts — real RFC 8693 exchangeV2 presenting user JWT as subject_token
```

### Host — Phase 4 Hardening (`packages/host/src`)

```
domain/auth.ts                              — agentClientIdForDag: replace identity fn with AGENT_CLIENT_MAP (dagId → real client id)
hitl/adapters/bot/messages-handler.ts       — resolve from.aadObjectId → team, authorize vs run's DAG team
hitl/adapters/bot/conversation-store.ts     — per-team conversation routing
hitl/identity.ts                            — AAD object id → team resolution
adapters/keycloak-broker.ts                 — Dynamics per-org host via audienceForScope
adapters/graph-capability.ts                — buildDynamicsReadHandle uses DYNAMICS_ORG_HOST
```

### Cross-repo — `fugueplatform` realm (`~/dev/java/keycloakConfigAsCode`)

Package `dk.secondbrand.keycloak.configuration.fugueplatform`. Build via
`nix develop --command bash -c 'cd java-configuration && mvn ...'` (no `mvn`/gradle on PATH).

```
.../fugueplatform/RolesStep.java               — NEW: one realm role per team (role name == team name)
.../fugueplatform/AzureIdpStep.java            — NEW: broker azuread; claimToRoleMapper("groups", <env GUID>, "<team>") per team (forceSync)
.../fugueplatform/ClientScopesStep.java        — add `teams` oidc-usermodel-realm-role-mapper on fugue-frontend scope
.../fugueplatform/FuguePlatformRealmConfiguration.java — wire AzureIdpStep + RolesStep into STEPS
.../fugueplatform/ValidationStep.java          — assert roles present + teams mapper config
.../fugueplatform/FuguePlatformRealmGoldenTest.java — assert teams claim multivalued/access-token-only + agent scope mirror
```

---

## Component Design

### Config extension

**Responsibility:** Accept Entra/Keycloak/Dynamics config and reject
internally-inconsistent combinations at boot.
**Files:** `domain/config.ts`
**Interface:**

```
ENTRA_TENANT_ID, ENTRA_CLIENT_ID, KEYCLOAK_TOKEN_URL?,
KEYCLOAK_AGENT_CLIENT_CREDENTIALS (JSON, sensitive), DYNAMICS_ORG_HOST?
Zod superRefine: tenant present iff client present; creds JSON validates.
Mirror existing AGENT_CLIENT_SCOPES transform (config.ts ~:96).
```

**Depends on:** none

### Shared transports

**Responsibility:** Inject-able HTTP transports keeping adapters network-free in test.
**Files:** `adapters/fetch-http-post.ts`, `adapters/fetch-graph-http.ts`
**Interface:**

```
createFetchHttpPost(): HttpPost          // application/x-www-form-urlencoded → {status, json}
createFetchGraphHttp(): GraphHttp        // bearer GET/POST, absolute URL
```

**Depends on:** none (inject `fetch`)

### Realm JWT verifier

**Responsibility:** Verify a realm JWT's signature against published JWKS.
**Files:** `adapters/realm-jwt-verifier.ts`
**Interface:**

```
createRealmJwtVerifier({ issuer }): VerifyRealmJwt
// jose.createRemoteJWKSet → markSignatureVerified; signature only.
// Mirror hitl/adapters/bot/verify.ts (AD-4).
```

**Depends on:** `jose` (already used by Bot verifier)

### Agent client credentials

**Responsibility:** Resolve a per-agent-client credential by client identity; miss is fail-closed.
**Files:** `adapters/agent-client-credentials.ts`
**Interface:**

```
type KeycloakClientCredential = { clientId, clientSecret }   // never logged
type AgentClientCredentials = (AgentClientId) => KeycloakClientCredential | undefined
// env-map adapter from KEYCLOAK_AGENT_CLIENT_CREDENTIALS; miss → undefined (AD-1 fail-closed)
```

**Depends on:** Config extension

### Live Keycloak token endpoint

**Responsibility:** Mint SA token via client-credentials; exchange via RFC 8693.
**Files:** `adapters/keycloak-token-endpoint-http.ts`
**Interface:**

```
createKeycloakTokenEndpoint(deps): KeycloakTokenEndpoint
buildClientCredentialsBody(req, cred)      // pure
buildExchangeV2Body(req, cred)             // pure; presents subject_token (Phase 3)
mapKeycloakTokenResponse(audience, res)    // pure; status → Result
// uses createFetchHttpPost (AD-2). Mirror adapters/entra-wif.ts split.
```

**Depends on:** Shared transports, Agent client credentials

### Capability broker selection (AD-3 gating)

**Responsibility:** Swap each unwired stub for its live adapter iff its config present.
**Files:** `host.ts` (`selectCapabilityBroker`)
**Interface:**

```
live endpoint ⇐ KEYCLOAK_AGENT_CLIENT_CREDENTIALS present
live WIF      ⇐ ENTRA_TENANT_ID + ENTRA_CLIENT_ID present
live Graph    ⇐ alongside WIF
else: fail-closed stub + exactly one boot warning naming the unwired leg
```

**Depends on:** all Phase 0/1 adapters

### User inbound authz

**Responsibility:** Verify realm JWT signature, parse `teams`, authorize run by DAG-owning team.
**Files:** `domain/auth.ts`, `domain/jwt-validation.ts`, `host.ts`
**Interface:**

```
RealmJwtClaims gains `readonly teams: readonly string[]`
validateRealmJwtClaims: defensive teams parse (AD-7)
routerDeps.realmJwt.authorizeUserRun: (u, dagTeam) => u.teams.includes(dagTeam)  // required (AD-5)
// canAccessDag user branch already runs before concurrency acquire (SC-005 holds)
```

**Depends on:** Realm JWT verifier, cross-repo realm `teams` claim

### User downstream exchange

**Responsibility:** Exchange the user's verified token for a downstream token (proof-bearing).
**Files:** `domain/auth.ts`, `domain/run-context.ts`, `adapters/keycloak-broker.ts`,
`adapters/keycloak-token-endpoint.ts`, `adapters/keycloak-token-endpoint-http.ts`
**Interface:**

```
user AuthIdentity gains subjectToken: SubjectToken (branded raw verified JWT)
run-context factory stores runId → SubjectToken
KeycloakBrokerDeps gains resolveSubjectToken: (runId) => SubjectToken | undefined
ExchangeV2Request gains required subjectToken
exchangeV2: RFC 8693, subject_token = user JWT; sub=user, azp=agent (AD-6, FR-030)
// undefined subjectToken → fail closed (no proof-less impersonation)
```

**Depends on:** Live Keycloak token endpoint, User inbound authz

### Hardening

**Responsibility:** Real dagId→client map, HITL per-team approver authz, Dynamics per-org host.
**Files:** `domain/auth.ts`, `hitl/adapters/bot/messages-handler.ts`,
`hitl/adapters/bot/conversation-store.ts`, `hitl/identity.ts`,
`adapters/keycloak-broker.ts`, `adapters/graph-capability.ts`
**Interface:**

```
agentClientIdForDag: config-mapped dagId → real client id (AGENT_CLIENT_MAP; ADR-0056)
HITL: resolve from.aadObjectId → team, authorize vs run's DAG team (parity with HTTP approve; FR-041)
Dynamics: per-org host from DYNAMICS_ORG_HOST through audienceForScope + buildDynamicsReadHandle (FR-042)
```

**Depends on:** User downstream exchange

### Cross-repo realm steps

**Responsibility:** Broker mother-company Entra, map Azure groups → team realm roles, emit `teams` claim.
**Files:** `RolesStep.java`, `AzureIdpStep.java`, `ClientScopesStep.java`,
`FuguePlatformRealmConfiguration.java`, `ValidationStep.java`, `FuguePlatformRealmGoldenTest.java`
**Interface:**

```
RolesStep: one realm role per team (role name == team name)
AzureIdpStep: broker azuread; claimToRoleMapper("groups", <env GUID>, "<team>") per team (forceSync)
teams mapper: oidc-usermodel-realm-role-mapper, multivalued:true,
              access.token.claim:true, id.token.claim:false, claim.name:teams,
              jsonType.label:String — on fugue-frontend client scope
Golden: teams claim multivalued/access-token-only + agent client scopes mirror permissions (FR-053, SC-008)
```

**Depends on:** none (independent repo; gates host Phase 2)

---

## Data Flow

```
Agent run:  DAG requires → broker.mintFor → Keycloak client_credentials → Entra WIF (client_assertion) → scoped handle
User run:   realm JWT → verifier (sig) → jwt-validation (iss/aud/exp/teams) → authorizeUserRun → run authorized
            → node mintFor → Keycloak exchangeV2 (subject_token=user JWT) → downstream (sub=user, azp=agent)
Realm:      Azure group GUID → claimToRoleMapper → realm role (team) → teams mapper → teams[] on access token
```

Key transformations are pure: `build*Body`/`map*Response` (token endpoint),
defensive `teams` parse (jwt-validation), `authorizeUserRun` membership check.
All I/O is injected at the transport edge.

---

## Implementation Phases

Ordered by dependency. Maps directly to decompose waves. The cross-repo realm
work runs in parallel with host Phase 1 and gates host Phase 2.

### Phase 0: Foundations — Wave A (no dependencies)

- Add Entra/Keycloak/Dynamics config fields + `superRefine` consistency checks.
- Build `createFetchHttpPost` (shared) and `createFetchGraphHttp`.
- Build `createRealmJwtVerifier` (signature-only, jose JWKS).
- Build `AgentClientCredentials` port + env-map adapter (fail-closed on miss).
- Write `.env.example` with all Entra/Keycloak/Bot/HITL vars + comments.
- **Files:** `domain/config.ts`, `adapters/fetch-http-post.ts`,
  `adapters/fetch-graph-http.ts`, `adapters/realm-jwt-verifier.ts`,
  `adapters/agent-client-credentials.ts`, `.env.example`
- **new_tests_required:** unit for body builders N/A here; unit for creds hit/miss;
  integration (recorded fake) for verifier valid/bad-sig/JWKS-down; config consistency tests.
- **depends_on:** none

### Phase 1: Agent path end-to-end — Wave B (depends on Phase 0)

- Build `createKeycloakTokenEndpoint` live HTTP adapter + pure helpers
  `buildClientCredentialsBody` / `buildExchangeV2Body` / `mapKeycloakTokenResponse`.
- Wire AD-3 config-gated swap in `selectCapabilityBroker` (host.ts): live endpoint ⇐
  creds, live WIF ⇐ tenant+client, live Graph ⇐ alongside WIF; else stub + one boot warn.
- **Files:** `adapters/keycloak-token-endpoint-http.ts`, `host.ts`
- **new_tests_required:** unit for the three pure helpers (exact body, no extra params,
  status→Result); integration no-egress on creds-miss + 4xx→denied;
  `selectCapabilityBroker` picks live-vs-stub by config presence + warns once.
- **depends_on:** Phase 0

### Phase 1′: HITL go-live — Wave B (depends on Phase 0 `.env.example`)

- Ops/provisioning task: provision Azure Bot + Entra app
  (`BOT_APP_ID`/`BOT_APP_PASSWORD`, endpoint → `POST /teams/messages`).
- Smoke-test suspend → card → approve → resume. No code (or minimal).
- **Files:** none (ops) / `.env.example` already from Phase 0
- **new_tests_required:** manual smoke test recorded; no automated tests.
- **depends_on:** Phase 0

### Phase 1″: Cross-repo realm steps — Wave B (independent repo; gates Phase 2)

- Add `RolesStep` (one realm role per team) and `AzureIdpStep` (broker azuread +
  per-team `claimToRoleMapper`, seed `business-sales`).
- Add `teams` protocol mapper (`oidc-usermodel-realm-role-mapper`, multivalued,
  access-token-only, `claim.name=teams`) on the `fugue-frontend` scope.
- Wire both new steps into `FuguePlatformRealmConfiguration.STEPS`.
- Extend `ValidationStep` (roles + teams mapper config) and
  `FuguePlatformRealmGoldenTest`.
- Build via `nix develop` (no mvn on PATH).
- **Files:** `RolesStep.java`, `AzureIdpStep.java`, `ClientScopesStep.java`,
  `FuguePlatformRealmConfiguration.java`, `ValidationStep.java`, `FuguePlatformRealmGoldenTest.java`
- **new_tests_required:** golden test asserts `teams` claim multivalued +
  access-token-only + agent client scopes mirror permissions (FR-053, SC-008).
- **depends_on:** none

### Phase 2: User inbound — Wave C (depends on Phase 0 verifier + Phase 1″ realm)

- Add `teams` to `RealmJwtClaims` (domain/auth.ts).
- Defensive `teams` parse in `domain/jwt-validation.ts` (mirror aud-array, no Zod).
- Wire `routerDeps.realmJwt` with required `authorizeUserRun = teams.includes(dagTeam)`.
- **`/security-expert` review required** (teams-claim parse + authz path).
- **Files:** `domain/auth.ts`, `domain/jwt-validation.ts`, `host.ts`
- **new_tests_required:** unit `teams` parse (valid/non-array/non-string/missing → fail-closed);
  unit `authorizeUserRun` member→true / non-member→false; property: any user ∉ team ⇒
  `canAccessDag` false (SC-005); admin + `fug_` paths unchanged (FR-023).
- **depends_on:** Phase 0, Phase 1″

### Phase 3: User downstream exchange — Wave D (depends on Phase 1 + Phase 2)

- Add `subjectToken: SubjectToken` to the user `AuthIdentity` (domain/auth.ts).
- Thread `runId → SubjectToken` host-side in the run-context factory (domain/run-context.ts).
- Add `resolveSubjectToken` to `KeycloakBrokerDeps`; user branch passes it (adapters/keycloak-broker.ts).
- Add required `subjectToken` to `ExchangeV2Request` (keycloak-token-endpoint.ts).
- Implement real RFC 8693 exchangeV2 presenting the user JWT as `subject_token`
  (keycloak-token-endpoint-http.ts).
- **`/security-expert` review required** (subject-token threading + exchangeV2).
- **Files:** `domain/auth.ts`, `domain/run-context.ts`, `adapters/keycloak-broker.ts`,
  `adapters/keycloak-token-endpoint.ts`, `adapters/keycloak-token-endpoint-http.ts`
- **new_tests_required:** broker user-branch sets `subjectToken`, agent-branch never does;
  exchangeV2 fail-closes when `resolveSubjectToken` undefined (no proof-less token);
  exchanged token preserves sub=user, azp=agent.
- **depends_on:** Phase 1, Phase 2

### Phase 4: Hardening — Wave E (depends on Phase 1 + Phase 2 + Phase 3)

- Replace `agentClientIdForDag` identity fn with config-mapped `AGENT_CLIENT_MAP`
  (dagId → real client id); re-key `AGENT_CLIENT_SCOPES` + creds on real ids (ADR-0056).
- HITL approver authz: resolve `from.aadObjectId` → team, authorize vs run's DAG
  team before recording decision; per-team conversation routing (FR-041).
- Dynamics per-org host from `DYNAMICS_ORG_HOST` through `audienceForScope` +
  `buildDynamicsReadHandle`; replace hardcoded placeholders (FR-042).
- **Files:** `domain/auth.ts`, `hitl/adapters/bot/messages-handler.ts`,
  `hitl/adapters/bot/conversation-store.ts`, `hitl/identity.ts`,
  `adapters/keycloak-broker.ts`, `adapters/graph-capability.ts`
- **new_tests_required:** dagId→real-client resolution; HITL non-member click refused
  (parity with HTTP path, SC-006); Dynamics targets configured org host, scoped read.
- **depends_on:** Phase 1, Phase 2, Phase 3

### Phase 5: Live verification + ADRs — Wave F (depends on real tenant)

- Run spikes #1–3 to PASS (or PARTIAL-with-fallback).
- Execute Appendix A provisioning runbook.
- Assert `fugue-agents` shows 0 secrets / 0 certs (federation only; SC-011).
- e2e the agent + user paths against the live tenant.
- Record the AD-1…AD-8 decisions as ADRs (immutable "why").
- **Files:** none (ops/manual) + ADR docs
- **new_tests_required:** manual runbook acceptance + sign-in-log evidence; no automated tests.
- **depends_on:** Phase 4 (+ live tenant)

---

## Testing Strategy

| Component | Unit Tests (pure, no mocks) | Integration Tests (recorded fake transport) | Property Tests |
|-----------|-----------------------------|----------------------------------------------|----------------|
| Config extension | tenant+client pairing; creds JSON validation | — | — |
| Shared transports | — | form-POST body + status surfaced; Graph bearer presented | — |
| Realm JWT verifier | — | valid → `SignatureVerifiedClaims`; bad-sig → `invalid`; JWKS-down → `unavailable` | — |
| Agent client credentials | hit returns cred; miss → undefined (fail-closed) | — | — |
| Keycloak token endpoint | `buildClientCredentialsBody`/`buildExchangeV2Body` exact body + no extra params; `mapKeycloakTokenResponse` status→Result | no-egress on creds-miss; 4xx → denied; exchangeV2 fail-close on undefined subjectToken | — |
| Broker selection (AD-3) | — | picks live-vs-stub by config presence; warns once | — |
| User inbound authz | `teams` parse (valid/non-array/non-string/missing → fail-closed); `authorizeUserRun` member/non-member | — | any user ∉ team ⇒ `canAccessDag` false (SC-005) |
| User downstream exchange | — | user-branch sets subjectToken, agent-branch never; sub=user/azp=agent | — |
| Hardening | dagId→real client; Dynamics org host | HITL non-member click refused (SC-006) | — |
| Cross-repo realm | — | — | golden: `teams` multivalued/access-token-only + agent scope mirror (FR-053, SC-008) |

**Must stay green:** SC-006/007/008/010/011/012 (existing host SC-invariant tests).
**Boot matrix:** (a) no config → byte-identical static path (SC-001);
(b) issuer-only → warn "verifier not wired"; (c) full config → live, no warn.
**Measurement:** unit/property/integration with recorded-call fakes (no live
network) for the host; golden-export for the realm; manual runbook + sign-in-log
evidence for Phase 5.

---

## Security & NFR Notes

- **Security trust boundary added** at the host inbound + capability-mint seams —
  `/security-expert` review is **required** on Phase 2 (teams-claim parse + authz)
  and Phase 3 (subject-token threading + exchangeV2). These are the load-bearing
  changes.
- **Cross-repo byte-match** (FIC issuer/subject/audience, `teams` claim shape):
  SSOT Appendix C is the single source; golden-test the realm side; host parses
  defensively. Spike #2 negative control (case-flip → `AADSTS70021`).
- **App-only `.default` token cannot be per-request downscoped** — containment is
  Entra resource-scoping (`Sites.Selected`, Exchange policy, Dataverse role);
  spike #3 must prove *denial*, not just coverage.
- **`teams`-claim fragility (AD-1):** a future non-team realm role would leak into
  `teams`. Mitigated by reserving the realm-role namespace for teams + the groups
  escape hatch; flag in the realm README.
- **NFR-014/NFR-011:** agent client secrets/tokens never logged; no raw token or
  broad client reachable from a capability handle (SC-007).
- **NFR-013:** identical requests de-duped by `(identity, audience, scope)` within
  token lifetime (SC-008) — handled by existing token cache, unchanged.

---

## Verification

1. `bun run typecheck` passes.
2. `bun test packages/host` passes, including the six SC-invariant tests
   (SC-006/007/008/010/011/012).
3. Project linter passes with zero violations (no bare throw, no catch-ignore, no
   `as any`, no raw-string ids) — SC-003.
4. Realm: `nix develop --command bash -c 'cd java-configuration && mvn test'` —
   `FuguePlatformRealmGoldenTest` green.
5. Boot matrix manual check: no-config → byte-identical static path; partial →
   exactly one naming warning; full → live, no warn.
6. Phase 5 (live): runbook acceptance + `fugue-agents` 0-secrets/0-certs + four
   spikes PASS/PARTIAL-with-fallback recorded.
