# PR Review Remediation Plan — Fix All

**Branch:** feat/fugue-host  
**Created:** 2026-05-22  
**Scope:** 5 critical, 11 important, 10 suggestions — all addressed

---

## Execution Strategy

Three waves, ordered by dependency and blast radius:

1. **Wave 1 — Critical fixes** (state machine, silent failures, spec references)
2. **Wave 2 — Important fixes** (exhaustive matching, resource leaks, branding, tests)
3. **Wave 3 — Suggestions** (polish, ADR, naming, minor improvements)

Each fix includes the file, the change, and verification criteria.

---

## Wave 1: Critical Fixes

### C1. Sync loop stuck in "syncing" on no-change result

**File:** `packages/host/src/sync/sync-loop.ts` (lines 215-218 in `doSync`)  
**Root cause:** When `executeSyncCycle` returns `{ kind: "no-change" }`, neither `onComplete` nor `onError` is called. The host state was transitioned to "syncing" by `onStarted()` and never transitions back.

**Fix:** Add an `onNoChange` callback parameter OR transition back to "ready" via `onComplete` with the current registry. The cleanest approach: call `onComplete` with the existing registry and the unchanged SHA, since sync logically completed successfully (just nothing changed).

```typescript
// In doSync():
} else if (result.kind === "no-change") {
  lastSha = result.currentSha;
  // Transition syncing → ready (sync succeeded, nothing changed)
  onNoChange(result.currentSha);
}
```

**Changes required:**
1. Add `OnSyncNoChange` callback type: `(sha: GitSha) => void`
2. Add `onNoChange` parameter to `startSyncLoop`
3. Call `onNoChange` in the `no-change` branch of `doSync`
4. In `host.ts`: wire `onNoChange` to transition `syncing → ready` with existing registry

**In host.ts, the onNoChange callback:**
```typescript
// onNoChange: transition syncing → ready (no registry swap needed)
(sha) => {
  if (hostState.phase === "draining" || hostState.phase === "stopped") return;
  // Use syncCompleted with current registry — it's a valid "sync completed, no change"
  const currentRegistry = getRegistry(hostState);
  if (!currentRegistry) return; // shouldn't happen from syncing state
  const result = syncCompleted(hostState, currentRegistry, sha, Date.now());
  if (result.ok) {
    hostState = result.value;
  }
},
```

**Alternative (simpler, no API change):** Just call `onComplete` from the sync loop itself with the **current** registry. Problem: `doSync` doesn't have access to the current registry. So the callback approach is needed.

**Verification:** Unit test in `sync-loop.test.ts` that asserts `onNoChange` is called when SHA unchanged. Integration test that boots, first sync completes, subsequent sync finds no change, host remains in `ready` (not stuck in `syncing`).

---

### C2. Circuit breaker/registry desync on failed state transition

**File:** `packages/host/src/host.ts` (lines ~167-185 in `onComplete` callback)  
**Root cause:** Circuit breaker cleanup and force-reset run unconditionally regardless of whether `syncCompleted` transition succeeded.

**Fix:** Gate circuit breaker operations behind `result.ok`:

```typescript
// onComplete callback in host.ts
const result = syncCompleted(hostState, newRegistry, newSha, Date.now());
if (result.ok) {
  hostState = result.value;

  // Only update circuit breakers for the registry that was actually installed
  const currentDagIds = new Set(newRegistry.dags.keys());
  for (const dagId of circuitBreakers.keys()) {
    if (!currentDagIds.has(dagId)) {
      circuitBreakers.delete(dagId);
    }
  }
  const now = Date.now();
  for (const dagId of currentDagIds) {
    circuitBreakers.set(dagId, forceReset(now));
  }

  // Diff and log
  const newDags = Array.from(newRegistry.dags.values()).map(d => ({ id: d.id, path: d.route, sha: d.sha }));
  const diff = diffDags(prevDags, newDags);
  logger.info("Registry updated via sync", { ... });
} else {
  logger.warn("syncCompleted transition failed — registry NOT updated", {
    currentPhase: hostState.phase,
    error: result.error.message,
  });
}
```

**Verification:** Test in `full-lifecycle.test.ts`: trigger sync while host is draining → verify circuit breakers are unchanged.

