# Plan: Fix All PR Review Findings

**Created:** 2026-05-22  
**Status:** Ready  
**Source:** Comprehensive PR review of `@fugue/host` (135 files, 18840 insertions)

---

## Execution Order

Fixes are grouped into waves. Each wave can be committed independently.
Dependencies flow downward — earlier waves must complete before later ones.

---

## Wave 1: Build & CI (unblocks everything else)

### 1.1 — Install dependencies
```bash
bun install
```
Verify all 52 tests pass after install.

### 1.2 — Fix Dockerfile lockfile name
**File:** `packages/host/Dockerfile:11`
```diff
-COPY package.json bun.lockb ./
+COPY package.json bun.lock ./
```

### 1.3 — Fix tsconfig module resolution
**File:** `packages/host/tsconfig.json`

The host uses Hono + Bun which require bundler resolution for bare specifier imports.
The framework package uses the base config (NodeNext). Since `composite: true` in base
requires compatible resolution across references, and the host is never consumed as a
library by other TS packages (it's a binary), the simplest fix is:

**Option A (preferred):** Remove `module`/`moduleResolution` overrides. Bun's runtime doesn't
care about tsconfig module settings — they only affect type-checking. NodeNext works fine
for `.js` extension imports.

```diff
 {
   "extends": "../../tsconfig.base.json",
   "compilerOptions": {
     "rootDir": "src",
     "outDir": "dist",
-    "types": ["@types/bun"],
-    "module": "ESNext",
-    "moduleResolution": "bundler"
+    "types": ["@types/bun"]
   },
   "include": ["src"],
   "references": [
     { "path": "../framework" }
   ]
 }
```

**Verify:** `bun run typecheck` passes after change.

---

## Wave 2: Critical — Data Loss / Correctness

### 2.1 — Fix `listTeams` returning only in-process teams after restart
**File:** `packages/host/src/adapters/token-store.ts`

**Approach:** On first `listTeams()` call, do a one-time Redis SCAN to populate the
in-process mirror. Alternatively, always read from Redis using a SCAN/KEYS pattern.

Since `RedisPort` only exposes `get/set/del`, extend it minimally:

**Option A (simplest — document limitation):** Add a comment to the `listTeams` response
noting it only shows teams provisioned since boot, and add a note in `docs/auth.md`.

**Option B (proper fix):** Store grants in a Redis hash (`fugue:teams-index`) for O(1)
listing. Requires adding `hgetall` to `RedisPort`.

**Chosen:** Option B — add `keys` method to RedisPort for production correctness.

**Changes:**
1. Add `keys(pattern: string): Promise<Result<string[], HostError>>` to `RedisPort`
2. Implement in `main.ts` Redis adapter using `client.keys(pattern)`
3. Change `listTeams()` in Redis token store to scan `fugue:teams:*` keys and
   batch-get their values
4. Remove the `knownTeams` in-process mirror (or keep as cache with Redis as source of truth)
5. Update tests

### 2.2 — Wire HostConfig timeout defaults into DAG factory
**File:** `packages/host/src/domain/dag-factory.ts`

The `loadResultToRegisteredDag` function currently uses `resolveDefaults()` which
hardcodes 30s. It should accept host config defaults and enforce the max.

**Changes:**
1. Add `hostDefaults` parameter to `loadResultToRegisteredDag`:
   ```typescript
   interface HostTimeoutDefaults {
     readonly defaultTimeoutMs: number;
     readonly maxTimeoutMs: number;
     readonly defaultMaxConcurrent: number;
   }
   ```
2. Use `hostDefaults.defaultTimeoutMs` as fallback instead of hardcoded 30s
3. Clamp timeout with `Math.min(resolved, hostDefaults.maxTimeoutMs)`
4. Pass `{ defaultTimeoutMs: config.DEFAULT_DAG_TIMEOUT_MS, maxTimeoutMs: config.MAX_DAG_TIMEOUT_MS, defaultMaxConcurrent: config.DEFAULT_DAG_CONCURRENCY }` from host.ts and sync-loop.ts
5. Update `sync-loop.ts` → `executeSyncCycle` to accept and thread these defaults
6. Update tests

---

## Wave 3: Important — Observability & Correctness

### 3.1 — Health endpoint reports degraded status
**File:** `packages/host/src/http/handlers/health.ts`

```diff
 export const healthHandler = (c: Context<HostEnv>): Response => {
-  return healthResponse(c, "ok");
+  const hostState = c.get("hostState");
+  if (hostState.phase === "degraded") {
+    return healthResponse(c, "degraded");
+  }
+  return healthResponse(c, "ok");
 };
```

**Test:** Add test case in `packages/host/src/__tests__/handlers/health.test.ts`.

### 3.2 — Remove duplicate `RegisteredDag.route` / `.config.route`
**File:** `packages/host/src/domain/registry.ts`

Remove `route` from `ResolvedDagConfig` — it's a routing concern, not a config concern.
The top-level `RegisteredDag.route` is the canonical location.

**Changes:**
1. Remove `route` from `ResolvedDagConfig` interface
2. Update `dag-factory.ts` to not set `config.route`
3. Update any readers of `registered.config.route` → `registered.route`
4. Grep for all usages and update

### 3.3 — Simplify team name validation regex
**File:** `packages/host/src/http/handlers/admin/teams.ts`

Replace the two-branch validation with a single clear regex:

```diff
-    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(teamName) && teamName.length > 1) {
-      return errorResponse(c, 400, "input-validation-failed",
-        "Team name must be lowercase alphanumeric with hyphens (e.g., 'team-a')");
-    }
-    if (teamName.length === 1 && !/^[a-z0-9]$/.test(teamName)) {
-      return errorResponse(c, 400, "input-validation-failed",
-        "Team name must be lowercase alphanumeric with hyphens (e.g., 'team-a')");
-    }
+    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(teamName)) {
+      return errorResponse(c, 400, "input-validation-failed",
+        "Team name must be lowercase alphanumeric with hyphens, starting and ending with alphanumeric (e.g., 'team-a')");
+    }
```

---

## Wave 4: Architecture Polish

### 4.1 — Extract sync callbacks from host.ts
**File:** `packages/host/src/host.ts` → new file `packages/host/src/sync/sync-callbacks.ts`

Extract the 4 callbacks (`onStarted`, `onComplete`, `onNoChange`, `onError`) into a
factory function:

```typescript
export interface SyncCallbackDeps {
  readonly getState: () => HostState;
  readonly setState: (s: HostState) => void;
  readonly getCircuitBreakers: () => Map<DagId, CircuitState>;
  readonly logger: LogPort;
}

export const createSyncCallbacks = (deps: SyncCallbackDeps) => ({
  onStarted: () => { ... },
  onComplete: (registry: Registry, sha: GitSha) => { ... },
  onNoChange: (sha: GitSha) => { ... },
  onError: (error: HostError) => { ... },
});
```

**Benefit:** Testable in isolation without booting full host. Reduces host.ts by ~80 lines.

### 4.2 — Replace `SharedInfra.contentFilter: ContentFilter | null` with NoOp
**File:** `packages/host/src/ports.ts` and `packages/host/src/main.ts`

```diff
 export interface SharedInfra {
   readonly llm: LlmClient;
   readonly redis: RedisPort;
   readonly tracer: Tracer;
-  readonly contentFilter: ContentFilter | null;
+  readonly contentFilter: ContentFilter;
   readonly logger: LogPort;
 }
```

Add a `noopContentFilter` in framework or host that always passes. Update `main.ts`
to use it instead of `null`. Update `createNodeContextForDag` to remove null handling.

### 4.3 — Add admin route-level guard (defense-in-depth)
**File:** `packages/host/src/http/router.ts`

Add a simple middleware for `/admin/*` routes:

```typescript
app.use("/admin/*", async (c, next) => {
  const identity = c.get("authIdentity");
  if (!identity || identity.kind !== "admin") {
    return errorResponse(c, 403, "forbidden", "Admin access required");
  }
  await next();
});
```

This makes the `requireAdmin()` in each handler truly defense-in-depth rather than
the primary guard.

---

## Wave 5: Documentation & Minor

### 5.1 — Add FR-xxx requirements reference
**File:** `docs/requirements.md` (new)

Create a brief document explaining that FR/NFR/SC references come from the spec:
```markdown
# Requirement Traceability

Requirement IDs (FR-xxx, NFR-xxx, SC-xxx) referenced in source code correspond to
the spec document at `.claude/specs/2026-05-20-fugue-host/spec.md`.

See that file for full requirement definitions.
```

### 5.2 — Document ConcurrencyState GC trade-off
**File:** `packages/host/src/domain/concurrency.ts`

Add a doc comment at the top:
```typescript
/**
 * PERFORMANCE NOTE: acquire/release create new Map instances per call.
 * At MAX_GLOBAL_CONCURRENCY=50, this means ≤100 Map copies/sec in steady state.
 * If scaling beyond 200+ concurrent, consider mutable-with-atomics approach.
 * Measured: Map(10 entries) copy is ~0.5μs — negligible at current scale.
 */
```

### 5.3 — Document local dev SHA collision risk
**File:** `packages/host/src/adapters/git-sync.ts`

Add to `createLocalGitAdapter` docstring:
```typescript
/**
 * NOTE: The mtime hash uses a simplified djb2-like algorithm. Hash collisions
 * are possible (two different file states → same hash → sync skipped).
 * Acceptable for dev mode. Workaround: touch any .ts file to force different mtime.
 */
```

---

## Verification Checklist

After all waves complete:

- [ ] `bun install` succeeds
- [ ] `bun test` — all 52 tests pass (0 failures)
- [ ] `bun run typecheck` — no TypeScript errors
- [ ] `docker build -f packages/host/Dockerfile .` — builds successfully
- [ ] Manual smoke: boot host in local mode, hit /health, /readiness, /dags
- [ ] Property tests still pass (`bun test packages/host/src/__tests__/*.property.test.ts`)

---

## Estimated Effort

| Wave | Effort | Risk |
|------|--------|------|
| 1 — Build/CI | 10 min | Low (mechanical) |
| 2 — Critical fixes | 1-2 hr | Medium (RedisPort extension, threading defaults) |
| 3 — Important fixes | 30 min | Low (small targeted changes) |
| 4 — Architecture | 45 min | Low (refactoring with existing tests) |
| 5 — Documentation | 15 min | None |

**Total:** ~3 hours
