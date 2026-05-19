# PR Review Remediation Plan — 2026-05-19

**Branch:** `feat/initial-setup`
**Source:** Comprehensive PR review (6 agents: code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead)
**Scope:** 14 critical + 47 advisory findings across `packages/framework/**`, `docs/`, root configs (excluding `apps/customer-summary/**`)
**Principle:** Code fixes over documentation workarounds. No backwards-compat for pre-release code. Boil the ocean — every advisory closed.

---

## Wave 0 — Block the merge

Three issues currently make the PR unmergeable. Land these first; nothing else can be validated until typecheck passes and fail-closed contracts are restored.

### Fix 0.1: Typecheck failures in `tool-use-loop.test.ts`

**Files:** `packages/framework/src/__tests__/tool-use-loop.test.ts:102, 139, 176, 267`
**Problem:** Test fixtures use raw string `name: "tool"` where branded `ToolName` is required. `bun run typecheck` exits non-zero.
**Fix:** Import `toolName` from `llm/tools.js` and wrap every tool-definition literal in the four failing tests:

```typescript
import { toolName } from "../llm/tools.js";

// Replace { name: "tool", ... } with { name: toolName("tool"), ... }
// Repeat for "test_tool" at lines 139, 176, 267
```

**Verify:** `bun run typecheck` clean.

### Fix 0.2: Restore fail-closed contract in `freshness-emission.ts`

**File:** `packages/framework/src/dag-runtime/freshness-emission.ts:151-167`
**Problem:** When `freshnessIndex.findConflict` returns `Err` (Redis outage), the code emits `node-error`, then **falls through** to synthesize a fake conflict (`succeededAtMs: 0, newWitness: conditionedOn`) and emits a misleading `freshness-violation`. The DAG continues. This directly violates Invariant 7 ("freshness is fail-closed") and ADR-0025. Operators see spurious violations during Redis outages and downstream abort logic fires on fake conflicts.
**Fix:** Return `err(fwError)` immediately after emitting `node-error`. Match the extractor-throws path at line 91/138.

```typescript
if (!conflictResult.ok) {
  // existing emit() call for node-error — keep
  return err(fwError); // NEW: abort the wave fail-closed; do not synthesize a conflict
}
```

Delete the synthetic-conflict block (the `conflict = { ... succeededAtMs: 0 ... }` construction and the subsequent `emit({ type: "freshness-violation", ... })`).

**Verify:** New test in `freshness-emission.test.ts` — stub `findConflict` to return `Err`, assert the wave aborts with `node-error` and no `freshness-violation` is emitted. See Fix 6.8.

### Fix 0.3: Restore fail-closed contract in `human-emission.ts`

**File:** `packages/framework/src/dag-runtime/human-emission.ts:58-71`
**Problem:** `confidence.extract` failure logs a warning, emits `node-error`, sets `nodeConfidence = null`, and continues. `emitHumanIntervention` returns `void` — the executor has no way to know. The `human-intervention` event still fires; the run resumes. A documented `non-retriable` error becomes invisible.
**Fix:** Change `emitHumanIntervention` to return `Result<void, FrameworkError>`. In the catch block, return `err(fwError)` instead of nulling out and continuing.

```typescript
// signature change
export function emitHumanIntervention(...): Result<void, FrameworkError> {
  try {
    // existing happy path
    return ok(undefined);
  } catch (e) {
    const fwError = /* existing factory */;
    // emit node-error as today
    return err(fwError);
  }
}
```

In `executor.ts` `handleHumanGate` (~line 282-292): check the result; on `err`, return a `node-failed` event instead of `human-responded`.

**Verify:** New test asserting a throwing confidence extractor produces `node-failed` and aborts the wave.

### Fix 0.4: Restore fail-closed contract in `reroute.ts`

**File:** `packages/framework/src/dag-runtime/reroute.ts:23, 45-49, 66`
**Problem:** `computeRerouteActiveSet` returns `undefined` on (a) invalid target wave and (b) malformed predicate during re-evaluation. `enrichHumanRespondedEvent` propagates `rerouteActiveSet: undefined`. `human-resolution.ts:116` falls back to `ctx.activeNodeIds`. The reviewer's reroute appears to succeed but executes the wrong graph traversal. No log, no event, no error.
**Fix:** Return a discriminated result.

```typescript
type RerouteResult =
  | { readonly kind: "ok"; readonly activeSet: ReadonlySet<NodeId> }
  | { readonly kind: "invalid-target"; readonly targetWave: number }
  | { readonly kind: "predicate-malformed"; readonly nodeId: NodeId; readonly predicateLabel: string };

export function computeRerouteActiveSet(...): RerouteResult { ... }
```

Propagate up to `callHumanReviewHook` in `executor.ts`. On `invalid-target` or `predicate-malformed`, return a `node-failed` event with the appropriate `FrameworkError` variant. Never fall back silently.

