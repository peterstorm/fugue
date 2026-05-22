# Comprehensive PR Remediation Plan

**Branch:** feat/fugue-host  
**Date:** 2026-05-22  
**Source:** Full PR review (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, architecture-agent, comment-analyzer)  
**Scope:** 7 Critical, 17 Important, 10 Suggestions → 34 total findings

---

## Wave 1: Critical — Token Store Error Handling & Production Wiring

**Goal:** Fix the 3 most dangerous findings — silent failures that compromise security.

### T1.1: Fix `revoke()` — check Redis write results

**File:** `packages/host/src/adapters/token-store.ts`  
**Finding:** Redis `set` calls in `revoke()` discard results — revoked tokens stay active on Redis failure.

```typescript
// BEFORE (broken):
await redis.set(tokenKey(hash as TokenHash), "", { expiresInSec: 1 });
await redis.set(teamKey(team), "", { expiresInSec: 1 });

// AFTER (safe):
const tokenDelResult = await redis.set(tokenKey(hash as TokenHash), "", { expiresInSec: 1 });
if (!tokenDelResult.ok) {
  return err({ kind: "redis-unavailable", operation: "token-revoke-hash-delete" } as HostError);
}
const teamDelResult = await redis.set(teamKey(team), "", { expiresInSec: 1 });
if (!teamDelResult.ok) {
  // Best-effort: token hash already expired, but team index remains — log and error
  return err({ kind: "redis-unavailable", operation: "token-revoke-team-delete" } as HostError);
}
```

### T1.2: Fix `resolve()` — distinguish Redis errors from "not found"

**File:** `packages/host/src/adapters/token-store.ts`  
**Finding:** Redis errors silently become `null` → team tokens fail with 401 during outage instead of 503.

**Change:** Widen `TokenStorePort.resolve` signature to return `Result<TokenGrant | null, HostError>`:

```typescript
// ports.ts — widen signature:
readonly resolve: (hash: TokenHash) => Promise<Result<TokenGrant | null, HostError>>;

// token-store.ts — Redis adapter:
resolve: async (hash) => {
  const result = await redis.get(tokenKey(hash));
  if (!result.ok) return err({ kind: "redis-unavailable", operation: "token-resolve" } as HostError);
  if (result.value === null || result.value === "") return ok(null);
  try {
    return ok(JSON.parse(result.value) as TokenGrant);
  } catch (e) {
    logger.error(`[token-store] Corrupt grant data for hash ${String(hash).slice(0, 8)}...`);
    return ok(null);
  }
},

// In-memory adapter — wrap in ok():
resolve: async (hash) => ok(byHash.get(hash) ?? null),

// Auth middleware — handle Result:
const resolveResult = await deps.tokenStore.resolve(hash);
if (!resolveResult.ok) {
  return errorResponse(c, 503, "auth-service-unavailable", "Authentication service temporarily unavailable");
}
const grant = resolveResult.value;
if (!grant) {
  return errorResponse(c, 401, ...);
}
```

### T1.3: Wire Redis-backed token store in `host.ts`

**File:** `packages/host/src/host.ts`  
**Finding:** `createInMemoryTokenStore()` used in production — tokens lost on restart.

```typescript
// BEFORE:
const tokenStore = createInMemoryTokenStore();

// AFTER:
import { createRedisTokenStore } from "./adapters/token-store.js";
const tokenStore = createRedisTokenStore(sharedInfra.redis);
```

Also update imports to add `createRedisTokenStore`.

### T1.4: Fix partial write in `store()` — rollback on second write failure

**File:** `packages/host/src/adapters/token-store.ts`

```typescript
const teamSetResult = await redis.set(teamKey(team), teamJson);
if (!teamSetResult.ok) {
  // Rollback: expire the orphaned token hash to prevent unrevokable ghost token
  await redis.set(tokenKey(hash), "", { expiresInSec: 1 });
  return err({ kind: "redis-unavailable", operation: "token-store-team-index" } as HostError);
}
```

**Verification:** Run existing auth tests + write new test for partial-failure scenario.

---

## Wave 2: Critical — Type Safety & Config Validation

