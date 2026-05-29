# @fugue/host PR Review Remediation Plan

**Branch:** feat/fugue-host  
**Date:** 2026-05-21  
**Source:** Comprehensive 6-agent review  
**Total findings:** 1 critical, 25 advisory  

---

## Wave 1: Critical Type Fix + Foundation (no deps)

**Files:** `host-error.ts`, `registry.ts`, `config.ts`, `host.ts`, `concurrency.ts`

### 1.1 CRITICAL: Split `concurrency-exceeded` into type-safe variants
**File:** `packages/host/src/domain/host-error.ts`

Replace:
```typescript
| { readonly kind: "concurrency-exceeded"; readonly scope: "global" | "dag"; readonly dagId?: DagId }
```
With:
```typescript
| { readonly kind: "concurrency-exceeded"; readonly scope: "global" }
| { readonly kind: "concurrency-exceeded"; readonly scope: "dag"; readonly dagId: DagId }
```

**Cascade:** Update `formatHostError` match (already handles both), update `httpStatusFor` (already matches on `kind` only), update `error-handler.ts` `detailsFor`, update `run-dag.ts` construction sites. Tests in `host-error.test.ts` and `error-handler.test.ts` may need update.

### 1.2 Freeze `emptyRegistry()`
**File:** `packages/host/src/domain/registry.ts`

Change:
```typescript
export const emptyRegistry = (): Registry => ({
  dags: new Map(),
  loadedAt: 0,
  sha: "",
});
```
To:
```typescript
export const emptyRegistry = (): Registry => Object.freeze({
  dags: new Map() as ReadonlyMap<DagId, RegisteredDag>,
  loadedAt: 0,
  sha: "",
});
```

### 1.3 Add cross-field `.refine()` to HostConfigSchema
**File:** `packages/host/src/domain/config.ts`

After the `.object({...})`, chain:
```typescript
.refine(
  (c) => c.DEFAULT_DAG_TIMEOUT_MS <= c.MAX_DAG_TIMEOUT_MS,
  { message: "DEFAULT_DAG_TIMEOUT_MS must not exceed MAX_DAG_TIMEOUT_MS" }
)
```

**Cascade:** Add test case in `config.test.ts` for this validation.

### 1.4 Fix `HostInstance.server` — use getter
**File:** `packages/host/src/host.ts`

In the return object, replace `server,` with a getter:
```typescript
get server() { return server; },
```

### 1.5 Remove unused imports in `host.ts`
**File:** `packages/host/src/host.ts`

- Remove `dagId` from the `@fugue/framework` import
- Remove `emptyRegistry` from the `./domain/registry.js` import (remove the entire line if only import)

### 1.6 Brand `AcquireToken`
**File:** `packages/host/src/domain/concurrency.ts`

Add brand field:
```typescript
export interface AcquireToken {
  readonly dagId: DagId;
  readonly acquiredAt: number;
  readonly __brand: "AcquireToken";
}
```

Update `acquire` to include brand on token construction:
```typescript
const token: AcquireToken = { dagId, acquiredAt: now, __brand: "AcquireToken" };
```

**Cascade:** Tests that construct fake tokens will need the brand field added.

---

## Wave 2: Error Handling Fixes

**Files:** `host.ts`, `host-error.ts`, `sync-loop.ts`, `main.ts`

### 2.1 Add `internal-invariant-violated` error kind
**File:** `packages/host/src/domain/host-error.ts`

Add variant:
```typescript
| { readonly kind: "internal-invariant-violated"; readonly message: string; readonly context: Record<string, unknown> }
```

Add to `httpStatusFor`: maps to `500`.
Add to `formatHostError`: `(e) => \`internal invariant violated: ${e.message}\``

### 2.2 Use correct error kind for bootComplete failure
**File:** `packages/host/src/host.ts` (~line 119)

Replace:
```typescript
return err({ kind: "config-invalid", message: `Failed to transition to ready: ${readyResult.error.message}` });
```
With:
```typescript
return err({ kind: "internal-invariant-violated", message: `Boot → ready transition failed`, context: { from: readyResult.error.from, to: readyResult.error.to } });
```