**Verify:** New tests for both failure modes.

---

## Wave 1 — Critical: API surface and structural duplication

### Fix 1.1: Collapse duplicate `runDagAsWorkerJob`

**Files:**
- `packages/framework/src/dag-runtime/run-dag-stateful.ts:374` — DELETE
- `packages/framework/src/dag-runtime/index.ts:34-35` — DELETE re-exports of `runDagStateful` and `DagRunOpts`
- `packages/framework/src/executor/run-dag.ts:178` — keep (the public one with HITL pre-flight)
- `packages/framework/src/__tests__/run-dag-as-worker-job.test.ts:11` — migrate import to `executor/run-dag.js`

**Problem:** Two implementations. The internal one bypasses the HITL pre-flight check (no `onHumanReview` for `humanReview`-declaring DAGs → silent generic failure instead of contract error).
**Fix:** Delete the internal copy. Single source of truth lives in `executor/`.

### Fix 1.2: Collapse duplicate `DagRunOpts` types

**Files:**
- `packages/framework/src/executor/run-dag.ts:100-103` — DELETE the deprecated `DagRunOpts = RunOptions` alias
- `packages/framework/src/dag-runtime/run-dag-stateful.ts:52` — DELETE the `interface DagRunOpts` (callers use `RunOptions`)

**Problem:** Same name, different structures, both reachable through public barrels. Structural compatibility hides drift.
**Fix:** One name, one definition — `RunOptions` in `executor/run-dag.ts`. Resolved transitively by Fix 1.1 plus this cleanup.

### Fix 1.3: Delete backward-compat shims for pre-release code

**Files:**
- `packages/framework/src/advanced.ts:17-18` — DELETE `runDagStateful` alias and `DagRunStatefulOpts` type alias
- `packages/framework/src/dag-runtime/node-span.ts:239-240` — DELETE `withNodeSpan = withTracedNodeSpan` alias
- `packages/framework/src/dag-runtime/run-node.ts:27, 120` — migrate to `withTracedNodeSpan`
- `packages/framework/src/dag-runtime/run-node.ts:31` — DELETE local `EMPTY_OUTCOME`, import from `node-span.js` (already exported there)

**Problem:** CLAUDE.md disallows back-compat shims for code that hasn't shipped. README confirms no external consumers as of 2026-05-11.
**Fix:** Delete every `@deprecated` alias. Migrate the one internal caller (`run-node.ts`). Also fold in the `EMPTY_OUTCOME` re-import.

### Fix 1.4: Isolate Redis adapters to a `/redis` subpath

**Files:**
- NEW: `packages/framework/src/redis.ts` — barrel exporting `RedisCache`, `RedisCheckpointer`, `RedisFreshnessIndex`
- `packages/framework/src/cache/index.ts` — REMOVE `RedisCache` re-export
- `packages/framework/src/checkpoint/index.ts` — REMOVE `RedisCheckpointer`, `RedisFreshnessIndex` re-exports
- `packages/framework/src/index.ts` — verify nothing transitively re-exports them
- `packages/framework/package.json` — add `./redis` to `exports`
- `packages/framework/src/scripts/check-imports.ts` — add `cache/redis-cache.ts`, `checkpoint/redis-checkpointer.ts`, `checkpoint/redis-freshness-index.ts` to the documented `ioredis`-permitted set (mirror the `queue-bullmq/` pattern); fail the build for any other module importing `ioredis`
- `packages/framework/src/__tests__/boundary-imports.test.ts` — add an assertion that the main barrel does not transitively import `ioredis`
- `CONTEXT.md` — update Architecture Layers table to document that Redis adapters live behind the `/redis` subpath

**Problem:** Main barrel transitively imports `ioredis`. Defeats the explicit subpath isolation pattern documented for BullMQ.
**Fix:** Mirror `bullmq.ts` for Redis. Consumers who do not need Redis must not pay for it.

### Fix 1.5: Move `FreshnessIndex` port to `types/`

**Files:**
- NEW: `packages/framework/src/types/freshness-index.ts` — move `FreshnessIndex`, `WriteEntry`, `FreshnessConflict`, `FreshnessCheckResult` interfaces here
- `packages/framework/src/dag-runtime/freshness-check.ts:60-72` — DELETE the moved interface definitions; keep the pure `checkFreshness` function and `InMemoryFreshnessIndex` class; import the interface from `types/freshness-index.js`
- `packages/framework/src/checkpoint/redis-freshness-index.ts:21` — change `FreshnessIndex` import to `types/freshness-index.js`
- `packages/framework/src/types/index.ts` — barrel re-export
- `packages/framework/src/__tests__/boundary-imports.test.ts` — assert `checkpoint/` does not import `dag-runtime/`

**Problem:** Port type lives inside `dag-runtime/`, forcing `checkpoint/redis-freshness-index.ts` to import from `dag-runtime/`. Violates the documented dependency arrow direction.
**Fix:** Ports belong in `types/`. Adapters live in `checkpoint/` and (in-memory) `dag-runtime/`.

