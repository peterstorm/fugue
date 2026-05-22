# PR Review Remediation Plan — feat/fugue-host

**Date:** 2026-05-22  
**Branch:** feat/fugue-host  
**Scope:** 38 findings from 6-agent review (6 critical, 17 important, 15 suggestions)

## Strategy

7 waves, ordered by dependency and risk. Each wave is independently committable.
Waves 1-3 are critical fixes. Waves 4-5 are important. Waves 6-7 are suggestions/polish.

---

## Wave 1 — Logic Bugs (Critical #1, #2, #7)

### Fix 1.1: DAG diff computed against wrong state
**File:** `packages/host/src/host.ts` — `onComplete` callback

**Before:**
```typescript
const result = syncCompleted(hostState, newRegistry, newSha, Date.now());
if (result.ok) { hostState = result.value; }

// BUG: hostState.registry IS newRegistry now
const prevDags = hostState.phase !== "booting" && ...
```

**After:**
```typescript
// Capture previous registry BEFORE state transition
const prevRegistry = getRegistry(hostState);
const prevDags = prevRegistry
  ? Array.from(prevRegistry.dags.values()).map(d => ({ id: d.id, path: d.route, sha: d.sha }))
  : [];

const result = syncCompleted(hostState, newRegistry, newSha, Date.now());
if (result.ok) { hostState = result.value; }

// Compute diff using captured previous state
const newDags = Array.from(newRegistry.dags.values()).map(d => ({ id: d.id, path: d.route, sha: d.sha }));
const diff = diffDags(prevDags, newDags);
```

