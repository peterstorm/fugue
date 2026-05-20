# PR Review Fixes Plan

**Date:** 2026-05-16  
**Branch:** feat/initial-setup  
**Scope:** All 17 advisory findings from comprehensive PR review

---

## Wave 1: Type System Hardening (no runtime behavior change)

### Fix 1.1 — Brand `Confidence` with smart constructor

**Files:**
- `packages/framework/src/types/confidence.ts`
- `packages/framework/src/sugar/confidence-buckets.ts`
- `packages/framework/src/index.ts` (export the constructor)
- All call sites constructing `Confidence` values

**Change:**

```ts
// types/confidence.ts

declare const __confidenceBrand: unique symbol;

export type Confidence = {
  readonly bucket: ConfidenceBucket;
  readonly source: ConfidenceSource;
  readonly raw?: number | string;
} & { readonly [__confidenceBrand]: void };

/** Smart constructor — the only sanctioned way to create a Confidence value. */
export const confidence = (
  bucket: ConfidenceBucket,
  source: ConfidenceSource,
  raw?: number | string,
): Confidence => ({ bucket, source, raw }) as Confidence;

/** @internal — for framework code reconstructing from deserialized data. */
export const __brandConfidence = (c: { bucket: ConfidenceBucket; source: ConfidenceSource; raw?: number | string }): Confidence =>
  c as Confidence;
```

Update `bucketFromProbability`/`bucketFromEnsemble` in `sugar/confidence-buckets.ts` to return `Confidence` directly:

```ts
export const confidenceFromProbability = (
  p: number,
  source: ConfidenceSource,
  thresholds = { high: 0.85, medium: 0.6 },
): Confidence =>
  confidence(
    p >= thresholds.high ? "high" : p >= thresholds.medium ? "medium" : "low",
    source,
    p,
  );
```

**Rationale:** Every other major domain type (RunId, NodeId, DagDef) has construction-time branding. Confidence was the outlier.

---

### Fix 1.2 — Introduce `SyntheticNodeId` brand

**Files:**
- `packages/framework/src/types/ids.ts`
- `packages/framework/src/dag-runtime/types.ts` (EXECUTOR_NODE_ID)
- `packages/framework/src/dag-runtime/executor.ts` (wave sentinel)
- All files using `__brandNodeId("__executor__")` / `__brandNodeId("__wave__")`

**Change:**

```ts
// types/ids.ts

declare const __syntheticNodeIdBrand: unique symbol;

/** Framework-internal sentinel IDs. Not user-declared — typed separately to prevent conflation. */
export type SyntheticNodeId = string & { readonly [__syntheticNodeIdBrand]: void };

/** NodeId OR framework sentinel — accepted by observer events and FrameworkError. */
export type AnyNodeId = NodeId | SyntheticNodeId;

export const syntheticNodeId = (s: string): SyntheticNodeId => s as SyntheticNodeId;
```

Update `FrameworkError` and `ObserverEvent` types to accept `AnyNodeId` where sentinels appear (e.g., `EXECUTOR_NODE_ID` in error `nodeId` fields). User-facing APIs (`NodeDef.id`, `DagDef.nodes[].id`, edge endpoints) remain `NodeId`.

**Rationale:** Prevents user code from comparing a real node ID with a sentinel and succeeding by string equality — the types now distinguish them.

---

### Fix 1.3 — Remove dead code

**Files:**
- `packages/framework/src/types/error-factories.ts` — remove dead `typeof nid === "object"` branch
- `packages/framework/src/nodes/llm-with-tools.ts` — remove dead `!llmClient.sendWithTools` guard

**Change (error-factories.ts):**
```ts
const toNodeId = (nid: string | NodeId): NodeId => brandNodeId(nid as string);
```

**Change (llm-with-tools.ts):**
Delete lines 87-93 (the `if (!llmClient.sendWithTools)` block). The capability system already guarantees `ctx.llm` is a conforming `LlmClient` with `sendWithTools`.

---

### Fix 1.4 — Add `sequence` and `collectAll` combinators to Result

**File:** `packages/framework/src/types/result.ts`

