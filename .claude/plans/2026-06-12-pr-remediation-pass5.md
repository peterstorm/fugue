# PR Remediation Plan — Pass 5

**Date:** 2026-06-12
**Branch:** feat/identity-scoped-capabilities
**Findings:** 3 critical, 14 advisory (after dedup; subject-token finding reported by both type-design-analyzer and architecture-tech-lead)

## Critical Fixes

### Fix 1: auth.md claims user identity unconditionally clears run gate
- **Source:** comment-analyzer
- **File:** packages/host/docs/auth.md:49 (also :276)
- **Issue:** "user → run gate cleared (not team-scoped)" / "A `user` identity clears the run gate regardless of team" — wrong since pass-4 (ee8db4d): `canAccessDag` delegates to the required `canRunDag`/`authorizeUserRun` policy, which may refuse (handler 403s).
- **Fix:** Reword both spots: user identity is gated by the `authorizeUserRun` policy decided at the verifier wiring site (required member of `RealmJwtDeps`); downstream authorization additionally per-hop in the broker.

### Fix 2: ADR-0058 Decision item 1 stale (snippet + prose)
- **Source:** comment-analyzer
- **File:** docs/adr/0058-two-path-inbound-host-auth.md:60-70
- **Issue:** `AuthIdentity` snippet omits `canRunDag` member; prose claims "a `user` clears the inbound run gate". Contradicts code and the ADR's own item 2.
- **Fix:** Add `canRunDag: (dagTeam: string) => boolean` to snippet; reword prose to wiring-site policy delegation.

### Fix 3: ADR-0058 Consequences bullet factually wrong
- **Source:** comment-analyzer
- **File:** docs/adr/0058-two-path-inbound-host-auth.md:165-169
- **Issue:** "`canAccessDag` returns `true` for `user`; run-gate tightening deferred" — mechanism now exists and is structurally required; only the JWKS verifier + concrete policy choice is deferred.
- **Fix:** Rewrite bullet accordingly.

## Advisory Fixes

### Fix 4: missing-capability not in retry fast-fail list
- **Source:** silent-failure-hunter
- **File:** packages/framework/src/dag-runtime/retry-policy.ts:69
- **Issue:** Dispatch-time `missing-capability` (claims-without-delivery guard, run-node.ts:186) is deterministic but retried — re-fires mintFor, duplicate audit records, terminal error wrapped as retry-exhausted.
- **Fix:** Add `error.kind === "missing-capability"` to fast-fail condition with comment.

### Fix 5: unfenced dispatchToolCallsWithSpans drops accumulated usage
- **Source:** silent-failure-hunter
- **File:** packages/framework/src/llm/tool-use-loop.ts:233
- **Issue:** Only unfenced await in the loop; a throw (e.g. asToolContext null-llm authoring error) escapes with no token usage, bypassing FR-W0-001 attribution and reclassified as retriable node-crash.
- **Fix:** try/catch around the dispatch, return err(withAccumulatedUsage(node-crash, non-retriable)).

### Fix 6: learnObservedCall ingests unsanitized provider figures
- **Source:** type-design-analyzer
- **File:** packages/host/src/adapters/metered-llm.ts:139 + packages/host/src/domain/llm-meter.ts:261
- **Issue:** One NaN provider usage figure permanently poisons ReservationState (maxObservedCall/reservedInFlight → NaN); SC-003 reservation gate silently fails open.
- **Fix:** Sanitize in learnObservedCall via the same non-finite/negative→0 clamp used by accumulate; clamp releaseReservation at 0.