### T2.1: Add LLM provider/key cross-validation in config

**File:** `packages/host/src/domain/config.ts`  
**Finding:** `LLM_PROVIDER: "anthropic"` validates without `ANTHROPIC_API_KEY`.

Add `.superRefine()` after the existing `.refine()`:

```typescript
.refine(
  (c) => c.DEFAULT_DAG_TIMEOUT_MS <= c.MAX_DAG_TIMEOUT_MS,
  { message: "DEFAULT_DAG_TIMEOUT_MS must not exceed MAX_DAG_TIMEOUT_MS" },
)
.superRefine((c, ctx) => {
  if (c.LLM_PROVIDER === "anthropic" && !c.ANTHROPIC_API_KEY) {
    ctx.addIssue({ code: "custom", path: ["ANTHROPIC_API_KEY"], message: "Required when LLM_PROVIDER is 'anthropic'" });
  }
  if (c.LLM_PROVIDER === "openai" && !c.OPENAI_API_KEY) {
    ctx.addIssue({ code: "custom", path: ["OPENAI_API_KEY"], message: "Required when LLM_PROVIDER is 'openai'" });
  }
  if (c.LLM_PROVIDER === "azure" && (!c.AZURE_OPENAI_ENDPOINT || !c.AZURE_OPENAI_API_KEY || !c.AZURE_OPENAI_DEPLOYMENT)) {
    ctx.addIssue({ code: "custom", path: ["AZURE_OPENAI_ENDPOINT"], message: "AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and AZURE_OPENAI_DEPLOYMENT required when LLM_PROVIDER is 'azure'" });
  }
});
```

**Side effect:** Update config.test.ts to verify cross-validation. Update `main.ts` `createLlmClient` — now the stub can be a proper Result-returning client since config guarantees key presence.

### T2.2: Fix `GitPort.currentSha` to return `Result<GitSha, HostError>`

**File:** `packages/host/src/ports.ts`

```typescript
// BEFORE:
readonly currentSha: (repoPath: string) => Promise<Result<string, HostError>>;

// AFTER:
readonly currentSha: (repoPath: string) => Promise<Result<GitSha, HostError>>;
```

Add `GitSha` to the import from `@fugue/framework`. Then update:
- `packages/host/src/adapters/git-sync.ts` — return branded `gitSha(stdout)` from the adapter
- `packages/host/src/sync/sync-loop.ts` — remove manual branding after `currentSha` call
- Any tests that create fake GitPorts

### T2.3: Fix `createLlmClient` — return Result instead of throwing

**File:** `packages/host/src/main.ts`

```typescript
// BEFORE: throws
const stub = {
  chat: async () => {
    throw Object.assign(new Error(message), { frameworkErrorKind: "llm-unavailable" as const });
  },
};

// AFTER: returns Result (matching LlmClient contract)
const stub = {
  chat: async () => err({ kind: "llm-unavailable", message } as FrameworkError),
};
return stub as LlmClient;
```

**Note:** With T2.1, this path is only hit when LLM_PROVIDER is set but the key is explicitly empty string (edge case). Consider removing the stub entirely and requiring key presence.

---

## Wave 3: Critical — Comment Accuracy

### T3.1: Fix fabricated FR-200/FR-201 references

**File:** `packages/host/src/http/middleware/auth.ts`

```typescript
// BEFORE:
 * @satisfies FR-200 — Protected routes require valid bearer token
 * @satisfies FR-201 — Team tokens scoped to team's DAGs

// AFTER:
 * Added post-spec for multi-tenant team isolation.
 * No formal FR — design decision documented in ADR-0033 trust model.
```

### T3.2: Fix incorrect FR-028 → FR-023 in list-dags

**File:** `packages/host/src/http/handlers/list-dags.ts`

```typescript
// BEFORE:
 * FR-028: GET /dags returns list of registered DAGs with metadata

// AFTER:
 * FR-023: GET /dags returns list of registered DAGs with metadata
```

---

## Wave 4: Important — Security & Authorization

### T4.1: Fix authorization bypass when `authIdentity` is undefined

**File:** `packages/host/src/http/handlers/run-dag.ts`