### 2.3 Halt sync when `syncStarted` transition fails
**File:** `packages/host/src/host.ts` — `onStarted` callback (~line 164)

The sync loop's `onStarted` fires BEFORE `executeSyncCycle`. We can't cancel the cycle from the callback. Instead, check state at the START of the sync in the actual trigger:

Actually—the sync loop design doesn't let `onStarted` abort. The simpler fix is to make the `onStarted` callback a **predicate** that returns `boolean`. If false, `doSync` short-circuits.

**Alternative (smaller change):** Document that state machine desync is tolerable (it only affects observability, not correctness—the sync cycle itself is idempotent). Add a comment:
```typescript
// NOTE: State machine sync is best-effort. If the transition fails (e.g., host is draining),
// the sync cycle still executes but onComplete/onError callbacks will also be rejected,
// keeping the state consistent at the cost of a wasted cycle.
```

**Decision:** Keep current behavior but add the documenting comment. The sync loop already checks `hostState.phase === "draining" || "stopped"` before applying transitions. The worst case is one wasted poll cycle — not a correctness issue.

### 2.4 LLM stub: throw with `frameworkErrorKind` for proper error handler mapping
**File:** `packages/host/src/main.ts` (~line 82)

Replace:
```typescript
throw new Error(
  `LLM client not configured. Set ${keyVar} environment variable to enable LLM calls (provider: ${config.LLM_PROVIDER}).`,
);
```
With:
```typescript
const message = `LLM client not configured. Set ${keyVar} environment variable to enable LLM calls (provider: ${config.LLM_PROVIDER}).`;
throw Object.assign(new Error(message), { frameworkErrorKind: "llm-unavailable" });
```

This ensures the error handler middleware maps it to a 500 with kind `"llm-unavailable"` and the actionable message reaches the HTTP response.

### 2.5 Document `RedisPort` rejection risk
**File:** `packages/host/src/adapters/node-context-factory.ts` — `RedisPort` interface

Add JSDoc:
```typescript
/**
 * Redis-like interface — only the methods we actually use.
 * Avoids coupling to a specific Redis client library.
 *
 * IMPORTANT: Methods may reject (throw) if the Redis connection drops.
 * All call sites MUST wrap in try/catch. The namespaced cache/checkpoint
 * adapters already do this — any new consumers must handle rejections.
 */
```

### 2.6 Remove redundant `message` from SyncResult `error` variant
**File:** `packages/host/src/sync/sync-loop.ts`

Replace:
```typescript
| { readonly kind: "error"; readonly sha: string; readonly syncError: HostError; readonly message: string }
```
With:
```typescript
| { readonly kind: "error"; readonly sha: string; readonly syncError: HostError }
```

**Cascade:** Remove `message` field from all construction sites in `executeSyncCycle` and `startSyncLoop`. Update `sync-loop.test.ts` assertions.

---

## Wave 3: Comment & Documentation Fixes

**Files:** `signals.ts`, `diff.ts`, `health.ts`, `run-dag.ts`, `error-handler.ts`, `sync-loop.ts`, ADR-0043

### 3.1 Fix `@satisfies` in signals.ts
**File:** `packages/host/src/lifecycle/signals.ts`

Replace:
```
 * @satisfies NFR-030 — Double-SIGTERM forces immediate exit
 * @satisfies NFR-031 — Uncaught exceptions and unhandled rejections exit with code 1
```
With:
```
 * INVARIANT: Double-SIGTERM forces immediate exit (prevents zombie processes during deployment)
 * INVARIANT: Uncaught exceptions and unhandled rejections exit with code 1 (fail-fast)
```

### 3.2 Fix `@satisfies FR-003` in diff.ts
**File:** `packages/host/src/sync/diff.ts`

Replace:
```
 * @satisfies FR-003 — Detect removed DAGs for graceful deregistration
```
With:
```
 * Enables graceful deregistration of removed DAGs during sync cycle.
```

### 3.3 Fix SC-002 reference in health.ts
**File:** `packages/host/src/http/handlers/health.ts`

Replace:
```
 * SC-002: Health/readiness endpoints
```
With:
```
 * Health and readiness probe handlers for Kubernetes integration.
```

### 3.4 Fix FR-024 "for resumption" in run-dag.ts
**File:** `packages/host/src/http/handlers/run-dag.ts`