### Fix 1.6: Fix layer violation in `types/llm.ts`

**File:** `packages/framework/src/types/llm.ts:54`
**Problem:** Inline `import("../tracing/tracer.js").Tracer` reaches outward from `types/` (layer 0) into `tracing/` (layer 2). `types/tracer.ts` already defines `Tracer`.
**Fix:**

```typescript
import type { Tracer } from "./tracer.js";
// then use Tracer directly in LlmRequest.tracer
```

### Fix 1.7: Replace inline OTel imports in `run-dag-stateful.ts`

**File:** `packages/framework/src/dag-runtime/run-dag-stateful.ts:163, 216, 341`
**Problem:** Inline `import("@opentelemetry/api").Span` expressions evade the boundary checker readability-wise. The file is already in `scopeExcludes`, so a top-level `import type` is permitted.
**Fix:** Add a single `import type { Span } from "@opentelemetry/api"` at the top of the file. Replace the three inline expressions with `Span`.

---

## Wave 2 — Critical: Type design (parse-don't-validate)

### Fix 2.1: Convert `EvalJudgeNodeConfig` to a tagged union

**File:** `packages/framework/src/types/eval-judge.ts:40-50`
**File:** `packages/framework/src/nodes/eval-judge.ts:138` (call site of `resolveRubric`)
**Problem:** `rubricTemplateId?: string` and `rubricInline?: string` can both be set; the runtime picks one by precedence.
**Fix:**

```typescript
export type EvalJudgeRubric =
  | { readonly source: "template"; readonly templateId: string }
  | { readonly source: "inline"; readonly text: string };

export interface EvalJudgeNodeConfig {
  // ... existing fields ...
  readonly rubric: EvalJudgeRubric;
  // delete rubricTemplateId and rubricInline
}
```

Update `resolveRubric` to take `EvalJudgeRubric` and branch on `source`.

### Fix 2.2: Convert `EvalJudgeResult` to a discriminated union

**File:** `packages/framework/src/types/eval-judge.ts:9-37`
**Problem:** Three independent flags (`passed`, `skipped`, `crash`) allow `{ passed: false, skipped: true }` (documented as invalid) and `{ passed: true, crash: { ... } }` (also invalid).
**Fix:**

```typescript
export type EvalJudgeResult =
  | { readonly outcome: "passed"; readonly score: number; readonly rationale: string; readonly judgeId: string }
  | { readonly outcome: "failed"; readonly score: number; readonly rationale: string; readonly judgeId: string }
  | { readonly outcome: "skipped-llm-failure"; readonly score: null; readonly reason: string; readonly judgeId: string }     // fail-open
  | { readonly outcome: "crash"; readonly score: null; readonly crashMessage: string; readonly judgeId: string };            // fail-closed
```

Update `eval-judge.ts`, `eval-judges.ts`, `executor-eval-judge.test.ts`, `eval-judge.test.ts`, `eval-judge-prompt.test.ts` callers. Most reads of `passed`/`skipped`/`crash` become a `match` on `outcome`.

### Fix 2.3: Derive `validBuckets` from `CONFIDENCE_ORDER`

**File:** `packages/framework/src/executor/validate-dag.ts:171-172`
**Problem:** Hardcoded `["high", "medium", "low", "unknown"]` will silently diverge from `ConfidenceBucket` if a new variant is added.
**Fix:**

```typescript
import { CONFIDENCE_ORDER, type ConfidenceBucket } from "../types/confidence.js";

const validBuckets = Object.keys(CONFIDENCE_ORDER) as readonly ConfidenceBucket[];
// remove the `as string` cast on p.minConfidence
```

### Fix 2.4: Eliminate `includeContent` field

**Files:**
- `packages/framework/src/types/node.ts:163-169, 287-288` — DELETE `includeContent` from `BaseNodeContext` and `NodeContextInit`
- `packages/framework/src/nodes/llm-pipeline.ts:120` — DELETE `includeContent: ctx.includeContent`; rely on `contentFilter`
- `packages/framework/src/nodes/eval-judge.ts:173` — same
- `packages/framework/src/shared/make-node-context.ts:34` — DELETE pass-through
- `packages/framework/src/tracing/content-filter.ts` — DELETE the `includeContent` branch from `resolveContentFilter`

**Problem:** Deprecated field still actively wired in three production sites. Two paths model the same concern.
**Fix:** Delete entirely. Callers who want full content set `contentFilter: null`; default behavior is `"redact"`.

### Fix 2.5: Discriminate `human-responded` event by action

**File:** `packages/framework/src/dag-runtime/types.ts` (`DagEvent` union)
**Problem:** `rerouteActiveSet?: ReadonlySet<NodeId>` is optional but semantically required for `action: "reroute"`. Transition code must runtime-check.
**Fix:**

