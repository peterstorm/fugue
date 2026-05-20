# PR Review Fix Plan — 2026-05-20

## Overview

11 advisory issues from comprehensive PR review. No critical blockers.
Grouped by type for efficient execution (documentation, types, tests, app).

---

## Phase 1: Documentation & Comments (low risk, high clarity)

### 1.1 — Add cross-reference comment in `runStateMachine` throws
**File:** `packages/framework/src/state-machine/runner.ts:128-133`
**Action:** Add a comment before the throw explaining the control flow:
```typescript
// DESIGN: This throw is caught by handleKernelError() in run-dag-stateful.ts.
// The queue layer (BullMQ) also catches it to trigger retry. See ADR-0005.
```

### 1.2 — Document timeout/abort race in OpenAI client
**File:** `packages/framework/src/llm/openai-client.ts:226-241`
**Action:** Add comment in `postResponses` catch block:
```typescript
// Priority when both timeout and caller-signal fire simultaneously:
// - If t.timedOut() && !signal?.aborted → classify as transient (retriable)
// - If signal?.aborted → classify as aborted (caller cancelled)
// - Race between them: whichever AbortSignal fires first wins at fetch level;
//   our timedOut() flag disambiguates after the fact.
```

### 1.3 — Add ADR references to `RunOptions` JSDoc
**File:** `packages/framework/src/executor/run-dag.ts:14-97`
**Action:** Add `@see` tags to relevant fields:
- `resume` → `@see ADR-0017 (checkpoint fingerprinting)`
- `freshnessIndex` → `@see ADR-0024 (freshness witness contracts)`
- `onHumanReview` → `@see ADR-0025 (human intervention events)`

### 1.4 — Document serialization boundary on `DagMachineContext`
**File:** `packages/framework/src/dag-runtime/types.ts`
**Action:** Add JSDoc block on `DagMachineContext` explaining:
- Live fields (closures, Zod schemas) exist ONLY in-process
- `DagMachineContextPersisted` is the serialization-safe subset
- `wrapDagJobLike` in `persistence.ts` handles the conversion
- Cross-reference `toJson`/`fromJson` for Map/Set handling

### 1.5 — Create `dag-runtime/README.md` module map
**File:** `packages/framework/src/dag-runtime/README.md` (new)
**Action:** Create a brief module map:
```markdown
# dag-runtime/ — Module Decomposition

## Core Loop
- `machine.ts` — compile DagDef → Machine (pure)
- `transition.ts` — pure state transition (DagPhase × DagEvent → DagPhase)
- `executor.ts` — imperative executor (sleep, hooks, wave dispatch)
- `run-dag-stateful.ts` — orchestrator (compose kernel + executor + telemetry)

## Wave Execution
- `wave-execution.ts` — dispatch all nodes in a wave concurrently
- `run-node.ts` — single node execution (validate → run → checkpoint)

## Routing & Conditional Logic
- `routing.ts` — predicate evaluation, route decisions (pure)
- `conditional.ts` — (legacy re-export, delegates to routing.ts)
- `route-emission.ts` — emit routing observer events
- `reroute.ts` — human-reroute enrichment
- `topology.ts` — static graph analysis (adjacency, incoming sources)

## Freshness
- `freshness-check.ts` — in-memory FreshnessIndex, conflict detection (pure)
- `freshness-emission.ts` — emit witness/write observer events per wave

## Human-in-the-Loop
- `human-emission.ts` — emit HumanInterventionEvent telemetry
- `human-resolution.ts` — transition helper for human responses

## Retry & Resolution
- `retry-policy.ts` — retry budget, backoff computation (pure)
- `wave-resolution.ts` — post-wave state: advance/human-gate/succeeded

## Eval Judges
- `eval-judges.ts` — post-run quality gates (background or inline)

## Telemetry
- `run-telemetry.ts` — OTel root span, run-start/run-end events
- `node-span.ts` — per-node OTel spans, outcome accumulation
- `emit.ts` — thin wrapper: ctx.observer → dispatchEvent

## Infrastructure
- `persistence.ts` — wrapDagJobLike (live ↔ persisted context)
- `types.ts` — DagPhase, DagEvent, DagMachineContext unions
```

---

## Phase 2: Type Improvements (medium risk, compile-time safety)

### 2.1 — Use `ReadonlyMap` / `ReadonlySet` in `DagMachineContextPersisted`
**File:** `packages/framework/src/dag-runtime/types.ts`
**Action:** Change the persisted context interface fields:
- `outputs: Map<NodeId, unknown>` → `outputs: ReadonlyMap<NodeId, unknown>`
- `retries: Map<NodeId, number>` → `retries: ReadonlyMap<NodeId, number>`
- `activeNodeIds: Set<NodeId>` → `activeNodeIds: ReadonlySet<NodeId>`
- `confidenceByNode: Map<NodeId, ...>` → `confidenceByNode: ReadonlyMap<NodeId, ...>`

