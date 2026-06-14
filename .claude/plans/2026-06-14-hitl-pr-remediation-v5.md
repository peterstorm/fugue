# PR Remediation Plan — v5

**Date:** 2026-06-14
**Branch:** feat/hitl-teams-approvals
**Findings:** 1 critical, 11 advisory (6-agent cohort, pass 6)

Branch has been through 5 prior remediation passes. Code/error/architecture cores are
clean. The genuine remaining gaps are (a) one CRITICAL test hole on the externally
reachable auth boundary, (b) a cluster of test advisories worth closing for completeness,
and (c) three trivial comment fixes. The two architecture residuals (TOCTOU
duplicate-wakeup, best-effort setStatus) and the bot-path authorization gap are
documented residuals — recorded in ADR-0060, not code defects.

## Critical Fixes

### Fix 1: `createBotTokenVerifier` orchestration untested
- **Source:** pr-test-analyzer
- **File:** packages/host/src/hitl/adapters/bot/verify.ts:68-118
- **Issue:** The auth-boundary orchestration (OpenID metadata-fetch failure →
  jwksPromise reset-for-retry, getJwks catch → `unavailable`, success/invalid/unavailable
  returns deciding 401 vs 503 vs accept) has no test. Only the two pure helpers
  (`bearer`, `classifyJoseError`) are covered.
- **Fix:** Add unit tests injecting a fake `fetch` + dynamic-import seam (pattern already
  used in connector.test.ts) to cover metadata failure, JWKS reset, and the three returns.

## Advisory Fixes

### Fix 2: run-executor slice-timeout untested (pr-test)
- run-executor.ts:64-104 — AbortController slice-timeout + unknown-DAG err vs run-failure
  ok({failed}) channel split exercised only via in-memory fake, never the real adapter.

### Fix 3: identity fail-closed invariant unasserted (pr-test, type)
- identity.ts:31-42 — reconstructed identity's `canRunDag: () => false` security property
  has no assertion. Add a direct round-trip test pinning fail-closed.

### Fix 4: Redis TTL set but never asserted (pr-test)
- run-store.ts:122 / decision-store.ts:98 set expiresInSec; redis-stores.test.ts fakes
  ignore TTL. Record set/setNx opts in the fakes and assert TTL is passed.

### Fix 5: concurrent duplicate approval on same gate untested (pr-test, arch)
- service.ts recordDecision — two valid approvals racing the same open gate. Pin the
  resolved behavior (single-flight lock serializes execution; last-write-wins value).

### Fix 6: stale "see Fix A" comment label (comment) — TRIVIAL
- run-store-job.ts:59 — replace remediation-plan label with "ADR-0060 Consequences".

### Fix 7: duplicated ADR-0005 reference line (comment) — TRIVIAL
- runner.ts:200-201 — delete redundant non-canonical "ADR 0005" line.

### Fix 8: misplaced unexpectedNonTerminal banner (comment) — TRIVIAL
- run-dag-stateful.ts:404-406 — banner sits above runDagStateful, not unexpectedNonTerminal.

## Deferred (by design / out of scope)

- **A9 actor primitive-obsession** (type) — informational audit field; branding it is a
  large cross-file surface for low impact. Tracked, not fixed this pass.
- **A10 ReviewActionData decoupled from parser** (type) — safe (`.otherwise` handled);
  the bot-only approve/reject asymmetry is intentional. Tracked.
- **A11 bot-path authorization gap** — explicitly documented v1 constraint in ADR-0060
  Consequences + hitl-teams.md + messages-handler.ts header. Deployment-policy mitigation.
- **TOCTOU duplicate-wakeup / best-effort setStatus** (arch) — recorded as residual in
  ADR-0060 timing-window note. Single-flight lock makes both benign.

## Validation Commands
```bash
bun run typecheck
bun test
```
