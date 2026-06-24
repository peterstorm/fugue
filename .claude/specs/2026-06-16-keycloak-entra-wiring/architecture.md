# Architecture Design: Keycloak/Entra Capability-Broker Wiring

**Spec:** `.claude/specs/2026-06-16-keycloak-entra-wiring/spec.md`
**Canonical design:** `docs/team-security-and-capabilities.md` (§4/§5/§7), ADRs 0051–0061
**Date:** 2026-06-16

## Summary

Additive wiring of already-merged, fail-closed pure core into live security paths,
across two repos: `packages/host` (TS) and the `fugueplatform` realm
config-as-code (`~/dev/java/keycloakConfigAsCode`, Java). Every new piece is an
**adapter implementing an existing port** or a **claim/config addition** —
no rewrite of the functional core. The governing invariant is *config-presence
gating* (AD-3): each leg goes live only when its config is present, otherwise the
fail-closed stub stays. This preserves SC-001 (zero-regression boot) at every
step.

## Markers resolved (the architect's call)

- **M1 — team modeling = realm roles (role name == team name).** Reuses the
  existing `IdpPlanBuilder.claimToRoleMapper` (Azure group GUID → realm role) seen
  in `toolbox/steps/AzureIdpStep.java`, plus a single `oidc-usermodel-realm-role-mapper`
  protocol mapper emitting `teams: string[]` (multivalued, access-token-only).
  Safe because `fugueplatform` is a greenfield realm whose realm-role namespace is
  **reserved for teams** — the role mapper emits all realm roles, which are all
  teams. *Escape hatch:* if non-team realm roles ever appear, switch the `teams`
  claim to a group-membership mapper (groups model membership more precisely) — a
  localized change to one mapper + the IdP join mapper, no host change.
- **M2 — roster = seed `business-sales` only.** The team→Azure-group GUID map is
  **per-environment config** (mirroring `azureConfig.adminGroupId()`), not
  hardcoded. Builder + golden test designed for N teams; one seeded.

## Domain model (additions only)

The functional core already owns the domain types. New/extended concepts:

| Concept | Kind | Where | Note |
|---|---|---|---|
| `teams: readonly string[]` | value (claim field) | `domain/auth.ts` `RealmJwtClaims` | parsed defensively in `domain/jwt-validation.ts` |
| `SubjectToken` | branded value | `domain/auth.ts` | raw verified user JWT, host-side only; never crosses the framework port |
| `KeycloakClientCredential` | value | `adapters/agent-client-credentials.ts` | `{ clientId, clientSecret }`; resolved by port, never logged |
| `AgentClientCredentials` | port | `adapters/agent-client-credentials.ts` | `(AgentClientId) → KeycloakClientCredential \| undefined` |
| Team (realm) | entity (cross-repo) | `fugueplatform` realm | a realm role; identity = role name = team name |

No new aggregates. `AuthIdentity` (discriminated union: admin/team/user) and the
`CapabilityBroker` port are unchanged in shape — only the `user` variant gains a
`subjectToken` field (Phase 3) and `RealmJwtClaims` gains `teams` (Phase 2).

## Component design (by phase = wave)

All TS adapters follow the established split: **pure helpers** (`build*Body` /
`map*Response`, unit-tested, network-free) + a **thin adapter** that injects the
transport. Mirror `adapters/entra-wif.ts` exactly (it already does this).

### Phase 0 — Foundations (no deps)