```typescript
// BEFORE:
const identity = c.get("authIdentity") as AuthIdentity | undefined;
if (identity && !canAccessDag(identity, registered.team)) {

// AFTER:
const identity = c.get("authIdentity") as AuthIdentity | undefined;
if (!identity) {
  return errorResponse(c, 401, "unauthorized", "Missing auth identity — middleware not applied");
}
if (!canAccessDag(identity, registered.team)) {
```

### T4.2: Fix `constantTimeEqual` length leak

**File:** `packages/host/src/http/middleware/auth.ts`

```typescript
// BEFORE:
export const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
};

// AFTER:
/**
 * Constant-time string comparison. Iterates full max-length regardless
 * of content, preventing both prefix and length timing side-channels.
 */
export const constantTimeEqual = (a: string, b: string): boolean => {
  const maxLen = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length; // length difference contributes to result
  for (let i = 0; i < maxLen; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
};
```

### T4.3: Wrap `hashToken` rejection in auth middleware

**File:** `packages/host/src/http/middleware/auth.ts`

```typescript
// BEFORE:
const hash = await hashToken(token);
const grant = await deps.tokenStore.resolve(hash);

// AFTER:
let grant: TokenGrant | null;
try {
  const hash = await hashToken(token);
  const resolveResult = await deps.tokenStore.resolve(hash);
  if (!resolveResult.ok) {
    return errorResponse(c, 503, "auth-service-unavailable", "Authentication service temporarily unavailable");
  }
  grant = resolveResult.value;
} catch {
  return errorResponse(c, 503, "auth-service-unavailable", "Authentication service temporarily unavailable");
}
```

---

## Wave 5: Important — Architecture & Imports

### T5.1: Fix sync-loop imports → canonical `ports.ts`

**File:** `packages/host/src/sync/sync-loop.ts`

```typescript
// BEFORE:
import type { GitPort } from "../adapters/git-sync.js";
import type { ModuleLoaderPort, LoadResult } from "../adapters/module-loader.js";

// AFTER:
import type { GitPort, ModuleLoaderPort, LoadResult } from "../ports.js";
```

### T5.2: Fix `index.ts` re-exports → canonical `ports.ts`

**File:** `packages/host/src/index.ts`

```typescript
// BEFORE:
export type { GitPort } from "./adapters/git-sync.js";
export type { ModuleLoaderPort, LoadResult, BulkLoadResult, LoadError } from "./adapters/module-loader.js";
export type { SharedInfra, RedisPort } from "./adapters/node-context-factory.js";
export type { LogPort } from "./ports.js";

// AFTER:
export type { GitPort, ModuleLoaderPort, LoadResult, BulkLoadResult, LoadError, SharedInfra, RedisPort, LogPort } from "./ports.js";
```

### T5.3: Remove "backwards compatibility" re-exports from adapter files

Remove these lines from:
- `packages/host/src/adapters/git-sync.ts` → remove `export type { GitPort } from "../ports.js"`
- `packages/host/src/adapters/module-loader.ts` → remove type re-exports

### T5.4: Remove "backwards compatibility" re-export from `sync-loop.ts`

```typescript
// REMOVE this line:
export { loadResultToRegisteredDag, loadResultsToSnapshots } from "../domain/dag-factory.js";

// Any tests importing these from sync-loop → import directly from domain/dag-factory
```

### T5.5: Move `__unsafeTestToken` out of production barrel

**File:** `packages/host/src/domain/concurrency.ts`  
Create a `packages/host/src/testing.ts` subpath that exports test utilities:

```typescript
// packages/host/src/testing.ts
export { __unsafeTestToken } from "./domain/concurrency.js";
export { createInMemoryTokenStore } from "./adapters/token-store.js";
```

Update `package.json` exports:
```json
"./testing": "./src/testing.ts"
```

Remove `__unsafeTestToken` from the main `index.ts` if present.

---

## Wave 6: Important — Type Design Fixes

### T6.1: `isTeamTokenShape` → Parse Don't Validate

**File:** `packages/host/src/domain/auth.ts`

