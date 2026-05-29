# PR Review Fixes — Final Remediation Plan

**Created:** 2026-05-22  
**Scope:** Fix all critical and important issues from comprehensive PR review  
**Approach:** Bottom-up — fix ports/domain first, then adapters, then wire changes

---

## Phase 1: Critical — Redis KEYS → SCAN

**Problem:** `redis.keys()` is O(N) and blocks the Redis event loop. Production-unsafe.

### Step 1.1: Add `scan` method to `RedisPort`
**File:** `packages/host/src/ports.ts`
- Add: `readonly scan: (pattern: string, cursor?: string) => Promise<Result<{ cursor: string; keys: string[] }, HostError>>`
- Keep `keys` for backward compat but mark deprecated with JSDoc

### Step 1.2: Implement `scan` in production Redis adapter
**File:** `packages/host/src/main.ts`
- Add `scan` implementation using ioredis `scanStream` or manual `SCAN cursor MATCH pattern COUNT 100`
- Iterate until cursor returns "0"

### Step 1.3: Replace `keys` usage in `createRedisTokenStore.listTeams`
**File:** `packages/host/src/adapters/token-store.ts`
- Replace `redis.keys(pattern)` with iterative `redis.scan(pattern)` loop
- Accumulate all keys from cursor-based iteration

### Step 1.4: Update in-memory token store (tests)
- In-memory adapter's `scan` just filters the map (no cursor needed for tests)

### Step 1.5: Add test for scan-based listTeams
- Test with >100 teams to verify cursor iteration works

---

## Phase 2: Important — Atomic token store `store()`

**Problem:** Check-then-act race: two concurrent `POST /admin/teams` for same team can both succeed.

### Step 2.1: Add `setNx` (set-if-not-exists) to `RedisPort`
**File:** `packages/host/src/ports.ts`
- Add: `readonly setNx: (key: string, value: string, opts?: { expiresInSec?: number }) => Promise<Result<boolean, HostError>>`
- Returns `true` if key was set (didn't exist), `false` if already existed

### Step 2.2: Implement in production Redis adapter
**File:** `packages/host/src/main.ts`
- Use ioredis `setnx` or `set(key, val, 'NX')`

### Step 2.3: Rewrite `createRedisTokenStore.store()` to use atomic set
**File:** `packages/host/src/adapters/token-store.ts`
- Replace GET check with `setNx` on `teamKey(team)`
- If `setNx` returns false → team already exists
- If `setNx` returns true → proceed to set `tokenKey(hash)`
- Rollback: if tokenKey SET fails, delete teamKey

### Step 2.4: Update in-memory adapter for consistency
- In-memory `store()` already checks `byTeam.has(team)` which is atomic in JS. Fine.

### Step 2.5: Add concurrent store test
- Spawn two promises that both call `store("team-x", ...)` simultaneously
- Assert exactly one succeeds and one returns `team-already-exists`

---

## Phase 3: Important — Fix `path` vs `route` in sync-callbacks diff

**Problem:** `sync-callbacks.ts` passes `d.route` (HTTP route like `/dags/x/run`) as `DagSnapshot.path` (which should be filesystem path like `/tmp/dags/team/x/dag.ts`).

### Step 3.1: Add `modulePath` or source path to `RegisteredDag`
**File:** `packages/host/src/domain/registry.ts`
- Add `readonly modulePath: string` to `RegisteredDag` interface

### Step 3.2: Thread `modulePath` through `loadResultToRegisteredDag`
**File:** `packages/host/src/domain/dag-factory.ts`
- Pass `result.modulePath` through to the `RegisteredDag`

### Step 3.3: Fix sync-callbacks to use `modulePath`
**File:** `packages/host/src/sync/sync-callbacks.ts:79`
- Change `path: d.route` → `path: d.modulePath`
- Same fix for `newDags` array

### Step 3.4: Update affected tests
- Any test that constructs `RegisteredDag` manually needs `modulePath`

---

## Phase 4: Important — Require `signal` in `createContext`

**Problem:** Optional signal creates orphaned `AbortController` — DAG becomes un-cancelable.

### Step 4.1: Make signal required in `createContext` type
**File:** `packages/host/src/host.ts`
- Change: `createContext: (registered: RegisteredDag, signal?: AbortSignal)` → `createContext: (registered: RegisteredDag, signal: AbortSignal)`
- Remove the `?? new AbortController().signal` fallback

### Step 4.2: Update `RunDagDeps.createContext` type
**File:** `packages/host/src/http/handlers/run-dag.ts`
- Already passes signal from AbortController — no functional change needed
- Just update the type signature

### Step 4.3: Update test fakes
- Any test that calls `createContext` without a signal needs one

---

## Phase 5: Suggestions — Consolidate `AuthEnv` / `HostEnv`

### Step 5.1: Remove `AuthEnv` from `middleware/auth.ts`
**File:** `packages/host/src/http/middleware/auth.ts`
- Delete the `AuthEnv` type export
- Import `HostEnv` from `../router.js` if needed, or just use `Context` generically since middleware doesn't need the full env

### Step 5.2: Single source of truth in `router.ts`
- `HostEnv` already includes both `hostState` and `authIdentity`
- No functional change — just remove the duplicate type definition

---

## Phase 6: Add missing test coverage

### Step 6.1: Token store rollback test
**File:** `packages/host/src/__tests__/token-store-rollback.test.ts` (new)
- Create a `RedisPort` fake that fails on the Nth `set` call
- Call `store("team-a", hash, grant)` with failure on team-index SET
- Assert the token-hash key was cleaned up (rolled back)

### Step 6.2: Concurrent store race test
- As described in Phase 2, Step 2.5

---

## Phase 7: Polish — Minor improvements

### Step 7.1: Deprecate `keys` on `RedisPort`
- Add `@deprecated Use scan() for production — keys() blocks Redis` JSDoc

### Step 7.2: Document LLM stub in main.ts
- Add a TODO/ADR reference for when real LLM integration is wired

### Step 7.3: Narrow `redis-unavailable` operation type (optional)
- If desired, create a `RedisOperation` string literal union
- Low priority — current approach works, just less type-safe

---

## Execution Order

```
Phase 1 (CRITICAL)  → ~30 min
Phase 2 (IMPORTANT) → ~20 min  
Phase 3 (IMPORTANT) → ~15 min
Phase 4 (IMPORTANT) → ~10 min
Phase 5 (CLEANUP)   → ~5 min
Phase 6 (TESTS)     → ~20 min
Phase 7 (POLISH)    → ~10 min
```

**Total estimated:** ~2 hours

## Verification

After all phases:
1. `bun test packages/host` — all pass
2. `bun run tsc --noEmit` — no type errors
3. Manual smoke: confirm `listTeams` uses scan, `store` is atomic
4. Re-run `/review-pr` to confirm resolution

---

## Dependencies Between Phases

```
Phase 1 (scan) ← independent
Phase 2 (setNx) ← independent  
Phase 3 (modulePath) ← independent
Phase 4 (signal) ← independent
Phase 5 (AuthEnv) ← independent
Phase 6 (tests) ← depends on Phases 1, 2, 3
Phase 7 (polish) ← independent
```

Phases 1–5 can be done in parallel. Phase 6 depends on the port changes.