| Component | File | Shape |
|---|---|---|
| Config extension | `domain/config.ts` | add `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `KEYCLOAK_TOKEN_URL?`, `KEYCLOAK_AGENT_CLIENT_CREDENTIALS` (JSON, sensitive), `DYNAMICS_ORG_HOST?`; Zod `superRefine` pairs tenant+client, validates creds JSON. Mirror existing `AGENT_CLIENT_SCOPES` transform (config.ts:96). |
| Shared form-POST transport | `adapters/fetch-http-post.ts` | `createFetchHttpPost(): HttpPost` — used by both WIF + Keycloak (AD-2). Inject `fetch` for tests. |
| Graph transport | `adapters/fetch-graph-http.ts` | `createFetchGraphHttp(): GraphHttp` — bearer GET/POST, absolute URL. |
| Realm JWT verifier | `adapters/realm-jwt-verifier.ts` | `createRealmJwtVerifier({issuer}): VerifyRealmJwt` via `jose.createRemoteJWKSet` → `markSignatureVerified`. Signature only. Mirror `hitl/adapters/bot/verify.ts` (AD-4). |
| Agent creds | `adapters/agent-client-credentials.ts` | `AgentClientCredentials` port + env-map adapter from `KEYCLOAK_AGENT_CLIENT_CREDENTIALS`; miss → `undefined` (fail-closed, AD-1). |
| Docs | `.env.example` | all Entra/Keycloak/Bot/HITL vars + comments. |

### Phase 1 — Agent path end-to-end (deps: P0)

| Component | File | Shape |
|---|---|---|
| Live Keycloak endpoint | `adapters/keycloak-token-endpoint-http.ts` | `createKeycloakTokenEndpoint(deps): KeycloakTokenEndpoint`; pure helpers `buildClientCredentialsBody(req, cred)`, `buildExchangeV2Body(req, cred)`, `mapKeycloakTokenResponse(audience, res)`. Uses `createFetchHttpPost`. |
| AD-3 gating | `host.ts` `selectCapabilityBroker` | swap each unwired stub for its live adapter **iff** its config present: live endpoint ⇐ `KEYCLOAK_AGENT_CLIENT_CREDENTIALS`; live WIF ⇐ `ENTRA_TENANT_ID`+`ENTRA_CLIENT_ID`; live Graph ⇐ alongside WIF. Else stub + one boot warn. |

`createEntraWifExchange` and the Graph builders already exist (LIVE) — Phase 1 only
*wires* them. Outcome: agent run with a granted `requires` mints end-to-end;
un-granted refused at Keycloak hop, zero Entra egress (SC-006/NFR-010).

### Phase 1′ — HITL go-live (deps: P0 `.env.example`; parallel with P1)

No code. Provision Azure Bot + Entra app (`BOT_APP_ID`/`BOT_APP_PASSWORD`,
endpoint → `POST /teams/messages`), smoke-test suspend→card→approve→resume.

### Phase 2 — User inbound (deps: P0 verifier + realm `teams` claim)

| Component | File | Shape |
|---|---|---|
| `teams` claim | `domain/auth.ts` `RealmJwtClaims` | add `readonly teams: readonly string[]`. |
| Defensive parse | `domain/jwt-validation.ts` | in `validateRealmJwtClaims`, parse `teams` mirroring the `aud`-array pattern (array of non-empty strings; malformed → `err({kind:"malformed"})`). No Zod — module stays pure. |
| Authz wiring | `host.ts` | `routerDeps.realmJwt = { verify: createRealmJwtVerifier(...), expectedIss, expectedAud, authorizeUserRun: (u, dagTeam) => u.teams.includes(dagTeam) }`. `authorizeUserRun` is a **required** member (compiler forces the decision — AD-5). |

`canAccessDag` user branch (auth.ts) already delegates to `canRunDag`; the check
already runs before concurrency acquire (SC-005 holds). Admin + `fug_` paths
untouched (FR-023).

### Phase 3 — User downstream exchange (deps: P1 + P2)

| Component | File | Shape |
|---|---|---|
| Capture subject token | `domain/auth.ts` | add `subjectToken: SubjectToken` to the `user` `AuthIdentity`; brand the raw verified JWT. |
| Thread host-side | `run-context.ts` (run-context factory) | store `runId → SubjectToken` when the shell builds context. |
| Broker dep | `adapters/keycloak-broker.ts` `KeycloakBrokerDeps` | add `resolveSubjectToken: (runId) => SubjectToken \| undefined`; user branch of `saDispatch` passes it. |
| Exchange request | `keycloak-token-endpoint.ts` `ExchangeV2Request` | add **required** `subjectToken`. |
| Real exchangeV2 | `keycloak-token-endpoint-http.ts` | RFC 8693 token exchange presenting the user's JWT as `subject_token` (proof-bearing — never proof-less; FR-030). `sub`=user, `azp`=agent. |

The framework `InvocationOrigin` stays string-only — the token is a host
side-channel (AD-6, FR-032).

### Phase 4 — Hardening (deps: P1–P3)

| Component | File | Shape |
|---|---|---|
| Real client map | `domain/auth.ts` `agentClientIdForDag` | replace identity function with config-mapped `dagId → real client id` (`AGENT_CLIENT_MAP`); re-key `AGENT_CLIENT_SCOPES` + creds on real ids (ADR-0056). |
| HITL approver authz | `hitl/adapters/bot/messages-handler.ts` (+ `conversation-store.ts`, `hitl/identity.ts`) | resolve `from.aadObjectId` → team, authorize vs run's DAG team before recording decision; per-team conversation routing (AD-7, FR-041). |
| Dynamics | `keycloak-broker.ts` + `graph-capability.ts` | per-org host from `DYNAMICS_ORG_HOST` through `audienceForScope` + `buildDynamicsReadHandle`; replace hardcoded placeholders (FR-042). |

### Phase 5 — Live verification (deps: real tenant)

Run spikes #1–3 to PASS, execute Appendix A runbook, assert 0-secrets/0-certs,
e2e the agent + user paths.

### Cross-repo: `fugueplatform` realm (gates P2 only; agent path already done)

In `~/dev/java/keycloakConfigAsCode`, package
`dk.secondbrand.keycloak.configuration.fugueplatform`. **Verified 2026-06-16.**

**Already complete (no work — the agent path + scopes shipped with the original
feature, golden-tested):** pipeline `RealmStep → ClientScopesStep → ClientStep →
ValidationStep`; clients `fugue-frontend` (confidential auth-code SSO, PKCE, mints
`aud: fugue-host`), `fugue-agent-mail`, `fugue-agent-sites` (confidential
service-account); optional scopes `msgraph:mail.send`, `msgraph:sites.read`,
**`dynamics:read`**, `entra-exchange` (mints `aud: api://AzureADTokenExchange`).
So **Phase 1 and the Dynamics *scope* need no realm change** (Dynamics remaining
work is host-side + Entra portal only).

