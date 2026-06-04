# PR Remediation Plan

**Date:** 2026-06-04
**Branch:** feat/host-documents-capability
**Findings:** 1 critical, 1 advisory

## Critical Fixes

### Fix 1: Custom-route requests during boot return 404 instead of 503
- **Source:** silent-failure-hunter
- **File:** packages/host/src/http/router.ts:107-115
- **Issue:** The wildcard POST handler's `routeOf` checks `"registry" in state`. During `booting` or `stopped` phases, the state has no `registry` field, so `routeOf` returns `""` and the handler returns 404 ("no DAG registered at route"). This is semantically wrong — the client should receive 503 ("host unavailable") to signal retry-later, consistent with the explicit `/dags/:id/run` handler.
- **Fix:** Add `canServeRequests(state)` check before the route lookup. Import `canServeRequests` from host-state.

## Advisory Fixes

### Fix 2: `routeOf` called twice per custom-route request
- **Source:** code-reviewer
- **File:** packages/host/src/http/router.ts:116-121
- **Issue:** `routeOf(c)` is called once in the guard (`if (routeOf(c) === "")`) and again inside `runDagByRouteHandler` (via the `resolveRawId` closure). This scans the registry twice per request. With a small number of DAGs this is negligible, but it's a free optimization.
- **Fix:** Not fixing — the duplication is trivial (O(n) over typically <50 DAGs) and the handler's own `canServeRequests` + registry lookup provides defense-in-depth. The critical fix (503 on boot) makes the first `routeOf` call happen only when the host can serve, which is the happy path.

## Validation Commands
```bash
bun run typecheck
bun test
```