**Change:**
```ts
/** Collect a list of Results into a Result of list. Short-circuits on first Err. */
export const sequence = <T, E>(results: readonly Result<T, E>[]): Result<T[], E> => {
  const values: T[] = [];
  for (const r of results) {
    if (!r.ok) return r;
    values.push(r.value);
  }
  return ok(values);
};

/** Collect all Results. Returns all values if all ok, all errors if any failed. */
export const collectAll = <T, E>(results: readonly Result<T, E>[]): Result<T[], E[]> => {
  const values: T[] = [];
  const errors: E[] = [];
  for (const r of results) {
    if (r.ok) values.push(r.value);
    else errors.push(r.error);
  }
  return errors.length === 0 ? ok(values) : err(errors);
};
```

Export from barrel.

---

### Fix 1.5 — Negative type-level tests

**File:** `packages/framework/src/__tests__/branded-type-safety.test.ts` (new)

**Change:**
```ts
import { describe, test } from "bun:test";

describe("Branded type compile-time safety", () => {
  test("plain string does not satisfy NodeId", () => {
    // @ts-expect-error — string literal doesn't satisfy NodeId brand
    const _: NodeId = "some-node";
  });

  test("plain string does not satisfy RunId", () => {
    // @ts-expect-error — string literal doesn't satisfy RunId brand
    const _: RunId = "some-run";
  });

  test("NodeId does not satisfy RunId", () => {
    const nid = nodeId("my-node");
    // @ts-expect-error — NodeId is not interchangeable with RunId
    const _: RunId = nid;
  });

  test("DagDef cannot be forged via spread", () => {
    // @ts-expect-error — spread doesn't carry the __dagValidated brand
    const _: DagDef = { id: dagId("x"), nodes: [], edges: [], outputNodeId: nodeId("x") };
  });

  test("Confidence cannot be constructed without factory", () => {
    // @ts-expect-error — plain object doesn't satisfy branded Confidence
    const _: Confidence = { bucket: "high", source: "logprob" };
  });
});
```

---

## Wave 2: Error Handling & Visibility

### Fix 2.1 — `onBackground` returns typed judge result

**Files:**
- `packages/framework/src/dag-runtime/run-dag-stateful.ts`
- `packages/framework/src/dag-runtime/eval-judges.ts`

**Change:** Alter `onBackground` signature from `(p: Promise<void>) => void` to `(p: Promise<BackgroundResult>) => void`:

```ts
// run-dag-stateful.ts

export interface BackgroundResult {
  readonly judgesPassed: boolean;
  readonly judgesCrashed: boolean;
  readonly meta: DagRunMeta;
}

export interface DagRunOpts ... {
  readonly onBackground?: (p: Promise<BackgroundResult>) => void;
  ...
}
```

Update `runFinalizeInBackground` to resolve/reject with `BackgroundResult`:

```ts
export const runFinalizeInBackground = (
  finalize: () => Promise<DagRunMeta>,
  rootSpan: Span,
  emitRunEnd: (status: "ok" | "error") => void,
): Promise<BackgroundResult> =>
  finalize()
    .then((meta): BackgroundResult => ({
      judgesPassed: !meta.evalJudgeFailed,
      judgesCrashed: meta.evalJudgeResults?.some(r => r.skipped && r.crash) ?? false,
      meta,
    }))
    .catch((e): BackgroundResult => {
      // ... existing cleanup logic ...
      return { judgesPassed: false, judgesCrashed: true, meta: createDagRunMeta() };
    });
```

**Rationale:** The caller needs to know whether judges passed/crashed to decide on alerting, quality-gate enforcement, or retry. A `void` promise provides no information.

---

### Fix 2.2 — `stateKey` fails the run on serialization failure (invariant violation)

**File:** `packages/framework/src/dag-runtime/machine.ts`

**Change:** Replace the silent fallback with a thrown error that surfaces through the kernel's standard error path:

```ts
stateKey: (phase) => {
  try {
    return JSON.stringify(phase);
  } catch (e) {
    // DagPhase is always JSON-serializable after Zod validation. A failure
    // here is a framework invariant violation — fail loud rather than
    // silently corrupting retry counters and dedup keys.
    throw new Error(
      `[compileDagToMachine] stateKey serialization INVARIANT VIOLATION for phase kind="${phase.kind}": ` +
      `${e instanceof Error ? e.message : e}. This indicates a non-serializable value leaked into DagPhase.`,
      { cause: e },
    );
  }
},
```

The kernel's outer `try/catch` in `runDagStateful` converts thrown errors to `err(FrameworkError)`, so this surfaces properly.

**Rationale:** A broken stateKey silently corrupts retry counters and dedup — that's worse than a loud failure. DagPhase must be serializable by design; if it's not, the bug is upstream.

---

### Fix 2.3 — `emitFreshnessWitnessEvents` returns a Result, executor can fail

**Files:**
- `packages/framework/src/dag-runtime/freshness-emission.ts`
- `packages/framework/src/dag-runtime/executor.ts`

**Change:** Make `emitFreshnessWitnessEvents` return `Result<void, FrameworkError>`:

```ts
// freshness-emission.ts
export const emitFreshnessWitnessEvents = async (
  ...args
): Promise<Result<void, FrameworkError>> => {
  // ... existing logic ...
  // On recordWrite failure or extractWitness failure, collect errors
  // Return err(...) if any critical freshness operation failed
  // Return ok(undefined) on success
};
```

```ts
// executor.ts — after wave success
const freshnessResult = await emitFreshnessWitnessEvents(...);
if (!freshnessResult.ok) {
  // Freshness infrastructure failure — emit error event and fail the wave
  return {
    type: "node-failed",
    nodeId: freshnessResult.error.kind === "node-crash" ? freshnessResult.error.nodeId : waveNodeIds[0],
    error: freshnessResult.error,
  };
}
```

**Rationale:** A broken freshness index silently disables the entire stale-read→write detection system. Failing the wave forces operators to fix the infrastructure rather than silently running without safety checks.

---

### Fix 2.4 — Wrap Redis marker store operations with context

**File:** `packages/framework/src/queue-bullmq/markers.ts`

**Change:**
```ts
export function createRedisMarkerStore(redis: Redis): MarkerStore {
  return {
    async set(key: string, ttlSeconds: number): Promise<void> {
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
        throw new RangeError(`ttlSeconds must be a finite positive number, got ${ttlSeconds}`);
      }
      try {
        await redis.set(key, "1", "EX", Math.ceil(ttlSeconds));
      } catch (e) {
        throw new Error(
          `[RedisMarkerStore] set failed for key "${key}": ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    },

    async exists(key: string): Promise<boolean> {
      try {
        const count = await redis.exists(key);
        return count > 0;
      } catch (e) {
        throw new Error(
          `[RedisMarkerStore] exists failed for key "${key}": ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await redis.del(key);
      } catch (e) {
        throw new Error(
          `[RedisMarkerStore] delete failed for key "${key}": ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    },
  };
}
```

---

## Wave 3: Cache Type Safety

### Fix 3.1 — `Cache.get` accepts a Zod schema for validated reads

**Files:**
- `packages/framework/src/cache/cache.ts` (interface)
- `packages/framework/src/cache/redis-cache.ts` (Redis impl)
- All Cache.get call sites

**Change:**

```ts
// cache/cache.ts
import type { z } from "zod";