```typescript
| { readonly type: "human-responded"; readonly nodeId: NodeId; readonly action: Exclude<HumanAction, { kind: "reroute" }> }
| { readonly type: "human-responded"; readonly nodeId: NodeId; readonly action: Extract<HumanAction, { kind: "reroute" }>; readonly rerouteActiveSet: ReadonlySet<NodeId> }
```

Update `transition.ts` and `human-resolution.ts` to pattern-match on `action.kind` and access `rerouteActiveSet` only in the reroute arm.

### Fix 2.6: Fix `frameworkErrorJson` Date round-trip

**File:** `packages/framework/src/types/errors.ts:163`
**Problem:** `JSON.stringify` on a `FrameworkError` containing `Date` (e.g. `checkpoint-expired.expiredAt`) serializes to string; deserialization produces `string` not `Date`.
**Fix:** Add a custom replacer/reviver. Simplest path: ensure every Date-typed field on the union is `readonly expiredAt: string` (ISO 8601) instead of `Date`. Update the factory and all readers. Dates are presentation-layer concerns; the union type can stay string-typed.

### Fix 2.7: Make `Witness` parameters non-swappable

**File:** `packages/framework/src/dag-runtime/freshness-check.ts:67` and `types/freshness-index.ts` (post-Fix 1.5)
**Problem:** `findConflict(resource: string, conditionedOnValue: string)` — two raw strings, easy to swap.
**Fix:** Take a `Witness` (or a `WitnessRef = { resource, value }`) parameter directly. Update both implementations and all call sites in `freshness-emission.ts`.

### Fix 2.8: Brand `nodeId` in the `onHumanReview` callback

**File:** `packages/framework/src/executor/run-dag.ts:49`
**Problem:** Hook author receives `nodeId: string`. To pass it back to branded APIs they must re-validate.
**Fix:** Type as `NodeId`. Branded types are already exported on the public surface (`runId`, `nodeId`, `dagId` constructors); no new boundary cost.

### Fix 2.9: Restrict `retry-exhausted.rootErrorKind`

**File:** `packages/framework/src/types/errors.ts:23`
**Problem:** `rootErrorKind: FrameworkError["kind"]` allows the recursive value `"retry-exhausted"`.
**Fix:** `rootErrorKind: Exclude<FrameworkError["kind"], "retry-exhausted">`.

---

## Wave 3 — Important: Error handling

### Fix 3.1: Classify non-429 4xx as non-retriable in OpenAI client

**File:** `packages/framework/src/llm/openai-client.ts:387-392, 515-526`
**Problem:** `401`, `403`, `422` burn the full retry budget.
**Fix:**

```typescript
if (httpResult.status === 429) {
  return err({ kind: "transient", ... });
}
if (httpResult.status >= 400 && httpResult.status < 500) {
  return err({ kind: "node-crash", retriability: "non-retriable", ... });
}
return err({ kind: "node-crash", retriability: "retriable", ... });
```

Apply to both `send`/`sendStructured` and `sendWithTools` paths.

### Fix 3.2: Propagate `callerAborted` in OpenAI `sendWithTools`

**File:** `packages/framework/src/llm/openai-client.ts:509`
**Problem:** Tool-use loop's inner provider catches errors without `callerAborted`. Cancelled runs misclassify as `transient` and retry.
**Fix:**

```typescript
classifyLlmError(error, resolveNodeId(req), {
  timeoutMs: this.requestTimeoutMs,
  callerAborted: (req.signal ?? ctx.signal)?.aborted,
});
```

### Fix 3.3: Detect single-extractor authoring error in `writes` nodes

**File:** `packages/framework/src/dag-runtime/freshness-emission.ts:95`
**Problem:** A `writes` node declaring `extractConditionedOn` without `extractNewWitness` (or vice versa) silently skips freshness tracking.
**Fix:** Split the guard:

```typescript
if (!se.extractConditionedOn && !se.extractNewWitness) return ok(undefined); // intentional skip
if (!se.extractConditionedOn || !se.extractNewWitness) {
  emit(/* node-error: "writes node has only one of extractConditionedOn/extractNewWitness — both required" */);
  return err({ kind: "node-crash", retriability: "non-retriable", ... });
}
```

Better: enforce this at `defineDag`-time in `validate-dag.ts` so the error surfaces at definition rather than at run-time.

### Fix 3.4: Scheduler marker `exists()` failure should skip enqueue

**File:** `packages/framework/src/scheduler/scheduler.ts:327-334`
**Problem:** Redis failure defaults to "not fired" → duplicate enqueue across processes.
**Fix:**

```typescript
const existsResult = await markers.exists(markerFiredKey(dep.id)).catch((e) => {
  fwLogger().error(`marker exists() failed for ${dep.id}; skipping enqueue this cycle`, e);
  return "unknown" as const;
});
if (existsResult === "unknown" || existsResult === true) {
  continue; // skip — rely on next scheduler cycle
}
// existsResult === false → proceed with enqueue
```

