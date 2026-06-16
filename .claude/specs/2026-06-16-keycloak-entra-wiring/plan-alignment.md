# Plan Alignment Report: Keycloak/Entra Capability-Broker Wiring

**Spec:** `.claude/specs/2026-06-16-keycloak-entra-wiring/spec.md`
**Plan:** `.claude/plans/2026-06-16-keycloak-entra-wiring.md`
**Date:** 2026-06-16

## Summary

The plan provides full, implementer-actionable coverage of every in-scope
requirement in the spec. All six user scenarios, all functional requirements
(FR-001..FR-053), all non-functional requirements (NFR-010..NFR-020), and all
success criteria (SC-001..SC-008) are addressed by a concrete component, file,
phase/wave, and (where applicable) a named test obligation.

Deliberately-deferred requirements (Phase 3 user-exchange FR-030/031/032, Phase 4
hardening FR-040/041/042, cross-repo realm FR-050..053 in Wave B/Phase 1″) are
treated as COVERED because the plan explicitly assigns each to a wave/phase with
files and tests, per the alignment rules. Out-of-scope items (per-team client
resolution, secret store, git-sync subdir scoping, RFC 8693 act-claim,
fugue-agents tier split, BFF/dashboard) were not evaluated and not flagged.

**Total requirements checked:** 41
**Total gaps found:** 0

## Gaps

None. Every in-scope requirement is covered by the plan.

## Coverage