The transition functions already use spread-and-replace (`new Map(ctx.outputs)`) so this change is safe. The live `DagMachineContext` (executor-side) keeps mutable types since it's the shell.

**Risk:** May require `as ReadonlyMap<>` casts in transition helpers. Compile and fix.

---

## Phase 3: Error Handling Improvements (medium risk)

### 3.1 — Add `retryAsyncResult` variant or document limitation
**File:** `packages/framework/src/shared/retry-async.ts`
**Action:** Add a Result-returning variant alongside the throwing one:
```typescript
/**
 * Retry with Result return. On exhaustion, returns Err with the last error
 * wrapped in a FrameworkError. Prefer this over `retryAsync` when the caller
 * needs typed error propagation.
 */
export const retryAsyncResult = async <T>(
  fn: () => Promise<T>,
  opts: RetryOpts & { readonly toFrameworkError: (e: unknown) => FrameworkError },
): Promise<Result<T, FrameworkError>> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return ok(await fn());
    } catch (e) {
      lastError = e;
      fwLogger().error(`[${opts.label}] attempt ${attempt + 1}/${opts.maxAttempts} failed:`, e);
      if (attempt < opts.maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, opts.baseDelayMs * (attempt + 1)));
      }
    }
  }
  return err(opts.toFrameworkError(lastError));
};
```

### 3.2 — Add defensive comment on `InMemoryFreshnessIndex.recordWrite`
**File:** `packages/framework/src/dag-runtime/freshness-check.ts:147`
**Action:** Add a comment explaining the Result return is for interface compatibility:
```typescript
/**
 * Record a successful write. Evicts oldest entries per resource and oldest
 * resources globally.
 *
 * The in-memory implementation never fails (returns `ok(undefined)` always).
 * The `Result` return type satisfies the `FreshnessIndex` interface contract
 * required by the Redis adapter, which CAN fail on network issues. Callers
 * should still check `.ok` — switching to a Redis-backed index at runtime
 * would silently break code that assumes success.
 */
```

---

## Phase 4: Test Coverage (low risk, correctness)

### 4.1 — Add property test for `DagMachineContextPersisted` serialization roundtrip
**File:** `packages/framework/src/__tests__/context-serialization-roundtrip.test.ts` (new)
**Action:** Create a property test that:
1. Generates random `DagMachineContextPersisted` values with Maps, Sets, branded IDs
2. Asserts `fromJson(toJson(ctx))` produces a value deeply equal to the original
3. Tests edge cases: empty Maps, Maps with special values (null, undefined in values), nested Maps

```typescript
import fc from "fast-check";
import { toJson, fromJson } from "../state-machine/serialize.js";
// ... generate arbitrary DagMachineContextPersisted shapes
// ... assert roundtrip equality
```

---

## Phase 5: Reference App Enhancement (low risk, showcase)

### 5.1 — Add freshness extractors to `fetch-customer` node
**File:** `apps/customer-summary/src/dag/nodes/fetch-customer.ts`
**Action:** Add `extractWitness` to the reads node:
```typescript
sideEffects: {
  kind: "reads",
  resource: resourceName("crm:customers"),
  extractWitness: (output) => witness("version-tag", "crm:customers", output.lastModified ?? "unknown"),
},
```
This demonstrates the freshness witness feature in the reference app without affecting behavior (the downstream `synthesize` node doesn't condition-on this witness).

### 5.2 — Add comment explaining why other nodes skip freshness
**File:** `apps/customer-summary/src/dag/nodes/synthesize.ts`
**Action:** Add brief comment:
```typescript
// No extractWitness: LLM synthesis is non-deterministic — no meaningful
// freshness signal to capture. The grounding guardrail validates factual
// consistency instead.
```

---

## Phase 6: Defensive Code Comment (low risk)

### 6.1 — Comment on `decideRoute` defensive validation
**File:** `packages/framework/src/dag-runtime/routing.ts:131-148`
**Action:** Add comment:
```typescript
// Defense-in-depth: validateDagShape already guarantees predicate structure,
// but decideRoute runs at execution time where `as` casts, deserialized
// payloads, or dynamic DAG construction could bypass static validation.
// This runtime check surfaces the bug immediately rather than producing
// a confusing "cannot call undefined" stack trace from pred.check().
```

---

## Execution Order

```
Phase 1 (docs/comments) → Phase 2 (types) → Phase 3 (errors) → Phase 4 (tests) → Phase 5 (app) → Phase 6 (comment)
```

**Estimated effort:** ~45 minutes total
- Phase 1: 15 min (5 edits + 1 new file)
- Phase 2: 10 min (type changes + compile fix)
- Phase 3: 10 min (new function + comment)
- Phase 4: 5 min (new test file)
- Phase 5: 3 min (2 small edits)
- Phase 6: 2 min (1 comment)

**Verification:** `bun test` after each phase to ensure no regressions.