Remove the `inMemoryFiredFallback` reliance; it doesn't survive a restart and obscures the contract.

### Fix 3.5: `idempotencyKey` extractor failure is fail-closed

**File:** `packages/framework/src/dag-runtime/node-span.ts:164-170`
**Problem:** Throwing extractor logged at `warn`; span continues without the key. The key is exactly the signal infrastructure uses to dedup writes/external calls.
**Fix:** Return `Err({ kind: "node-crash", retriability: "non-retriable", ... })` from the caller chain. The caller (`run-node.ts`) should abort the node.

### Fix 3.6: Log orchestrator crashes at `error`

**File:** `packages/framework/src/dag-runtime/eval-judges.ts:63`
**Fix:** Replace `ctx.logger?.warn` with `ctx.logger?.error`. Add a doc comment noting that `warn` is for expected judge failures (skipped/score=null) and `error` is for orchestrator bugs.

### Fix 3.7: Misconfigured `writeCheckpoint` must fail loudly

**File:** `packages/framework/src/dag-runtime/run-node.ts:201-224`
**Problem:** `writeCheckpoint: true` with no `ctx.checkpointWriter` silently skips checkpointing.
**Fix:** At `prepareDagRun` time (`run-dag-stateful.ts`), if `writeCheckpoint` is enabled but `checkpointWriter` is absent on the resolved context, return `err({ kind: "node-crash", retriability: "non-retriable", message: "writeCheckpoint requested but no checkpointWriter wired" })`. Fail at config time, not silently at execution time.

### Fix 3.8: Missing `nodeDef` in `emitHumanIntervention` is an invariant violation

**File:** `packages/framework/src/dag-runtime/human-emission.ts:76`
**Problem:** `nodeMap.get(phase.nodeId)` returning `undefined` defaults `nodeSideEffects` to `"none"` silently.
**Fix:** Guard with an assertion:

```typescript
const nodeDef = nodeMap.get(phase.nodeId);
if (!nodeDef) {
  // emit node-error with framework-bug message; return err
  return err({ kind: "node-crash", retriability: "non-retriable", message: `internal: node '${phase.nodeId}' missing from nodeMap during human-intervention emit` });
}
const nodeSideEffects = nodeDef.sideEffects.kind;
```

### Fix 3.9: Runtime guard in `asToolContext`

**File:** `packages/framework/src/llm/tool-dispatch.ts:17`
**Problem:** Cast is unsound — a node without `requires: ["llm"]` produces a `ToolContext` where `ctx.llm` is actually `null`; tools crash with `null.method()`.
**Fix:**

```typescript
function asToolContext(ctx: NodeContext): ToolContext {
  if (!ctx.llm) {
    throw new Error(
      `dispatchToolCallsWithSpans: ctx.llm is null. Node '${ctx.nodeId}' must declare requires: ["llm"]`,
    );
  }
  return ctx as ToolContext;
}
```

Add unit test covering the throw path (Fix 6.9).

### Fix 3.10: `OBSERVER_STRICT` should produce a synchronously visible failure

**File:** `packages/framework/src/observer/dispatch.ts:30-33`
**Problem:** `queueMicrotask(() => { throw error })` produces an unhandled rejection that test assertions cannot synchronously observe.
**Fix:** Track the most recent strict failure on a module-level variable; expose `__lastStrictFailure()` for tests. Or, simpler, in strict mode `await` the dispatch promise and rethrow. Document the trade-off (strict mode blocks observer dispatch on async observers).

### Fix 3.11: Surface MLflow exporter init failure in shutdown/flush

**File:** `packages/framework/src/tracing/mlflow-otlp-exporter.ts:456, 470`
**Problem:** `.catch(() => null)` in `shutdown()` and `forceFlush()` suppresses both "inner exporter failed to initialize" and "shutdown completed cleanly."
**Fix:** Log at `warn` in the catch (a single line each — these are not hot paths) before returning `null`. Include the inner error's message.

### Fix 3.12: Validate `__brandConfidence` minimally

**File:** `packages/framework/src/types/confidence.ts:74`
**Problem:** Deserialization brand accepts any `{ bucket, source, raw? }` — a corrupt checkpoint with `source: "logprob"` and no `raw` violates the documented invariant.
**Fix:** Validate `bucket` is a known `ConfidenceBucket` and `source` is a known `ConfidenceSource`. Return `Result<Confidence, string>` from the strict variant; keep the unchecked `__brandConfidenceUnchecked` for hot deserialization paths but mark its dangers.

---

## Wave 4 — Important: Code hygiene

### Fix 4.1: Delete duplicated `stripCodeFences`

**File:** `packages/framework/src/llm/anthropic-client.ts:106`
**Problem:** Identical to `tool-use-loop.ts:81`. The Anthropic client uses forced tool-use for structured output; this copy is unreachable.
**Fix:** Delete from `anthropic-client.ts`. Verify no callers.