---

### C3. Token store `revoke` returns `ok` on corrupt data

**File:** `packages/host/src/adapters/token-store.ts` (lines 140-148)  
**Root cause:** `JSON.parse` catch returns `ok(undefined)` — claims revocation succeeded.

**Fix:**
```typescript
} catch (e) {
  logger?.error("[token-store] Corrupt team index data in Redis — revocation failed", {
    team,
    error: e instanceof Error ? e.message : String(e),
  });
  return err({
    kind: "redis-unavailable",
    operation: `token-revoke: corrupt team index for '${team}' — manual cleanup required`,
  } as HostError);
}
```

**Verification:** Unit test with corrupt JSON in team index → verify `err` returned with `redis-unavailable` kind.

---

### C4. Token store `resolve` returns `ok(null)` on corrupt grant

**File:** `packages/host/src/adapters/token-store.ts` (lines 97-104)  
**Root cause:** `JSON.parse` catch returns `ok(null)` — indistinguishable from "token not found".

**Fix:**
```typescript
} catch (e) {
  logger?.error("[token-store] Corrupt grant data in Redis", {
    hashPrefix: String(hash).slice(0, 8),
    error: e instanceof Error ? e.message : String(e),
  });
  return err({
    kind: "redis-unavailable",
    operation: `token-resolve: corrupt grant data for hash ${String(hash).slice(0, 8)}…`,
  } as HostError);
}
```

**Impact on auth middleware:** The auth middleware already handles `!resolveResult.ok` → returns 503. So corrupt data now correctly returns 503 instead of 401. ✅

**Verification:** Unit test with corrupt JSON in token key → verify `err` returned → auth middleware returns 503.

---

### C5. Wrong `@satisfies` spec references in integration tests

**File:** `packages/host/src/__tests__/integration/full-lifecycle.test.ts` (lines 10-11)  
**File:** `packages/host/src/__tests__/integration/dag-isolation.test.ts` (line 6)

**Fix full-lifecycle.test.ts:**
```
- @satisfies NFR-030 — Host MUST exit cleanly on SIGTERM after draining in-flight requests
+ @satisfies FR-060 — Host MUST exit cleanly on SIGTERM after draining in-flight requests
- @satisfies NFR-031 — Host MUST log startup/shutdown lifecycle events
+ @satisfies NFR-020 — Host MUST log startup/shutdown lifecycle events
- @satisfies SC-003 — Given git remote unreachable...
+ @satisfies NFR-012 — Git sync failures MUST NOT affect serving of already-loaded DAGs
```

**Fix dag-isolation.test.ts:**
```
- @satisfies FR-030 — Cache keys prefixed fugue:<dagId>:cache:<key>
+ @satisfies FR-031 — Cache keys prefixed fugue:<dagId>:cache:<key>
```

**Verification:** Grep for the old references to confirm they're gone.

---

## Wave 2: Important Fixes

### I1. `detailsFor` uses `.otherwise()` instead of `.exhaustive()`

**File:** `packages/host/src/http/middleware/error-handler.ts` (line 48)

**Fix:** Replace `.otherwise(() => undefined)` with explicit cases for all 24 HostError kinds:

```typescript
const detailsFor = (error: HostError): unknown =>
  match(error)
    .with({ kind: "dag-not-found" }, (e) => ({ available: e.available }))
    .with({ kind: "input-validation-failed" }, (e) => ({ issues: e.issues }))
    .with({ kind: "validation-failed" }, (e) => ({ issues: e.issues }))
    .with({ kind: "global-concurrency-exceeded" }, () => ({ scope: "global" }))
    .with({ kind: "dag-concurrency-exceeded" }, (e) => ({ scope: "dag", dagId: e.dagId }))
    .with({ kind: "timeout" }, (e) => ({ timeoutMs: e.timeoutMs }))
    .with({ kind: "forbidden" }, (e) => ({ callerTeam: e.callerTeam, dagTeam: e.dagTeam }))
    .with({ kind: "dag-disabled" }, (e) => ({ reason: e.reason }))
    .with({ kind: "body-parse-failed" }, () => undefined)
    .with({ kind: "git-clone-failed" }, () => undefined)
    .with({ kind: "git-pull-failed" }, () => undefined)
    .with({ kind: "git-timeout" }, () => undefined)
    .with({ kind: "git-spawn-failed" }, () => undefined)
    .with({ kind: "import-failed" }, () => undefined)
    .with({ kind: "no-default-export" }, () => undefined)
    .with({ kind: "redis-unavailable" }, () => undefined)
    .with({ kind: "bun-install-failed" }, () => undefined)
    .with({ kind: "config-invalid" }, () => undefined)
    .with({ kind: "dag-validation-failed" }, () => undefined)
    .with({ kind: "discovery-failed" }, () => undefined)
    .with({ kind: "async-result-expired" }, () => undefined)
    .with({ kind: "unauthorized" }, () => undefined)
    .with({ kind: "team-already-exists" }, () => undefined)
    .with({ kind: "team-not-found" }, () => undefined)
    .with({ kind: "internal-invariant-violated" }, () => undefined)
    .exhaustive();
```