```typescript
// BEFORE:
export const isTeamTokenShape = (s: string): boolean =>
  s.startsWith(TOKEN_PREFIX) && s.length >= TOKEN_MIN_LENGTH;

// AFTER:
/**
 * Parse a string as a team token shape. Returns the branded TeamToken
 * if it has the correct prefix and minimum length.
 * Does NOT verify the token exists — that's the store's job.
 */
export const parseTeamTokenShape = (s: string): s is TeamToken =>
  s.startsWith(TOKEN_PREFIX) && s.length >= TOKEN_MIN_LENGTH;
```

Using a type guard (`s is TeamToken`) rather than `Result` since this is a structural validation — the caller already has the string and just needs the type narrowed. Update callers.

### T6.2: Split `concurrency-exceeded` into distinct kinds

**File:** `packages/host/src/domain/host-error.ts`

```typescript
// BEFORE:
| { readonly kind: "concurrency-exceeded"; readonly scope: "global" }
| { readonly kind: "concurrency-exceeded"; readonly scope: "dag"; readonly dagId: DagId }

// AFTER:
| { readonly kind: "global-concurrency-exceeded" }
| { readonly kind: "dag-concurrency-exceeded"; readonly dagId: DagId }
```

Update all exhaustive matches in `httpStatusFor`, `formatHostError`, and `run-dag.ts` handler.

### T6.3: Add `del` to `RedisPort`

**File:** `packages/host/src/ports.ts`

```typescript
export interface RedisPort {
  readonly get: (key: string) => Promise<Result<string | null, HostError>>;
  readonly set: (key: string, value: string, opts?: { expiresInSec?: number }) => Promise<Result<string | null, HostError>>;
  readonly del: (key: string) => Promise<Result<number, HostError>>;
}
```

Update:
- `token-store.ts` Redis adapter → use `del()` instead of `set("", { expiresInSec: 1 })`
- `main.ts` Redis client wrapper → implement `del`
- Test fakes → add `del` method

---

## Wave 7: Important — Comment Fixes

### T7.1: Fix `constantTimeEqual` comment

**File:** `packages/host/src/http/middleware/auth.ts` (done with T4.2)

### T7.2: Fix `DEFAULT_TIMEOUT_MS` comment

**File:** `packages/host/src/domain/dag-registration.ts`

```typescript
// BEFORE:
 * Distinct from HostConfig.DEFAULT_DAG_TIMEOUT_MS (config.ts) which is the
 * host-level max allowed timeout.

// AFTER:
 * Per-DAG registration default when DAG module omits config.timeoutMs.
 * Note: HostConfig.DEFAULT_DAG_TIMEOUT_MS (60s) is the host-level default;
 * HostConfig.MAX_DAG_TIMEOUT_MS (120s) is the maximum allowed.
 * Neither is currently wired to constrain this value — future work.
```

### T7.3: Fix sync-loop "backwards compatibility" comment

**File:** `packages/host/src/sync/sync-loop.ts`

Already removed in T5.4. If any re-exports remain, relabel:
```
// Re-export for test convenience (tests import from sync-loop)
```

---

## Wave 8: Tests — Fill Empty Test Files

**Goal:** Write the 6 most critical empty test files.

### T8.1: `host-state.test.ts`
All 8 transitions × {valid, invalid} + query functions:
- `bootComplete` from `booting` → `ready` ✓ 
- `bootComplete` from `ready` → TransitionError
- `syncStarted` from `ready` → `syncing` ✓
- `syncStarted` from `booting` → TransitionError
- `syncCompleted` from `syncing` → `ready` ✓ (preserves registry)
- `syncFailed` from `syncing` → keeps existing registry (NFR-012)
- `beginDrain` from `ready` → `draining` ✓
- `drainComplete` from `draining` → `stopped` ✓
- `redisDied` from `ready`/`syncing` → `degraded`
- `redisRecovered` from `degraded` → `ready`
- `canServeRequests` for each phase
- `getRegistry` for each phase

### T8.2: `host-state.property.test.ts`
- Property: any valid transition sequence never produces registry-less state that serves
- Property: `drainComplete` from non-draining always errors
- Property: `syncFailed` never loses existing registry
- Property: all transitions are total (every phase × event → Result)