### Fix 4.2: Delete duplicated `resolveNodeId`

**Files:** `packages/framework/src/llm/anthropic-client.ts:113`, `packages/framework/src/llm/openai-client.ts:236`
**Problem:** Identity function (`(req) => req.nodeId`) duplicated.
**Fix:** Inline `req.nodeId` at the 11 call sites. The wrapper adds no semantic value.

### Fix 4.3: Brand `SubSpanEvent.parentSpanId`

**File:** `packages/framework/src/types/events.ts:77` and a new `types/span-id.ts`
**Problem:** Raw `string` for an OTel span ID (16 hex chars). Consistent with the ID-branding philosophy elsewhere.
**Fix:** Introduce `SpanId` branded type with a smart constructor. Update event union and `tracing/` emitters.

### Fix 4.4: Brand `TaskConfig.id` and `.cron`

**File:** `packages/framework/src/scheduler/types.ts`
**Problem:** Raw strings for task IDs (conflate with other ID kinds) and cron expressions (validated only at arm-time).
**Fix:** Introduce `TaskId` and `CronExpression` branded types in `types/`. Validate cron at `TaskConfig` construction using `cron-parser`; smart constructor returns `Result<CronExpression, string>`.

### Fix 4.5: Require `KernelRunOpts.computeDedupKey`

**File:** `packages/framework/src/state-machine/types.ts:104`
**Problem:** Optional — fallback is "string concat, not collision-resistant."
**Fix:** Make required. The BullMQ adapter and any production caller must supply a proper implementation.

### Fix 4.6: Make `Result<T,E>` nominal

**File:** `packages/framework/src/types/result.ts`
**Problem:** Purely structural. `{ ok: true, value: someError }` satisfies `Ok<SomeError>`.
**Fix:** Add a module-private `unique symbol` brand on both `Ok` and `Err`. `ok()`/`err()` constructors apply it; callers cannot forge.

```typescript
declare const RESULT_BRAND: unique symbol;
export interface Ok<T> { readonly ok: true; readonly value: T; readonly [RESULT_BRAND]: "ok" }
export interface Err<E> { readonly ok: false; readonly error: E; readonly [RESULT_BRAND]: "err" }
```

Update all combinators. Verify `unwrap` does not leak via the barrel.

### Fix 4.7: Validate `EnqueueOpts.attempts` at the type level

**File:** `packages/framework/src/queue/types.ts`
**Fix:** Use the `PositiveInt` branded type (introduce if missing). Smart constructor returns `Result<PositiveInt, string>`. Update the BullMQ adapter to consume the brand directly.

### Fix 4.8: Strengthen `__brandXxx` ID constructors

**File:** `packages/framework/src/types/ids.ts`
**Problem:** Internal escape hatches accept raw `string` with zero validation.
**Fix:** Add minimal regex validation matching `ID_REGEX`. If validation must be skipped for hot deserialization paths, expose a separate `__brandRunIdUnchecked` and only use it where profiling shows it matters.

### Fix 4.9: Verify `__brand*` ID functions are not on the public barrel

**File:** `packages/framework/src/types/index.ts` and `packages/framework/src/index.ts`
**Fix:** Audit the barrel. If `export * from "./ids.js"` re-exports `__brand*`, switch to named re-exports. Add a `boundary-imports.test.ts` assertion that `__brand*` symbols are absent from the public main barrel.

---

## Wave 5 — Documentation

### Fix 5.1: Fix `dag-runtime/run-node.ts:2` rotten caller comment

**Fix:** Replace with:

```typescript
// runNodeShared — single implementation of per-node execution. Sole caller: wave-execution.ts.
```

### Fix 5.2: Update `docs/adr/README.md` to 29 ADRs

**File:** `docs/adr/README.md`
**Fix:**
- Add rows for ADR 0026, 0027, 0028, 0029 to the index table
- Replace the "Verified 2026-05-11: all 23 ADRs present" line with "Verified 2026-05-19: all 29 ADRs present, 0007 superseded by 0021 (correctly marked), no other gaps or duplicates."

### Fix 5.3: Resolve `withNodeSpan` deprecation contradiction

Covered by Fix 1.3 (the deprecation alias is deleted; sole caller migrates to `withTracedNodeSpan`).

### Fix 5.4: Strip `Phase N` sprint labels from comments

**Files:**
- `packages/framework/src/dag-runtime/index.ts:37`
- `packages/framework/src/types/events.ts:127, 183, 209`
- `packages/framework/src/dag-runtime/executor.ts:226`
- `packages/framework/src/dag-runtime/freshness-emission.ts:1`
- `packages/framework/src/dag-runtime/human-emission.ts:1`

**Fix:** Delete the `Phase N:` prefix. Keep the rest of each comment where it explains a non-obvious invariant.