**Verification:** Compile — adding new HostError kind now fails here. Existing error-handler tests still pass.

---

### I2. Token store rollback DEL result not checked

**File:** `packages/host/src/adapters/token-store.ts` (line ~130)

**Fix:**
```typescript
// Rollback: delete the orphaned token hash
const rollbackResult = await redis.del(tokenKey(hash));
if (!rollbackResult.ok) {
  logger?.error("[token-store] CRITICAL: Failed to rollback orphaned token hash — token is valid but unrevokable via admin API", {
    team,
    hashPrefix: String(hash).slice(0, 8),
  });
}
return err({ kind: "redis-unavailable", operation: "token-store-team-index" } as HostError);
```

**Verification:** Unit test: simulate DEL failure after SET success → verify error logged at critical level.

---

### I3. `formatOpenReason` uses ternary instead of exhaustive match

**File:** `packages/host/src/domain/circuit-breaker.ts` (lines 34-37)

**Fix:**
```typescript
import { match } from "ts-pattern";  // already imported

export const formatOpenReason = (reason: OpenReason): string =>
  match(reason)
    .with({ kind: "threshold-exceeded" }, (r) => `Exceeded ${r.threshold} failures within ${r.windowMs}ms window`)
    .with({ kind: "half-open-test-failed" }, () => "Half-open test request failed")
    .exhaustive();
```

**Verification:** Existing circuit-breaker tests pass. Adding 3rd variant to OpenReason would now compile-error.

---

### I4. Redis connection leaked on `Bun.serve()` failure

**File:** `packages/host/src/host.ts` (lines 121-131)

**Fix:**
```typescript
} catch (e) {
  // Clean up resources acquired during boot before returning error
  if (deps.onShutdown) {
    await deps.onShutdown().catch((cleanupErr) => {
      logger.error("Failed to clean up resources after port bind failure", {
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    });
  }
  return err({
    kind: "internal-invariant-violated",
    message: `Failed to bind HTTP server on port ${config.PORT}: ${e instanceof Error ? e.message : String(e)}`,
    context: { port: config.PORT },
  });
}
```

**Verification:** Test: provide `onShutdown` mock + cause port bind failure → verify `onShutdown` called.

---

### I5. Auth middleware catch block swallows errors without logging

**File:** `packages/host/src/http/middleware/auth.ts` (lines 113-116)

**Fix:** Add logger to `AuthMiddlewareDeps` and log in catch:

```typescript
export interface AuthMiddlewareDeps {
  readonly adminToken: string;
  readonly tokenStore: TokenStorePort;
  readonly logger?: LogPort;  // NEW — optional to avoid breaking tests
}

// In the catch block:
} catch (e) {
  deps.logger?.error("[auth-middleware] Token resolution failed unexpectedly", {
    error: e instanceof Error ? e.message : String(e),
    stack: e instanceof Error ? e.stack : undefined,
  });
  return errorResponse(c, 503, "auth-service-unavailable",
    "Authentication service temporarily unavailable");
}
```

**Wire in host.ts router deps:** Add `logger` to auth middleware deps when constructing the router.

**Verification:** Auth middleware test: cause `hashToken` to throw → verify logger.error called.

---