export interface Cache {
  /** 
   * Get a cached value, validated against the provided schema.
   * Returns null on miss. Returns err on validation failure (schema drift).
   */
  get<T>(key: string, schema: z.ZodType<T>): Promise<Result<T | null, FrameworkError>>;
  set<T>(key: string, value: T, ttlSec: number): Promise<Result<void, FrameworkError>>;
}
```

```ts
// cache/redis-cache.ts
async get<T>(key: string, schema: z.ZodType<T>): Promise<Result<T | null, FrameworkError>> {
  try {
    const raw = await this.redis.get(key);
    if (raw === null) return ok(null);
    const parsed = JSON.parse(raw);
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      fwLogger().warn(`[RedisCache.get] key="${key}" schema validation failed: ${validated.error.message}`);
      // Treat schema-drift cache hit as a miss — stale shape shouldn't crash the caller
      return ok(null);
    }
    return ok(validated.data);
  } catch (e) {
    const message = `key="${key}": ${e instanceof Error ? e.message : String(e)}`;
    fwLogger().warn(`[RedisCache.get] ${message}`);
    return err(cacheError("get", message));
  }
}
```

```ts
// cache/cache.ts — InMemoryCache updated similarly
async get<T>(key: string, schema: z.ZodType<T>): Promise<Result<T | null, FrameworkError>> {
  const entry = this.store.get(key);
  if (!entry) return ok(null);
  if (this.now() > entry.expiresAt) {
    this.store.delete(key);
    return ok(null);
  }
  const parsed = JSON.parse(entry.value);
  const validated = schema.safeParse(parsed);
  if (!validated.success) return ok(null); // schema drift → treat as miss
  return ok(validated.data);
}
```

Update `llm-pipeline.ts` and any other `Cache.get` call sites to pass the schema. This is already partially done since `llm-pipeline.ts` validates post-read — now the validation moves into the cache layer itself.

---

## Wave 4: Kernel Purity

### Fix 4.1 — Extract `computeDedupKey` from kernel, make injectable

**Files:**
- `packages/framework/src/state-machine/runner.ts`
- `packages/framework/src/state-machine/types.ts`

**Change:** Add `computeDedupKey` to `KernelRunOpts` as an injectable hook, with a default implementation:

```ts
// types.ts — add to KernelRunOpts
export interface KernelRunOpts<S, E, C> {
  ...
  /**
   * Deterministic per-transition key for event-log dedup. The runner calls
   * this to stamp each `appendEvent`. Default: SHA-256 of (prevStateKey,
   * attemptNumber, eventType), truncated to 16 hex chars.
   */
  computeDedupKey?: (prevStateKey: string, attemptNumber: number, event: E) => string;
}
```

Move the `node:crypto` based implementation out of `runner.ts` into a new file `packages/framework/src/shared/dedup-key.ts`:

```ts
// shared/dedup-key.ts
import { createHash } from "node:crypto";

