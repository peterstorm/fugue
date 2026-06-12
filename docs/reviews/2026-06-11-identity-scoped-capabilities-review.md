# Review: identity-scoped-capabilities (loom run, Waves 1–6)

> **Resolution status (2026-06-11): all fugue-repo findings addressed; keycloak repo deferred.**
>
> Fixed in `packages/framework` + `packages/host` (typecheck clean across all 9 packages; framework 1503 pass / 0 fail, host suite 0 fail):
> - **C1** — `runDag` now threads a `CapabilityBroker` + `origin` and mints each node's `requires` at dispatch (`mintFor(inv, node.requires)` with the real `nodeId`), merging minted handles **over** the boot-scoped static client set. No broker is wired when `REALM_JWT_ISSUER` is unset → byte-identical to before (framework tests untouched). The broker passes plain capability names through; `provides()` lets run-start validation skip broker-minted scopes. Proven end-to-end by `framework/src/__tests__/per-node-minting.test.ts`.
> - **C2** — `mail.send` targets `/users/{from}/sendMail`; `MailMessage.from` is now a required sender mailbox (app-only tokens can't use `/me`).
> - **C5** — branded `SignatureVerifiedClaims` (only producer = the JWKS verifier) and `AuthenticatedUser` (only producer = `validateRealmJwtClaims`); the verify→validate pipeline is now type-enforced.
> - **C6** — `CapabilityRegistry` augmented with the `"<provider>:<operation>"` scope keys, wired to `HandleForScope` via per-scope `_Equal` assertions (`domain/capability-registry.ts`); the broker's record cast is now sound-by-construction.
> - **C7** — added: per-node minting (framework), cross-identity cache isolation, single-flight concurrency + lost-update, `canAccessDag` user branch, framework-error→HTTP classifier, `AGENT_CLIENT_SCOPES` boot validation, metered-llm concurrency reservation, nbf.
> - **I1** — broker single-flight (in-flight promise map) + cache cells re-read live (no lost update); metered-llm in-flight reservation bounds concurrent budget overshoot.
> - **I2** — early-refresh clock-skew margin on cached tokens. **I3** — user-origin `agentClientId` = the DAG's agent-type client (not the frontend `azp`); cache identity = `(sub, agentClientId)`. **I4** — `policy-refusal`/`downstream-denied`→403, `llm-budget-exceeded`→429, `infra-unreachable`→503, settled refusals exempt from the circuit breaker. **I5** — auth middleware header corrected + `!isTeamTokenShape` guard now enforced.
> - **Suggestions** — `infra-unreachable.operation` is a closed literal union; parse-time `policy-refusal` enriched with the agent client; `AGENT_CLIENT_SCOPES` scope names validated at boot; malformed-2xx Graph/Dynamics bodies → `infra-unreachable`; `formatToken` enforces 32-byte input; `wifTokenEndpoint` validates `tenantId`; `withAccumulatedUsage` logs `llm.usage-unattributed` instead of silently dropping; stale `auth.ts`/`run-dag.ts` docs refreshed.
>
> **Deferred — keycloak repo (`keycloakConfigAsCode`):** C3, C4, I6, I7, I8 (per request, not addressed in this pass).
> **Deferred — fugue polish (lower-risk type-tightening):** full credential/`Subject`/`AuthorizedParty`/`EpochSeconds`/`EpochMillis`/`CacheKey` branding (#1); `canAccessDag` → `allow|deny` ADT (#4) — kept `boolean` + pinning tests, and the user path is inert today (inbound verifier unwired → user tokens fail closed); relocating the new port types out of `adapters/`; single-source scope-table derivation; cross-repo scope contract test.

**Date:** 2026-06-11
**Scope:**
- `fugue` branch `feat/identity-scoped-capabilities` vs `main` — commits `ac5186c`, `bba6dee` (62 files, ~9k insertions)
- `keycloakConfigAsCode` commit `cd8084d` on `fix/t2-fugue-wave-gate-critical-findings` (fugueplatform realm package, 19 files, ~2k insertions)

**Method:** seven parallel specialized agents — general code review, silent-failure hunt, test-coverage analysis, type-design analysis, comment/doc accuracy, architecture review, security review. Both fugue suites pass under `bun test` (framework 1533 pass, host exit 0) and typecheck clean. The Keycloak repo was reviewed statically (no Maven run).

**Plan/spec:** `docs/plans/2026-06-10-identity-scoped-capabilities.md`, `.claude/specs/2026-06-10-identity-scoped-capabilities/spec.md`, ADRs 0053–0059.

---

## Executive summary

The functional core is genuinely excellent — pure, property-tested, fail-closed, with some of the strongest invariant work in the codebase (token-in-closure handles, no-egress-on-refusal proofs via empty call logs, NaN-clock rejection). FC/IS adherence ~92%, zero mocks across 9k lines.

The review found **three independent showstoppers**, all in the last mile the loom waves didn't connect:

1. The live broker can never mint (`requires` is never threaded), and enabling it via `REALM_JWT_ISSUER` silently drops all static capabilities.
2. The flagship `mail.send` capability calls `/me/sendMail`, which Microsoft Graph rejects unconditionally for app-only tokens.
3. The Keycloak realm config accidentally grants **every scope to every client** — including `entra-exchange` to the user-facing frontend — while `ValidationStep` is structurally unable to notice (subset check instead of equality).

The criticals concentrate in **wiring** and **one Keycloak API semantic**, not in the core design.

---

## Critical — must fix before merge

### C1. The live broker is a dead seam, and enabling it breaks every DAG
*(found independently by 4 agents — code review, silent-failure, architecture, test analysis)*

**Location:** `packages/host/src/host.ts:171-199`, `packages/host/src/adapters/node-context-factory.ts:317`

The only production call site is `broker.mintFor(invocation, [])` — per-node `requires` is never threaded, so the entire 365-line `keycloak-broker.ts` (fail-closed gate, dual-egress caching, operation narrowing, audit — the headline of this feature, FR-W3-002/US4) is unreachable production code. The tripwire comment at `node-context-factory.ts:319-329` admits it.

Worse: when `REALM_JWT_ISSUER` is set, `createKeycloakBroker` fully **replaces** `createPassthroughBroker(extractClients(...))`. With empty `requires` the live broker resolves `{}`, so **every statically-configured capability client (http, db, custom adapters) vanishes from NodeContext**. Any DAG whose nodes declare `requires` fails at run start with `missing-capability` — a loud but *misattributed* error (the operator will hunt the DAG's capability wiring, not the JWT issuer env var). Meanwhile the feature the env var ostensibly enables — JWT inbound auth — is also silently inert because `verifyRealmJwt` is deliberately unwired (`host.ts:243-247`).

The audit correlation triple would also carry the sentinel `nodeId: "__run__"` even if minting were reachable, weakening the per-node attribution ADR-0053 promises.

**Fix:** resolve per node at node dispatch — `mintFor({...origin, nodeId}, node.requires)` — and **merge** minted handles over the boot-scoped static client set instead of replacing it (broker-resolvable `provider:operation` names go through the broker; plain capability names keep their static clients). Also retire the throw-on-`Err` tripwire, restoring Result-at-boundary. Consider refusing to boot (or `logger.error`) when `REALM_JWT_ISSUER` is set while verifier/endpoints are unwired.

### C2. `mail.send` targets `/me/sendMail` with an app-only token — guaranteed Graph rejection
*(3 agents — code review, architecture, comment accuracy)*

**Location:** `packages/host/src/adapters/graph-capability.ts:164`

The handle is built exclusively over the app-only WIF token (client-credentials grant). Graph rejects `/me` for application-permission tokens unconditionally ("/me request is only valid with delegated authentication flow"). The repo's own runbook contradicts the code: `docs/runbooks/2026-06-10-entra-fugue-agents-provisioning.md:251` specifies `POST /users/{mailbox}/sendMail`, as does spike-3 Part B step 5. The test (`graph-capability.test.ts:89,96`) pins the wrong URL, so this ships green and fails on first live call — surfacing as `downstream-denied` and likely misread as an Entra permission problem.

**Fix:** thread a sender mailbox (id/UPN) through config or `MailMessage` (`capability-scope.ts:88` currently has no field for it) and target `/users/{sender}/sendMail`. This needs config threading, not just a URL edit. Unlike the Dynamics placeholder, this defect carries no KNOWN LIMITATION marker — the comments affirmatively claim a working app-only path (`@satisfies US7`).

### C3. Keycloak: `addDefaultOptionalClientScope` auto-grants all four scopes to all clients
*(4 agents — code review, silent-failure, comment accuracy, security)*

**Location:** `keycloakConfigAsCode/java-configuration/.../fugueplatform/steps/ClientScopesStep.java:77`

```java
realm.addDefaultOptionalClientScope(created.getId());
```

This registers each scope in the realm's **default-optional** list — the set Keycloak auto-attaches to **every client created afterwards**. `ClientStep` runs after `ClientScopesStep`, so `fugue-frontend`, `fugue-agent-mail`, and `fugue-agent-sites` all inherit all four optional scopes (`msgraph:mail.send`, `msgraph:sites.read`, `dynamics:read`, `entra-exchange`) regardless of the explicit per-client grants. Consequences:

- `fugue-agent-mail` can mint `msgraph:sites.read` / `dynamics:read` via client_credentials.
- The frontend SSO client can request `entra-exchange` on a user token — i.e. **a logged-in browser user can obtain a token carrying `aud: api://AzureADTokenExchange`, the WIF assertion audience** (the H3 hazard the design explicitly controls for).
- Every *future* client created in this realm inherits the same grants.
- The live realm diverges from the golden export (`"assignedOptionalScopes": []` for the frontend) on day one.

This silently breaks AD-5 ("assigning a scope to an agent's client *is* the policy grant"), H3, and H4, and falsifies ADR-0057's "Keycloak's own scope validation refuses an unassigned scope / defense in depth" claim. The inline comment ("register as a realm-wide OPTIONAL scope (never default)") shows it was a semantic misunderstanding of the Admin API — scope creation already makes a scope optional; realm-default registration is something else entirely. The reference `toolbox`/`secondbrands` packages never call this API. Neither the golden test (pure plan, no live Keycloak) nor `ValidationStep` (subset check — C4) can catch it.

**Fix:** delete the `addDefaultOptionalClientScope` call. Per-client assignment in `ClientStep.assignOptionalScopes` is the policy grant and does not require realm-level registration. Verify against a live realm.

### C4. Keycloak: `ValidationStep.validateClientScopeAssignment` checks subset, not equality
*(4 agents)*

**Location:** `keycloakConfigAsCode/.../fugueplatform/steps/ValidationStep.java:~191-204`

The Javadoc says "asserts the optional scopes assigned on the live client **exactly match** the expected grant set," but the code is `liveScopes.containsAll(expectedScopes)` — only *missing* grants fail; *excess* grants pass green. The frontend's expected-empty set passes trivially with all four scopes attached, so the only check that could see the C3 leak is blind to it. In a realm where scope assignment **is** the authorization policy, this is the load-bearing guard.

**Fix:** use set equality (excluding Keycloak's built-in optional scopes), reporting both missing and unexpected scopes. For the frontend, asserting "no optional downstream scopes at all" is the security-relevant direction. Additionally, read back realm and per-client **default**-scope lists and fail if any fugue scope (especially `entra-exchange`) appears in a *default* list — "optional, never default" is load-bearing (H3) and currently never verified live.

### C5. Signature-verified-ness of JWTs lives in a comment, not a type
*(type-design analyzer)*

**Location:** `packages/host/src/domain/jwt-validation.ts:91-150`, `packages/host/src/domain/auth.ts:68-83`, `packages/host/src/http/middleware/auth.ts:59`

Three compounding gaps mean **an unvalidated JWT can flow where a validated one is expected, by construction**:

1. `RealmJwtClaims` is a structurally-satisfiable plain interface — any `{iss, aud, exp, sub, azp}` object (e.g. `JSON.parse(atob(token.split(".")[1]))`) inhabits it with zero verification.
2. `validateRealmJwtClaims(claims: unknown, …)` accepts anything; a future endpoint author who calls it on a decoded-but-unverified payload gets `ok({sub, azp})` for a forged token. The verify-signature→validate-claims sequencing is enforced only by middleware convention, under a comment headed "SECURITY BOUNDARY — READ THIS".
3. The success value is plain `{ sub: string; azp: string }` — indistinguishable from unvalidated strings.

**Fix (parse, don't validate):** make the JWKS verifier port the *only* producer of a branded `SignatureVerifiedClaims` (unique-symbol brand, like `RunId` in `ids.ts:17-22`); have `validateRealmJwtClaims` accept only that brand and return a branded `AuthenticatedUser`. The compiler then enforces the pipeline the module header shouts about.

### C6. Unchecked cast severs the broker's handles from the type registry
*(type-design + architecture)*

**Location:** `packages/host/src/adapters/keycloak-broker.ts:361`

`handleRecord as ScopedCapabilityHandle` casts `Record<string, OperationNarrowedHandle>` to `Partial<{[K in Capability]: CapabilityRegistry[K]}>` with nothing connecting `CapabilityRegistry["msgraph:mail.send"]` to `MailSendHandle`. It is the codebase's **second** trust-boundary cast — `capability-manager.ts` explicitly says "keep every such cast here — do not introduce a second." The type-level map that should be the link — `HandleForScope` (`capability-scope.ts:100-104`) — is defined but never wired into the registry. A consumer who augments `CapabilityRegistry` with a raw vendor client type for a scope key (the established pattern for `db`/`http`) compiles cleanly and node code crashes at runtime.

**Fix:** require registry augmentation for broker-resolvable scopes and add a compile-time assertion (`_Equal<CapabilityRegistry["msgraph:mail.send"], MailSendHandle>` in the style of `node.ts:288`) per scope-named capability, or derive the registry entries from `HandleForScope`.

### C7. Security-relevant test gaps
*(pr-test-analyzer; confidence 8–9/10 each)*

1. **`canAccessDag` `user` branch untested** (`domain/auth.ts:~100`): the deliberate "any authenticated user can run any team's DAG" policy has zero pinning tests; nor is a `user` identity tested against admin-only routes (`http/router.ts:79`); `run-dag.ts:114` mapping user → `callerTeam: "admin"` is also untested. A refactor could silently widen or narrow access with a green suite.
2. **Cross-identity cache isolation untested** (`keycloak-broker.ts:198,284`): the identity selection (`user → sub`, `agent → agentClientId`) is written in two separately-maintained expressions; if either regressed to always use `agentClientId`, user B would be served user A's cached app-only token and the entire suite stays green. One test closes it: two `mintFor` calls with different `sub`s within TTL → two egresses, distinct bearers.
3. **No concurrency tests anywhere** — SC-008 and SC-003 are only proven serially (see I1).
4. **`ValidationStep` has zero always-on tests** — 226 lines of fail-closed security read-back run only behind the `EXTERNAL_INTEGRATION_TESTS` gate. The comparison logic is pure-extractable: lift the predicates (grant shape per client type, scope-set comparison, mapper-present) into pure functions over `ClientRepresentation`-shaped values and unit test them (JUnit 5 + jqwik).
5. **`host.ts` broker-selection wiring untested**, including the C1 cliff.

---

## Important — should fix

### I1. No single-flight on broker token caches; budget overshoot scales with concurrency
`keycloak-broker.ts:249-250, 293-315, 338-342`; `metered-llm.ts:165-178`

`saCache`/`appOnlyCache` are read-modify-write cells spanning `await`s on a host-global broker. Two concurrent `mintFor` calls for the same `(identity, audience, scope)` both miss and both mint — SC-008's "≤1 token request per triple per TTL" only holds single-threaded — and `saCache = minted.value.cache` assigns a pre-await snapshot, so interleaved mints of *different* triples can clobber each other's entries (lost update → spurious re-mints). Same class in `metered-llm`: N parallel in-flight calls all pass the pre-call gate → overshoot by N, not one (SC-003). **Fix:** in-flight promise map (single-flight) keyed on the cache key; re-read the current cell after each await; reservation counter for the meter if the budget is hard. The pure cache module needs no change.

### I2. No clock-skew / early-refresh margin on cached token expiry
`token-cache.ts:80` via `keycloak-broker.ts:232,341`

`isFresh` is `now < expiresAt` with no margin; a token looked up 1ms before expiry is presented downstream after it expires, and the resulting 401 maps to `downstream-denied` — ADR-0059's *settled, never-retry* category — when a retry would fix it. This was an explicitly deferred Wave-3 advisory scheduled "at T8 wiring" (`SESSION-HANDOFF-2026-06-11.md`); T8 landed without it. **Fix:** `expiresAt = storedAt + ttlMs - skewMs` (30–60s, capped at a fraction of `expires_in`).

### I3. User-origin `agentClientId` is the frontend's `azp`, not the agent-type client
`node-context-factory.ts:222`, consumed at `keycloak-broker.ts:257,276-278`

For user runs, `assignedScopes(inv.origin.agentClientId)` consults the *frontend SSO client's* policy, and a future `exchangeV2` would set `azp` to the frontend — contradicting ADR-0056 (per-agent-type clients) and session-handoff carry-forward #2 ("map the run to the real agent-type Keycloak client"). Currently inert (endpoint unwired) but it is *the* security-relevant identity mapping for the headline feature. Related: the user-hop cache key omits `azp` entirely (`(sub, audience, scope)`), so in any multi-client scenario a token exchanged for `(user, agentA)` is served to `(user, agentB)` while the audit claims B minted it — the SC-008 dedup unit should be `(sub, azp, audience, scope)`.

### I4. All run failures map to HTTP 500
`http/handlers/run-dag.ts:241-247`

`policy-refusal`, `downstream-denied`, and `llm-budget-exceeded` all return 500. A fail-closed authorization "no" presented as a server error misleads clients, trips retry/alerting machinery, and — because the circuit breaker's `markFailure` counts these — repeated policy refusals can open the circuit for everyone. **Fix:** `policy-refusal`/`downstream-denied` → 403, `llm-budget-exceeded` → 429; exempt settled refusals from `markFailure`.

### I5. Auth middleware header is wrong on the security boundary
`http/middleware/auth.ts:4-20, 32, 183`

The file header (a) lists the resolution order as admin → team → JWT when the code (and ADR-0058, and the factory's own JSDoc) is admin → JWT → team, and (b) claims a `fug_`-shape exclusion check that does not exist — `isTeamTokenShape` is imported and never called. Today the invariant holds incidentally (generated `fug_` tokens are base64url and dot-free, so never JWT-shaped), but it lives in a comment; a `fug_` token containing two dots would route to the JWT path and 401. **Fix:** add `&& !isTeamTokenShape(token)` to match the documented contract (or fix the comment and drop the import), and rewrite the header to match the factory JSDoc.

### I6. Keycloak: `fullScopeAllowed` never disabled
`client/executor/ClientConfigurationExecutor.java:132-172`

The representation leaves `fullScopeAllowed` null → Keycloak defaults it to `true` for every client, including the WIF trust-anchor agent SA clients. Impact limited today (no custom realm roles), but the trust anchor should pin `fullScopeAllowed=false` explicitly.

### I7. Keycloak: `alreadyExists → continue` skips all reconciliation
`ClientScopesStep.java:51-56`

A pre-existing scope short-circuits creation, mapper attachment, and registration. A partial previous run is never repaired on re-run; a pre-existing scope with wrong attributes or a wrong/extra mapper is silently accepted. **Fix:** on `alreadyExists`, compare representations and update or fail.

### I8. Keycloak: environment detection fail-opens; localhost pinned in prod
`FuguePlatformEnvironment.java:166-185, 36-49, 80-86`

`detect` defaults to LOCAL on `null` or any unrecognized URI — a typo'd production hostname silently provisions a realm with the `http://localhost:8080` issuer. And `redirectUris()` unconditionally appends `http://localhost:3000/...` in every environment including OPR production (a test actively pins this). **Fix:** throw (or `Either`) for non-null unrecognized URIs; scope localhost redirects to `Local` in the type, or write an explicit decision record.

---

## Suggestions

**Branding / type tightening**
- SA token, app-only token, user JWT, cache keys, `sub`/`azp`, audiences are all unbranded `string`; `saCache` and `appOnlyCache` are the same type, so credential-class swaps compile. Mixed clock units (middleware/jwt-validation = UNIX seconds; broker/token-cache = epoch millis) live in comments. The repo already brands `RunId`/`TeamToken` — extend the pattern (`Subject`, `AuthorizedParty`, `CacheKey`, `EpochSeconds`/`EpochMillis`). This was itself a deferred Wave-3 advisory ("do it before T8 wires them into token exchange") that shipped unaddressed.
- `infra-unreachable.operation` is an open `string`; ADR-0059 enumerates five values and documents `"mint"`, which nothing emits (actual: `client-credentials`, `token-exchange`, `entra-wif`, `graph`). Use a literal union and align the ADR.
- `policy-refusal` encodes parse-time vs assignment-time as field optionality; "parse-time refusal with a client id" is representable. Use a discriminated sub-shape. Also: the broker calls `parseScope` with the invocation in hand but returns the error without enriching `agentClientId` — `formatFrameworkError` then falsely prints "agent client unknown".
- `canAccessDag` returns `boolean` — the one auth outcome modeled as a flag. An `allow | deny{reason}` ADT would carry the deliberate user→true decision in data and feed audit. Until the broker is actually in the node path (C1), consider gating user-runs behind a config flag or realm-role check — the compensating per-hop control the comment cites does not yet exist in the wired system.
- `formatToken` brands `TeamToken` without enforcing the 32-byte input — the brand is violable at its origin.
- `mintFor` accepts any `Capability` but the live broker policy-refuses non-scope names (`"http"`); a mixed `requires` is representable and fails at runtime once real requires are threaded (C1 fix should specify pass-through behavior for non-scope capabilities in the port contract).
- `AGENT_CLIENT_SCOPES` Zod transform validates JSON shape, not scope-name validity — a typo'd scope passes boot and silently fail-closes every mint at runtime, contradicting the "fails at boot, never at runtime" doc. Parse each scope with `parseScope` in the transform. Also untested.
- Keycloak: `FuguePlatformClient.assignedOptionalScopes` is raw `List<String>` (typo representable until apply time), and nothing forbids granting `entra-exchange` to `FrontendSso` but call-site convention.

**Error-handling polish**
- `withAccumulatedUsage` (`tool-use-loop.ts`) silently drops prior-turn token usage for error kinds without a `usage` field — under-counts budgets; log `llm.usage-unattributed` or widen the carrying kinds.
- Malformed 2xx Graph/Dynamics bodies map to empty data (`title: ""`, `rows: []`) instead of an error — diverges from `entra-wif.ts`'s documented A4 mapping (200-without-usable-body → `infra-unreachable`). Mirror it.
- `jwt-validation.ts` doesn't check `nbf`; the future JWKS verifier must pin RS256/ES256, reject `none`/HS256, and validate `kid` (owed, not in this diff); `JwtVerifyError` mapping checks `kind === "unavailable"` and lets future kinds fall to 401 — use `match(...).exhaustive()`.
- `entra-wif.ts:146` interpolates `tenantId` into the token URL without GUID validation.
- Keycloak: 409-tolerant catches in `ClientScopesStep.java:75-80` / `ClientStep.java:176-183` rethrow without the original exception as cause.

**Structure / docs**
- The five new port types (`KeycloakTokenEndpoint`, `EntraWifExchange`, `HttpPost`, `GraphHttp`, `VerifyRealmJwt`) live in `adapters/` and `http/middleware/` instead of `ports.ts`/domain; pure mappers (`buildWifFormBody`, `mapWifResponse`, `mapGraphError`) are domain-grade logic in adapter files. (Also a deferred Wave-3 advisory.)
- `cacheIdentityFor`/`viaForOrigin` derivations duplicated in the broker (`:198/284`, `:208-221` vs `:297`); the audit-as-witness property is abandoned on the cache-hit path. Extract pure helpers next to `token-cache.ts`.
- Scope names + WIF audience are free strings duplicated across TS `KNOWN_SCOPES`, the `AGENT_CLIENT_SCOPES` env policy, and Java `FuguePlatformConstants` — no shared source or cross-repo contract test; drift surfaces only as runtime denials.
- Stale docs: spike-1/2/4 claim the fugue-platform realm package / keycloakConfigAsCode "does not exist" (superseded by `cd8084d` — annotate, since the runbook in the same PR says the opposite); `run-dag.ts:37-43` says broker wiring "branches on it later" but T8 landed on this branch; `domain/auth.ts` header still describes the two-mode admin/team model; runbook line 92's "the dynamics-read agent" is a phantom third client (`dynamics:read` belongs to `fugue-agent-sites`).
- `capability-scope.ts` parser re-derives the union via `includes` + `as` casts; scope→kind/audience/handle mappings are restated in four places — derive from one scope table.
- Keycloak: `AudienceMapper`/`OptionalClientScope` are generic Keycloak concepts housed realm-locally (consistent with the `UsernameMapper` precedent); promote to `client/model` on second realm use.
- Test gaps (advisory tier): `llmBudgetTokens` five-hop config threading never asserted end-to-end; multi-capability `requires` (record assembly, partial-failure cache semantics) untested; shipped `unwired-*.ts` modules never imported by any test (tests assert lookalike fakes); `isJwtShape` edge cases; tool-use-loop abort-path usage stamping; `AudienceMapper`/`OptionalClientScope` guard clauses.

---

## Strengths (keep exactly as-is)

- **FC/IS split is exemplary** — `token-cache`, `jwt-validation`, `llm-meter`, `capability-scope` are time-injected, I/O-free, ADT-modelled, property-tested. Zero mocking framework usage in 9k lines; fakes are object literals at injected ports.
- **The CapabilityBroker port is deep** (Ousterhout sense): one method hides parse, policy gate, two caches, two egresses, narrowing, and audit. Framework stays fully host-agnostic (FR-W2-004 verified — no Keycloak/Entra names or literals in framework).
- **SC-007 enforcement is the strongest available in TS** — the bearer lives only in the `buildGraphHandle` closure; handle interfaces structurally contain no `client`/`token` member; forgery is harmless because a forged handle carries no authority.
- **No-egress-on-refusal proof** — the SC-006 assertion is literally an empty call log on both egresses, behavioral and refactor-resilient.
- **Fail-closed thoroughness** — non-finite-clock rejection in `jwt-validation.ts:99-101`; verifier-without-iss/aud → 503; JWT-shaped tokens never fall through to the team path; the policy gate fires before any cache read; the U+001F cache-key delimiter claim verified by hex dump.
- **Unwired null-adapters are a good pattern, not a smell** — they fail loudly on the retriable channel, typed-distinct from policy refusals.
- **`broker-audit.ts`** — never-throws contract with layered fallback, `sub` modelled as absence not sentinel, no token material or prompt content logged.
- **`llm-meter`** — standout type design: derived `total` (inconsistency unrepresentable), `BudgetDecision` sum type, clamped negative deltas; partial usage metered on failed calls so failure cannot bypass budget.
- **Keycloak realm hardening** — `sslRequired=all`, brute-force on, ROPC disabled everywhere, frontend is confidential auth-code + PKCE S256 with exact web origins, agents are client_credentials-only with empty redirect/origins, golden export contains no secrets, sealed `FuguePlatformClient` with constructor invariants (`webOrigins.contains("*")` rejected; agents structurally lack browser-flow fields), `entraExchange()` emits only `included.custom.audience` (replay-surface closed, documented). The `ClientPlanBuilder.enableServiceAccounts(boolean)` fix repairs a real prior bug (false was a silent no-op).
- **ValidationStep's overall shape** — live read-back validation, specific exception mapping, no log-and-continue; `RealmStep` correctly refuses to claim "hardened" until read-back.

---

## Recommended action

1. **Fix C1–C4 first.** C1+C2 in fugue; C3+C4 in keycloakConfigAsCode (C3 is a one-line delete plus live verification; C4 is the validation tightening that would have caught it).
2. **Land C5 (branded verified claims) and C6 (registry wiring) while context is fresh** — both are the type-system work the deferred Wave-3 advisories already called for.
3. **Delegate test gaps (C7):** `ts-test-engineer` for fugue (cross-identity cache isolation, single-flight concurrency, `canAccessDag` user branch, `AGENT_CLIENT_SCOPES`/`llmBudgetTokens` threading); `java-test-engineer` to extract `ValidationStep` predicates into pure functions and cover with JUnit 5 + jqwik.
4. Work through I1–I8, then the suggestions opportunistically.
5. Re-run `/loom:review-pr` after fixes; run code-simplifier last.

Note: criticals span two repos, so `/loom:review-and-fix` should be run per-repo if used.

---

### Machine Summary
CRITICAL_COUNT: 7
ADVISORY_COUNT: 20
CRITICAL: host.ts:171-199 + node-context-factory.ts:317 — live broker only ever called with empty requires; minting machinery unreachable and REALM_JWT_ISSUER silently drops all static capabilities
CRITICAL: graph-capability.ts:164 — /me/sendMail invalid for app-only WIF tokens; runbook requires /users/{mailbox}/sendMail; no sender-mailbox config exists; test pins wrong URL
CRITICAL: ClientScopesStep.java:77 — addDefaultOptionalClientScope auto-grants all scopes to all clients incl. entra-exchange to the frontend SSO client; breaks AD-5/H3/H4
CRITICAL: ValidationStep.java:~195 — containsAll subset check contradicts "exactly match" Javadoc and masks the over-grant; use set equality + optional-never-default read-back
CRITICAL: jwt-validation.ts:91 + auth.ts:68-83 — signature-verified-ness documentation-only; RealmJwtClaims structurally forgeable; brand verifier output
CRITICAL: keycloak-broker.ts:361 — second unchecked trust-boundary cast; HandleForScope never wired to CapabilityRegistry
CRITICAL: security-relevant test gaps — canAccessDag user branch, cross-identity cache isolation, concurrency, ValidationStep logic all untested
ADVISORY: keycloak-broker.ts:249-342 — no single-flight; concurrent mints double-egress (SC-008) and lose cache writes; metered-llm overshoots by N (SC-003)
ADVISORY: keycloak-broker.ts:232,341 — no clock-skew/early-refresh margin on cached token expiry (deferred Wave-3 advisory undelivered)
ADVISORY: node-context-factory.ts:222 — user-origin agentClientId = frontend azp, not agent-type client (ADR-0056, handoff carry-forward #2); user-hop cache key omits azp
ADVISORY: run-dag.ts:241-247 — policy-refusal/downstream-denied/budget all map to HTTP 500 and trip circuit breaker
ADVISORY: http/middleware/auth.ts:4-32,183 — header claims phantom fug_-shape exclusion and wrong resolution order; isTeamTokenShape unused
ADVISORY: ClientConfigurationExecutor.java:132-172 — fullScopeAllowed defaults true for all clients
ADVISORY: ClientScopesStep.java:51-56 — alreadyExists skips all reconciliation; partial-run damage never repaired
ADVISORY: FuguePlatformEnvironment.java:166-185 — detect fail-opens to LOCAL on unrecognized URIs; localhost:3000 redirect pinned in prod envs
ADVISORY: unbranded credential classes, sub/azp, cache keys; mixed epoch-seconds/millis clock units in comments not types
ADVISORY: errors.ts:180-217 — infra-unreachable.operation open string ("mint" documented, never emitted); policy-refusal origin as optionality
ADVISORY: config.ts:84-104 — AGENT_CLIENT_SCOPES validates shape not scope names; untested
ADVISORY: tool-use-loop.ts withAccumulatedUsage — usage silently dropped for non-carrying error kinds
ADVISORY: graph-capability.ts:198-225 — malformed 2xx bodies map to empty data instead of errors
ADVISORY: scope names + WIF audience duplicated as free strings across repos; no contract test
ADVISORY: stale docs — spike claims superseded by cd8084d; runbook phantom "dynamics-read agent"; auth.ts two-mode header; run-dag.ts "T8 later" comment
ADVISORY: port types defined in adapters/ instead of ports.ts; pure WIF/Graph mappers in adapter files
ADVISORY: keycloak-broker.ts:198,284 — duplicated cacheIdentityFor/via derivations; audit-as-witness abandoned on cache-hit path
ADVISORY: auth.ts:104-109 — canAccessDag user→true while compensating per-hop control unreachable; boolean instead of allow/deny ADT
ADVISORY: ClientScopesStep.java:75-80 + ClientStep.java:176-183 — exceptions rethrown without cause
ADVISORY: entra-wif.ts:146 — tenantId without GUID validation; jwt-validation.ts nbf unchecked; future JWKS verifier must pin algs