| ID | Description | Status |
|----|-------------|--------|
| US1 | Foundations available for every secured path; fail-closed boot; `.env.example` | Covered — Phase 0 / Wave A (config superRefine, transports, verifier, creds adapter, `.env.example`); boot matrix in Testing Strategy + AD-3 gating |
| US2 | Agent-initiated run reaches a scoped downstream capability | Covered — Phase 1 / Wave B (Keycloak token endpoint + AD-3 broker selection); SC-007 handle-isolation + zero-egress refusal tests |
| US3 | User-initiated run authenticated and authorized per team | Covered — Phase 2 / Wave C (teams parse, `authorizeUserRun` required); `fug_`/admin unchanged (FR-023); fail-closed-when-unwired via AD-3/AD-4 |
| US4 | User-initiated run reaches downstream as the user | Covered — Phase 3 / Wave D (subjectToken side-channel + RFC 8693 exchangeV2; fail-close on missing subject token); Sites.Selected denial via Phase 5 spike #3 |
| US5 | HITL approvals authorized per team | Covered — Phase 4 / Wave E (aadObjectId→team resolution, authorize vs run's DAG team, parity with HTTP path) |
| US6 | Live verification against a real tenant | Covered — Phase 5 / Wave F (spikes #1–3 PASS/PARTIAL, runbook, 0-secrets/0-certs assertion) |
| FR-001 | Accept Entra/Keycloak/Dynamics config; reject inconsistent combos at boot | Covered — Phase 0 config.ts Zod `superRefine` (tenant iff client; creds JSON validates) |
| FR-002 | Live transport for OAuth form-POST + downstream Graph calls | Covered — Phase 0 `createFetchHttpPost` (shared Keycloak+Entra) + `createFetchGraphHttp` (AD-2) |
| FR-003 | Verify realm JWT signature against published keys; leave claim validation to pure validator | Covered — Phase 0 `createRealmJwtVerifier` jose JWKS signature-only (AD-4) |
| FR-004 | Resolve per-agent-client credential by identity; miss is fail-closed | Covered — Phase 0 `AgentClientCredentials` env-map adapter, miss → undefined (fail-closed); hit/miss tests |
| FR-005 | `.env.example` documents every Entra/Keycloak/Bot/HITL var with comments | Covered — Phase 0 `.env.example` task |
| FR-010 | Mint Keycloak SA token via client-credentials, exchange for app-only downstream via WIF | Covered — Phase 1 `createKeycloakTokenEndpoint` + existing `entra-wif.ts`; data flow agent run |
| FR-011 | Per-leg live-adapter selection only when leg config present; no global flag | Covered — Phase 1 `selectCapabilityBroker` AD-3 config-presence gating |
| FR-012 | Ungranted capability refused at Keycloak hop, zero Entra egress | Covered — Phase 1 integration test "no-egress on creds-miss + 4xx→denied"; SC-004 |
| FR-020 | Realm JWT carries team membership multi-valued; host parses defensively (fail-closed on malformed) | Covered — Phase 2 defensive `teams` parse in jwt-validation.ts (AD-7), malformed → err |
| FR-021 | Authorize user run by DAG-owning team vs membership; decision required, non-defaultable | Covered — Phase 2 `authorizeUserRun` required member of `routerDeps.realmJwt` (AD-5) |
| FR-022 | User authz decision stateless, no per-request datastore lookup | Covered — Phase 2 `(u, dagTeam) => u.teams.includes(dagTeam)` derived from verified token only |
| FR-023 | Existing admin and `fug_` team paths continue unchanged | Covered — Phase 2 test "admin + `fug_` paths unchanged"; AuthIdentity union shape preserved |
| FR-030 | Present user's actual verified token as proof on exchange; no proof-less subject assertion | Covered — Phase 3 exchangeV2 subject_token=user JWT; fail-close on undefined subjectToken (AD-6) |
| FR-031 | Exchanged token preserves user as subject and agent as authorized party | Covered — Phase 3 sub=user/azp=agent; test asserts preservation |
| FR-032 | Verified user token threaded host-side only; never across framework port/origin | Covered — Phase 3 `SubjectToken` side-channel; framework `InvocationOrigin` stays string-only (AD-6) |
| FR-040 | DAG identity resolves to real Keycloak agent client via config (replace placeholder) | Covered — Phase 4 `AGENT_CLIENT_MAP` replaces identity fn (ADR-0056) |
| FR-041 | HITL approval button authorizes approver vs run's owning team, parity with HTTP path | Covered — Phase 4 messages-handler aadObjectId→team authz; SC-006 parity test |
| FR-042 | Dynamics capability targets configured per-org host, scoped to read | Covered — Phase 4 `DYNAMICS_ORG_HOST` via `audienceForScope` + `buildDynamicsReadHandle` |
| FR-050 | Realm brokers mother-company Entra; maps Azure groups → team realm roles | Covered — Phase 1″ `AzureIdpStep` + `RolesStep` (claimToRoleMapper per team) |
| FR-051 | Realm emits team membership as multi-valued `teams` claim, access-token only (not ID token) | Covered — Phase 1″ `oidc-usermodel-realm-role-mapper` (multivalued, access.token.claim:true, id.token.claim:false) |
| FR-052 | Agent-type clients are confidential SA clients; optional scope mirrors Entra permission = grant | Covered — Phase 1″/golden test "agent client scopes mirror permissions"; existing ClientStep + ClientScopesStep |
| FR-053 | Realm changes golden-export tested (claim/scope structure asserted) | Covered — Phase 1″ `FuguePlatformRealmGoldenTest` |
| NFR-010 | Refused capability request produces zero downstream egress (SC-006) | Covered — Phase 1 no-egress integration test; AD-3 fail-closed stub |
| NFR-011 | No raw token or broad client reachable from a capability handle (SC-007) | Covered — existing handle isolation (Security & NFR Notes); US2 handle-inspection scenario |
| NFR-012 | `fugue-agents` app holds zero static secrets/certs — federation only (SC-011) | Covered — Phase 5 0-secrets/0-certs assertion; SC-007/SC-011 |
| NFR-013 | Identical requests de-duped by (identity, audience, scope) within token lifetime (SC-008) | Covered — Security & NFR Notes: existing token cache unchanged handles dedup |
| NFR-014 | Sensitive config (secrets, tokens) never logged | Covered — creds typed `// never logged`; Security & NFR Notes NFR-014 |
| NFR-020 | Every adapter failure mode maps to typed result in failure taxonomy; no bare throws | Covered — `map*Response` status→Result; verifier valid/bad-sig/JWKS-down→typed; SC-003 linter (no bare throw) |
| SC-001 | No-config host boots byte-identical to pre-wiring baseline | Covered — AD-3 gating; boot matrix (a) no config → byte-identical static path |
| SC-002 | `bun run typecheck` + `bun test packages/host` pass incl. six SC-invariant tests | Covered — Verification steps 1–2; "Must stay green" SC-006/007/008/010/011/012 |
| SC-003 | Linter passes zero violations (no bare throw, catch-ignore, `as any`, raw-string ids) | Covered — Verification step 3 |
| SC-004 | Granted scope sends mail e2e; un-granted refused with zero Entra egress (audit) | Covered — Phase 1 tests + Phase 5 e2e agent path |
| SC-005 | User ∉ DAG team denied before concurrency acquisition (property-tested) | Covered — Phase 2 property test: any user ∉ team ⇒ `canAccessDag` false (runs before concurrency acquire) |
| SC-006 | Non-member's HITL button click refused (parity with HTTP path) | Covered — Phase 4 HITL parity test |
| SC-007 | Post-provisioning `fugue-agents` shows 0 secrets/0 certs; four spikes PASS/PARTIAL | Covered — Phase 5 / Wave F |
| SC-008 | `fugueplatform` golden test asserts `teams` multivalued/access-token-only + agent scope mirror | Covered — Phase 1″ golden test |
