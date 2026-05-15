# Plan: Framework-Level Cache with Observable Hits

## Summary

Lift the cache lookup/write from inside `createLlmNode`/`createLlmWithToolsNode` `run()` bodies into `runNodeShared`. This makes cache hit/miss a first-class framework signal — observable via `NodeEndEvent`, countable in `RunSummary`, and usable by the `coldCache()` persistence policy.

## Current State

- `createLlmNode` and `createLlmWithToolsNode` both inline cache read/write inside `run()`.
- On cache hit, the node returns `ok(cachedValue)` — the framework has no way to distinguish this from a fresh computation.
- `RunSummary.cacheHitCount` was always 0 (dead code, now deprecated `coldCache()` always returns true).
- `ContextCacheAdapter` interface on `NodeContext` has `get`/`set`/`writeCheckpoint`.

## Design

### 1. Add `CachePolicy` to `NodeDef`

```ts
// types/node.ts
export interface NodeCachePolicy {
  /** Compute the cache key from the node's validated input. */
  readonly computeKey: (input: unknown) => string;
  /** TTL in seconds. Default: 86400 (24h). */
  readonly ttlSec?: number;
}
```

On `NodeDef`:
```ts
readonly cachePolicy?: NodeCachePolicy;
```

This is optional — nodes without it don't participate in framework-managed caching.

### 2. Framework cache lookup in `runNodeShared`

After input validation succeeds, BEFORE calling `node.run()`:

```ts
// Framework cache hit path
if (node.cachePolicy && ctx.cache) {
  const cacheKey = node.cachePolicy.computeKey(inputResult.value);
  try {
    const lookup = await ctx.cache.get(cacheKey);
    if (lookup.hit) {
      const validated = validateOutput(node.outputSchema, lookup.value, nodeId);
      if (validated.ok) {
        // Emit node-end with cacheHit: true — short-circuit, don't call run()
        emit(ctx, { type: "node-end", ..., duration: 0, cacheHit: true });
        return ok(validated.value);
      }
      // Stale/invalid cache entry — fall through to run()
    }
  } catch {
    // Cache read failure is non-fatal — fall through to run()
  }
}

// ... normal run() path
```

### 3. Framework cache write in `runNodeShared`

After successful `run()` + output validation, BEFORE emitting node-end:

```ts
// Framework cache write path (best-effort)
if (node.cachePolicy && ctx.cache) {
  const cacheKey = node.cachePolicy.computeKey(inputResult.value);
  const ttl = node.cachePolicy.ttlSec ?? 86400;
  try {
    await ctx.cache.set(cacheKey, outputResult.value, ttl);
  } catch {
    // Cache write failure is non-fatal — log and continue
  }
}
emit(ctx, { type: "node-end", ..., cacheHit: false });
```

### 4. Add `cacheHit` to `NodeEndEvent`

```ts
export interface NodeEndEvent {
  // ...existing fields...
  readonly cacheHit: boolean;
}
```

### 5. Restore `cacheHitCount` in `RunSummary` + `computeRunSummary`

```ts
// In computeRunSummary:
case "node-end":
  nodeIds.add(e.nodeId);
  if (e.cacheHit) cacheHitCount++;
  break;
```

### 6. Restore `coldCache()` policy

```ts
export function coldCache(): PersistencePolicy {
  return { shouldFlush: (s) => s.cacheHitCount < s.nodeCount };
}
```

### 7. Add OTel span attribute for `TailSamplingProcessor`

In `runNodeShared`, after cache hit validation, set the span attribute:
```ts
import { trace } from "@opentelemetry/api";
trace.getActiveSpan()?.setAttribute("ai.node.cache_hit", true);
```

The `TailSamplingProcessor` can then also count cache hits from span attributes.

### 8. Refactor `createLlmNode` — remove inline cache logic

```ts
// Before (inside run()):
const cacheKey = config.computeCacheKey?.(input) ?? `${config.id}:${stableHash(input)}`;
if (ctx.cache) {
  const lookup = await ctx.cache.get(cacheKey);
  if (lookup.hit) return ok(lookup.value as O);
}
// ... LLM call ...
if (ctx.cache) {
  await ctx.cache.set(cacheKey, output, DEFAULT_CACHE_TTL_SEC);
}

// After (on the NodeDef):
cachePolicy: config.computeCacheKey
  ? { computeKey: (input) => config.computeCacheKey!(input as I) }
  : { computeKey: (input) => `${config.id}:${stableHash(input)}` },
```

Wait — there's a subtlety. Today the LLM node ALWAYS caches (if `ctx.cache` is wired). There's no opt-out per node. The default key is `${id}:${stableHash(input)}`. The `computeCacheKey` config just overrides the key derivation.

