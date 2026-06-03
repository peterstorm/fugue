# PR Remediation Plan

**Date:** 2026-06-04
**Branch:** feat/extensible-capabilities
**Findings:** 1 critical, ~25 advisory (6-agent cohort). After dedup + false-positive triage: 1 critical + 4 actionable advisories applied; the rest deferred (intentional/documented, test-infra follow-ups, or false positives).

## Critical Fixes

### Fix 1: `http` mis-documented as non-handle-backed in `dependsOn` JSDoc
- **Source:** comment-analyzer
- **File:** packages/framework/src/types/capability-handle.ts:67-73
- **Issue:** The JSDoc lists `http` among built-ins "wired directly into `SharedInfra` without a handle … never registered with the lifecycle manager, so depending on them always fails the boot-time check." This is false: `createHttpCapability` returns `CapabilityHandle<"http">` (http-capability.ts:212-218) and host `SharedInfra` has no `http` field (ports.ts:139-154) — http reaches the NodeContext via the `capabilities` array, so it *is* registered with the lifecycle manager and *is* a valid `dependsOn` target.
- **Fix:** Remove `http` from the list; add a clause noting it is handle-backed.

## Advisory Fixes (applied)

### Fix 2: Graph `/content` redirect forwards the bearer token to the storage host
- **Source:** silent-failure-hunter (security-adjacent) + dangling in-code TODO
- **File:** packages/adapter-ms-graph/src/index.ts:235-249 (`graphGet`)
- **Issue:** `redirect: "follow"` forwards the `Authorization: Bearer …` header to the pre-authenticated CDN/blob URL the `/content` endpoint 302-redirects to, leaking the Graph credential. The code comment already admitted "a hardened impl would refetch the location without the Authorization header."
- **Fix:** Switch to `redirect: "manual"`; on a 3xx, refetch the `Location` without the `Authorization` header (the redirect target is already authenticated via its signed query string). Add a regression test asserting the second hop carries no `Authorization`.

### Fix 3: `parseWorkbook` returns a mutable `rows: T[]`
- **Source:** type-design-analyzer
- **File:** packages/xlsx/src/index.ts:97
- **Issue:** Success type exposes a mutable array, inconsistent with the codebase's immutability convention.
- **Fix:** `rows: T[]` → `rows: readonly T[]`.

### Fix 4: `normalizeCell` JSDoc omits the error-cell outcome
- **Source:** comment-analyzer
- **File:** packages/xlsx/src/index.ts:59-64
- **Issue:** JSDoc says it handles "error cells" but not that they map to `null` (code line 75; README documents it).
- **Fix:** State "error cells → `null`" in the JSDoc.

### Fix 5: ADR-0052 pipeline diagram vs. inline-parse examples
- **Source:** comment-analyzer
- **File:** docs/adr/0052-document-source-capability.md (pipeline diagram)
- **Issue:** Diagram shows parsing in a separate transform node while every runnable example parses inline in the fetch node.
- **Fix:** Add a one-line note that the parse may live inline in the fetch node (examples favor this) or in a dedicated transform node.

### Fix 6: Branch regression — failing circuit-breaker test from non-existent error kind
- **Source:** full-suite run (red test on the branch), root-caused to this PR's `errors.ts` change
- **File:** packages/host/src/__tests__/handlers/run-dag.test.ts:52
- **Issue:** `failExecuteDag` fabricated `{ kind: "node-execution-failed" }` — a kind absent from the `FrameworkError` union. This PR refactored `formatError` from a `never`-guard (returned a fallback string) to ts-pattern `.exhaustive()` (commit 42f883f), which now *throws* on that fictional kind. The throw at `run-dag.ts:218` falls into the catch block, which calls `markFailure` a **second** time (already called at line 217) — double-counting failures so the per-DAG circuit opened one failure early. Test "honors a per-DAG circuitBreaker.failureThreshold" failed (request 2 returned 503 instead of 500).
- **Fix:** Use the real `node-crash` variant (`{ kind, message, nodeId, retriability }`) in the test helper. `formatFrameworkError` now matches it, no throw, single `markFailure`. Production `.exhaustive()` correctly stays fail-loud on genuinely impossible input.

## Deferred (with rationale)

- **ms-graph token/401 → transient classification** (silent-failure-hunter): an explicit test asserts empty-token and thrown-token → `transient` (ms-graph.test.ts:192-215); distinguishing permanent auth-config failure from transient IdP-network failure is not reliably possible at the token boundary without provider-specific error types. Intentional; left as-is.
- **pg `healthCheckWithTimeout` "dangling rejection"** (code-reviewer, 70%): FALSE POSITIVE. `Promise.race` attaches a rejection reaction to every input promise, so a late-rejecting `SELECT 1` is already handled — no unhandled rejection. No change.
- **`mapPgError` `.startsWith` on non-string code** (code-reviewer, 45%): over-defensive; pg SQLSTATE and Node socket codes are always strings.
- **Capability error `nodeId` is a construction-time sentinel** (architecture): diagnostic-only; retriability (the load-bearing field) is correct. Capability-scoped provenance is a reasonable intentional choice.
- **`extractClients` duplicate/null guard not at the cast site** (type-design + architecture, 40%): the invariant holds on the real boot path via `topoSortHandles`; defense-in-depth only.
- **Test-coverage gaps** (pr-test-analyzer): pg real-`Pool` lifecycle (needs injectable pool — Testcontainers follow-up already acknowledged in the test header), HTTP PUT/PATCH/DELETE bodies, fs 0-byte file, `clearTimeout` assertion. Real but additive; the test authors flagged the Testcontainers seam as a separate follow-up. Not blocking.
- **Remaining stringly-typed fields** (`FileMeta.lastModified`, `FrameworkError.expiredAt`, `FileRef` raw strings): JSON-round-trip-driven; branding is a larger cross-cutting change, out of scope for this PR.

## Validation Commands
```bash
bun run typecheck
bun test
```