**Missing — required for human login + teams (gates host Phase 2 / Wave C).**
The realm currently has **no `AzureIdpStep` and no `RolesStep`**, so no human can
authenticate yet. New work (mirror `toolbox`):

> Build via `nix develop --command bash -c 'cd java-configuration && mvn ...'`
> (no `mvn`/gradle on PATH).

| Step | Responsibility |
|---|---|
| `RolesStep` (new) | declare one realm role per team (role name == team name, e.g. `business-sales`). |
| `AzureIdpStep` (new) | broker azuread; `claimToRoleMapper("groups", <env group GUID>, "<team>")` per team (forceSync). |
| `teams` protocol mapper (new, in `ClientScopesStep`) | `oidc-usermodel-realm-role-mapper`: `multivalued:true`, `access.token.claim:true`, `id.token.claim:false`, `claim.name:teams`, `jsonType.label:String`. Attach to the `fugue-frontend` client scope. |
| `ValidationStep` (extend) | assert roles present + the `teams` mapper config. |
| Golden test (extend) | `FuguePlatformRealmGoldenTest` asserts `teams` claim multivalued/access-token-only + agent client scopes mirror permissions (FR-053, SC-008). |

## Approach decisions

### A. Transport sharing (AD-2) — **decided: one shared `HttpPost`**
Both Keycloak and Entra POST `application/x-www-form-urlencoded` and consume
`{status, json}`. One `createFetchHttpPost` reused → one place for
timeout/retry/TLS. Graph differs (bearer, GET/POST, absolute URL) → its own
`createFetchGraphHttp`. Rejected: per-adapter `fetch` (breaks the injected-port
invariant that keeps tests network-free).