### Fix 5.5: Fix `Decision` import path in `wave-resolution.ts` JSDoc/signature

**File:** `packages/framework/src/dag-runtime/wave-resolution.ts:65-66`
**Fix:** Replace `import("./conditional.js").Decision` with `import("./routing.js").Decision`. The shim re-exports it but `routing.ts` is canonical.

### Fix 5.6: Delete redundant module banners

**Files** (per comment-analyzer R1-R7, I2-I3, I6):
- `packages/framework/src/dag-runtime/types.ts:1-3`
- `packages/framework/src/dag-runtime/machine.ts:1-2`
- `packages/framework/src/dag-runtime/transition.ts:6-7` (trim only the `.exhaustive()` self-description; keep lines 1-4)
- `packages/framework/src/dag-runtime/topology.ts:1-6` and `routing.ts:1-6` (delete the cross-referencing banner)
- `packages/framework/src/dag-runtime/run-dag-stateful.ts:7-11` (delete the four-line helper list; keep the orchestration-only directive)
- `packages/framework/src/state-machine/runner.ts:57-59` (delete inline duplicate of JSDoc FR-011 comment)
- `packages/framework/src/dag-runtime/run-dag-stateful.ts:269-280` (delete inline `// 1.`–`// 6.` step comments — JSDoc covers it)
- `packages/framework/src/dag-runtime/human-resolution.ts:1` (delete; keep line 2)
- `packages/framework/src/dag-runtime/wave-execution.ts:91` (delete `// out-of-bounds invariant violation` — code says so)
- `packages/framework/src/dag-runtime/types.ts:139-150` ("structurally identical to the monolithic definition" — delete those two sentences; keep the rest of the section comment)

### Fix 5.7: CONTEXT.md updates

**File:** `CONTEXT.md`
**Fix:**
- Architecture Layers table: add a row for the `/redis` subpath (after Fix 1.4)
- Key Invariants: append "8. Pre-release: no backward-compat shims — internal renames are first-class refactors, not aliased." This makes Fix 1.3's principle a durable contract.

---

## Wave 6 — Tests

These can land alongside the fixes that introduce them, but listed together for visibility. The user's standard ("Tests written. Invariants in types, not comments.") makes these mandatory, not optional.

### Fix 6.1: Direct unit tests for `decideRoute()`

**New file:** `packages/framework/src/__tests__/decide-route.test.ts`
Cover:
- Fast path (`guarded.length === 0`)
- Malformed predicate at run-time (null, missing `check`, missing `label`) → `predicate-malformed`
- All predicates gated by `minConfidence` and confidence null → default edge fires
- Predicate that throws → `predicate-malformed`
- Continue-evaluating-after-first-match (evidence completeness)
- `chosenTargets` and `prunedTargets` always disjoint

### Fix 6.2: Property test for `decideRoute()`

**New file:** `packages/framework/src/__tests__/decide-route-property.test.ts`
Properties (per the test-coverage report):
1. `guarded.length === 0` → `prunedTargets` empty, `defaultTaken` false
2. Predicate match → matched target in `chosenTargets`, all other guarded in `prunedTargets`
3. `outcome === "predicate-malformed"` → `chosenTargets` never populated
4. Unconditional targets always in `chosenTargets`
5. `chosenTargets` and `prunedTargets` always disjoint

Use `fast-check` with at least 1000 runs.

### Fix 6.3: `RedisFreshnessIndex` operation failure suite

**New file:** `packages/framework/src/__tests__/redis-freshness-index-ops.test.ts`
Mirror the `checkpointerSuite` parametric pattern. Cover:
- `recordWrite` Lua-script failure returns `Err`
- `consecutiveFailures >= 5` warning log path
- `findConflict` timeout returns `Err`
- Real-Redis happy path gated on `REDIS_URL`

Rename the existing `redis-freshness-index.test.ts` (which tests only encoding helpers) to `freshness-index-encoding.test.ts` to remove the false-coverage signal.

### Fix 6.4: `BufferedObserver.onReplayFailure` test

**File:** `packages/framework/src/__tests__/buffered-observer.test.ts`
Cover:
- `onReplayFailure` is called with the failed event and error when the inner observer throws
- `dispatchErrors` counter increments
- Fallback (no `onReplayFailure`) logs at `error`
- `run-end` dispatch error is caught and logged

### Fix 6.5: `TailSamplingProcessor.exportFailed` counter

**File:** `packages/framework/src/__tests__/tail-sampling-processor.test.ts`
Add a case where the exporter returns `ExportResultCode.FAILED`; assert the counter increments.

### Fix 6.6: `ratio()` RangeError guard tests

**File:** `packages/framework/src/__tests__/persistence-policy.test.ts`
Add explicit tests for `ratio(NaN)`, `ratio(Infinity)`, `ratio(-0.1)`, `ratio(1.1)`.

### Fix 6.7: `executeWave` out-of-bounds invariant test