Also remove the stale `as { registry: Registry }` cast (finding #20).

### Fix 1.2: Wrap `Bun.serve` in try/catch
**File:** `packages/host/src/host.ts` — after router creation

**After:**
```typescript
let bunServer;
try {
  bunServer = Bun.serve({ fetch: app.fetch, port: config.PORT });
} catch (e) {
  return err({
    kind: "internal-invariant-violated",
    message: `Failed to bind HTTP server on port ${config.PORT}: ${e instanceof Error ? e.message : String(e)}`,
    context: { port: config.PORT },
  });
}
server = { port: bunServer.port, stop: () => bunServer.stop() };
```

### Fix 1.3: Clean up circuit breakers for removed DAGs
**File:** `packages/host/src/host.ts` — `onComplete` callback, after registry swap

**After:**
```typescript
// Clean up circuit breakers for removed DAGs (prevents memory leak)
const currentDagIds = new Set(newRegistry.dags.keys());
for (const dagId of circuitBreakers.keys()) {
  if (!currentDagIds.has(dagId)) {
    circuitBreakers.delete(dagId);
  }
}
// Force-reset circuit breakers for current DAGs (FR-092)
const now = Date.now();
for (const dagId of currentDagIds) {
  circuitBreakers.set(dagId, forceReset(now));
}
```

**Tests to update:** `full-lifecycle.test.ts` — add assertion that removed DAG's circuit breaker is cleaned.

---

## Wave 2 — Layer Violation & Type Safety (Critical #3, #4)

### Fix 2.1: Move LoadResult types to ports layer
**Files:**
- Create: `packages/host/src/ports/module-loader.ts` (extract `LoadResult`, `LoadError`, `BulkLoadResult`, `ModuleLoaderPort`)
- Update: `packages/host/src/adapters/module-loader.ts` → imports port interfaces from `../ports/module-loader.js`
- Update: `packages/host/src/domain/dag-factory.ts` → imports from `../ports/module-loader.js`
- Update: `packages/host/src/sync/sync-loop.ts` → imports from `../ports/module-loader.js`

**Alternative (simpler, less churn):** Move `LoadResult`, `LoadError`, `BulkLoadResult` interfaces to existing `packages/host/src/ports.ts` and keep `ModuleLoaderPort` there too. Then both `domain/dag-factory.ts` and `adapters/module-loader.ts` import from `../ports.js`.

**Decision:** Use alternative — consolidate into `ports.ts`. Less file churn, matches existing pattern.

### Fix 2.2: Brand cache-keys parameters
**File:** `packages/host/src/domain/cache-keys.ts`

**Before:**
```typescript
export const buildCacheKey = (dagId: string, key: string): string => ...
export const buildCheckpointKey = (dagId: string, runId: string, nodeId: string): string => ...
```

**After:**
```typescript
import type { DagId, RunId, NodeId } from "@fugue/framework";

export const cacheKeyPrefix = (dagId: DagId): string => `fugue:${dagId}:cache:`;
export const buildCacheKey = (dagId: DagId, key: string): string => `${cacheKeyPrefix(dagId)}${key}`;
export const checkpointKeyPrefix = (dagId: DagId, runId: RunId): string => `fugue:${dagId}:${runId}:`;
export const buildCheckpointKey = (dagId: DagId, runId: RunId, nodeId: NodeId): string =>
  `${checkpointKeyPrefix(dagId, runId)}${nodeId}`;
```

**Cascade:** Update `node-context-factory.ts` call sites — they should already have branded types available from the `RegisteredDag`.

---

## Wave 3 — Comment Accuracy (Critical #5, #6)

### Fix 3.1: Fix FR references in run-dag.ts header
**File:** `packages/host/src/http/handlers/run-dag.ts:3-7`

**After:**
```typescript
/**
 * Run DAG handler — POST /dags/:id/run
 *
 * FR-020: Executes DAG and returns result as JSON with 200
 * FR-026: Error responses are machine-readable JSON with error/message/details/dagId/runId
 * FR-027: Per-DAG concurrency limit exceeded returns 429 with Retry-After
 * FR-028: Per-DAG timeout returns 408 with run ID (enables future resumption)
 */
```

### Fix 3.2: Fix ResolvedDagConfig comment
**File:** `packages/host/src/domain/registry.ts:20-21`

**After:**
```typescript
/**
 * Per-DAG configuration — core fields (route, timeout, maxConcurrency) fully resolved.
 * Optional TTL and circuit-breaker overrides use host defaults when undefined.
 */
```

### Fix 3.3: Fix step numbering in run-dag.ts
**File:** `packages/host/src/http/handlers/run-dag.ts`

Renumber the `finally` block from "step 8" to "step 7".

### Fix 3.4: Fix sync-loop step 8 claim
**File:** `packages/host/src/sync/sync-loop.ts:12`

**After:**
```typescript
 * 8. Returns SyncResult to caller (registry swap performed externally by host.ts)
```

### Fix 3.5: Fix AD-5 → ADR-0034
**File:** `packages/host/src/adapters/git-sync.ts:13`

**After:**
```typescript
 * @satisfies ADR-0034 — Raw git via Bun.spawn
```

### Fix 3.6: Fix cache-keys FR references
**File:** `packages/host/src/domain/cache-keys.ts:7-9`

**After:**
```typescript
 * @satisfies FR-031 — Auto-namespace all Redis keys by DAG ID
 * @satisfies SC-008 — Two DAGs using same cache key string are isolated
```

---

## Wave 4 — Error Handling Hardening (Important #8, #9, #10, #11)

### Fix 4.1: Wrap createRedisConnectivity in try/catch returning Result
**File:** `packages/host/src/main.ts`

```typescript
const createRedisConnectivity = async (redisUrl: string): Promise<
  Result<{ port: RedisConnectivityPort; redis: RedisPort; disconnect: () => Promise<unknown> }, HostError>
> => {
  try {
    const { default: Redis } = await import("ioredis");
    const client = new Redis(redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true });
    // ... existing logic ...
    return ok({ port, redis, disconnect: () => client.quit() });
  } catch (e) {
    return err({
      kind: "redis-unavailable",
      operation: `Redis client initialization: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
};
```

Update `main()` to handle the Result:
```typescript
const redisResult = await createRedisConnectivity(config.REDIS_URL);
if (!redisResult.ok) {
  logger.error(`Redis connectivity failed: ${formatHostError(redisResult.error)}`);
  process.exit(1);
}
const { port: redisPort, redis, disconnect: disconnectRedis } = redisResult.value;
```

### Fix 4.2: Add context to extractDagId catch
**File:** `packages/host/src/domain/dag-registration.ts`

```typescript
try {
  return makeDagId(id);
} catch {
  // Expected: id string doesn't conform to DagId brand rules (e.g., "foo bar").
  // Fallback to "unknown" — the calling error includes the raw invalid value via path.
}
return makeDagId("unknown");
```

Also: the outer `validateDagRegistration` that calls `extractDagId` should include the raw attempted ID in its error message. Add `rawId: id` to the HostError details.

### Fix 4.3: Make createLlmClient less fragile
**File:** `packages/host/src/main.ts`

Two options:
- **A (safe stub):** Return a structured FrameworkError-like error instead of throwing
- **B (current + comment):** Document the throw contract and ensure the error handler catches it

**Decision:** Option B — add a clarifying comment. The current approach works because the error-handler middleware catches all throws. But improve the cast:

```typescript
const createLlmClient = (config: { LLM_PROVIDER: string; ANTHROPIC_API_KEY?: string; OPENAI_API_KEY?: string }): LlmClient => {
  const keyVar = config.LLM_PROVIDER === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const message = `LLM client not configured. Set ${keyVar} environment variable (provider: ${config.LLM_PROVIDER}).`;

  // Fail-on-use stub: throws a FrameworkError-shaped exception caught by error-handler middleware.
  // SAFETY: This is intentional — DAGs that don't use LLM never hit this path.
  // DAGs that do use LLM get an immediate actionable error rather than a silent null.
  const stub = {
    chat: async () => {
      throw Object.assign(new Error(message), { frameworkErrorKind: "llm-unavailable" as const });
    },
  };
  return stub as unknown as LlmClient;
};
```

### Fix 4.4: Upgrade onShutdown error to logger.error
**File:** `packages/host/src/host.ts`

```typescript
logger.error("Error during infrastructure cleanup — resources may be leaked", {
  error: e instanceof Error ? e.message : String(e),
});
```

---

## Wave 5 — Type System Hardening (Important #12-16, #13)

### Fix 5.1: Add safe JSON stringify to logger
**File:** `packages/host/src/main.ts`

```typescript
const safeStringify = (obj: unknown): string => {
  try { return JSON.stringify(obj); }
  catch { return `[unserializable: ${typeof obj}]`; }
};

