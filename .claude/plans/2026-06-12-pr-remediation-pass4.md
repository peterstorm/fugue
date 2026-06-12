# PR Remediation Plan — Pass 4

**Date:** 2026-06-12
**Branch:** feat/identity-scoped-capabilities
**Findings:** 2 critical, 21 advisory (6 review agents; deduped)

## Critical Fixes

### Fix C1: Host test script never runs 8 new test files
- **Source:** pr-test-analyzer
- **File:** packages/host/package.json:17
- **Issue:** `test` script globs only `src/__tests__`, skipping `src/adapters/__tests__` and `src/domain/__tests__` — 144 tests (SC-006/007/008/011, JWT validation, token cache) never run in CI.
- **Fix:** Widen find to `src -path '*__tests__*'` keeping existing exclusions.

### Fix C2: ADR-0054 grep verification claim is false
- **Source:** comment-analyzer
- **File:** docs/adr/0054-capability-broker-port-passthrough.md:119; packages/framework/src/types/capability-broker.ts:136; packages/framework/src/shared/capabilities.ts:42; packages/framework/src/shared/passthrough-broker.ts:25
- **Issue:** ADR claims grep for keycloak/entra across framework broker files returns nothing; the comments now name both vendors.
- **Fix:** Reword framework comments provider-neutral ("the host's realm-backed minting broker") so the checkable invariant holds again.

## Advisory Fixes

### Fix A1: Throw fence mislabels failed hop
- **Source:** code-reviewer
- **File:** packages/host/src/adapters/keycloak-broker.ts:337
- **Fix:** Track which hop is in flight so a thrown EntraWif failure reports operation "federation", hop "entra-wif".

### Fix A2: withAccumulatedUsage stamps usage {0,0}
- **Source:** code-reviewer
- **File:** packages/framework/src/llm/tool-use-loop.ts:118
- **Fix:** Skip the stamp when prior usage is zero and own usage is undefined (absent = no attributable tokens).

### Fix A3: mergeScopedCapabilities silently drops reserved keys
- **Source:** silent-failure-hunter
- **File:** packages/framework/src/shared/make-node-context.ts:107
- **Fix:** Warn via fwLogger when a filtered-out entry is non-null (mirrors llm.usage-unattributed precedent).

### Fix A4: broker.mintFor unfenced at dispatch seam
- **Source:** silent-failure-hunter
- **File:** packages/framework/src/dag-runtime/run-node.ts:141
- **Fix:** try/catch the await, map throw to infra-unreachable (operation "mint", hop naming the broker seam) — enforce never-throw at the boundary.

### Fix A5: assignedScopes outside mintFor throw fence
- **Source:** silent-failure-hunter
- **File:** packages/host/src/adapters/keycloak-broker.ts:376
- **Fix:** Fence the mintFor loop body so an injected AssignedScopes throw becomes infra-unreachable + mint-failed audit (preserves SC-009 coverage).

### Fix A6: Team-token store 503 discards error unlogged
- **Source:** silent-failure-hunter
- **File:** packages/host/src/http/middleware/auth.ts:278
- **Fix:** Log resolveResult.error before returning 503, mirroring JWT-path pass-3 fix.

### Fix A7: Throwing inner LlmClient bypasses settle/log
- **Source:** silent-failure-hunter
- **File:** packages/host/src/adapters/metered-llm.ts:208
- **Fix:** Catch, log llm.call-failed with errorKind "thrown", rethrow.

### Fix A8: No test that throwing inner releases reservation
- **Source:** pr-test-analyzer
- **File:** packages/host/src/__tests__/metered-llm.test.ts
- **Fix:** Add test: throwing fake inner → reservation released, next call admitted.

### Fix A9: Inert-policy warn branch untested
- **Source:** pr-test-analyzer
- **File:** packages/host/src/__tests__/broker-selection.test.ts
- **Fix:** Add test: AGENT_CLIENT_SCOPES set + REALM_JWT_ISSUER unset → "inert" warn.

### Fix A10: formatToken length guard untested
- **Source:** pr-test-analyzer
- **File:** packages/host/src/__tests__/domain/auth.test.ts
- **Fix:** Add tests for 31/33-byte inputs throwing.