### B. `teams` parsing — **decided: defensive parse in the pure validator, no Zod**
`jwt-validation.ts` is a pure domain module that already hand-parses
`iss/aud/exp/sub/azp` defensively. Add `teams` the same way (mirror the `aud`
array branch). Zod lives at the config boundary, not in this module. Keeps the
parse-don't-validate seam in one place and the module dependency-free.

### C. Config gating vs feature flag (AD-3) — **decided: config presence**
Each leg lights up independently as provisioned; every partial state stays
provably fail-closed. Rejected: a single `CAPABILITY_MINTING_ENABLED` flag (forces
all egresses live at once — the four-spike gate forbids it).

### D. Roles vs groups (M1) — **decided: realm roles**, see Markers above.

## Test strategy

- **Unit (pure, no mocks):** `buildClientCredentialsBody`/`buildExchangeV2Body`
  exact body + no-extra-params; `mapKeycloakTokenResponse` status→Result;
  `teams` parse (valid / non-array / non-string element / missing → fail-closed);
  `authorizeUserRun` member→true / non-member→false; creds hit/miss.
- **Property:** any user ∉ team ⇒ `canAccessDag` false (SC-005).
- **Integration (recorded-call fake transport, no network):** live endpoint
  no-egress on creds-miss + 4xx→denied; verifier valid→`SignatureVerifiedClaims`,
  bad-sig→`invalid`, JWKS-down→`unavailable`; Graph bearer presented; broker
  user-branch sets `subjectToken`, agent-branch never does; exchangeV2 fail-closes
  when `resolveSubjectToken` undefined; `selectCapabilityBroker` picks
  live-vs-stub by config presence + warns once.
- **Golden (Java):** `FuguePlatformRealmGoldenTest` — `teams` mapper shape + agent
  scope mirror.
- **Must stay green:** SC-006/007/008/010/011/012.
- **Boot matrix:** (a) no config → byte-identical static path; (b) issuer-only →
  warn "verifier not wired"; (c) full config → live, no warn.

## Risks & concerns

- **Security trust boundary added** at the host inbound + capability-mint seams →
  recommend a `/security-expert` pass on Phase 2/3 before merge (subject-token
  threading + JWT path are the load-bearing changes).
- **Cross-repo byte-match** (FIC issuer/subject/audience, `teams` claim shape):
  SSOT Appendix C is the single source; golden-test the realm side; host parses
  defensively. Spike #2 negative control (case-flip → `AADSTS70021`).
- **App-only `.default` token cannot be per-request downscoped** → containment is
  Entra resource-scoping (`Sites.Selected`, Exchange policy, Dataverse role);
  spike #3 must prove *denial*, not just coverage.
- **`teams`-claim fragility** (M1): a future non-team realm role would leak into
  `teams`. Mitigated by reserving the realm-role namespace for teams + the groups
  escape hatch; flag in the realm README.

## Next steps (implementation order → loom waves)

1. **Wave A = Phase 0** (parallelizable: config, 2 transports, verifier, creds,
   `.env.example`). Unblocks everything.
2. **Wave B = Phase 1** (Keycloak endpoint + AD-3 gating) **‖ Phase 1′** (HITL ops)
   **‖ realm `RolesStep`+`AzureIdpStep`+`teams` mapper** (cross-repo, unblocks P2).
3. **Wave C = Phase 2** (teams claim + authz wiring).
4. **Wave D = Phase 3** (subject-token threading + real exchangeV2).
5. **Wave E = Phase 4** (real client map, HITL authz, Dynamics).
6. **Wave F = Phase 5** (live verification — gated on tenant + spikes).

Hand off to `/loom` for wave decomposition; security-expert review on Waves C/D.
