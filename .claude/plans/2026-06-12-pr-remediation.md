# PR Remediation Plan

**Date:** 2026-06-12
**Branch:** feat/identity-scoped-capabilities
**Findings:** 4 critical, 22 advisory (deduplicated across 6 review agents: code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead)

> **Resolution status (2026-06-12): ALL findings fixed — 4/4 critical, 22/22 advisory, 0 deferred.**
> Validation: `bun run typecheck` clean across all 9 packages; framework `bun test` 1509 pass / 0 fail; host `bun test` exit 0 (suite suppresses the summary line when piped — exit code is the pass signal).
> Notable API change: framework `RunOptions.broker`/`origin` replaced by `RunOptions.minting?: MintingAuthority` (one `{ broker, origin }` pair — half-wired state unrepresentable). Host call site updated; `selectCapabilityBroker` extracted from `createHost` and exported for the C7.5 boot-wiring tests.
> `domain/token-cache.ts` `store` gained a required `now` parameter (stale-entry sweep); only production caller (keycloak-broker) updated.

Context: verification review of the 2026-06-11 remediation pass (docs/reviews/2026-06-11-identity-scoped-capabilities-review.md). All prior fugue-repo findings verified closed except the items below. Prior "Deferred" items remain deferred.

## Critical Fixes

### CR-1: Settled refusals retried + rewrapped as retry-exhausted → I4 defeated end-to-end
- **Source:** code-reviewer, pr-test-analyzer (×2 findings), both verified empirically
- **File:** packages/framework/src/dag-runtime/retry-policy.ts:62-67, packages/host/src/domain/framework-error-http.ts:47-57
- **Issue:** Fast-fail set omits `policy-refusal`, `downstream-denied`, `llm-budget-exceeded` → settled refusals retried (mintFor ×3 at limit 2, duplicate refusal audits, WIF egress re-fired on settled denial — violates ADR-0059/SC-009). Every non-fast-fail error wrapped as `retry-exhausted` even at limit 0; classifier never unwraps `rootErrorKind` → 500 + breaker trip for every broker refusal in real runs.
- **Fix:** (a) add the three settled kinds to the fast-fail set preserving the original error; (b) classifier also matches `retry-exhausted` and classifies on `rootErrorKind` (restores intended 503 for legitimately-exhausted `infra-unreachable`); (c) make classifier `.exhaustive()` (A15); (d) integration test: refusing broker through real `runDag` into handler → 403 + breaker untouched; (e) framework pinning test: settled refusal → exactly 1 mintFor call under retry budget.

### CR-2: broker/origin independent optionals — illegal half-wired state representable on public API
- **Source:** type-design-analyzer (critical), code-reviewer, silent-failure-hunter, architecture-tech-lead (advisory)
- **File:** packages/framework/src/executor/run-dag.ts:99-105, dag-runtime/run-dag-stateful.ts:109-111,140, dag-runtime/executor.ts:233-235, dag-runtime/run-node.ts:58-64,142
- **Issue:** Run-start validation skips broker-provided scopes keyed on broker alone; dispatch mints keyed on broker AND origin. Broker-without-origin → validation waved through, no mint, node gets undefined handle → misattributed retriable node-crash, zero audit record.
- **Fix:** Collapse to single `minting?: { readonly broker: CapabilityBroker; readonly origin: InvocationOrigin }` threaded through all four layers; host.ts passes the pair as one object. Illegal state unrepresentable.

### CR-3: extractClients doc describes pre-C1 architecture
- **Source:** comment-analyzer
- **File:** packages/host/src/domain/capability-manager.ts:279-297
- **Issue:** Claims record is input to pass-through broker, "no longer passed to makeNodeContext directly", "do not introduce a second correlation point" — all false post-C1; contradicts node-context-factory.ts:333, keycloak-broker.ts:445-452, ADR-0053 §trust-boundary shift.
- **Fix:** Rewrite to current truth: boot-scoped base context passed to makeNodeContext; minted handles merge over it at dispatch; one boot-time cast here + one per-invocation cast in the Keycloak broker, no third.

### CR-4: ADR-0058 prescribes the azp mapping the I3 fix removed
- **Source:** comment-analyzer
- **File:** docs/adr/0058-two-path-inbound-host-auth.md:94,108-109
- **Issue:** Decision item 3 says `agentClientId: azp` (the security defect I3 fixed); cache-dedup described as sub-only (now `(sub, agentClientId)`). Future JWKS-wave implementer would reintroduce both regressions.
- **Fix:** Amend item 3 to DAG's agent-type client (dagId placeholder; never frontend azp) with I3 rationale; update dedup-unit sentence.

## Advisory Fixes

### A1: isScopeName vs provides predicate divergence (3 agents)
- **File:** packages/host/src/adapters/keycloak-broker.ts:99,364,466
- **Fix:** mintFor skips exactly when `!parseScope(capability).ok`; delete dead scope-shaped-but-unparseable refusal branch; test: colon-named static custom capability + live broker → node runs with static client.

### A2: Broker token caches never evict (2 agents)
- **File:** packages/host/src/domain/token-cache.ts:113, keycloak-broker.ts:278-279
- **Fix:** Sweep stale entries on store (pure helper in token-cache.ts) + test.

### A3: host.ts broker-selection wiring untested (C7.5, 2 agents)
- **File:** packages/host/src/host.ts:178-213
- **Fix:** Test booting createHost with REALM_JWT_ISSUER set vs unset: live broker constructed with assignedScopes from AGENT_CLIENT_SCOPES; unwired endpoints surface infra-unreachable, not silent success.