export const defaultComputeDedupKey = (
  prevStateKey: string,
  attemptNumber: number,
  event: unknown,
): string => {
  const eventType =
    typeof (event as { type?: unknown })?.type === "string"
      ? (event as { type: string }).type
      : "<event>";
  const key = `${prevStateKey}|${attemptNumber}|${eventType}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
};
```

In `runner.ts`, use the injected hook or the default:

```ts
// runner.ts — at the top of runStateMachine
const dedupKeyFn = opts.computeDedupKey ?? (await import("../shared/dedup-key.js")).defaultComputeDedupKey;
```

Wait — dynamic import breaks the sync flow. Better approach: the caller (dag-runtime/run-dag-stateful.ts) passes the default explicitly:

```ts
// run-dag-stateful.ts — constructs runOpts
import { defaultComputeDedupKey } from "../shared/dedup-key.js";

const runOpts: KernelRunOpts<...> = {
  ...
  computeDedupKey: opts?.computeDedupKey ?? defaultComputeDedupKey,
};
```

`runner.ts` never imports `node:crypto` — it just calls `opts.computeDedupKey ?? defaultFallback` where the fallback is a simple string concat (no hash, just uniqueness):

```ts
// runner.ts — inline fallback (pure, no node:crypto)
const dedupKeyFn = opts.computeDedupKey ?? ((prev, attempt, event) => {
  const eventType = typeof (event as any)?.type === "string" ? (event as any).type : "<e>";
  return `${prev}|${attempt}|${eventType}`;
});
```

This removes `node:crypto` from the kernel entirely. The dag-runtime shell injects the SHA-256 version via the opts.

**Rationale:** The kernel becomes runtime-agnostic (edge/browser compatible). The SHA-256 dedup key is an implementation detail injected by the shell.

---

### Fix 4.2 — Thread logger via `KernelRunOpts`, remove `fwLogger` from kernel

**Files:**
- `packages/framework/src/state-machine/runner.ts`
- `packages/framework/src/state-machine/types.ts`

**Change:** Add optional logger to `KernelRunOpts`:

```ts
// types.ts
export interface KernelRunOpts<S, E, C> {
  ...
  /** Logger for kernel-internal warnings (e.g., onTrace threw). Defaults to silent no-op. */
  logger?: { warn: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void };
}
```

```ts
// runner.ts — replace fwLogger() calls
const log = opts.logger ?? { warn: () => {}, error: () => {} };
// ...
} catch (traceErr) {
  log.error("[runStateMachine] onTrace threw — ignoring to preserve durability:", traceErr);
}
```

Remove the `import { fwLogger } from "../logger.js"` from `runner.ts`.

The dag-runtime shell wires `fwLogger()` when constructing `runOpts`:

```ts
// run-dag-stateful.ts
const runOpts = { ...otherOpts, logger: fwLogger() };
```

**Rationale:** The kernel has zero ambient state. All dependencies are explicit. Tests can inject a recording logger to assert on kernel warnings.

---

## Wave 5: BullMQ Adapter Fixes

### Fix 5.1 — Single `worker.on("failed")` listener with dispatch

**File:** `packages/framework/src/queue-bullmq/adapter.ts`

**Change:** Replace the dual-listener pattern with a single internal dispatcher:

```ts
function createWorker<S, C>(...): WorkerHandle {
  // ... existing setup ...

  // Single registered listener; internal routing by exhaustion state
  const failedHandlers: Array<(id: string, err: unknown, attempts: number, max: number) => Promise<void> | void> = [];
  const exhaustedHandlers: Array<(id: string, err: unknown, attempts: number) => Promise<void> | void> = [];

  worker.on("failed", (job, error) => {
    if (!job?.id) {
      worker.emit("error", new Error(`[BullMQ] "failed" event with no job id on queue "${name}"`));
      return;
    }
    const id = job.id;
    const attemptsMade = job.attemptsMade ?? 1;
    const max = job.opts?.attempts ?? 1;

    if (attemptsMade >= max) {
      // Exhausted — route to onExhausted handlers
      for (const handler of exhaustedHandlers) {
        Promise.resolve(handler(id, error, attemptsMade)).catch((handlerErr) => {
          worker.emit("error", handlerErr instanceof Error ? handlerErr : new Error(String(handlerErr)));
        });
      }
    } else {
      // Mid-retry — route to onFailed handlers
      for (const handler of failedHandlers) {
        Promise.resolve(handler(id, error, attemptsMade, max)).catch((handlerErr) => {
          worker.emit("error", handlerErr instanceof Error ? handlerErr : new Error(String(handlerErr)));
        });
      }
    }
  });

  return {
    onFailed(handler) {
      failedHandlers.push(handler);
    },
    onExhausted(handler) {
      exhaustedHandlers.push(handler);
    },
    onError(handler) {
      worker.on("error", handler);
    },
    async close() {
      await worker.close();
    },
  };
}
```

**Rationale:** Single dispatch point eliminates double-invocation, ordering dependencies, and the performance overhead of duplicate event handlers.

---

### Fix 5.2 — Dedup Lua script scans N recent entries (configurable depth)

**File:** `packages/framework/src/queue-bullmq/job.ts`

**Change:** Expand the XREVRANGE COUNT from 1 to a configurable depth (default 8):

```lua
if dedupKey ~= "" then
  local depth = ARGV[7]  -- new arg: scan depth for dedup
  local entries = redis.call("XREVRANGE", stream, "+", "-", "COUNT", depth)
  for i = 1, #entries do
    local fields = entries[i][2]
    for j = 1, #fields, 2 do
      if fields[j] == "dedupKey" and fields[j+1] == dedupKey then
        return "skipped"
      end
    end
  end
end
```

Add `ARGV[7]` (depth) to the script call, default `8`. The scan window covers any reasonable interleaving between appendEvent and updateData — 8 is generous given the crash window is typically 1 entry wide.

**Rationale:** Fixes the edge case where a concurrent trace event pushes the duplicate past the 1-entry window. Cost: scanning 8 entries instead of 1 — negligible for Redis.

---

## Wave 6: Export Restructuring

### Fix 6.1 — Move BullMQ adapter to a separate subpath export

**Files:**
- `packages/framework/package.json`
- `packages/framework/src/index.ts`
- `packages/framework/src/bullmq.ts` (new barrel)

**Change:**

```jsonc
// package.json — add subpath
{
  "exports": {
    ".": "./src/index.ts",
    "./advanced": "./src/advanced.ts",
    "./bullmq": "./src/bullmq.ts"
  }
}
```

```ts
// src/bullmq.ts (new)
export { createBullMQBackend } from "./queue-bullmq/adapter.js";
export { defaultStreamKey, adaptBullMQJob } from "./queue-bullmq/job.js";
export type { AdaptBullMQJobOpts } from "./queue-bullmq/job.js";
export { createRedisMarkerStore } from "./queue-bullmq/markers.js";
export { createRedisStreamReader } from "./queue-bullmq/event-log.js";
```

Remove BullMQ re-exports from `src/index.ts`. Consumers that need BullMQ import from `@ai-summary/framework/bullmq`.

Update `apps/customer-summary` imports to use the new subpath.

**Rationale:** Consumers who only use in-memory queues (e.g., single-process scripts, tests) no longer pull bullmq + ioredis into their dependency graph.

---

## Wave 7: Testing

### Fix 7.1 — Test concurrent wave node failures

**File:** `packages/framework/src/__tests__/dag-concurrent-wave-failure.test.ts` (new)

**Change:** Property-test + unit test verifying that when 2+ nodes in the same wave fail simultaneously:

1. The transition receives `node-failed` with `coFailedNodeIds` listing all siblings
2. All failed nodes get `node-error` observer events
3. Partial outputs from successful siblings are preserved in `partialOutputs`
4. Retry budget is applied to the primary failure node

```ts
import { describe, test, expect } from "bun:test";
import fc from "fast-check";
// ... setup DAG with 3 parallel nodes, inject failures into 2

describe("concurrent wave failures", () => {
  test("all failures are surfaced via observer events", async () => {
    // Create a 3-node wave where nodes 1 and 2 fail
    // Verify observer sees node-error for both
    // Verify transition receives coFailedNodeIds = [node2]
  });

  test("partial outputs from successful siblings are preserved", async () => {
    // Node 0 succeeds, nodes 1 and 2 fail
    // Verify partialOutputs contains node 0's output
  });

  test("property: coFailedNodeIds length = total failures - 1", () => {
    fc.assert(fc.property(
      fc.integer({ min: 2, max: 10 }), // wave size
      fc.integer({ min: 2, max: 10 }), // number of failures (capped at wave size)
      (waveSize, failCount) => {
        const actualFails = Math.min(failCount, waveSize);
        // ... run wave, verify coFailedNodeIds.length === actualFails - 1
      }
    ));
  });
});
```

---

## Execution Order

| Wave | Fixes | Dependencies | Est. files touched |
|------|-------|--------------|-------------------|
| 1 | 1.1, 1.2, 1.3, 1.4, 1.5 | None | ~20 |
| 2 | 2.1, 2.2, 2.3, 2.4 | None | ~8 |
| 3 | 3.1 | None | ~6 |
| 4 | 4.1, 4.2 | None | ~4 |
| 5 | 5.1, 5.2 | None | ~2 |
| 6 | 6.1 | None | ~4 |
| 7 | 7.1 | Waves 1-6 complete | ~2 |

Waves 1–6 are independent and can be done in parallel or any order. Wave 7 is integration testing and should run last.

---

## Not Fixing (with rationale)

None. All 17 findings have code fixes above.

---

## Verification

After all waves complete:
1. `bun test` passes (all 1,071+ existing tests + new tests)
2. `bun run typecheck` passes with no regressions
3. Boundary import check continues to pass
4. New branded-type-safety tests compile and pass (negative assertions via `@ts-expect-error`)
5. `customer-summary` app compiles against new Cache/Confidence APIs