Replace:
```
 * FR-024: DAG timeout returns 408 with run ID for resumption
```
With:
```
 * FR-024: DAG timeout returns 408 with run ID (enables future resumption)
```

### 3.5 Soften NFR-003 in sync-loop.ts  
**File:** `packages/host/src/sync/sync-loop.ts`

Replace:
```
 * @satisfies NFR-003 — Git sync detection MUST complete within poll interval + 5s
```
With:
```
 * @satisfies NFR-003 — Git sync detection SHOULD complete within poll interval + 5s (individual ops timeout at 30s; overall cycle timeout not yet enforced)
```

### 3.6 Remove `@deprecated` on unreleased `errorHandler`
**File:** `packages/host/src/http/middleware/error-handler.ts`

Replace:
```typescript
/**
 * Legacy error handler without logger — logs to console.error.
 * @deprecated Use createErrorHandler(logger) instead.
 */
```
With:
```typescript
/**
 * Convenience error handler using console.error — intended for dev/test only.
 * Production code should use createErrorHandler(logger) with a structured logger.
 */
```

### 3.7 Update ADR-0043 status
**File:** `docs/adr/0043-otel-tracing-for-host-operations.md`

Replace:
```
## Status
Accepted
```
With:
```
## Status
Accepted — Not Yet Implemented (design decision for future sprint)
```

---

## Wave 4: Architecture & Coupling

**Files:** `node-context-factory.ts`, `sync-loop.ts`, `circuit-guard.ts`

### 4.1 Extract `LogPort` to shared location
**File:** Create `packages/host/src/ports.ts`

Move `LogPort` from `adapters/node-context-factory.ts` to `packages/host/src/ports.ts`:
```typescript
/**
 * Shared port interfaces used across host subsystems.
 * Lives outside domain/ because ports are boundary contracts, not domain logic.
 */

/**
 * Unified logger port for all host subsystems.
 * Avoids coupling to a specific logging library.
 */
export interface LogPort {
  readonly info: (msg: string, data?: Record<string, unknown>) => void;
  readonly warn: (msg: string, data?: Record<string, unknown>) => void;
  readonly error: (msg: string, data?: Record<string, unknown>) => void;
}
```

**Cascade:**
- `node-context-factory.ts`: `export type { LogPort } from "../ports.js"` (re-export for back-compat)
- `sync/sync-loop.ts`: Change `SyncLogger` to import from `../ports.js` instead of `../adapters/node-context-factory.js`
- `lifecycle/signals.ts`: Import `LogPort` from `../ports.js`
- Update `index.ts` to export from `./ports.js`

### 4.2 Document circuit-guard.ts placement pattern
**File:** `packages/host/src/domain/circuit-guard.ts`

Add module-level JSDoc:
```typescript
/**
 * Circuit Guard — protocol encapsulation over an injected CircuitPort.
 *
 * DESIGN: This module lives in domain/ despite performing side effects (port.set())
 * because it encapsulates a PURE PROTOCOL — the sequence of state transitions is
 * deterministic given the port's current state. The side effects are limited to
 * the injected port handle; the functions are testable with a trivial Map-backed fake.
 *
 * This is the "pure protocol over injected port" pattern — distinct from
 * imperative shell code that manages lifecycle or timers.
 */
```

### 4.3 Cache `set` return type honesty
**File:** `packages/host/src/adapters/node-context-factory.ts`

Add comment at the cache `set` implementation explaining the contract clearly:
```typescript
// DESIGN: Cache writes are best-effort. We return ok() even on failure because:
// 1. Cache is a performance optimization, not a correctness requirement
// 2. Returning err() would abort the DAG run for a non-critical failure
// 3. Redis failures are logged for observability
// The return type Promise<Result<void, FrameworkError>> is dictated by the
// framework's ContextCacheAdapter interface — we cannot narrow it to Promise<void>.
```

---

## Wave 5: Test Coverage

**Files:** New test files

### 5.1 Add `circuit-guard.test.ts`
**File:** `packages/host/src/__tests__/circuit-guard.test.ts`

