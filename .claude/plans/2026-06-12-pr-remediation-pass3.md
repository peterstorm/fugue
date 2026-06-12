# PR Remediation Plan — Pass 3

**Date:** 2026-06-12
**Branch:** feat/identity-scoped-capabilities
**Findings:** 2 critical, 20 advisory (deduplicated across 6 review agents)

Agents: code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead. Zero criticals in code; both criticals are documentation-accuracy drift introduced by the pass-1/2 remediation commits.

## Critical Fixes

### Fix 1: ADR-0057 describes a removed broker refusal path
- **Source:** comment-analyzer
- **File:** docs/adr/0057-keycloak-optional-scopes-mirror-permissions.md:98
- **Issue:** Claims an unrecognized `requires` name is a `policy-refusal` at the broker edge. Post-C1, `mintFor` skips unparseable names (treated as static capabilities); they surface at run-start as `missing-capability` (HTTP 500). Only an assigned-scope miss yields `policy-refusal` (403).
- **Fix:** Amend the broker-enforcement bullet; note boot-time `AGENT_CLIENT_SCOPES` validation (config.ts) catches typo'd policy entries.

### Fix 2: `llm-budget-exceeded.cumulative` doc contradicts emitter
- **Source:** comment-analyzer (critical), type-design-analyzer, code-reviewer (advisory dups)
- **File:** packages/framework/src/types/errors.ts:162 + packages/host/src/adapters/metered-llm.ts:117
- **Issue:** Doc says "tokens already consumed"; emitter passes `projected` (settled cumulative + reserved in-flight estimate).
- **Fix:** Emitter reports `decision.cumulative` (settled) in the error; `projected` stays in the warn log which already carries `reservedInFlight`. Re-document that refusal may fire while settled cumulative is below budget when in-flight reservations project an overrun.

## Advisory Fixes

### Fix 3: NaN poisons LLM budget fail-open
- **Source:** type-design-analyzer
- **File:** packages/host/src/domain/llm-meter.ts:103,137
- **Fix:** `accumulate` treats non-finite delta components as 0; `budgetDecision` fails closed (refuse) on non-finite cumulative. Tests added.

### Fix 4: Derive scope operation unions from KNOWN_SCOPES
- **Source:** type-design-analyzer
- **File:** packages/host/src/domain/capability-scope.ts:134,163,166
- **Fix:** `type MsGraphOperation = (typeof KNOWN_SCOPES)["msgraph"][number]` (same for Dynamics); casts in parseScope become tautological; drift becomes a compile error.

### Fix 5: Group realm-JWT middleware deps
- **Source:** type-design-analyzer
- **File:** packages/host/src/http/middleware/auth.ts:89,221-227
- **Fix:** Replace three independent optionals (`verifyRealmJwt`/`expectedIss`/`expectedAud`) with one optional `realmJwt: { verify, expectedIss, expectedAud }` group; runtime half-wired 503 branch deletes itself. Update host.ts wiring + tests.

### Fix 6: Log discarded JWT verifier Result errors
- **Source:** silent-failure-hunter
- **File:** packages/host/src/http/middleware/auth.ts:209-219
- **Fix:** `logger.error` with `reason` before the 503 (unavailable); `logger.warn` before the 401 (invalid) — mirrors sibling paths.

### Fix 7: Config warning for scopes-without-issuer
- **Source:** type-design-analyzer
- **File:** packages/host/src/domain/config.ts:96 / packages/host/src/host.ts:112
- **Fix:** Boot warning when `AGENT_CLIENT_SCOPES` populated but `REALM_JWT_ISSUER` unset (converse already warns).

### Fix 8: Split TeamToken brand producers
- **Source:** type-design-analyzer
- **File:** packages/host/src/domain/auth.ts:188,204
- **Fix:** `TeamTokenShaped` (inbound, shape-only, from `isTeamTokenShape`) vs `TeamToken` (generated, full-entropy, from `formatToken`; assignable to shaped). Consumers of inbound tokens accept `TeamTokenShaped`.

### Fix 9: canAccessDag latent authz gap
- **Source:** code-reviewer
- **File:** packages/host/src/domain/auth.ts:159
- **Fix:** `// SECURITY:` cross-reference linking this predicate to the future JWKS-verifier wiring site (and vice versa in host.ts/auth docs), so the verifier wave cannot land without revisiting.

### Fix 10: validateCapabilities/mergeScopedCapabilities disagreement
- **Source:** architecture-tech-lead (+ comment-analyzer FR-W2-009 note)
- **File:** packages/framework/src/shared/capabilities.ts:75, make-node-context.ts:100, types/capability-broker.ts:104
- **Fix:** Option (a): `validateCapabilities` rejects `broker.provides(cap) === true` for `BUILTIN_CAPABILITY_KEYS` as a wiring error (loud, not silent drop). Amend the FR-W2-009 comment to state the merge must also change when broker-minted built-ins land. Property test pinning: every cap `provides()` exempts survives the merge.