### T8.3: `sync-loop.test.ts`
- `executeSyncCycle`: no-change (SHA unchanged) → `SyncResult.unchanged`
- `executeSyncCycle`: pull success + load → `SyncResult.updated`
- `executeSyncCycle`: pull fail → `SyncResult.error`
- `executeSyncCycle`: lockfile changed → runs install before load
- `executeSyncCycle`: diff-check failure → defensive install (fail-safe)
- `startSyncLoop`: concurrent guard (second sync skipped while first runs)
- `startSyncLoop`: stop() terminates timer

### T8.4: `handlers/run-dag.test.ts`
All 10+ error branches via `createRunDagHandler` with injected deps:
- Invalid DagId → 400
- Host not serving → 503
- DAG not found → 404
- DAG disabled → 503
- Authorization failure → 403
- Body parse error → 400
- Input validation failure → 400
- Circuit breaker open → 503
- Concurrency exceeded → 429
- Execution error (Result.err) → 500
- Timeout (AbortError) → 408
- Happy path → 200

### T8.5: `registry.test.ts` + `registry.property.test.ts`
- `withDag` adds, replaces, preserves others
- `withoutDag` removes, noop for missing
- `freeze` produces immutable snapshot
- `lookupDag` finds by DagId
- `healthyCount` counts healthy only
- `isEmpty` correctness
- Property: `withDag` is idempotent (same id replaces)
- Property: `withoutDag` of non-existent = identity
- Property: `freeze` → subsequent `withDag` on source doesn't affect frozen copy

### T8.6: `node-context-factory.test.ts`
- Cache key namespacing (same key, different DAGs → isolated)
- Redis failure → cache get returns miss (graceful degradation)
- Redis failure → cache set returns ok (no error propagation)
- Corrupted cache entry → treated as miss
- TTL resolution (dagConfig overrides, host defaults)

---

## Wave 9: Suggestions (Nice-to-Have, Do If Time Permits)

### T9.1: Introduce branded `TeamName` type
- Add to `@fugue/framework` or `@fugue/host` domain
- Regex: `/^[a-z0-9-]+$/` (filesystem-safe, Redis-key-safe)
- Add to: `TokenGrant.team`, `RegisteredDag.team`, `AuthIdentity.team`, `FugueYaml.team`

### T9.2: `ConcurrencyError` → discriminated union
```typescript
type ConcurrencyError =
  | { readonly kind: "global-at-capacity" }
  | { readonly kind: "dag-at-capacity"; readonly dagId: DagId };
```

### T9.3: Add `GitSha` format validation
```typescript
export const gitSha = (s: string): GitSha => {
  if (s !== "" && !/^[0-9a-f]{40}$/.test(s)) {
    throw new Error(`Invalid GitSha: "${s}"`);
  }
  return s as unknown as GitSha;
};
```

### T9.4: Log JSON parse failures in token store
Add `console.error` for corrupt Redis data in `resolve()` and `revoke()` catch blocks.

### T9.5: Add `listTeams` limitation log/indicator
When Redis adapter's `listTeams` is called, log a warning that the list may be incomplete.

### T9.6: Move `hashToken` to adapter
Create `packages/host/src/adapters/crypto.ts` with the hashing function. Update auth.ts to only export types and pure functions. Import `hashToken` from crypto adapter in middleware.

---

## Execution Order & Dependencies

