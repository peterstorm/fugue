# PR Review Remediation Plan (v2)

**Date:** 2026-05-22  
**Branch:** feat/fugue-host  
**Issues:** 3 critical, 8 important, 7 suggestions = 18 total  

---

## Phase 1: Critical Fixes (must fix before merge)

### C1. Sync loop remote detection deadlock
**File:** `packages/host/src/sync/sync-loop.ts`  
**Problem:** `executeSyncCycle` reads local SHA via `git rev-parse HEAD` and compares to `lastSha` BEFORE pulling. In remote mode, local HEAD never changes until pull executes, but pull only runs if SHA differs. The loop always returns `no-change` after initial clone.

**Fix:** Restructure `executeSyncCycle` to pull BEFORE SHA comparison in remote mode:

```typescript
// BEFORE (broken)
// 1. currentSha = rev-parse HEAD (local)
// 2. if currentSha === lastSha → no-change  ← deadlock here
// 3. pull
// 4. ...

// AFTER (correct)
// 1. If remote mode AND lastSha !== EMPTY_SHA → pull first
// 2. currentSha = rev-parse HEAD (now reflects remote)
// 3. if currentSha === lastSha → no-change (genuine no-change)
// 4. ...
```

Specifically:
1. Move the `pull` step (Step 3) to BEFORE the SHA read (Step 1) when in remote mode and not initial sync (lastSha !== "")
2. Keep the initial sync path unchanged (clone handles the first fetch)
3. If pull fails, return error with previousSha (same as current behavior)

**Test updates:** `sync-loop.test.ts` — add test: "detects remote changes after pull advances HEAD"

---

### C2. `TokenStorePort.listTeams()` missing Result return
**File:** `packages/host/src/ports.ts` (line 157)  
**Downstream:** `packages/host/src/adapters/token-store.ts`, `packages/host/src/http/handlers/admin/teams.ts`  

**Problem:** Only port method not returning `Result<T, HostError>`. Infrastructure failures have no error channel.

**Fix:**
1. Change port signature:
   ```typescript
   readonly listTeams: () => Promise<Result<readonly TokenGrant[], HostError>>;
   ```
2. Update `createInMemoryTokenStore`:
   ```typescript
   listTeams: async () => ok(Array.from(byTeam.values()).map((v) => v.grant)),
   ```
3. Update `createRedisTokenStore`:
   ```typescript
   listTeams: async () => ok(Array.from(knownTeams.values())),
   ```
4. Update `teams.ts` handler to unwrap Result:
   ```typescript
   const teamsResult = await deps.tokenStore.listTeams();
   if (!teamsResult.ok) return errorResponse(c, teamsResult.error);
   const teams = teamsResult.value;
   ```

**Test updates:** Update `handlers/admin/teams.test.ts` to account for Result wrapper.

---

### C3. `onStarted()` outside try block — deadlock on throw
**File:** `packages/host/src/sync/sync-loop.ts` (line ~253 in `doSync`)  

**Problem:** If `onStarted()` throws, the catch block never runs, `running` stays `true`, and all future syncs return `"skipped"` permanently.

**Fix:** Move `onStarted()` inside the try block:
```typescript
const doSync = async (): Promise<SyncResult> => {
  if (running) {
    return { kind: "skipped", previousSha: lastSha, reason: "already-in-progress" };
  }

  running = true;
  try {
    onStarted();  // ← moved inside try
    const result = await executeSyncCycle(git, loader, config, lastSha, logger);
    // ... rest unchanged
  } catch (e) {
    // ... existing error recovery
  } finally {
    running = false;
  }
};
```

**Test:** Add `sync-loop.test.ts` case: "recovers if onStarted throws — next sync not deadlocked"

---

## Phase 2: Important Fixes (should fix)

### I1. `disconnectRedis().catch(() => {})` — silent resource leak
**File:** `packages/host/src/main.ts` (line 177)

**Fix:**
```typescript
} catch (e) {
  await disconnectRedis().catch((disconnectErr) => {
    console.error(JSON.stringify({
      level: "error",
      msg: "Failed to disconnect Redis during error cleanup",
      error: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
      ts: new Date().toISOString(),
    }));
  });
  throw e;
}
```

---

### I2. Unused `now` parameter in `redisRecovered`
**File:** `packages/host/src/domain/host-state.ts` (~line 195)

**Fix:** Remove the `now` parameter since it's intentionally unused (recovery preserves existing timestamps):
```typescript
export const redisRecovered = (
  state: HostState,
): Result<HostState, TransitionError> => {
```