So the refactored `createLlmNode` should always declare `cachePolicy`:
```ts
cachePolicy: {
  computeKey: config.computeCacheKey
    ? (input) => config.computeCacheKey!(input as I)
    : (input) => `${config.id}:${stableHash(input)}`,
  ttlSec: 86400,
},
```

### 9. Same for `createLlmWithToolsNode`

Same refactoring. The tool-name hash is part of the default key:
```ts
cachePolicy: {
  computeKey: config.computeCacheKey
    ? (input) => config.computeCacheKey!(input as I)
    : (input) => {
        const toolNamesHash = stableHash(config.tools.map(t => t.name).sort());
        return `${config.id}:${stableHash({ ...buildInputForKey(input), toolNamesHash })}`;
      },
  ttlSec: 86400,
},
```

Actually, the llm-with-tools node keys on `{ system, user, model, toolNamesHash, input }` — the full request fingerprint. This requires access to `config.buildUser(input)` and `systemPrompt` at key-computation time. The `computeKey` receives the validated input, but the system/user messages are derived from it inside `run()`.

**Issue:** The llm-with-tools cache key depends on computed values (system prompt, user message) that are derived from the input inside `run()`. Moving the cache lookup before `run()` means the key computation must be self-contained — it can only use the raw input.

**Solution:** The default key should be `stableHash(input)` (like the LLM node's default). The prior key included system/user/model/tools to guard against prompt changes. But those are static per node-definition — they don't change across calls. The only dynamic part is `input`. So `${config.id}:${stableHash(input)}` is a sufficient key because:
- `config.id` is unique per node
- Same input → same system prompt, same user message (they're derived deterministically from input)
- Different model/tools → different `config.id` (node is redefined)

If the prompt template changes on a redeploy, the cache TTL (24h) provides eventual consistency. For immediate invalidation on prompt changes, the `promptHash` can be folded into the key at construction time (it's static).

### 10. Handle the `promptName` prompt-change case

For prompt-registry-aware cache invalidation:
```ts
cachePolicy: {
  computeKey: config.computeCacheKey
    ? (input) => config.computeCacheKey!(input as I)
    : (input) => `${config.id}:${config.promptName}:${stableHash(input)}`,
  ttlSec: 86400,
},
```

This way, changing the `promptName` config invalidates all cached entries. But the prompt CONTENT can still change without invalidating (a prompt template edit). To handle that, fold the prompt hash:

Actually — the existing code didn't handle this either. It just hashed the input and called it a day. The cache was never invalidated on prompt changes. Keep the same semantics: `${id}:${stableHash(input)}`.

---

## Execution Order

1. Add `NodeCachePolicy` type to `types/node.ts`
2. Add `cacheHit: boolean` to `NodeEndEvent` in `types/events.ts`
3. Add `cacheHitCount` back to `RunSummary` in `observer/buffered.ts`
4. Implement cache read/write in `runNodeShared` (dag-runtime/run-node.ts)
5. Restore `coldCache()` policy in `observer/policy.ts`
6. Add `AI_NODE_CACHE_HIT` semantic convention + span attribute write
7. Restore `cacheHitCount` in `TailSamplingProcessor`
8. Refactor `createLlmNode` — remove inline cache, declare `cachePolicy`
9. Refactor `createLlmWithToolsNode` — same
10. Update tests

## Files Touched

| Step | Files |
|------|-------|
| 1 | `types/node.ts` |
| 2 | `types/events.ts` |
| 3 | `observer/buffered.ts` |
| 4 | `dag-runtime/run-node.ts` |
| 5 | `observer/policy.ts` |
| 6 | `tracing/semantic-conventions.ts` |
| 7 | `observer/tail-sampling-processor.ts` |
| 8 | `nodes/llm.ts` |
| 9 | `nodes/llm-with-tools.ts` |
| 10 | `__tests__/` (multiple) |

## Backwards Compatibility

None needed (per project rules). But the change is additive:
- Nodes without `cachePolicy` work exactly as before (no cache interaction at framework level).
- `createLlmNode`/`createLlmWithToolsNode` just move from "node does its own caching" to "framework does it".
- `ContextCacheAdapter` interface unchanged.

## Edge Cases

- **Cache read throws:** Non-fatal, fall through to `run()`. Log a warning.
- **Cache hit fails output schema validation:** Treat as stale entry, fall through to `run()`. Don't delete (TTL handles expiry).
- **Cache write throws/returns Err:** Non-fatal, log and continue. Node result is already valid.
- **Node has `cachePolicy` but `ctx.cache` is null:** No caching, no error. Same as today.
- **Concurrent nodes with same cache key:** Both compute, both write. Last-write-wins is fine (same output from same input).