### I6. `loadResultToRegisteredDag` silently defaults team to "unknown"

**File:** `packages/host/src/domain/dag-factory.ts` (lines 30-33)

**Fix:** Since this is a pure domain function, it can't log. Instead, return the team extraction with a flag, OR accept a logger param (makes it impure). Better approach: this is a validation concern — surface it in the caller.

Best approach: keep the function pure, but have the **caller** (in sync-loop or host) log when team is "unknown":

```typescript
// In dag-factory.ts — add an exported utility:
export const extractTeam = (modulePath: string): { team: string; inferred: boolean } => {
  const pathParts = modulePath.split("/");
  const dagsDirIndex = pathParts.lastIndexOf("dags");
  if (dagsDirIndex >= 0 && dagsDirIndex + 1 < pathParts.length) {
    return { team: pathParts[dagsDirIndex + 1], inferred: true };
  }
  return { team: "unknown", inferred: false };
};
```

Then in `loadResultToRegisteredDag`, use `extractTeam`. In the sync-loop's `loadAll` processing (or in `host.ts` `onComplete`), check for `team === "unknown"` and log a warning:

```typescript
// In host.ts onComplete, after building the registry:
for (const dag of newRegistry.dags.values()) {
  if (dag.team === "unknown") {
    logger.warn(`DAG '${dag.id}' has team 'unknown' — path does not follow dags/{team}/{name}/dag.ts convention`, {
      dagId: dag.id,
      route: dag.route,
    });
  }
}
```

**Verification:** Test: load DAG with non-standard path → verify warning logged.

---

### I7. `ModuleLoaderPort.sha` accepts raw `string` instead of `GitSha`

**File:** `packages/host/src/ports.ts` (line ~55)

**Fix:**
```typescript
export interface ModuleLoaderPort {
  readonly loadDagModule: (
    modulePath: string,
    sha: GitSha,  // was: string
  ) => Promise<Result<LoadResult, HostError>>;

  readonly discoverDagPaths: (dagsRoot: string) => Promise<Result<string[], HostError>>;

  readonly loadAll: (
    dagsRoot: string,
    sha: GitSha,  // was: string
  ) => Promise<BulkLoadResult>;
}
```

**Cascade:** Update `module-loader.ts` adapter, `fake-module-loader.ts` test fixture, and any callers to use `GitSha` typed parameter.

**Verification:** `tsc --noEmit` passes. Tests still pass.

---

### I8. `beginDrain` uses if-chain instead of exhaustive match

**File:** `packages/host/src/domain/host-state.ts` (lines 164-178)

**Fix:**
```typescript
export const beginDrain = (
  state: HostState,
  inflightCount: number,
  now: number,
): Result<HostState, TransitionError> =>
  match(state)
    .with({ phase: "ready" }, (s) => ok({
      phase: "draining" as const,
      registry: s.registry,
      drainStartedAt: now,
      inflightCount,
    }))
    .with({ phase: "degraded" }, (s) => ok({
      phase: "draining" as const,
      registry: s.registry,
      drainStartedAt: now,
      inflightCount,
    }))
    .with({ phase: "syncing" }, (s) => ok({
      phase: "draining" as const,
      registry: s.registry,
      drainStartedAt: now,
      inflightCount,
    }))
    .with({ phase: "booting" }, (s) => err(invalidTransition(s.phase, "draining")))
    .with({ phase: "draining" }, (s) => err(invalidTransition(s.phase, "draining")))
    .with({ phase: "stopped" }, (s) => err(invalidTransition(s.phase, "draining")))
    .exhaustive();
```

**Verification:** Existing `host-state.test.ts` tests pass. Adding 7th phase now causes compile error.

---

### I9. Fill empty test files (6 files)

**Files:**
1. `packages/host/src/__tests__/host-state.property.test.ts`
2. `packages/host/src/__tests__/lifecycle/startup.test.ts`
3. `packages/host/src/__tests__/node-context-factory.test.ts`
4. `packages/host/src/__tests__/registry.property.test.ts`
5. `packages/host/src/__tests__/handlers/health.test.ts`
6. `packages/host/src/__tests__/handlers/list-dags.test.ts`