### Fix 11: Vendor hop names in framework error taxonomy
- **Source:** architecture-tech-lead
- **File:** packages/framework/src/types/errors.ts:190 + host emitters
- **Fix:** `infra-unreachable.operation` becomes role categories `"mint" | "exchange" | "federation" | "downstream"`; new `hop: string` carries the host-specific name (client-credentials→mint, token-exchange→exchange, entra-wif→federation, graph→downstream). Update emitters (keycloak-token-endpoint, entra-wif, graph-capability, keycloak-broker fences) + affected tests. ADR-0054/0059 amendment notes.

### Fix 12: Brand AgentClientId
- **Source:** architecture-tech-lead
- **File:** packages/host/src/adapters/node-context-factory.ts:227-235, domain
- **Fix:** Host-side branded `AgentClientId` with single constructor `agentClientIdForDag(dagId)` — the documented dagId→Keycloak-client migration becomes compiler-checked. Framework port keeps `string`.

### Fix 13: entra-wif throw escapes never-throws port
- **Source:** silent-failure-hunter + code-reviewer (dup)
- **File:** packages/host/src/adapters/entra-wif.ts:158,289
- **Fix:** Validate `cfg.tenantId` once in `createEntraWifExchange` (throws at construction = boot failure); `exchange` keeps its never-throws contract. Test for the construction throw.

### Fix 14: keycloak-broker comment fixes
- **Source:** comment-analyzer
- **File:** packages/host/src/adapters/keycloak-broker.ts:91,376-437
- **Fix:** `TOKEN_REFRESH_SKEW_MS` is a duration, not "(epoch millis)"; renumber mintFor step comments (0,2,3,4 → contiguous).

### Fix 15: SC-008 tag collision
- **Source:** comment-analyzer
- **File:** packages/host/src/adapters/node-context-factory.ts:14,277
- **Fix:** Qualify the spec namespace so cache-isolation SC-008 doesn't collide with token-dedup SC-008.

### Fix 16: errors.ts stale doc claims
- **Source:** comment-analyzer
- **File:** packages/framework/src/types/errors.ts:155,210
- **Fix:** Overshoot-by-one → first parallel burst may overshoot by N (reservation learning); PARSE-TIME policy-refusal origin note updated to reflect that all production parseScope callers discard the Err (origin currently aspirational).

### Fix 17: parseScope doc misleading
- **Source:** comment-analyzer
- **File:** packages/host/src/domain/capability-scope.ts:146-152
- **Fix:** Clarify the function returns the refusal but every production consumer treats Err as "not a downstream scope"; realized failure is run-start missing-capability.

### Fix 18: Doc drift in ADRs/runbook/spikes
- **Source:** comment-analyzer
- **Files:** docs/adr/0054, 0056, 0057, 0058, 0059; docs/runbooks/2026-06-10-entra-fugue-agents-provisioning.md; docs/spikes/spike-2
- **Fix:** ADR-0057 (critical, Fix 1); ADR-0059 overshoot + parse-time refusal; ADR-0058 explicit `!isTeamTokenShape` guard; ADR-0054+0059 operation-category amendment (Fix 11); AADSTS700213 → AADSTS70021 (verify against Microsoft docs first).

### Fixes 19–24: Test gaps (pr-test-analyzer)
- node-context-factory: assert metered wrapping (`ctx.llm !== shared.llm`) + `llmBudgetTokens` threading
- keycloak-broker: pin effectiveTtlMs half-lifetime floor (ttlSec:1 → cache HIT at t=400)
- retry-policy: fast-fail tests for `downstream-denied` + `llm-budget-exceeded`
- entra-wif: invalid-tenant construction throw test (post Fix 13)
- run-node: checkpoint-skipped node mints nothing (zero mintFor calls on resume)
- unwired defaults: direct tests of createUnwired* modules
- keycloak-broker.test.ts:374: correct the `// expiresAt = 1000ms` comment (500ms effective)

## Validation Commands
```bash
bun run typecheck
bun test
```

## Outcome (2026-06-12)

ALL 22 findings fixed, 0 deferred.

- Code fixes: errors.ts operation→category+hop split (mint/exchange/federation/downstream), metered-llm settled-cumulative reporting (cast-free), llm-meter NaN sanitize + fail-closed budgetDecision, KNOWN_SCOPES-derived operation unions, grouped `RealmJwtDeps` (misconfig 503 branch deleted), verifier Result-error logging, scopes-without-issuer boot warning, TeamTokenShaped/TeamToken brand split, canAccessDag↔host.ts SECURITY cross-references, validateCapabilities built-in-claim rejection + merge seam-contract docs, branded AgentClientId via agentClientIdForDag, entra-wif construction-time tenantId validation, broker comment fixes, SC-008 namespace qualification.
- Doc fixes (verified AADSTS70021 against MS docs): ADR-0054/0056/0057/0058/0059 amendments, runbook + spike-2 error-code standardization.
- Tests added: NaN hardening (+property), settled-cumulative refusal, metered-LLM factory wiring + budget threading, TTL half-lifetime floor pin, downstream-denied + llm-budget-exceeded fast-fail, checkpoint-skip mints-nothing, tenant validation (construction throw), unwired-defaults direct tests, validate/merge seam property tests.
- Validation: typecheck 9/9 packages clean; bun test exit 0, zero failures.