**File:** `packages/framework/src/__tests__/dag-runtime-stateful.test.ts` (or new file)
Construct a call to `executeWave` with an invalid `waveIndex`; assert the `node-failed` event with `nodeId: WAVE_NODE_ID`.

### Fix 6.8: Freshness `findConflict` fail-closed test

**File:** `packages/framework/src/__tests__/freshness-emission.test.ts`
Stub `freshnessIndex.findConflict` to return `Err`. Assert:
- Wave aborts with `node-error`
- No `freshness-violation` event emitted
- The run does not produce a synthetic `succeededAtMs: 0` event

### Fix 6.9: `asToolContext` null-llm guard test

**File:** `packages/framework/src/__tests__/tool-dispatch.test.ts`
Construct a `NodeContext` with `llm: null`; assert `dispatchToolCallsWithSpans` throws an authoring error with the documented message.

### Fix 6.10: OpenAI `sendWithTools` abort misclassification test

**File:** `packages/framework/src/__tests__/openai-client.test.ts`
Abort the caller signal mid-tool-use; assert the returned `FrameworkError.kind === "aborted"` (not `"transient"`).

### Fix 6.11: HITL pre-flight check covered through public entry

**File:** `packages/framework/src/__tests__/run-dag-as-worker-job.test.ts`
Migrate import to `executor/run-dag.js`. Add a case where a `humanReview`-declaring DAG is invoked without `onHumanReview` → `Err({ kind: "missing-hook", ... })` (or the documented variant).

### Fix 6.12: Redis adapter bundle isolation

**File:** `packages/framework/src/__tests__/boundary-imports.test.ts`
Add assertion: parsing the main barrel (`src/index.ts`) transitively must not pull in `ioredis`. Same for `state-machine/`, `dag-runtime/`. Permit only the new `redis.ts` subpath and `queue-bullmq/` for Redis.

### Fix 6.13: Property test for `dagTransition` exhaustiveness

(Spot-check existing coverage.) Verify `dag-transition-property.test.ts` covers the new `human-responded` discriminated variants (Fix 2.5) — extend if needed.

---

## Wave 7 — Lower-priority polish

Land after the above; defer if time-boxed.

- Brand `EnqueueOpts.jobId` as `JobId` (consistency with other ID branding).
- Replace `validate-dag.ts` ad-hoc validator with `zod` schema if the codebase already takes a zod dependency.
- Consider `p-limit` for wave-level LLM concurrency (architecture report Question 3). This is a design decision, not a defect — open a separate ADR if pursued.
- Consider extracting an `LlmHttpClient` helper to absorb the `sendStructured`/`sendWithTools` request-setup duplication inside `OpenAILlmClient` (565 LOC class).
- Re-run `loom:code-simplifier` once Waves 0-6 land.

---

## Sequencing and parallelization

**Wave 0 must land first** — typecheck and fail-closed are merge blockers.

**Waves 1-3 can land in parallel** by an implementer if test coverage in Wave 6 lands alongside each fix. Suggested parallelism:
- Branch A (API/structure): Fixes 1.1-1.7
- Branch B (Types): Fixes 2.1-2.9
- Branch C (Error handling): Fixes 3.1-3.12

**Wave 4 (hygiene) and Wave 5 (docs)** are independent of the above and can land at any time.

**Wave 6 (tests)** should land with each fix where applicable; the listed numbering is for tracking, not for sequencing.

**Wave 7** is optional follow-up; open as separate PRs after this remediation lands.

---

## Verification gates

Before declaring this remediation complete, run:

1. `bun run typecheck` — clean
2. `bun test packages/framework` — all green
3. `bun run packages/framework/src/scripts/check-imports.ts` — clean
4. Manual review: search `grep -rn "@deprecated" packages/framework/src/` — every remaining occurrence must be justified (no pre-release back-compat shims)
5. Manual review: `git diff main...HEAD packages/framework/src/index.ts packages/framework/src/advanced.ts packages/framework/src/redis.ts packages/framework/src/bullmq.ts packages/framework/src/testing.ts` — public surface intentional
6. `bun run packages/framework/src/scripts/check-imports.ts` (or equivalent) confirms `ioredis` is reachable only from `redis.ts` and `queue-bullmq/`
7. Re-run `/loom:review-pr whole pr, not customer app though` — Machine Summary `CRITICAL_COUNT: 0`

---

## Out of scope

- `apps/customer-summary/**` — explicit scope exclusion from the review
- Any feature work — this remediation is purely defect-closure
- Performance tuning — flagged as open question (wave-level concurrency); deferred to its own ADR
- Documentation reorganization — only the ADR README count and CONTEXT.md updates listed above

---

## Tracking

- Critical: 14 issues → Waves 0-2 (all addressed)
- Advisory: 47 issues → Waves 3-6 (all addressed)
- Total fixes enumerated: 62
- Estimated effort (rough): 3-5 focused days of implementation + review