### A4: Config docs — AGENT_CLIENT_SCOPES keyed by DAG id; REALM_JWT_ISSUER selects broker
- **File:** packages/host/src/domain/config.ts:66-71,85
- **Fix:** One sentence each: keys are DAG ids until dagId→client mapping lands; setting REALM_JWT_ISSUER also selects the live capability broker.

### A5: void p.finally() unhandled-rejection hazard
- **File:** packages/host/src/adapters/keycloak-broker.ts:344-346
- **Fix:** `p.then(cleanup, cleanup)`; wrap doAcquireAppToken body in try/catch mapping throws to infra-unreachable.

### A6: llm.usage-unattributed lacks correlation IDs
- **File:** packages/framework/src/llm/tool-use-loop.ts:108-118
- **Fix:** Thread nodeId (+ runId/dagId where in scope) into withAccumulatedUsage log payload + test.

### A7: Non-numeric nbf silently skipped
- **File:** packages/host/src/domain/jwt-validation.ts:164
- **Fix:** Present-but-non-numeric nbf → malformed (fail closed, matching exp) + test. Also fix doc enumeration to include nbf step (A25).

### A8: Dynamics 2xx non-object rows silently filtered
- **File:** packages/host/src/adapters/graph-capability.ts:252
- **Fix:** Log dropped-row count via injected logger if available; otherwise map partially-malformed body consistent with A4 precedent + test.

### A9: !isTeamTokenShape guard unpinned (mutation survives)
- **File:** packages/host/src/__tests__/middleware/auth.test.ts
- **Fix:** Test: fug_-prefixed JWT-shaped token resolves via team path (401 on no grant), never reaches verifyRealmJwt.

### A10: I2 skew margin unpinned (mutation survives)
- **File:** packages/host/src/adapters/__tests__/keycloak-broker.test.ts
- **Fix:** Test: lookup at mint + lifetime − margin + ε re-mints.

### A11: mergeScopedCapabilities reserved-key guard untested
- **File:** packages/framework/src/shared/make-node-context.ts:96-104
- **Fix:** Test: minted handle named logger/tracer must not clobber infrastructure.

### A12: malformed-2xx→infra-unreachable and usage-unattributed untested
- **File:** packages/host/src/adapters/__tests__/graph-capability.test.ts, framework tool-use-loop tests
- **Fix:** Add behavioral tests for both.

### A13: buildGraphHandle returns union, not HandleForScope<S>; cast comment overstates
- **File:** packages/host/src/adapters/graph-capability.ts:262-266, keycloak-broker.ts:445-457
- **Fix:** Make buildGraphHandle generic `<S extends DownstreamScope>(scope: S, ...): HandleForScope<S>`; correct comment.

### A14: expires_in accepts NaN/Infinity/negative
- **File:** packages/host/src/adapters/entra-wif.ts:222
- **Fix:** Parse to positive finite seconds at MintedToken/AppOnlyToken boundaries; reject as malformed → infra-unreachable + test.

### A15: classifyFrameworkError .otherwise() non-exhaustive
- **File:** packages/host/src/domain/framework-error-http.ts:47-57
- **Fix:** Folded into CR-1: `.exhaustive()` enumeration.

### A16–A24: Doc/comment rot (comment-analyzer advisories)
- ADR-0059:97 — "mint" → "client-credentials"; replace drifted line citations with function-name anchors
- ADR-0053:79 — becomes true once CR-3 lands (verify wording)
- ADR-0054:81-90,117-129 — add provides?() to port description; zero-regression default is "no broker wired"
- passthrough-broker.ts:1-9, capability-broker.ts:15-19, framework index.ts:97-99 — "default broker" → "optional embedder convenience"
- domain/auth.ts:52-53,147 — T8 landed; broker wired, endpoint fail-closed-unwired
- capability-scope.ts:10-12,114-117,169-171 — T10 shipped
- token-cache.ts:3-5 — broker exists, selected at boot
- runbook :92 — phantom "dynamics-read agent" → unassigned/Dynamics-unwired note
- packages/host/docs/auth.md — add user/OIDC tier + third path to diagram

### A26: auth.test.ts vacuous assertion + overstating comment
- **File:** packages/host/src/__tests__/domain/auth.test.ts:57-64
- **Fix:** Replace tautological `expect(user.kind).not.toBe("admin")`; correct the comment claiming router coverage that doesn't exist (or add the router rejection assertion).

## Execution Grouping (file-disjoint, parallel-safe)

- **Group A (orchestrator):** CR-1, CR-2, A15 + their tests; host.ts threading; A3 host-selection test; passthrough/capability-broker/index.ts comment fixes (A19-family). Files: framework dag-runtime/*, executor/run-dag.ts, shared/capabilities.ts, types/capability-broker.ts, shared/passthrough-broker.ts, index.ts, per-node-minting.test.ts; host framework-error-http.ts(+test), host.ts, handlers/run-dag.test.ts, new host boot test.
- **Group B (implementer agent):** A1, A2, A5–A14, A25, A26 + tests. Files: keycloak-broker.ts(+test), token-cache.ts(+test), entra-wif.ts(+test), graph-capability.ts(+test), jwt-validation.ts(+test), tool-use-loop.ts(+test), make-node-context test, middleware auth.test.ts, domain/auth.test.ts.
- **Group C (docs agent):** CR-3, CR-4, A4, A16–A18, A20–A24. Files: capability-manager.ts (doc only), config.ts (doc only), domain/auth.ts (doc only), capability-scope.ts (doc only), ADRs 0053/0054/0058/0059, runbook, packages/host/docs/auth.md.

## Validation Commands
```bash
bun run typecheck
cd packages/framework && bun test
cd packages/host && bun test
```
