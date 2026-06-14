# Plan: Complete Keycloak/Entra capability minting + HITL Teams approvals

**Spec anchors:** US4–US8, FR-W3-006..009, FR-W4-001..006, FR-X-002, SC-006..012, ADR-0055..0060
**Created:** 2026-06-14
**Status:** proposal — awaiting decisions in "Open Decisions" before implementation

## Summary

The merged PRs (#16 identity-scoped-capabilities, #17 HITL Teams approvals) landed all the
*pure core, ports, audit, caching, and fail-closed wiring*. What is missing is the **live I/O
adapters at the three Entra/Keycloak egresses**, the **JWKS realm-JWT verifier**, the **subject-token
threading** for user-initiated exchange, and a single **HITL per-team authorization gap** on the
Teams-button path — plus the out-of-band Azure/Keycloak provisioning. Everything currently fails
closed (no silent successes), so this is *additive wiring*, not a rewrite: every seam already exists
as an injected port with a recorded-call fake.

The work is asymmetric:
- **HITL** is code-complete. It needs Azure Bot provisioning, the Teams-button authz gap closed,
  and `.env.example`/docs.
- **Keycloak/Entra** has its broker plumbing merged but cannot yet mint a single downstream token —
  the Keycloak token endpoint has *no* live HTTP adapter, the Entra WIF adapter exists but is
  unwired, the Graph transport is unwired, and the user inbound JWT path is verifier-less.

---

## Current State (verified 2026-06-14)

| Component | File | State | Gap |
|---|---|---|---|
| Capability broker (pure) | `adapters/keycloak-broker.ts` | WIRED | — |
| Auth domain + JWT validation (pure) | `domain/auth.ts`, `domain/jwt-validation.ts` | WIRED | — |
| Token cache, audit, scope-narrow (pure) | `domain/token-cache.ts`, `adapters/broker-audit.ts`, `domain/capability-scope.ts` | WIRED | — |
| Auth middleware (accepts `RealmJwtDeps`) | `http/middleware/auth.ts` | WIRED | `realmJwt` left `undefined` at boot |
| Keycloak token endpoint | `adapters/keycloak-token-endpoint.ts` (port) + `unwired-token-endpoint.ts` | **STUB ONLY** | no live HTTP adapter exists |
| Entra WIF exchange | `adapters/entra-wif.ts` (`createEntraWifExchange`) | **LIVE, UNWIRED** | never called outside tests; boot uses `createUnwiredEntraWifExchange` |
| Graph HTTP transport | `adapters/graph-capability.ts` (`GraphHttp` port + builders) | **STUB ONLY** | boot uses `createUnwiredGraphHttp` |
| Realm JWT JWKS verifier (`VerifyRealmJwt`) | port in `http/middleware/auth.ts` | **MISSING** | no JWKS adapter; only fakes |
| `authorizeUserRun` policy | `RealmJwtDeps.authorizeUserRun` | **MISSING** | no decision wired |
| Subject-token threading (user exchange) | n/a | **MISSING** | `ExchangeV2Request` carries only `userSub` (ADR-0058 amendment gap) |
| dagId→Keycloak client mapping | `domain/auth.ts` `agentClientIdForDag` | **PLACEHOLDER** | identity function (ADR-0056) |
| Dynamics/Dataverse | `keycloak-broker.ts:154`, `graph-capability.ts:236` | **PLACEHOLDER** | hardcoded host |
| Entra config (`ENTRA_TENANT_ID`/`ENTRA_CLIENT_ID`) | `domain/config.ts` | **MISSING** | not in schema |
| HITL durable suspend/resume + stores | `hitl/**` | WIRED (Redis/BullMQ) | — |
| HITL Bot connector / inbound verify / endpoint | `hitl/adapters/bot/**`, `http/router.ts` | WIRED | needs Azure Bot provisioned |
| HITL Teams-button per-team authz | `hitl/adapters/bot/messages-handler.ts` | **v1 GAP** | any channel member can approve any team's run |
| `.env.example` HITL/Entra vars | `.env.example` | **MISSING** | only foundation vars documented |

---

## Architectural Decisions

### AD-1: How the host authenticates as each agent's Keycloak client (`client_credentials`)

**Choice:** A new **`AgentClientCredentials` port** — `(AgentClientId) → KeycloakClientCredential | undefined`
— resolved from a config map `KEYCLOAK_AGENT_CLIENT_CREDENTIALS` (JSON `{ clientId: clientSecret }`),
injected into the live token-endpoint adapter. A miss is **fail-closed** (`policy-refusal`-shaped, no egress).

**Why:** Each agent client is a *confidential service-account client* (plan §"Per-agent dimension",
runbook Step 8 — `client-credentials only`). To mint a token **AS** `fugue-agent-mail`, the host must
present that client's secret. The one-host-per-team deployment model (PR #13) means a single host owns
only a small, fixed set of agent clients, so a config/secret-store map is sufficient — not multi-tenant
resolution. Keeping it a **port** lets a Vault/secret-store adapter replace the env map later with no
broker change, and lets tests inject a fake.

**Rejected:**
- *One shared host service account for all agents* — collapses the per-agent trust boundary the whole
  feature exists to create; `azp` audit would lie.
- *Secret carried in `ClientCredentialsRequest`* — leaks credential material across the port surface and
  into the broker; the adapter should resolve it privately by `agentClientId`.

### AD-2: One shared fetch transport for all OAuth form POSTs

**Choice:** A single `createFetchHttpPost(): HttpPost` adapter (`adapters/fetch-http-post.ts`) implementing
the existing `HttpPost` port (`entra-wif.ts`), reused by **both** the Entra WIF exchange **and** the new
Keycloak token endpoint. Graph gets its own `createFetchGraphHttp(): GraphHttp` (different shape — bearer +
GET/POST + absolute URL).

**Why:** `EntraWifExchange` and the Keycloak token endpoint both POST `application/x-www-form-urlencoded`
and consume `{ status, json }`. One transport, one place for timeout/retry/TLS posture. The bot connector
and webhook notifier already prove the fetch-adapter pattern in this codebase; this just factors the
form-POST half into a named port impl instead of a fourth ad-hoc `fetch`.

**Rejected:** *Hardcoded `fetch` inside each adapter* — breaks the "every egress is an injected port"
invariant that makes the security tests network-free.

### AD-3: Staged go-live via config presence, not a flag

**Choice:** `selectCapabilityBroker` swaps each unwired stub for its live adapter **only when that
adapter's config is present**: live Keycloak endpoint when `KEYCLOAK_AGENT_CLIENT_CREDENTIALS` is set,
live WIF when `ENTRA_TENANT_ID`+`ENTRA_CLIENT_ID` are set, live Graph alongside live WIF. Absent config →
keep the current fail-closed stub + one-time boot warn (today's behaviour).

**Why:** Lets the agent path, the user path, and the Entra leg light up **independently** as each is
provisioned and spike-verified, without a big-bang cutover. Mirrors the existing `REALM_JWT_ISSUER`-gated
broker selection. Each partially-wired state stays provably fail-closed.

**Rejected:** *Single `CAPABILITY_MINTING_ENABLED` flag* — forces all three egresses live at once, which
the four-spike provisioning gate explicitly forbids.

### AD-4: Realm JWT verifier mirrors the Bot token verifier

**Choice:** `createRealmJwtVerifier({ issuer })` builds a `VerifyRealmJwt` using `jose.createRemoteJWKSet`
against `<issuer>/.well-known/openid-configuration` → `jwks_uri`, then `markSignatureVerified(claims)`.
Structurally identical to `hitl/adapters/bot/verify.ts` (lazy JWKS cache, infra-vs-invalid classification,
fail-closed).

**Why:** The pattern is already in the repo, reviewed, and `jose@^6` is a host dependency. The verifier
port (`VerifyRealmJwt`) and its branded output (`SignatureVerifiedClaims`) already exist; only the live
producer is missing. Claim policy (iss/aud/exp) is *already* done in `domain/jwt-validation.ts` — the
adapter does **signature only**, then hands off.

**Rejected:** *Hand-rolled JWKS fetch + RS256 verify* — re-implements what `jose` (already used by the bot
path) does correctly, including key rotation.

### AD-5: `authorizeUserRun` from a realm-role/group claim (recommended) vs. allow-map

**Choice (recommended):** Extend `RealmJwtClaims` with an optional `teams: readonly string[]` claim
(sourced from a Keycloak realm-role or group mapper), and implement `authorizeUserRun(user, dagTeam) =>
user.teams.includes(dagTeam)`. The mapping is data on the verified token, so the host stays stateless.

**Why:** Keeps the authorization decision in the IdP (where team membership lives) rather than a second
store the host must keep in sync. The middleware already brands the principal; adding one claim is the
smallest correct surface. `authorizeUserRun` is a **required** member of `RealmJwtDeps` — the compiler
forces this decision at the wiring site, so it can't be silently `() => true`.

**Rejected:**
- *Redis-backed user→teams grant store* — viable, but adds a sync/ops burden and an I/O hop in the auth
  hot path; defer unless team membership must be host-local.
- *`() => true`* — explicitly forbidden by the wiring-site comment (latent any-user-runs-any-DAG grant
  consuming the team's concurrency/LLM/circuit budget).

### AD-6: Subject-token threading is a host-side side-channel, never the framework origin

**Choice:** Carry the **raw verified user JWT** host-side: capture it on the `user` `AuthIdentity` as a
branded `SubjectToken`, store it in a per-run map (`runId → SubjectToken`) when the shell builds the
context, and add `resolveSubjectToken: (runId) => SubjectToken | undefined` to `KeycloakBrokerDeps`. The
live `exchangeV2` reads it; `ExchangeV2Request` gains a required `subjectToken`. The framework
`InvocationOrigin` stays string-only (`sub`/`agentClientId`).

**Why:** ADR-0058 Amendment (2026-06-12) is explicit: a real Standard Token Exchange V2 must present the
user's **actual verified JWT** as `subject_token` proof, and the live adapter MUST NOT be a proof-less
impersonation grant. The framework port must not depend on a host Keycloak concern, so the token cannot
ride the origin. A per-run host-side channel is the documented landing spot.

**Rejected:**
- *Proof-less "mint a token claiming this sub"* — silently discards the sub-preserving proof; explicitly
  forbidden by the port contract.
- *Putting the token on `InvocationOrigin`* — leaks a host credential across the framework seam.

### AD-7: Close the HITL Teams-button per-team authz gap by reusing the HTTP path's check

**Choice:** In `messages-handler.ts`, before recording a button decision, resolve the **approver's AAD
identity** (from the verified inbound activity's `from.aadObjectId`) to fugue team membership and authorize
against the run's DAG team — the same isolation check `runs.ts` already applies on the HTTP approve path.
Pair with per-team conversation routing (store conversation references keyed by team, not one default).

**Why:** Today the HTTP approval path authorizes the caller against the DAG team, but the Teams-button path
does not — any member of the single default channel can approve any team's run (ADR-0060 v1 consequence).
Closing it makes the two approval surfaces enforce the *same* policy.

**Rejected:** *Ship single-channel only and document the limit* — acceptable **only** if the deployment is
single-team-per-channel; surfaced as an Open Decision.

---

## File Structure

### New adapters (Imperative Shell — `infra`/`adapters`)

```
packages/host/src/adapters/fetch-http-post.ts            — createFetchHttpPost(): HttpPost (form POST → {status,json})
packages/host/src/adapters/fetch-http-post.test.ts       — transport reject → throws; status/json passthrough
packages/host/src/adapters/keycloak-token-endpoint-http.ts        — createKeycloakTokenEndpoint(cfg, http, creds): live impl
packages/host/src/adapters/keycloak-token-endpoint-http.test.ts   — body shape + response mapping (pure helpers)
packages/host/src/adapters/fetch-graph-http.ts           — createFetchGraphHttp(): GraphHttp (bearer GET/POST)
packages/host/src/adapters/fetch-graph-http.test.ts      — bearer presented; status/json passthrough
packages/host/src/adapters/realm-jwt-verifier.ts         — createRealmJwtVerifier({issuer}): VerifyRealmJwt (JWKS)
packages/host/src/adapters/realm-jwt-verifier.test.ts    — valid → SignatureVerifiedClaims; infra → unavailable
packages/host/src/adapters/agent-client-credentials.ts   — AgentClientCredentials port + env-map adapter
packages/host/src/adapters/agent-client-credentials.test.ts
```

### Pure helpers (Functional Core — co-located, exported for test)

```
adapters/keycloak-token-endpoint-http.ts exports:
  buildClientCredentialsBody(req, cred)   — URL-encoded grant body (pure)
  buildExchangeV2Body(req, cred)          — RFC 8693 token-exchange body incl. subject_token (pure)
  mapKeycloakTokenResponse(audience, res) — {status,json} → Result<MintedToken, FrameworkError> (pure)
```
(Mirror `entra-wif.ts`'s `buildWifFormBody` / `mapWifResponse` split exactly.)

### Domain changes (Functional Core)

```
packages/host/src/domain/auth.ts            — add branded SubjectToken; add `subjectToken` to `user` AuthIdentity
                                              — replace agentClientIdForDag placeholder with config-mapped lookup (AD, Phase 4)
packages/host/src/domain/auth.ts            — extend RealmJwtClaims with optional `teams` claim (AD-5)
packages/host/src/domain/jwt-validation.ts  — surface `teams` on AuthenticatedUser (parse-don't-validate)
packages/host/src/domain/run-context.ts     — NodeContextForDag carries optional SubjectToken (user runs)
packages/host/src/domain/config.ts          — new env: ENTRA_TENANT_ID, ENTRA_CLIENT_ID, KEYCLOAK_TOKEN_URL?,
                                              KEYCLOAK_AGENT_CLIENT_CREDENTIALS, (Phase 4) AGENT_CLIENT_MAP, DYNAMICS_ORG_HOST?
```

### Wiring (composition root)

```
packages/host/src/host.ts        — selectCapabilityBroker: swap 3 unwired stubs for live adapters (AD-3)
                                  — routerDeps.realmJwt: wire verifier + iss/aud + authorizeUserRun (Phase 2)
                                  — KeycloakBrokerDeps.resolveSubjectToken + per-run token map (Phase 3)
packages/host/src/adapters/keycloak-broker.ts — saDispatch user branch passes subjectToken; deps gain resolveSubjectToken (Phase 3)
```

### HITL authz (Phase 4)

```
packages/host/src/hitl/adapters/bot/messages-handler.ts  — authorize approver AAD identity vs run's DAG team
packages/host/src/hitl/adapters/bot/conversation-store.ts — per-team conversation reference routing
packages/host/src/hitl/identity.ts                        — AAD object id → fugue team mapping (new port + adapter)
```

### Docs / ops

```
.env.example                                              — add HITL/Bot/Entra/Keycloak vars with comments
docs/runbooks/2026-06-10-entra-fugue-agents-provisioning.md — run spikes #1–#3 to PASS; provision fugue-agents app
docs/hitl-teams.md                                        — update v1-gap note once AD-7 lands
```

---

## Component Design

### `createFetchHttpPost` — shared form-POST transport
**Responsibility:** POST URL-encoded body, return `{ status, json }`; reject only on transport failure.
**Interface:**
```
createFetchHttpPost(opts?: { timeoutMs?: number }): HttpPost   // HttpPost from entra-wif.ts
```
**Depends on:** none (fetch). Reused by WIF + Keycloak endpoint.

### `createKeycloakTokenEndpoint` — live Keycloak authority
**Responsibility:** mint `client_credentials` AS the agent client (agent path); Standard Token Exchange V2
of the user's JWT (user path). Both narrowed to `scope`/`audience`. Never throws across the boundary.
**Interface:**
```
createKeycloakTokenEndpoint(
  cfg:  { tokenUrl: string },                 // derived from REALM_JWT_ISSUER or explicit
  http: HttpPost,
  creds: AgentClientCredentials,              // AD-1
): KeycloakTokenEndpoint                       // { mintClientCredentials, exchangeV2 }
```
**Behaviour:** `mintClientCredentials` resolves the agent client's secret via `creds`; a miss →
`policy-refusal`/`infra-unreachable` with **zero egress**. `exchangeV2` requires `req.subjectToken`
(grant_type `urn:ietf:params:oauth:token-exchange`, `subject_token=<user JWT>`,
`requested_token_type` access-token, `audience`/`scope` narrowing). Response mapping mirrors `mapWifResponse`:
4xx → `downstream-denied`; 429/503 named; other → `infra-unreachable`.
**Depends on:** `HttpPost`, `AgentClientCredentials`.

### `createFetchGraphHttp` — live Graph transport
**Responsibility:** drive `GraphRequest` (method/url/bearer/body) → `{ status, json }`; reject on transport
failure (the pure `runGraph` fence in `graph-capability.ts` maps the rest).
**Interface:** `createFetchGraphHttp(opts?): GraphHttp`
**Depends on:** none. The operation builders (`buildMailSendHandle`, …) are already done.

### `createRealmJwtVerifier` — JWKS signature verifier
**Responsibility:** verify a realm JWT's signature against the realm JWKS; on success return
`markSignatureVerified(claims)`; classify failures `invalid` (401) vs `unavailable` (503). **Signature
only** — iss/aud/exp stay in `validateRealmJwtClaims`.
**Interface:** `createRealmJwtVerifier(cfg: { issuer: string }): VerifyRealmJwt`
**Depends on:** `jose` (dynamic import, like the bot verifier).

### `AgentClientCredentials` — confidential-client secret resolver (AD-1)
**Interface:**
```
type KeycloakClientCredential = { readonly clientId: string; readonly clientSecret: string };
type AgentClientCredentials = (agentClientId: AgentClientId) => KeycloakClientCredential | undefined;
createEnvAgentClientCredentials(map: Record<string, string>): AgentClientCredentials   // fail-closed
```

### `SubjectToken` threading (AD-6, Phase 3)
**Interface:**
```
type SubjectToken = string & { readonly __brand: "SubjectToken" };   // domain/auth.ts
// AuthIdentity.user gains: readonly subjectToken: SubjectToken
// KeycloakBrokerDeps gains: readonly resolveSubjectToken: (runId: string) => SubjectToken | undefined
// ExchangeV2Request gains:  readonly subjectToken: string  (required; live adapter fail-closes if absent)
```

---

## Data Flow

**Agent-initiated (team/admin token) — Phase 1 target:**
```
team token → auth mw (team identity) → invocationOriginForIdentity → origin{agent, agentClientId}
  → runDag(minting) → broker.mintFor → policy gate (assignedScopes) → [assigned]
  → KeycloakTokenEndpoint.mintClientCredentials(creds.secret) → SA token
  → EntraWifExchange.exchange(SA token as client_assertion) → app-only Graph token
  → buildGraphHandle → node calls sendMail via GraphHttp.request
```

**User-initiated (OIDC JWT) — Phase 2+3 target:**
```
realm JWT → auth mw: createRealmJwtVerifier (signature) → validateRealmJwtClaims (iss/aud/exp)
  → authorizeUserRun(user, dagTeam) → user identity{sub, azp, subjectToken, canRunDag}
  → origin{user, sub, agentClientId=dagId} ; subjectToken stored runId→token (host side)
  → broker.mintFor → policy gate → KeycloakTokenEndpoint.exchangeV2(subjectToken) → user-preserving SA token
  → EntraWifExchange → app-only token → handle
```

---

## Implementation Phases

Ordered by dependency. Items within a phase are independent (parallelizable).

### Phase 0: Foundations (no dependencies)
- Add Entra/Keycloak env to `config.ts` schema + `superRefine` pairing (tenant+client together; creds JSON valid).
- `createFetchHttpPost` (`HttpPost`) + tests.
- `createFetchGraphHttp` (`GraphHttp`) + tests.
- `createRealmJwtVerifier` (`VerifyRealmJwt`) + tests.
- `AgentClientCredentials` port + env-map adapter + tests.
- `.env.example`: add all HITL/Bot/Entra/Keycloak vars with comments.
- **Files:** `config.ts`, `fetch-http-post.ts`, `fetch-graph-http.ts`, `realm-jwt-verifier.ts`,
  `agent-client-credentials.ts` (+ tests), `.env.example`.

### Phase 1: Keycloak/Entra **agent path** end-to-end (depends on Phase 0)
- `createKeycloakTokenEndpoint` live impl + pure body/response helpers + tests.
- `selectCapabilityBroker`: swap the three unwired stubs for live adapters under AD-3 config gating.
- **Outcome:** an agent-initiated run with `requires:["msgraph:mail.send"]` mints a real token end-to-end
  (against a provisioned tenant). Until provisioning lands, integration tests use recorded-call fakes.
- **Files:** `keycloak-token-endpoint-http.ts` (+ test), `host.ts`.

### Phase 1′: HITL go-live (independent of Keycloak; can run in parallel)
- Provision Azure Bot + Entra app (out-of-band, see runbook H-1 below); set `BOT_APP_ID`/`BOT_APP_PASSWORD`,
  messaging endpoint → `POST /teams/messages`, install bot in a Teams channel.
- Smoke-test a suspend → card → approve → resume cycle.
- **Files:** none (ops) — code is ready.

### Phase 2: User inbound path (depends on Phase 0 verifier)
- Extend `RealmJwtClaims`/`AuthenticatedUser` with `teams` (AD-5); update `jwt-validation.ts`.
- Wire `routerDeps.realmJwt`: `verify` = `createRealmJwtVerifier`, `expectedIss`/`expectedAud` from config,
  `authorizeUserRun` = team-membership check.
- **Outcome:** user JWTs accepted; DAG execution + static capabilities authorized per team. (Downstream
  user→Graph exchange still fails closed until Phase 3.)
- **Files:** `auth.ts`, `jwt-validation.ts`, `host.ts`.

### Phase 3: User **downstream** exchange (depends on Phase 1 + Phase 2)
- Capture `SubjectToken` on the `user` identity (auth mw already holds the raw token).
- Thread runId→SubjectToken host-side; add `resolveSubjectToken` to `KeycloakBrokerDeps`;
  `saDispatch` user branch passes it; `ExchangeV2Request.subjectToken` required.
- Implement `exchangeV2` as a real RFC 8693 token exchange (ADR-0058 amendment — proof-bearing).
- **Files:** `auth.ts`, `run-context.ts`, `keycloak-broker.ts`, `keycloak-token-endpoint-http.ts`,
  `host.ts`.

### Phase 4: Hardening (depends on Phase 1–3)
- **ADR-0056:** replace `agentClientIdForDag` identity function with a config-mapped dagId→real-client-id
  registry; re-key `AGENT_CLIENT_SCOPES` + `KEYCLOAK_AGENT_CLIENT_CREDENTIALS` on real client ids.
- **HITL AD-7:** approver AAD→team authz on the Teams-button path + per-team conversation routing.
- **Dynamics (optional):** per-org Dataverse host from `DYNAMICS_ORG_HOST`; thread through
  `audienceForScope` + `buildDynamicsReadHandle`. *Only if Dynamics is in scope.*
- **Files:** `auth.ts`, `config.ts`, `messages-handler.ts`, `conversation-store.ts`, `hitl/identity.ts`,
  `keycloak-broker.ts`, `graph-capability.ts`.

### Phase 5: Live verification (depends on a real tenant)
- Run spikes #1–#3 to **PASS** (FIC sign-in attribution, sub×FIC match, resource-scoping coverage/denial).
- Execute the provisioning runbook against the tenant; verify 0 secrets / 0 certs on `fugue-agents`.
- e2e: agent run mints+sends mail; user run exchanges+reads a scoped site; out-of-scope denied.

---

## Testing Strategy

| Component | Unit (pure) | Integration (I/O) | Property |
|---|---|---|---|
| `fetch-http-post` | — | transport reject → throws; status/json passthrough (fetch faked) | — |
| Keycloak endpoint helpers | `buildClientCredentialsBody`/`buildExchangeV2Body` exact body; **no extra params**; `mapKeycloakTokenResponse` status→Result | live adapter over recorded-call fake: no-egress on creds-miss; 4xx→denied | — |
| `fetch-graph-http` | — | bearer presented as `Authorization: Bearer`; status/json passthrough | — |
| `realm-jwt-verifier` | classify infra vs invalid | valid token → `SignatureVerifiedClaims`; bad sig → `invalid`; JWKS down → `unavailable` | — |
| `AgentClientCredentials` | hit → cred; miss → undefined (fail-closed) | — | — |
| broker subject-token (Phase 3) | user branch sets `subjectToken`; agent branch never does | exchangeV2 fail-closes when `resolveSubjectToken` returns undefined | — |
| `authorizeUserRun` | member → true; non-member → false | — | any user ∉ team ⇒ `canAccessDag` false |
| HITL approver authz (Phase 4) | AAD→team map; non-member click → refused | button path refuses cross-team approval (parity with HTTP path) | — |
| `selectCapabilityBroker` wiring | live vs stub chosen by config presence (AD-3); warns once | — | — |

**Invariants to preserve (existing tests must stay green):** no-egress-on-refusal (SC-006), per-origin
exchange count (SC-010), `(identity,audience,scope)` dedup (SC-008), no static Entra secret (SC-011), no
raw token reachable from a handle (SC-007).

---

## Security & NFR Notes

- **Trust boundaries:** three injected egress ports keep every security assertion network-free. Do not
  introduce a hardcoded `fetch` in any adapter — route through `HttpPost`/`GraphHttp`.
- **Fail-closed staging (AD-3):** each unwired→live swap is config-gated; a partially-provisioned host
  stays provably fail-closed (assigned-but-unwired → `infra-unreachable`, never a silent success).
- **No static Entra credential (SC-011):** the Keycloak SA token is the `client_assertion`; the WIF body
  builder structurally omits `client_secret`/cert. Preserve this — the new Keycloak-side secret (AD-1) is
  a *Keycloak* client secret for the `client_credentials` mint, never sent to Entra.
- **Subject-token proof (ADR-0058):** `exchangeV2` MUST present the user's real JWT; never a proof-less
  impersonation grant. Fail closed if the subject token is absent.
- **Secret handling:** agent-client secrets (AD-1) and `BOT_APP_PASSWORD` must never be logged; load from
  env/secret store; the `KEYCLOAK_AGENT_CLIENT_CREDENTIALS` value is sensitive.
- **`authorizeUserRun`:** required by type; never `() => true`. Decide AD-5 before wiring Phase 2.
- **HITL authz parity (AD-7):** the Teams-button path must enforce the same per-team isolation as the HTTP
  approve path before any multi-team deployment.

---

## Verification

1. `bun run typecheck` (or workspace tsc) — green across `packages/host`.
2. `bun test packages/host` — all existing + new suites pass; the six SC-invariant tests stay green.
3. `.claude/linter` rules pass (no bare throw, no catch-ignore, no `as any`, no raw-string-ids).
4. Boot the host with: (a) no realm config → static path byte-identical; (b) `REALM_JWT_ISSUER` only →
   broker warns "verifier not wired"; (c) full Entra+Keycloak config → live broker, no warn.
5. **Phase 1/5 manual:** against a provisioned tenant, an agent run sends mail via a minted scoped handle;
   an out-of-scope `requires` is refused with zero egress (check audit log).
6. **Phase 1′ manual:** suspend a HITL DAG, approve the Teams card in-channel, confirm the run resumes.
7. **Phase 3 manual:** a user-initiated run reads a Sites.Selected site it is entitled to; a non-entitled
   site returns `downstream-denied`.

---

## Open Decisions (please confirm before implementation)

1. **`authorizeUserRun` source (AD-5):** realm-role/`teams` claim on the JWT (recommended, stateless) vs a
   Redis-backed user→team grant store?
2. **HITL Teams-button authz (AD-7):** deploy single-team-per-channel now (document the limit) **or** build
   the approver-AAD→team authz + per-team routing in Phase 4?
3. **Dynamics/Dataverse:** in scope, or Graph-only (`msgraph:mail.send` / `msgraph:sites.read`) for now?
4. **Agent-client secrets (AD-1):** env-map JSON acceptable for v1, or wire a secret store (Vault/Azure
   Key Vault) from the start?
5. **Sequencing:** is Phase 1′ (HITL go-live) the priority to land first, given it's the closest to working?
