# PR Remediation Plan (v3)

**Date:** 2026-06-03
**Branch:** feat/extensible-capabilities
**Findings:** 7 critical, 17 advisory (after dedup across 6 review agents)

## Critical Fixes

### Fix 1: Boot-failure capability leak
- **Source:** silent-failure-hunter
- **File:** packages/host/src/host.ts:124, packages/host/src/domain/capability-manager.ts:102
- **Issue:** `connectAll` failure returns early from `createHost` without closing already-connected handles → leaked pools/sockets on crash-loop boots.
- **Fix:** `connectAll` returns the connected prefix on `Err`; host closes that prefix before returning the error.

### Fix 2: topoSortHandles silently ignores unregistered `dependsOn`
- **Source:** architecture-tech-lead, code-reviewer, type-design-analyzer
- **File:** packages/host/src/domain/capability-manager.ts:73
- **Issue:** `dependsOn: ["db"]` with no registered `db` handle boots successfully — the exact failure mode ADR-0051 exists to prevent.
- **Fix:** Return `Err(internal-invariant-violated)` when a dep has no registered handle.

### Fix 3: Duplicate capability names unguarded
- **Source:** type-design-analyzer
- **File:** packages/host/src/domain/capability-manager.ts:57, ports.ts:153
- **Issue:** Two handles with the same `name` silently last-writer-win in `byName`/`extractClients`.
- **Fix:** `topoSortHandles` rejects duplicate names. Remove dead `CapabilitySet` type.

### Fix 4: Capability typing erased by cast chain
- **Source:** type-design-analyzer, silent-failure-hunter, architecture-tech-lead
- **File:** packages/host/src/domain/capability-manager.ts:202, packages/host/src/adapters/node-context-factory.ts:251
- **Issue:** `extractClients` returns `Partial<Record<string, unknown>>`, then `as unknown as Record<string, never>` at the wiring site.
- **Fix:** Type `extractClients` as `Partial<{[K in Capability]: CapabilityRegistry[K]}>` (one documented cast inside, where the array-widening loses the per-handle correlation); delete the factory cast.

### Fix 5: Broken createFakeHttpCapability JSDoc example
- **Source:** comment-analyzer
- **File:** packages/framework/src/http/http-capability.ts:208
- **Issue:** Example wraps routes in `ok(...)`, which feeds the Result wrapper into `schema.safeParse` — fails at runtime.
- **Fix:** Example uses raw bodies / `FakeHttpRoute` objects.

### Fix 6: Host capability lifecycle wiring untested
- **Source:** pr-test-analyzer
- **File:** packages/host/src/host.ts:112-130, 317-320
- **Fix:** Integration tests: connect/close ordering through `createHost`, connect-failure aborts boot AND closes connected prefix, cycle error surfaces, shutdown closes handles in reverse.

### Fix 7: Real pg adapter has zero tests
- **Source:** pr-test-analyzer
- **File:** packages/adapter-pg/src/index.ts:123-267
- **Fix:** Export `createPgClient` (pool injection). Unit-test `mapPgError` classification (08xxx/53xxx/57P01 → transient; others → non-retriable node-crash) via fake pool, row-validation failures, queryOne/execute/queryRaw, healthCheck timeout, fake longest-prefix ambiguity.

## Advisory Fixes

### Fix 8: Structured HTTP status on errors (kills string-match 404)
- **Files:** packages/framework/src/types/errors.ts:68, http/http-capability.ts:121, apps/customer-summary/src/dag/nodes/fetch-customer-http.ts:70
- **Fix:** Add optional `httpStatus` to `transient` variant; `executeRequest` sets it on non-2xx; fake supports `{status, body}` error routes; node branches on `httpStatus === 404`. Fix the false-confidence 404 test to drive a real 404 through the fake.

### Fix 9: JSON parse failure no longer coerced to null
- **File:** http/http-capability.ts:126 — distinct node-crash for invalid-JSON bodies.

### Fix 10: Abort listener removed on completion; unreadable error body labeled
- **File:** http/http-capability.ts:104, 120 — `finally` removes the external-signal listener and clears the timer; body-read failure yields `"<body unreadable>"` instead of `""`.

### Fix 11: Tracing — sync Result errors flagged; extraction failures visible; JSDoc accurate
- **File:** tracing/capability-tracing.ts:60, 103, 136 — `isErrResult` check on sync branch; `span.addEvent` on extractAttributes failure; corrected wrapper JSDoc (documents `this`-binding contract).

### Fix 12: closeAll returns failure summary
- **File:** domain/capability-manager.ts:130, host.ts:319 — returns `readonly {name, error}[]`; host warns on non-clean capability shutdown.

### Fix 13: Single typed cast in validateCapabilities
- **File:** shared/capabilities.ts:45 — `Partial<Record<Capability, unknown>>` instead of `as unknown as`.

### Fix 14: builtinKeys single source of truth
- **Files:** types/node.ts, shared/make-node-context.ts:50 — `BUILTIN_CAPABILITY_KEYS` const co-located with `CapabilityRegistry`, `satisfies readonly Capability[]`.

### Fix 15: pg adapter — ESM-safe require, real statement_timeout, real healthCheck timeout
- **File:** adapter-pg/src/index.ts:228, 111, 258 — `createRequire(import.meta.url)`; wire `statement_timeout` into `poolConfig` (delete dead `_statementTimeoutMs` param); healthCheck races SELECT 1 against a cleared 5s timer.

### Fix 16: Documentation accuracy
- **Files:** types/capability-handle.ts:9,54; docs/adr/0051:75; adapter-pg/README.md:97 — healthCheck polling described as available-not-yet-wired; README matches implementation.

### Fix 17: Smoke script diagnostics
- **File:** scripts/smoke-mlflow.ts:59 — log distinct non-OK statuses during polling.

### Fix 18: Test hygiene
- **Files:** capability-tracing.test.ts:97 (dead `connected` var), http-capability.test.ts (mid-flight abort + invalid-JSON-body + 404-httpStatus tests), new capability-tracing OTel tests via `InMemorySpanExporter` (dep already present).

## Deferred

### Wire checkHealth into host degraded-state polling
- **Reason:** Feature decision, not a defect fix — requires polling interval config and interplay with the redis-probe-driven state machine. `checkHealth` stays exported + unit-tested; docs now say "not yet wired".
- **Recommendation:** Small follow-up ADR/issue: poll `checkHealth` on `REDIS_PROBE_INTERVAL_MS` cadence, fold `degraded` into HostState reasons.

### Gate `node.run` parameter on ValidatedNodeContext brand
- **Reason:** Requires re-threading `TypedNodeContext` derivation through `runNodeShared`/executor — a runtime-wide type refactor beyond remediation scope. Fix 4 closes the worst erasure point.
- **Recommendation:** Track as type-soundness follow-up to ADR-0051.

## Validation Commands
```bash
bun run typecheck   # tsc --build --noEmit at repo root (per-package tsc --noEmit)
bun test
```