### Fix A11: sendMail receipt synthesis untested
- **Source:** pr-test-analyzer
- **File:** packages/host/src/adapters/__tests__/graph-capability.test.ts
- **Fix:** Assert 202-with-id → messageId, and "accepted" sentinel fallback.

### Fix A12: buildGraphHandle returns union not HandleForScope<S>
- **Source:** type-design-analyzer
- **File:** packages/host/src/adapters/graph-capability.ts:278
- **Fix:** Generic signature `<S extends DownstreamScope>(scope: S, ...) => HandleForScope<S>` so swapped match arms fail compilation.

### Fix A13: provides()/delivery contract comment-only
- **Source:** type-design-analyzer
- **File:** packages/framework/src/dag-runtime/run-node.ts:155
- **Fix:** Post-merge presence check: each required cap with provides()===true must resolve non-null; fail node with validation/missing-capability instead of undefined-handle crash.

### Fix A14: Stale "threaded from config" in ADR-0058
- **Source:** comment-analyzer
- **File:** docs/adr/0058-two-path-inbound-host-auth.md:96
- **Fix:** Describe grouped realmJwt dep (verifier + iss/aud one unit).

### Fix A15: errors.ts parseScope-caller comment wrong
- **Source:** comment-analyzer
- **File:** packages/framework/src/types/errors.ts:226
- **Fix:** Mention boot-time AGENT_CLIENT_SCOPES validator fails the boot.

### Fix A16: FR-W2-009 @satisfies overstates
- **Source:** comment-analyzer
- **File:** packages/host/src/adapters/metered-llm.ts:19; node-context-factory.ts:307
- **Fix:** Reword to "FR-W2-009 groundwork — pending migration onto the mintFor seam".

### Fix A17: "single accepted overshoot" contradicts generalised bound
- **Source:** comment-analyzer
- **File:** packages/host/src/domain/dag-registration.ts:50
- **Fix:** Reword to generalised overshoot bound.

### Fix A18: ADR-0059 Decision section shows superseded shape
- **Source:** comment-analyzer
- **File:** docs/adr/0059-capability-failure-taxonomy.md:99-104
- **Fix:** Inline "(superseded — see Amendment 2026-06-12)" marker; fix Context example to `requires: ["msgraph:mail.send"]`.

### Fix A19: user→true grant coupled to JWKS wiring by comments only
- **Source:** architecture-tech-lead
- **File:** packages/host/src/domain/auth.ts:206; middleware/auth.ts (RealmJwtDeps); host.ts
- **Fix:** Add required `authorizeUserRun` member to RealmJwtDeps; canAccessDag delegates the user branch. Wiring a verifier forces the authz decision.

### Fix A20: HTTP handler imports type from adapters
- **Source:** architecture-tech-lead
- **File:** packages/host/src/http/handlers/run-dag.ts:15
- **Fix:** Move NodeContextForDag (+ pure invocationOriginForIdentity) into domain/run-context.ts; adapter imports it.

### Fix A21: Reservation admission logic pure-extractable
- **Source:** architecture-tech-lead
- **File:** packages/host/src/adapters/metered-llm.ts:90-137
- **Fix:** Extract ReservationState value + pure admit/reserve/release/learn transitions into llm-meter.ts; decorator keeps one mutable cell.

### Fix A22: Audit mint conflates cache hit with real egress
- **Source:** architecture-tech-lead
- **File:** packages/host/src/adapters/keycloak-broker.ts:419; broker-audit types
- **Fix:** Add `acquisition: "minted" | "cache-reuse"` discriminant to the mint outcome, emitted from the branch taken; SC-008 becomes operator-observable.

## Validation Commands
```bash
bun run typecheck
bun test packages/framework
cd packages/host && bun run test   # after C1 this now includes the 8 missing files
```

## Priority Order
1. C1 (unblocks honest validation), C2
2. A4, A13 (run-node mint block — same region)
3. A1, A5, A22 (keycloak-broker), A12 (graph-capability)
4. A21, A7, A16 (metered-llm/llm-meter), A2 (tool-use-loop), A3 (make-node-context)
5. A19 (auth/RealmJwtDeps), A6 (middleware), A20 (type relocation)
6. A15, A17 (comments), A14, A18 (ADRs)
7. A8-A11 (new tests)