**Downstream:** Update all call sites (likely `host.ts`) to not pass `now`. Update tests.

---

### I3. `lastSha !== ""` raw comparison → use branded constant  
**File:** `packages/host/src/sync/sync-loop.ts` (line 160)

**Fix:** Import and use `EMPTY_SHA` or the branded empty constructor:
```typescript
import { gitSha } from "@fugue/framework";

const EMPTY_SHA = gitSha("");

// In executeSyncCycle:
if (!config.isLocalMode && lastSha !== EMPTY_SHA) {
```

Note: Since `GitSha` is a branded string, `=== ""` would already work via string comparison. But using the constant communicates intent. Check if `@fugue/framework` exports an `EMPTY_SHA` constant — if not, define one locally in sync-loop.ts.

---

### I4. ADR-0037 references non-existent file
**File:** `docs/adr/0037-pure-concurrency-limiter.md` (line 42, 60)

**Fix:** Update both references from the non-existent middleware path to actual location:
```markdown
// Line 42:
Implementation lives at `packages/host/src/domain/concurrency.ts`. The imperative
shell (`packages/host/src/http/handlers/run-dag.ts`) holds the mutable state
reference, calls acquire before dispatch, and release in finally.

// Line 60:
- The imperative shell must correctly maintain the mutable state reference. A bug
  in the shell (e.g. missing `release` in an error path) could leak slots. Mitigated
  by the finally-block pattern in the run-dag handler.
```

---

### I5. Auth middleware false ADR-0033 reference
**File:** `packages/host/src/http/middleware/auth.ts` (line 13)

**Fix:** Remove the incorrect cross-reference:
```typescript
// BEFORE:
// Design decision documented in ADR-0033 trust model.

// AFTER:
// Trust model: admin token (env) is root of trust; team tokens are hashed
// and resolved via Redis. See packages/host/docs/auth.md for full design.
```

---

### I6. Smart constructors for HostError — eliminate `as HostError` casts
**File:** `packages/host/src/domain/host-error.ts` (new exports)  
**Downstream:** `packages/host/src/adapters/token-store.ts` (15+ casts)

**Fix:** Add smart constructor functions at end of `host-error.ts`:
```typescript
// ── Smart Constructors ─────────────────────────────────────────────────────

export const redisUnavailable = (operation: string): HostError => ({ kind: "redis-unavailable", operation });
export const teamAlreadyExists = (team: string): HostError => ({ kind: "team-already-exists", team });
export const teamNotFound = (team: string): HostError => ({ kind: "team-not-found", team });
export const importFailed = (path: string, message: string, stack?: string): HostError => ({ kind: "import-failed", path, message, stack });
export const validationFailed = (path: string, issues: readonly z.core.$ZodIssue[]): HostError => ({ kind: "validation-failed", path, issues });
export const noDefaultExport = (path: string): HostError => ({ kind: "no-default-export", path });
export const discoveryFailed = (dagsRoot: string, message: string): HostError => ({ kind: "discovery-failed", dagsRoot, message });
export const internalInvariantViolated = (message: string, context: Record<string, unknown>): HostError => ({ kind: "internal-invariant-violated", message, context });
```

Then replace all `{ kind: "...", ... } as HostError` casts in `token-store.ts` with the constructors:
```typescript
// BEFORE:
return err({ kind: "redis-unavailable", operation: "token-resolve" } as HostError);
// AFTER:
return err(redisUnavailable("token-resolve"));
```

---

### I7. Enrich `ConcurrencyError` with context
**File:** `packages/host/src/domain/concurrency.ts`

**Fix:** Change from bare strings to discriminated union with context:
```typescript
export type ConcurrencyError =
  | { readonly kind: "global-at-capacity"; readonly current: number; readonly max: number }
  | { readonly kind: "dag-at-capacity"; readonly dagId: DagId; readonly current: number; readonly max: number };
```

Update `acquire()` return:
```typescript
if (state.global.current >= state.global.max) {
  return err({ kind: "global-at-capacity", current: state.global.current, max: state.global.max });
}
// ...
if (dagState.current >= dagState.max) {
  return err({ kind: "dag-at-capacity", dagId, current: dagState.current, max: dagState.max });
}
```

**Downstream:** Update `run-dag.ts` handler to pattern-match on `.kind` instead of string equality. Update concurrency tests.

---

### I8. `proc.exited.catch(() => {})` — add diagnostic comment
**File:** `packages/host/src/adapters/git-sync.ts` (lines 57, 234)