**Strategy:** Implement after Wave 1 and Wave 2 code changes are complete (tests validate the fixed code).

**Test content specs:**

1. **host-state.property.test.ts** — fast-check arbitrary sequences of transitions:
   - Invariant: registry never lost from serving state
   - Invariant: `canServeRequests(ready|degraded|syncing) === true`
   - Invariant: drainComplete always reachable from any serving state (via beginDrain → drainComplete)
   - Invariant: no valid transition sequence from "stopped" produces any state other than "stopped"

2. **startup.test.ts** — Unit tests for:
   - `validateRedis` success/failure paths
   - `buildSyncConfig` with DAGS_LOCAL_PATH vs remote mode
   - `executeStartup` with Redis failure, clone failure, load failure

3. **node-context-factory.test.ts** — Unit tests for:
   - `resolveTtl`: undefined → undefined, 0ms → 0, 999ms → 1sec (ceil), 5000ms → 5
   - Cache get: Redis error → ok(null) (graceful degradation)
   - Cache set: Redis error → ok(undefined) (best-effort)
   - Cache get: corrupt JSON → ok(null)
   - Checkpoint write: Redis error → still ok (best-effort)
   - Key namespacing: correct prefix applied

4. **registry.property.test.ts** — fast-check:
   - `withDag(r, dag).dags.size >= r.dags.size`
   - `withoutDag(r, id)` is idempotent
   - `lookupDag(withDag(r, dag), dag.id)` returns the dag
   - `freeze` input → output mapping is deterministic

5. **health.test.ts** — Unit tests for:
   - `healthHandler` always returns 200
   - `readinessHandler` returns 200 when canServeRequests
   - `readinessHandler` returns 503 when booting/draining/stopped

6. **list-dags.test.ts** — Unit tests for:
   - Returns 503 when host can't serve
   - Returns empty array when registry exists but has no dags
   - Returns DAG list with correct fields when registry has dags

**Verification:** `bun test` passes for all new test files.

---

### I10. Node context cache/checkpoint best-effort with no observability

**File:** `packages/host/src/adapters/node-context-factory.ts`

**Fix:** Track consecutive cache failures on the SharedInfra or via a counter closure, and log at escalating severity:

```typescript
// In createNamespacedCache:
let consecutiveFailures = 0;

// In the set function, after failure:
consecutiveFailures++;
if (consecutiveFailures >= 10) {
  logger.error("Cache write failures exceeded threshold — Redis may be degraded", {
    key: fullKey, dagId, consecutiveFailures,
  });
} else {
  logger.warn("Cache set failed — Redis error", { key: fullKey, dagId, error: setResult.error.kind });
}

// On success:
consecutiveFailures = 0;
```

This keeps the function best-effort but provides production observability. Full "transition to degraded" is a future enhancement.

**Verification:** Test: simulate N Redis failures → verify error-level log after threshold.

---

### I11. NFR-003 MUST downgraded to SHOULD in comment

**File:** `packages/host/src/sync/sync-loop.ts` (line 20)

**Fix:**
```
- @satisfies NFR-003 — Git sync detection SHOULD complete within poll interval + 5s (individual ops timeout at 30s; overall cycle timeout not yet enforced)
+ @satisfies NFR-003 — Git sync detection MUST complete within poll interval + 5s (individual ops timeout at 30s; overall cycle timeout TBD — tracked for future enforcement)
```

**Verification:** Grep confirms MUST.

---

## Wave 3: Suggestions

### S1. Introduce `TeamId` branded type

**Files:** `packages/framework/src/types/ids.ts`, `packages/host/src/domain/auth.ts`, `packages/host/src/domain/registry.ts`, etc.

**Change:** Add `TeamId` brand in framework types. Use in `RegisteredDag.team`, `TokenGrant.team`, `AuthIdentity.team`, `HostError` forbidden variant.

**Verification:** `tsc --noEmit` passes. All tests pass.

---

### S2. Remove `route` duplication

**File:** `packages/host/src/domain/registry.ts`, `packages/host/src/domain/dag-factory.ts`

**Change:** Remove `RegisteredDag.route` top-level field. Access via `RegisteredDag.config.route` everywhere.

**Cascade:** Update `list-dags` handler, `dag-factory`, any test referencing `.route` directly.