Tests to write:
- `checkCircuit` with closed circuit → returns `allowed: true`
- `checkCircuit` with open circuit (cooldown not elapsed) → returns `allowed: false`
- `checkCircuit` with open circuit (cooldown elapsed) → transitions to half-open, returns `allowed: true`, consumes test request
- `checkCircuit` from half-open with `testRequestAllowed: false` → returns `allowed: false`
- `markSuccess` from half-open → transitions to closed
- `markSuccess` from closed → resets failure count
- `markFailure` from half-open → transitions back to open
- `markFailure` accumulates failures until threshold
- Port `set` is called with correct intermediate states
- Protocol ordering: attemptReset happens before isAllowed check

### 5.2 Add `startup.test.ts`
**File:** `packages/host/src/__tests__/lifecycle/startup.test.ts`

Tests to write:
- `validateRedis` → logs success on ok
- `validateRedis` → logs failure and returns err on rejection
- `buildSyncConfig` local mode → uses DAGS_LOCAL_PATH as repoPath
- `buildSyncConfig` remote mode → generates /tmp/ path
- `buildSyncConfig` clock injection → deterministic path
- `buildSyncConfig` → isLocalMode flag correctness
- `executeStartup` → returns err if Redis fails
- `executeStartup` → returns err if initial sync fails
- `executeStartup` → returns BootResult with registry on success
- `executeStartup` → logs lifecycle events at each step

### 5.3 Add signal handler logic tests (extract for testability)
**File:** `packages/host/src/__tests__/lifecycle/signals.test.ts` (extend existing)

Since `process.exit` can't be easily tested, add tests for the **logic** by extracting `handleShutdown` protocol:

Create a testable wrapper that captures exit calls:
```typescript
// In the test file:
it("first SIGTERM calls onShutdown", async () => { ... });
it("second SIGTERM during shutdown logs force-exit warning", async () => { ... });
it("onShutdown error is caught and logged", async () => { ... });
```

Use Bun's `mock` or a simple spy on process.exit if available. If not feasible, document as known gap with comment.

---

## Wave 6: Nice-to-Haves (lower priority, can defer)

### 6.1 Lockfile check failure propagation
**File:** `packages/host/src/sync/sync-loop.ts`

Add `warnings?: readonly string[]` to the `updated` SyncResult variant. When lockfile check fails, append a warning. Callers can log it.

### 6.2 `index.ts` export surface refinement
Consider adding `@fugue/host/testing` subpath in `package.json` exporting state machine functions and `emptyRegistry` for test consumers, while removing them from the main barrel.

### 6.3 Primitive branding (GitSha, RepoPath)
Defer to a separate PR. Would touch many files and all tests. Document as future improvement.

---

## Execution Order & Dependencies

```
Wave 1 (foundation)     → Wave 2 (errors)      → Wave 3 (comments)
    │                        │                        │
    └── 1.1 depends on nothing                       │
    └── 1.2 depends on nothing                       │
    └── 1.3 depends on nothing                       │
    └── 1.4 depends on nothing                       │
    └── 1.5 depends on nothing                       │
    └── 1.6 depends on nothing                       │
         │                                            │
         └── 2.1 depends on 1.1 (new error kind)    │
         └── 2.2 depends on 2.1                      │
         └── 2.3 depends on nothing                  │
         └── 2.4 depends on nothing                  │
         └── 2.5 depends on nothing                  │
         └── 2.6 depends on nothing                  │
              │                                       │
              └── all of Wave 3 independent           │
                   │                                  │
                   └── Wave 4 depends on nothing (can parallel with 3)
                        │
                        └── Wave 5 depends on 4.1 (LogPort extraction for clean imports in tests)
                             │
                             └── Wave 6 is optional, defer
```

**Estimated effort:**
- Wave 1: ~30 min (type edits + test fixups)
- Wave 2: ~20 min (error kind + comment + SyncResult simplification)
- Wave 3: ~10 min (comment replacements)
- Wave 4: ~15 min (extract LogPort, add comments)
- Wave 5: ~45 min (new test files with ~30 test cases total)
- Wave 6: Defer

**Total: ~2 hours**

---

## Verification

After each wave, run:
```bash
cd packages/host && bun test
```

After all waves:
```bash
cd packages/host && bun run typecheck && bun test
```