const createLogger = (): SyncLogger => ({
  info: (msg, data) => console.log(safeStringify({ level: "info", msg, ...data, ts: new Date().toISOString() })),
  warn: (msg, data) => console.warn(safeStringify({ level: "warn", msg, ...data, ts: new Date().toISOString() })),
  error: (msg, data) => console.error(safeStringify({ level: "error", msg, ...data, ts: new Date().toISOString() })),
});
```

### Fix 5.2: Fix ResolvedDagConfig optional fields
**File:** `packages/host/src/domain/registry.ts`

Make optional fields explicitly optional with documented semantics (already the case — the fix is the comment from Wave 3). The optionals are intentional: they mean "use host defaults". Add a type-level comment:

```typescript
export interface ResolvedDagConfig {
  readonly route: string;
  readonly timeout: number;
  readonly maxConcurrency: number;
  /** Per-DAG override. `undefined` → host applies global CACHE_TTL_MS default. */
  readonly cacheTtlMs?: number;
  /** Per-DAG override. `undefined` → host applies global CHECKPOINT_TTL_MS default. */
  readonly checkpointTtlMs?: number;
  /** Per-DAG override. `undefined` → host applies global circuit breaker config. */
  readonly circuitBreaker?: {
    readonly failureThreshold: number;
    readonly resetTimeoutMs: number;
  };
}
```

### Fix 5.3: Add `GitSha` branded type
**File:** `packages/framework/src/types/ids.ts` — add GitSha brand

```typescript
export type GitSha = string & { readonly __brand: unique symbol };
export const gitSha = (raw: string): GitSha => raw as unknown as GitSha;
```

Update `HostState` to use `GitSha` instead of plain `string` for `lastSyncSha`.
Update `Registry.sha` to use `GitSha`.

**Cascade:** All call sites passing SHA strings need to wrap in `gitSha(...)`. This is mechanical but touches ~10 files. Keep the empty-string sentinel but type it: `gitSha("")`.

**Decision:** Defer to a separate PR if cascade is >20 lines. Mark as TODO with ADR reference.

### Fix 5.4: FugueYaml.timeoutMs add .positive()
**File:** `packages/host/src/domain/config.ts` or `dag-registration.ts`

```typescript
timeoutMs: z.number().positive().optional(),
```

### Fix 5.5: Consolidate port interfaces into ports.ts
**File:** `packages/host/src/ports.ts`

Move from their current locations:
- `GitPort` from `adapters/git-sync.ts`
- `ModuleLoaderPort` + `LoadResult` + `LoadError` + `BulkLoadResult` from `adapters/module-loader.ts`
- `RedisPort` + `SharedInfra` from `adapters/node-context-factory.ts`
- `CircuitPort` + `CircuitConfig` from `domain/circuit-guard.ts`
- `RedisConnectivityPort` from `lifecycle/startup.ts`

All port interfaces in one file (or `ports/` directory). Adapters import from ports, implement them.

**Decision:** This is a large refactor. Do it as a separate `ports/` directory with individual files:
```
packages/host/src/ports/
├── index.ts       (barrel re-export)
├── log.ts         (LogPort — existing)
├── git.ts         (GitPort)
├── module-loader.ts (ModuleLoaderPort, LoadResult, LoadError, BulkLoadResult)
├── redis.ts       (RedisPort, RedisConnectivityPort)
├── circuit.ts     (CircuitPort, CircuitConfig)
└── infra.ts       (SharedInfra)
```

**Risk:** High churn (every import path changes). Group with Wave 2.1 if doing it, or defer to follow-up PR.

**Decision:** Defer full port consolidation to follow-up. For this PR, only move `LoadResult`/`LoadError`/`BulkLoadResult`/`ModuleLoaderPort` to `ports.ts` (the minimum needed to fix the layer violation).

---

## Wave 6 — ADR Index & Documentation (Important #19)

### Fix 6.1: Update ADR README index
**File:** `docs/adr/README.md`

Add entries for ADRs 0030-0043:
```markdown
| [0030](0030-state-machine-pure-transitions.md) | Pure state machine transitions | Accepted |
| [0031](0031-immutable-registry-snapshot.md) | Immutable registry snapshot | Accepted |
| [0032](0032-framework-independence.md) | Framework independence | Accepted |
| [0033](0033-dag-registration-host-contract.md) | DAG registration host contract | Accepted |
| [0034](0034-raw-git-via-bun-spawn.md) | Raw git via Bun.spawn | Accepted |
| [0035](0035-hono-http-server.md) | Hono HTTP server | Accepted |
| [0036](0036-layered-error-handling.md) | Layered error handling | Accepted |
| [0037](0037-pure-concurrency-limiter.md) | Pure concurrency limiter | Accepted |
| [0038](0038-pure-circuit-breaker.md) | Pure circuit breaker | Accepted |
| [0039](0039-big-bang-rename.md) | Big-bang rename @ai-summary → @fugue | Accepted |
| [0040](0040-single-instance-in-memory-state.md) | Single instance in-memory state | Accepted |
| [0041](0041-separate-dags-repository.md) | Separate DAGs repository | Accepted |
| [0042](0042-config-via-zod-env-yaml.md) | Config via Zod env/YAML | Accepted |
| [0043](0043-otel-tracing-for-host-operations.md) | OTel tracing for host operations | Accepted |
```

Update numbering integrity section to say "all 43 ADRs present".

---

## Wave 7 — Polish & Suggestions (Nice-to-haves)

### Fix 7.1: Add maxRequestBodySize to Bun.serve
```typescript
const bunServer = Bun.serve({
  fetch: app.fetch,
  port: config.PORT,
  maxRequestBodySize: 10 * 1024 * 1024, // 10MB — prevents request body DoS
});
```

### Fix 7.2: DagDiff internal map should use DagId key
**File:** `packages/host/src/domain/dag-diff.ts`

Change internal `Map<string, DagSnapshot>` to `Map<DagId, DagSnapshot>` (may need to change map construction to use `id` as key since DagId is a branded string).

### Fix 7.3: Remove dead imports in sync-loop.ts
**File:** `packages/host/src/sync/sync-loop.ts`

Remove unused `diffDags`, `diffSummary`, `DagSnapshot` imports (if they're truly dead — verify no re-export usage).

### Fix 7.4: Propagate triggerSync result
**File:** `packages/host/src/host.ts`

```typescript
triggerSync: async () => {
  if (syncLoop) {
    const result = await syncLoop.triggerSync();
    if (result.kind === "error") {
      logger.warn("Manual sync trigger failed", { error: result.syncError });
    }
    return result;
  }
  return { kind: "no-op" as const };
},
```

Update `HostInstance.triggerSync` return type accordingly.

### Fix 7.5: Add corrupted cache raw preview
**File:** `packages/host/src/adapters/node-context-factory.ts`

```typescript
logger.warn("Cache entry corrupted — treating as miss", {
  key: fullKey, dagId,
  rawPreview: raw?.slice(0, 100),
});
```

### Fix 7.6: Dual timeout defaults comment
**File:** `packages/host/src/domain/dag-registration.ts`

```typescript
/**
 * Per-registration default when DAG module omits config.timeoutMs.
 * Distinct from HostConfig.DEFAULT_DAG_TIMEOUT_MS which is the host's fallback
 * for the MAX allowed timeout. This value is the per-DAG default if unspecified.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
```

### Fix 7.7: SyncLogger → use LogPort directly
**File:** `packages/host/src/sync/sync-loop.ts`

Remove `export type SyncLogger = import("../ports.js").LogPort;` alias. Use `LogPort` directly in all signatures. Update imports in consuming files.

---

## Execution Order

```
Wave 1  → git commit -m "fix: DAG diff ordering, Bun.serve safety, circuit breaker cleanup"
Wave 2  → git commit -m "refactor: move LoadResult to ports, brand cache-key params"
Wave 3  → git commit -m "docs: fix FR references, ResolvedDagConfig comment, step numbering"
Wave 4  → git commit -m "fix: Redis connectivity Result wrapper, extractDagId context, shutdown log level"
Wave 5  → git commit -m "refactor: safe stringify, ResolvedDagConfig docs, timeoutMs .positive()"
Wave 6  → git commit -m "docs: update ADR README index with 0030-0043"
Wave 7  → git commit -m "polish: maxRequestBodySize, DagDiff branded keys, dead imports, cache preview"
```

## Deferred (follow-up PR)

- **Full port consolidation** into `ports/` directory (high churn, no bug fix)
- **GitSha branded type** (touches ~10 files across host-state, registry, sync-loop)
- **CircuitPermit token pattern** (type-level protocol enforcement — design decision needed)
- **HostInstance phase distinction** (RunningHost / StoppedHost typestate — breaking API change)
- **RedisPort → Result return type** (breaking change to adapter interface — needs ADR)
- **LLM provider ↔ API key cross-validation** (product decision: fail-fast vs fail-on-use)

## Estimated Effort

| Wave | Files Touched | Risk | Time |
|------|--------------|------|------|
| 1 | 2 (host.ts, test) | Medium (logic changes) | 15 min |
| 2 | 4-5 (ports.ts, cache-keys, dag-factory, module-loader, node-context-factory) | Low (mechanical) | 20 min |
| 3 | 5 (run-dag, registry, sync-loop, git-sync, cache-keys) | None (comments only) | 10 min |
| 4 | 2 (main.ts, dag-registration.ts) | Low | 15 min |
| 5 | 3 (main.ts, registry.ts, config.ts) | Low | 10 min |
| 6 | 1 (README.md) | None | 5 min |
| 7 | 5 (host.ts, dag-diff.ts, sync-loop.ts, node-context-factory.ts, dag-registration.ts) | Low | 20 min |
| **Total** | | | **~95 min** |