---

### S3. Extract onComplete callback logic into named function

**File:** `packages/host/src/host.ts`

**Change:** Extract `handleSyncComplete(newRegistry, newSha, logger, ...)` function.

---

### S4. Add `Retry-After` header on circuit-open 503

**File:** `packages/host/src/http/handlers/run-dag.ts` (~line 133)

**Change:** Add `headers: { "Retry-After": "30" }` to the circuit-open error response (matches cooldown period).

---

### S5. Create auth ADR

**File:** `docs/adr/0044-team-scoped-token-auth.md`

**Content:** Document the team-scoped token model, SHA-256 hash-only storage, constant-time comparison, `fug_` prefix convention, and Redis key layout.

---

### S6. Use sentinel abort reason for host timeouts

**File:** `packages/host/src/http/handlers/run-dag.ts`

**Change:**
```typescript
const HOST_TIMEOUT = Symbol("host-timeout");
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(HOST_TIMEOUT), timeoutMs);

// In catch:
if (e instanceof Error && e.name === "AbortError" && controller.signal.reason === HOST_TIMEOUT) {
```

---

### S7. Improve local git adapter hash robustness

**File:** `packages/host/src/adapters/git-sync.ts`

**Change:** Replace djb2 with `Bun.CryptoHasher("sha256")` for local mode change detection. Prevents false negatives from hash collisions.

---

### S8. Remove dead `?? 30_000` fallback

**File:** `packages/host/src/http/handlers/run-dag.ts` (line 155)

**Change:** `const timeoutMs = registered.config.timeout;` — remove unreachable fallback, or add defensive comment.

---

### S9. Move `hashToken` to adapter/utility

**File:** `packages/host/src/domain/auth.ts` → `packages/host/src/adapters/hash.ts`

**Change:** Extract `hashToken` to an adapter module. The `auth.ts` domain module remains sync and pure. Auth middleware and admin handlers import from the adapter.

**Assessment:** Low priority — `hashToken` is deterministic and well-documented. Skip if team prefers cohesion over purity.

---

### S10. Test `startSyncLoop` no-change path and concurrency guard

**File:** `packages/host/src/__tests__/sync-loop.test.ts`

**Change:** Add tests for:
- `triggerSync` while sync in progress → returns `{ kind: "skipped" }`
- SHA unchanged between polls → `onNoChange` called (after C1 fix)
- Unexpected throw → `onError` called, loop recovers

---

## Execution Order

```
Wave 1 (Critical — do first, in order):
  C1 → C2 → C3 → C4 → C5

Wave 2 (Important — parallel-safe within wave):
  I1, I2, I3 (can be done in parallel — different files)
  I4, I5 (both touch host.ts/auth.ts — do sequentially)
  I7 (ports.ts + cascade — do before I9 tests)
  I8 (host-state.ts — do before I9 property test)
  I6, I10, I11 (independent)
  I9 (tests — do LAST in wave 2, after all code fixes)

Wave 3 (Suggestions — non-blocking, cherry-pick):
  S5 (ADR — independent, no code)
  S1, S2 (type changes — cascade, do together)
  S3, S4, S6, S7, S8 (independent minor fixes)
  S9 (skip unless team wants strict purity)
  S10 (tests — do after C1 is complete)
```

## Estimated Effort

| Wave | Items | Estimated Time |
|------|-------|---------------|
| Wave 1 | 5 critical | ~45 min |
| Wave 2 | 11 important | ~90 min |
| Wave 3 | 10 suggestions | ~60 min |
| **Total** | **26 items** | **~3.5 hours** |

## Verification Checklist

After all fixes:
- [ ] `tsc --noEmit` — zero type errors
- [ ] `bun test` — all tests pass (existing + new)
- [ ] `grep -r "\.otherwise(" packages/host/src/` — zero results in production code
- [ ] `grep -r "NFR-030\|NFR-031\|SC-003\|FR-030" packages/host/src/__tests__/` — zero results
- [ ] No new `as unknown as` casts in production code (only branded type factories)
- [ ] All 6 empty test files have meaningful content
- [ ] Re-run `/review-pr` and confirm CRITICAL_COUNT: 0