### Fix 7: subject-token channel missing for future Token Exchange V2 (dedup: type-design + architecture)
- **Source:** type-design-analyzer + architecture-tech-lead
- **File:** packages/host/src/adapters/keycloak-token-endpoint.ts:53; packages/framework/src/types/capability-broker.ts
- **Issue:** ExchangeV2Request carries only userSub; middleware discards verified raw JWT. Live exchange cannot be implemented without re-plumbing, or degrades to proof-less impersonation. No doc names the gap.
- **Fix:** Document the decision now (per both agents' acceptable alternative): ADR-0058 amendment specifying host-side SubjectTokenRef threading (framework port stays string-only), plus JSDoc on ExchangeV2Request naming the gap and forbidding impersonation-style fallback. Full threading deliberately NOT implemented now — would carry a raw bearer through the system with no consumer (endpoint is fail-closed unwired until the JWKS wave).

### Fix 8: AgentClientId "compiler-checked" docstring overclaims
- **Source:** type-design-analyzer
- **File:** packages/host/src/domain/auth.ts:53-61
- **Issue:** Brand has zero consuming positions; migration safety is convention (single producer), not compiler.
- **Fix:** Soften docstring: single-construction-site convention, brand reserved for future load-bearing use.

### Fix 9: parseScope error-as-control-flow
- **Source:** architecture-tech-lead
- **File:** packages/host/src/domain/capability-scope.ts:173
- **Issue:** Err(policy-refusal) used as routine "not a downstream scope" classifier; all callers discard payload. Contradicts FR-X-003 miss-is-absence.
- **Fix:** Reshape to `parseScope(name): DownstreamScope | undefined`; update consumers (keycloak-broker provides/mintFor skip, config boot validation) and tests.

### Fix 10: U+001F composite-key invariant duplicated
- **Source:** architecture-tech-lead
- **File:** packages/host/src/adapters/keycloak-broker.ts:127 vs packages/host/src/domain/token-cache.ts:36
- **Issue:** cacheIdentityFor inlines \x1f, duplicating KEY_DELIMITER injectivity invariant across core/shell.
- **Fix:** Export composite-key primitive from token-cache.ts; adapter loses delimiter knowledge.

### Fix 11: llmBudgetTokens yaml→RegisteredDag threading untested
- **Source:** pr-test-analyzer
- **File:** packages/host/src/domain/dag-factory.ts:120; config.ts:205
- **Fix:** Add test pinning registration-config threading + FugueYamlSchema.llmBudgetTokens parse test.

### Fix 12: createHost executeDag minting wiring untested — DEFERRED
- **Source:** pr-test-analyzer (rated 4/10)
- **File:** packages/host/src/host.ts:269
- **Reason:** The closure is unreachable without the full boot path (executeStartup with redis/git/loader, capability connection, Bun.serve). Its exact semantics are already pinned by run-dag.test.ts (which mirrors executeDag exactly: real runDag with `minting: { broker, origin }`) plus broker-selection.test.ts (boot-time broker selection). A createHost-level duplicate would be heavy scaffolding for no new invariant.
- **Recommendation:** Cover via an integration/boot smoke test if one is ever added for host.ts wiring generally.

### Fix 13: default wall-clock branch in JWT middleware untested
- **Source:** pr-test-analyzer
- **File:** packages/host/src/http/middleware/auth.ts:258
- **Fix:** One test with deps.now omitted and far-past exp → expired (pins seconds-vs-ms).

### Fix 14: entra-wif 429/generic-5xx message branches asserted on kind only
- **Source:** pr-test-analyzer
- **File:** packages/host/src/adapters/entra-wif.ts:263
- **Fix:** Add message-text assertions for 429 named-throttle and generic 5xx (and graph-capability 429).

### Fix 15: Dynamics $filter encoding untested
- **Source:** pr-test-analyzer
- **File:** packages/host/src/adapters/graph-capability.ts:237
- **Fix:** Add query-with-$filter encoding test.

### Fix 16: docs omit authorizeUserRun policy member
- **Source:** comment-analyzer
- **File:** packages/host/src/http/middleware/auth.ts:10; packages/host/docs/auth.md:15,34
- **Fix:** Mention the third RealmJwtDeps member (user-run authorization policy) in module header + auth.md JWT-group description/diagram.

### Fix 17: ADR-0058 points at re-export shim
- **Source:** comment-analyzer
- **File:** docs/adr/0058-two-path-inbound-host-auth.md:104
- **Fix:** Attribute invocationOriginForIdentity to domain/run-context.ts.

## Priority Order

1. Fixes 4, 5, 6 (behavioral error-handling gaps)
2. Fixes 9, 10 (architecture reshapes touching code + tests)
3. Fix 8 (docstring)
4. Fixes 11-15 (test additions)
5. Fixes 1, 2, 3, 7, 16, 17 (docs)

## Validation Commands
```bash
bun run typecheck
cd packages/framework && bun test
cd packages/host && bun run test
```