**Fix:** Since the timeout error IS already returned and there's no logger in scope, add explicit justifying comments:
```typescript
proc.kill();
// Process may already have exited between timeout race resolution and kill.
// The exit reason is not meaningful after kill — the timeout error is already captured above.
await proc.exited.catch(() => {});
```

---

## Phase 3: Suggestions (nice to have)

### S1. Promote `Clock` type to `ports.ts`
**File:** `packages/host/src/ports.ts`

**Fix:** Add after LogPort:
```typescript
/** Injectable time source — enables deterministic testing. */
export type Clock = () => number;
```

Update `sync-loop.ts` to import from ports instead of defining locally. Update any other local `Clock` definitions.

---

### S2. Extract sync callbacks in `host.ts`
**File:** `packages/host/src/host.ts`

**Fix:** Extract sync loop callbacks to a named builder for readability:
```typescript
const buildSyncCallbacks = (state: { get: () => HostState; set: (s: HostState) => void }, logger: LogPort, circuits: Map<DagId, CircuitState>) => ({
  onStarted: () => { /* ... */ },
  onComplete: (registry: Registry, sha: GitSha) => { /* ... */ },
  onNoChange: (sha: GitSha) => { /* ... */ },
  onError: (error: HostError) => { /* ... */ },
});
```

---

### S3. Fix `"unknown" as DagId` bypass
**File:** `packages/host/src/adapters/module-loader.ts` (line 68)

**Fix:** Use the smart constructor:
```typescript
import { dagId } from "@fugue/framework";

// At module level (validated once):
const UNKNOWN_DAG_ID = dagId("unknown");

// Usage:
dagId: UNKNOWN_DAG_ID,
```

---

### S4. Update `lastSyncSha` comment
**File:** `packages/host/src/domain/host-state.ts` (line 43)

**Fix:**
```typescript
/**
 * Host lifecycle state ADT.
 *
 * `lastSyncSha` convention: branded empty string (via `gitSha("")`) means
 * "never synced" (initial state). After first successful sync, always a
 * valid 40-char git SHA. See also `EMPTY_SHA` in sync-loop.ts.
 */
```

---

### S5. Test for `onStarted` throw deadlock
**File:** `packages/host/src/__tests__/sync-loop.test.ts`

Covered by C3 fix — test is part of that change.

---

### S6. Test for Redis rollback double-failure in token store
**File:** `packages/host/src/__tests__/handlers/admin/teams.test.ts` or new file

**Fix:** Add test case:
```typescript
test("store handles double failure (team index + rollback)", async () => {
  // Create a Redis that fails on SET for team key AND fails on DEL for rollback
  const failingRedis = { ... };
  const store = createRedisTokenStore(failingRedis, mockLogger);
  const result = await store.store("team-x", hash, grant);
  expect(result.ok).toBe(false);
  expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("CRITICAL"));
});
```

---

### S7. Include JSON.parse error in cache corruption log
**File:** `packages/host/src/adapters/node-context-factory.ts` (line ~92)

**Fix:**
```typescript
} catch (e) {
  logger.warn("Cache entry corrupted — treating as miss", {
    key: fullKey,
    dagId,
    rawPreview: raw?.slice(0, 100),
    parseError: e instanceof Error ? e.message : String(e),
  });
  return { hit: false };
}
```

---

## Execution Order

```
1. C1 (sync deadlock)       — highest risk, correctness bug
2. C3 (onStarted try)       — in same file as C1, fix together
3. I3 (EMPTY_SHA)           — in same file as C1/C3, fix together
4. C2 (listTeams Result)    — port contract change, ripples to handler + tests
5. I6 (smart constructors)  — enables cleaner I4 fix; many file touches
6. I7 (ConcurrencyError)    — type change with downstream updates
7. I2 (unused now param)    — small, isolated
8. I1 (disconnectRedis)     — one line in main.ts
9. I8 (proc.exited comment) — two comments in git-sync.ts
10. I4 (ADR-0037)           — docs only
11. I5 (auth ADR ref)       — one comment
12. S1-S7                   — polish pass
```

**Estimated effort:** ~45 min for criticals, ~30 min for importants, ~20 min for suggestions.  
**Total:** ~1.5 hours

---

## Verification

After all fixes:
1. `bun test` — all packages pass
2. `bun run typecheck` — no type errors (especially after ConcurrencyError change)
3. Re-run `/review-pr code errors` to verify critical issues resolved
4. Run `security-expert` on auth domain (separate pass)