```
Wave 1 (Token Store) ──────────────────── T1.1, T1.2, T1.3, T1.4
     │
     ├─ T1.2 changes TokenStorePort.resolve signature
     │  └─ affects auth middleware (T4.3)
     │  └─ affects existing tests (auth.test.ts, teams.test.ts)
     │
     └─ T1.3 requires T1.2 (Redis store uses new resolve signature)

Wave 2 (Types/Config) ─────────────────── T2.1, T2.2, T2.3
     │ (independent of Wave 1)
     └─ T2.1 may affect config.test.ts

Wave 3 (Comments) ─────────────────────── T3.1, T3.2
     │ (independent, trivial)

Wave 4 (Security) ─────────────────────── T4.1, T4.2, T4.3
     │ depends on T1.2 (new resolve signature)

Wave 5 (Architecture) ─────────────────── T5.1, T5.2, T5.3, T5.4, T5.5
     │ (independent)

Wave 6 (Type Design) ──────────────────── T6.1, T6.2, T6.3
     │ T6.3 (RedisPort.del) should go before T1 to simplify revoke
     │ → Pull T6.3 into Wave 1 pre-step

Wave 7 (Comments) ─────────────────────── T7.1, T7.2, T7.3
     │ T7.1 covered by T4.2, T7.3 covered by T5.4

Wave 8 (Tests) ─────────────────────────── T8.1–T8.6
     │ depends on all code changes (Waves 1-7)
     │ should be last so tests verify final state

Wave 9 (Suggestions) ──────────────────── T9.1–T9.6
     │ (do after Waves 1-8 if time/energy permits)
```

---

## Revised Execution Plan (Merged for Efficiency)

### Phase A: Foundation Changes (do first, enables everything else)
1. **T6.3** — Add `del` to `RedisPort` + implementations
2. **T1.2** — Widen `TokenStorePort.resolve` to `Result<TokenGrant | null, HostError>`
3. **T6.2** — Split `concurrency-exceeded` kinds

### Phase B: Token Store Complete Fix
4. **T1.1** — Fix `revoke()` to check results + use `del`
5. **T1.4** — Add rollback in `store()` partial failure
6. **T1.3** — Wire `createRedisTokenStore` in `host.ts`

### Phase C: Security & Auth
7. **T4.2** — Fix `constantTimeEqual`
8. **T4.3** — Wrap `hashToken` + use new `resolve` Result in middleware
9. **T4.1** — Fix authorization bypass in run-dag handler

### Phase D: Config & Type Safety
10. **T2.1** — LLM provider/key cross-validation
11. **T2.2** — `GitPort.currentSha` → `Result<GitSha, ...>`
12. **T2.3** — Fix `createLlmClient` to return Result
13. **T6.1** — `isTeamTokenShape` → type guard

### Phase E: Architecture Cleanup
14. **T5.1** — sync-loop imports from ports.ts
15. **T5.2** — index.ts re-exports from ports.ts
16. **T5.3** — Remove adapter re-exports
17. **T5.4** — Remove sync-loop re-exports
18. **T5.5** — Create testing.ts subpath

### Phase F: Comments
19. **T3.1** — Remove fabricated FR-200/FR-201
20. **T3.2** — Fix FR-028 → FR-023
21. **T7.2** — Fix DEFAULT_TIMEOUT_MS comment

### Phase G: Tests
22. **T8.4** — `run-dag.test.ts` (highest value — covers auth bypass fix)
23. **T8.1** — `host-state.test.ts`
24. **T8.3** — `sync-loop.test.ts`
25. **T8.5** — `registry.test.ts` + property
26. **T8.2** — `host-state.property.test.ts`
27. **T8.6** — `node-context-factory.test.ts`

### Phase H: Polish (if time permits)
28. **T9.1–T9.6** — Branded TeamName, ConcurrencyError union, GitSha validation, etc.

---

## Estimated Effort

| Phase | Items | Estimate |
|-------|-------|----------|
| A: Foundation | 3 | 20 min |
| B: Token Store | 3 | 15 min |
| C: Security | 3 | 15 min |
| D: Config/Types | 4 | 20 min |
| E: Architecture | 5 | 15 min |
| F: Comments | 3 | 5 min |
| G: Tests | 6 | 60 min |
| H: Polish | 6 | 30 min |
| **Total** | **33** | **~3 hours** |

---

## Verification

After each phase, run:
```bash
bun test --filter packages/host
```

After all phases:
```bash
bun test              # Full monorepo test suite
bun run typecheck     # Verify no type regressions
```

---

## Exit Criteria

- [ ] All 7 Critical findings resolved
- [ ] All 17 Important findings resolved  
- [ ] All existing tests still pass
- [ ] 6 new test files written and passing
- [ ] No empty test file stubs remaining for critical paths
- [ ] `bun test` green across monorepo
- [ ] TypeScript compilation clean
