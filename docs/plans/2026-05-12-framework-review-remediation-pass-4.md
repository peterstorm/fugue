# Plan: Framework PR-review remediation — pass 4 (`feat/initial-setup`)

**Created:** 2026-05-12
**Status:** Draft
**Goal:** Resolve every finding from the 2026-05-12 6-agent multi-agent review of `packages/framework/**` that ran against post-pass-3 state (`7c6be05`). Each wave is an independent PR.

**Source review:** `/loom:review-pr` fan-out — code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead. Aggregate: **17 critical, 38 advisory**.

**Licence:** Framework still has zero external consumers (README §"Adding to the public surface"). No semver, no shims, no migration code. Public surface freely editable.

---

## 0. Decisions baked in

These are the non-trivial calls. They are decided here so every subsequent wave is mechanical.

- **D1 — `NodeDef<I, O, E extends FrameworkError = FrameworkError>`.** Constrain the error type parameter. Removes the structural-probe + `as FrameworkError` cast in `run-node.ts:187-192`. All built-in nodes already satisfy this; no migration.
- **D2 — Brand identifiers: `RunId`, `NodeId`, `DagId`, `ToolName`.** Single coordinated rename across `types/events.ts`, `types/errors.ts`, `types/dag.ts`, `types/node.ts`, `state-machine/types.ts`, `queue/types.ts`, `llm/tools.ts`. Smart constructors with regex/length validation; module-level `unique symbol` brands. Closes "primitive obsession" finding and the `ToolDef.name` bypass.
- **D3 — `SpanAttributeRegistry` becomes a factory.** Module-level singleton (`tracing/span-attribute-registry.ts:74`) is replaced with `createSpanAttributeRegistry()`. Instance is owned by the `MlflowOtlpExporter` (constructor-injected) and by `enrichLlmSpan` callers (passed through `fwTracer()` or a new `TracingContext` value object).
- **D4 — Single `nowFn: () => number` clock seam.** `DagRunOpts.now` already exists. Thread it (a) into `runStateMachine` via `RunOptions.now`, (b) into `buildDagExecutor` so every `new Date()` for observer events at `run-node.ts`, `executor.ts`, `runner.ts` is replaced with `new Date(nowFn())`. No new ports — the existing seam is widened in propagation depth only.
- **D5 — `Observer` port has no optional methods.** Make `onRouteDecided` and `onNodePruned` required. Remove the `?.()` optional-chaining at `dispatchEvent` call sites in `buffered.ts`. `NoopObserver` already implements them as no-ops; no other internal observer needs migration.
- **D6 — Break `LlmClient ↔ NodeContext` import cycle.** Move `LlmClient`, `LlmRequest`, `LlmResponse`, `LlmRuntime`, `SendWithToolsRequest`, `ToolDef`, `ToolContext` from `llm/client.ts` + `llm/tools.ts` into `types/llm.ts`. `types/node.ts` imports the LLM types directly; `sendWithTools` signature widens from `LlmRuntime` to `NodeContext`. ADR 0012's structural widening is retired. Update barrel re-exports.
- **D7 — `topoSort` moves to `advanced.ts`.** Currently on the main public barrel (`index.ts:48`). Internal helper used only by `compileDagToMachine` and `validateDagShape` — neither needs external use.
- **D8 — `types/index.ts` switches from `export *` to named exports.** `export * from "./dag.js"` leaks `brandAsDagDef`, `normalizeEdge`, `isOneOfMatch`, `isUnconditionalEdge`. Replace with an explicit named-export list that mirrors the README. Same pattern for `types/node.ts` etc.
- **D9 — DAG topology fingerprint on resume.** `wrapDagJobLike` (in `dag-runtime/persistence.ts`) computes `dagFingerprint(dag)` at wrap time and stores it on the first persisted context snapshot. On resume, the live DAG's fingerprint must match. Mismatch → `err({ kind: "checkpoint-version-mismatch", expected, actual })` and the run terminates. Closes the W7-Q1 architectural gap.
- **D10 — `createInMemoryEventLogReader(backend)` lands in `queue/in-memory.ts`.** `EventLogReader` becomes symmetric across backends; replay-to-timestamp testable without Redis. Approximately 20 LOC.
- **D11 — `MlflowOtlpExporter.shutdown()` and `forceFlush()` are no-ops when `failedPermanently` is set.** Stop throwing during OTel SDK shutdown chain. Initialization-failure logging already happens once at init time; `shutdown`/`forceFlush` are wrong places to re-surface it.
- **D12 — Defer the larger "coherent telemetry factory" question (W7-Q4).** A `createCoherentTelemetry(exporter, policy)` factory that wires `TailSamplingProcessor` + `BufferedObserver` from one call would prevent policy divergence, but it widens the public surface. Out of scope for pass 4; revisit when first external consumer arrives.
- **D13 — Defer the multi-process scheduler question (W7-Q5).** `resolveDependents` reading process-local `activeRegistry` is correct for single-process deployments. Multi-process coordination requires a new shared `TaskRegistryStore` port. Out of scope for pass 4; documented as a known constraint.

---

## Scope and triage

| Wave | Theme | Risk if deferred |
|------|-------|------------------|
| 1 | Critical runtime correctness (4 items) | Span leaks under `OBSERVER_STRICT`; trace data silently dropped on init failure; missing routing events; concurrent registry corruption |
| 2 | Silent-failure / observability hardening (9 items) | Operator blind spots: unbalanced events, swallowed Redis errors, console-bypass logs, ambiguous timeout-vs-cancellation |
| 3 | Type-system tightening (11 items, mostly mechanical after D1, D2) | ID-swap bugs invisible at type level; tool-name validation bypassable; unconstrained generics force runtime structural probes |
| 4 | Architectural refactors (D3, D4, D6, D7, D8, D9, D10 + topoSort move) | Singleton registry corrupts under parallelism; non-deterministic timestamps prevent property tests on event ordering; tool-author API hazard |
| 5 | Test coverage gaps (10 items) | Span nesting, in-memory concurrency, version enforcement, backoff growth — all critical invariants untested |
| 6 | Documentation drift sweep (~17 items) | README misleads new contributors; consumers wire generics wrong; ADR citations point at superseded decisions |
| 7 | Architectural-question answers (Q1, Q2, Q3 covered by D6/D9; Q4/Q5 deferred per D12/D13) | DAG topology mismatch on redeploy is currently undefined behaviour |

Waves 1–2 are merge blockers. Wave 3 should land before Wave 4 because the type-system changes shape the API surface that Wave 4 refactors. Wave 6 runs last.

---

## 1. Wave 1 — Critical runtime correctness

### 1.1 `withNodeSpan` span leak under `OBSERVER_STRICT`

`packages/framework/src/dag-runtime/node-span.ts:78-118`. `withNodeSpan` calls `const result = await fn()` with no `try/finally`. Under `OBSERVER_STRICT=1`, `dispatchEvent` in `buffered.ts` rethrows observer exceptions; any throwing observer leaks the OTel span (`span.end()` never fires).

**Fix:**

```typescript
let result: Result<unknown, FrameworkError>;
try {
  result = await fn();
} catch (e) {
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
  span.end();
  throw e;
}
// ...existing outcome logic...
span.end();
return { result, outcome };
```

**Regression test:** `__tests__/node-span-leak.test.ts` — wire a throwing `BufferedObserver` with `OBSERVER_STRICT=1`, run a single-node DAG, assert the OTel exporter sees a closed span.

### 1.2 `MlflowOtlpExporter.shutdown()` and `forceFlush()` failure handling (D11)

`packages/framework/src/tracing/mlflow-otlp-exporter.ts:327-338`.

- `shutdown()` currently throws when `failedPermanently` is set — aborts the OTel SDK shutdown chain, leaving other exporters un-closed.
- `forceFlush()` does `innerPromise.catch(() => null)`, silently resolving when init failed. Process exits "cleanly" while every span since startup was dropped.

**Fix (both methods become no-ops when init has failed permanently):**

```typescript
async shutdown(): Promise<void> {
  if (this.failedPermanently) return;
  if (!this.innerPromise) return;
  const inner = await this.innerPromise;
  if (inner?.shutdown) await inner.shutdown();
}

async forceFlush(): Promise<void> {
  if (this.failedPermanently) return;
  if (!this.innerPromise) return;
  const inner = await this.innerPromise;
  if (inner?.forceFlush) await inner.forceFlush();
}
```

Initialization failure is already logged once via `fwLogger().error` at init time; shutdown/flush should not re-throw or re-log.

**Regression test:** extend `__tests__/mlflow-otlp-exporter.test.ts` — force a permanent init failure (mock the inner exporter import to reject), then call `shutdown()` and `forceFlush()` independently; both must resolve without throwing.

### 1.3 `run-telemetry.ts` run-start dispatch ordering

`packages/framework/src/dag-runtime/run-telemetry.ts:51-56`. `dispatchEvent` for `run-start` runs **before** `beginRunTelemetry` returns the `emitRunEnd` closure. An observer throw at `run-start` propagates out of `beginRunTelemetry`, so the caller's `emitRunEnd` is never captured — the run terminates without a `run-end` observer event, breaking observers that expect balanced pairs.

**Fix:** capture the `emitRunEnd` closure **before** dispatching `run-start`, wrap the dispatch in a try/catch (logged via `fwLogger().error`), and continue regardless. The closure must always be returned.

```typescript
const emitRunEnd = (status, error) => { /* existing */ };
try {
  dispatchEvent(nodeCtx.observer, { type: "run-start", ... });
} catch (e) {
  fwLogger().error("[runTelemetry] run-start dispatch threw:", e);
}
return { emitRunEnd, ... };
```

**Regression test:** observer whose `onRunStart` throws → run still emits `run-end`.

### 1.4 `Observer` port: remove optional methods (D5)

`packages/framework/src/observer/observer.ts:22-23`. `onRouteDecided?` and `onNodePruned?` are optional. Custom observers silently miss routing/pruning events; `dispatchEvent` papers over the gap with `?.()`.

**Fix:**

- Remove the `?` from `onRouteDecided` and `onNodePruned` on the `Observer` interface.
- Remove the optional-chaining calls in `observer/buffered.ts:67,70`.
- `NoopObserver` and `RecordingObserver` already implement them; no other implementation changes needed.

**Regression test:** type-level — `__tests__/observer-port-completeness.test.ts` constructs an `Observer` literal missing `onRouteDecided` and expects a TypeScript compile error (use `// @ts-expect-error`).

### 1.5 `SpanAttributeRegistry` factory (D3)

`packages/framework/src/tracing/span-attribute-registry.ts:74`. Process-global mutable singleton. Concurrent worker runs cross-corrupt; `clear()` from one test evicts attributes from a parallel test.

**Fix:**

- Convert `SpanAttributeRegistryImpl` to `createSpanAttributeRegistry()`.
- `MlflowOtlpExporter` constructor takes a `registry: SpanAttributeRegistry` parameter; default to a new instance per exporter.
- `enrichLlmSpan` accepts a `registry` parameter via a new `EnrichLlmSpanOpts.registry` field; the existing call sites in `nodes/llm.ts` and `nodes/llm-with-tools.ts` thread it through from `fwTracer()` or pass `undefined` to fall back to a process-default (kept for backward source compatibility within the framework only).
- Update `init.ts:initTracing` so the registry is created alongside `tailProcessor` and exposed via `TracingHandle.registry`.

**Regression test:** `__tests__/span-attribute-registry-isolation.test.ts` — two registries, write to one, clear the other, assert the first still has its attributes.

---

## 2. Wave 2 — Silent-failure / observability hardening

### 2.1 `TailSamplingProcessor` pendingExports chain

`packages/framework/src/observer/tail-sampling-processor.ts:132-143`. `pendingExports.add(p)` holds the **raw** rejected promise; the `.catch` is a fork, not a chain. Transient unhandled-rejection race on slow exporters.

**Fix:** chain everything off the logged variant:

```typescript
const logged = p.catch((err) => {
  this.exportFailed++;
  fwLogger().error(`[TailSamplingProcessor] Export failed for trace ${traceId}:`, err);
});
this.pendingExports.add(logged);
logged.finally(() => this.pendingExports.delete(logged));
```

### 2.2 `BufferedObserver` unbalanced `run-end` warning

`packages/framework/src/observer/buffered.ts:238`. `?? []` silently emits `run-end` to the inner observer with no preceding `run-start`.

**Fix:**

```typescript
const buf = this.buffers.get(e.runId);
if (!buf) {
  fwLogger().warn(`[BufferedObserver] onRunEnd for unknown runId=${e.runId}`);
}
const events = buf?.events ?? [];
```

### 2.3 Scheduler `markers.set(fired)` failure backoff

`packages/framework/src/scheduler/scheduler.ts:205-212`. Marker write failure is logged and swallowed; `handleFire` returns success; normal-tick reschedule. A persistent Redis failure spams `enqueue` every tick, relying on `enqueue` idempotency.

**Fix:** rethrow the marker error so `onTimerFire`'s `.catch` applies backoff. Update the comment to drop the "enqueue is idempotent" rationale; idempotency belongs to the queue contract, not the scheduler's error path.

```typescript
try {
  await markers.set(markerFiredKey(task.id), ttlSeconds);
} catch (err) {
  fwLogger().error(`[CronScheduler] markers.set(fired) failed for "${task.id}":`, err);
  throw err;
}
```

`onTimerFire`'s `.catch` already triggers `rescheduleTaskWithBackoff`; this just lets it kick in.

### 2.4 `openai-client.ts` timeout vs cancellation distinction

`packages/framework/src/llm/openai-client.ts:275-285`. `AbortError` from a fetch-timeout is indistinguishable from a user-initiated cancel; both end up as `err({ kind: "aborted" })`.

**Fix:** in `postResponses`, wrap the fetch in a try/catch that tags timeout-induced aborts:

```typescript
try {
  httpRes = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
} catch (e) {
  clearTimeout(timeout);
  signal?.removeEventListener("abort", onCallerAbort);
  if (e instanceof Error && e.name === "AbortError" && !signal?.aborted) {
    throw Object.assign(e, { __timedOut: true });
  }
  throw e;
} finally {
  clearTimeout(timeout);
  signal?.removeEventListener("abort", onCallerAbort);
}
```

In `sendStructured`/`sendWithTools`, detect `__timedOut` and return `err({ kind: "transient", message: "request timed out after ${timeoutMs}ms" })`.

### 2.5 `RedisCheckpointer` `console.warn` → `fwLogger`

`packages/framework/src/checkpoint/redis-checkpointer.ts:178-183`. One stray `console.warn` for corrupt entries. Replace with `fwLogger().warn(...)`.

### 2.6 `queue/dead-letter.ts` and `tracing/mlflow-otlp-exporter.ts` `console.*` sweep

Call sites:

- `queue/dead-letter.ts:43,65`
- `tracing/mlflow-otlp-exporter.ts:177,239,272`

Replace all with `fwLogger().{warn,error}`. The MLflow exporter's `logParseFailure` helper at line 171 routes through `fwLogger().warn`.

**Note:** `logger.ts` has no imports from `tracing/`, so no cycle introduced.

### 2.7 Unknown `spanType` warn

`packages/framework/src/tracing/mlflow-otlp-exporter.ts:289`. `SPAN_TYPE_TO_MLFLOW[spanType] ?? "CHAIN"` silently coerces unknown types.

**Fix:**

```typescript
const mlflowType = SPAN_TYPE_TO_MLFLOW[spanType];
if (!mlflowType) {
  fwLogger().warn(`[MlflowOtlpExporter] Unknown spanType="${spanType}" → defaulting to CHAIN`);
}
out["mlflow.spanType"] = mlflowType ?? "CHAIN";
```

### 2.8 Cache-read warn includes `cacheKey`

- `nodes/llm.ts:84`
- `nodes/llm-with-tools.ts:129`

Add `cacheKey` to the log message so operators can correlate failures with specific entries.

### 2.9 `queue-bullmq/event-log.ts` `recordedAtMs = 0` fallback signal

`packages/framework/src/queue-bullmq/event-log.ts:227-241`. Malformed Redis-stream IDs fall back to `recordedAtMs = 0`. Forensic queries silently include or exclude these.

**Fix:** add a `synthetic: true` field to `RecordedEvent` (optional, defaults to `false` on real timestamps) so `readEventsBetween` callers can detect and skip synthesized timestamps. Update the `RecordedEvent<E>` type in `state-machine/types.ts:39`.

---

## 3. Wave 3 — Type-system tightening

### 3.1 `NodeDef<I, O, E extends FrameworkError = FrameworkError>` (D1)

`packages/framework/src/types/node.ts:161`. Constrain the error generic; remove the structural-probe + `as FrameworkError` cast in `run-node.ts:187-192`.

All built-in factories (`createFetchNode`, `createTransformNode`, `createLlmNode`, etc.) already satisfy the constraint. No call-site migration.

### 3.2 Brand `ToolName` (D2 partial)

`packages/framework/src/llm/tools.ts:23`. Introduce:

```typescript
declare const __toolNameBrand: unique symbol;
export type ToolName = string & { readonly [__toolNameBrand]: void };

export function assertValidToolName(name: string): asserts name is ToolName {
  if (!TOOL_NAME_REGEX.test(name)) throw new Error(...);
}

export function toolName(name: string): ToolName {
  assertValidToolName(name);
  return name;
}
```

`ToolDef.name: ToolName`. `tool()` calls `toolName(config.name)` internally. Direct object-literal construction (`{ name: "x", ... }`) becomes a compile error.

### 3.3 Brand `RunId`, `NodeId`, `DagId` (D2 main)

New `packages/framework/src/types/ids.ts`:

```typescript
declare const __runIdBrand: unique symbol;
declare const __nodeIdBrand: unique symbol;
declare const __dagIdBrand: unique symbol;
export type RunId = string & { readonly [__runIdBrand]: void };
export type NodeId = string & { readonly [__nodeIdBrand]: void };
export type DagId = string & { readonly [__dagIdBrand]: void };

// regex: ^[A-Za-z0-9_:-]{1,128}$  (allow `:` for run-id namespacing)
export function runId(s: string): RunId { /* validate + cast */ }
export function nodeId(s: string): NodeId { /* validate + cast */ }
export function dagId(s: string): DagId { /* validate + cast */ }
```

Coordinated rename across:

- `types/events.ts` — every `runId: string` → `RunId`, every `nodeId: string` → `NodeId`, every `dagId: string` → `DagId`.
- `types/errors.ts` — same for each `FrameworkError` variant.
- `types/dag.ts` — `DagDef.id: DagId`, `NodeDef.id: NodeId`, `EdgeDef.from: NodeId`, `EdgeDef.to: NodeId`, `outputNodeId: NodeId`.
- `types/node.ts` — `BaseNodeContext.runId: RunId`, etc.
- `state-machine/types.ts` — `RecordedEvent.runId: RunId`.
- `queue/types.ts` — `EnqueueOpts.jobId: string` stays untyped (jobIds are vendor-specific).
- `dag-runtime/types.ts` — every internal usage.

Smart-constructor call sites: `defineDag`, `makeNodeContext`, `runDag` entry, `createInMemoryJob`. Each takes raw strings at the entry point and validates once.

### 3.4 `validate-dag.ts` `missedFromNode` fix

`packages/framework/src/executor/validate-dag.ts:189`. Currently `missedFromNode: input.outputNodeId` — points at the output node itself. Walk backwards from `outputNodeId` along unconditional + default edges to find the actual frontier source.

```typescript
function findUnreachableFrontier(nodes, edges, outputId): NodeId {
  // BFS backward along unconditional/default edges from outputId; first node
  // whose only inbound paths are conditional-with-no-default is the frontier.
}
```

### 3.5 `Capability` ↔ `CapabilityFields` compile-time sync assertion

`packages/framework/src/types/node.ts`. Append:

```typescript
type _AssertCapabilitySync =
  | (Capability extends keyof CapabilityFields ? never : "Capability has key missing from CapabilityFields")
  | (keyof CapabilityFields extends Capability ? never : "CapabilityFields has key missing from Capability");
// Assignment to never proves they match exactly.
const _capabilityCheck: _AssertCapabilitySync = undefined as never;
```

### 3.6 `ratio(p)` bounds check

`packages/framework/src/observer/policy.ts:19`. Reject NaN, Infinity, negative, > 1:

```typescript
export function ratio(p: number): PersistencePolicy {
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new Error(`ratio(p): p must be in [0, 1], got ${p}`);
  }
  return { shouldFlush: () => Math.random() < p };
}
```

### 3.7 `validateCapabilities` returns all missing

`packages/framework/src/shared/capabilities.ts:47-58`. Currently returns on the first missing. Collect into a `Capability[]` and return a single `Err` with a `readonly missing: readonly Capability[]` payload. Update `validation.test.ts`.

### 3.8 `formatDetail` exhaustive default

`packages/framework/src/executor/define-dag.ts:44-57`. Add an `_: never` exhaustiveness arm:

```typescript
switch (detail.kind) {
  case "duplicate-node-id": return `...`;
  // ...
  default: {
    const _exhaustive: never = detail;
    return `unhandled error kind: ${JSON.stringify(_exhaustive)}`;
  }
}
```

Future `FrameworkError` variants surfacing through `DagDefinitionError` will fail to compile.

### 3.9 `Machine.stateKey` required

`packages/framework/src/state-machine/types.ts:27`. Currently optional with `JSON.stringify` fallback — unreliable for `Map`/`Set`/`Date`. Make required. Update both internal `Machine` implementations (`buildDagExecutor`'s machine and any test fixtures) to provide a concrete keyer.

### 3.10 `WorkerHandle.onExhausted` callback

`packages/framework/src/queue/types.ts:102-115`. `onFailed(id, err, attempts, max)` requires callers to check `attempts >= max` manually. Add a separate `onExhausted(id, err, attempts)` callback; `onFailed` now fires only for mid-retry failures.

Update `dead-letter.ts:attachDeadLetterHandler` (which previously used `onFailed` + manual check) to use `onExhausted`. Update BullMQ and in-memory adapters to wire both.

### 3.11 `Predicate` `oneOf: []` runtime validator

`packages/framework/src/executor/validate-dag.ts:104-123`. Empty `oneOf` arrays never match and are almost certainly authoring bugs.

```typescript
if ("oneOf" in value && Array.isArray(value.oneOf) && value.oneOf.length === 0) {
  return err({ kind: "predicate-malformed", edge, field, reason: "oneOf array is empty" });
}
```

---

## 4. Wave 4 — Architectural refactors

### 4.1 Thread `nowFn` through observer-event sites (D4)

`packages/framework/src/dag-runtime/run-node.ts` (8 sites), `executor.ts` (6 sites), `state-machine/runner.ts` (2 sites). Every `new Date()` for an observer-event `timestamp` field becomes `new Date(nowFn())`.

`buildDagExecutor` already takes `DagRunOpts.now` — propagate via closure into `runNodeShared`. `runStateMachine` already accepts `RunOptions.now`; pass it through. `run-dag-stateful.ts:178-183` widens to include `now` in the `runOpts` it constructs.

Property test after: `node-start.timestamp <= node-end.timestamp` for any generated DAG.

### 4.2 Break `LlmClient ↔ NodeContext` cycle (D6)

Move from `src/llm/client.ts` and `src/llm/tools.ts` into `src/types/llm.ts`:

- `LlmClient`, `LlmRequest`, `LlmResponse`, `LlmRuntime`, `SendWithToolsRequest`
- `ToolDef`, `ToolContext` (and `ToolName` from 3.2)

`types/node.ts` imports `LlmClient` from `types/llm.ts` directly.

`sendWithTools` signature changes:

```typescript
// before
sendWithTools(req: SendWithToolsRequest, runtime: LlmRuntime): Promise<...>;

// after
sendWithTools(req: SendWithToolsRequest, ctx: NodeContext): Promise<...>;
```

`anthropic-client.ts:206-207` and `openai-client.ts:464` drop the `as NodeContext` widening. The structural-widening comment block referencing ADR 0012 is removed (the cycle that motivated it no longer exists).

Add ADR 0024 "Break LlmClient/NodeContext cycle — supersedes ADR 0012".

### 4.3 `createInMemoryEventLogReader` (D10)

`packages/framework/src/queue/in-memory.ts`. New export:

```typescript
export function createInMemoryEventLogReader(backend: InMemoryBackend): EventLogReader {
  return {
    async readEvents(jobId) {
      const job = backend.__jobs.get(jobId);
      return job ? [...job.events] : [];
    },
    async readEventsBetween(jobId, fromMs, toMs) {
      const events = await this.readEvents(jobId);
      return events.filter(e => e.recordedAtMs >= fromMs && e.recordedAtMs <= toMs);
    },
  };
}
```

`InMemoryBackend.__jobs` already exists (a `Map<string, InMemoryJob>`); expose it via a sanctioned accessor rather than relying on the internal field name. Export from `queue/index.ts` and the main barrel.

New tests in `__tests__/queue-in-memory-event-log-reader.test.ts`: round-trip a job's events without touching Redis.

### 4.4 `topoSort` to `advanced.ts` (D7)

`packages/framework/src/index.ts:48`. Remove `export { topoSort } from "./shared/topo.js"`. Add it to `advanced.ts`. Internal consumers (`compileDagToMachine`, `validateDagShape`) already import directly from `shared/topo.ts`; nothing changes for them.

### 4.5 `types/index.ts` named exports (D8)

`packages/framework/src/types/index.ts`. Replace:

```typescript
export * from "./dag.js";
```

with:

```typescript
export type { DagDef, DagDefInput, EdgeDef, EdgeDefInput, Predicate, /* ... */ } from "./dag.js";
export { withRetryLimits } from "./dag.js";
// brandAsDagDef, normalizeEdge, isOneOfMatch, isUnconditionalEdge stay internal.
```

Same audit for `types/node.ts`, `types/events.ts`, `types/errors.ts`. Cross-check the resulting named list against the README "Authoring surface" section.

### 4.6 DAG topology fingerprint check on resume (D9, Q1 answer)

`packages/framework/src/dag-runtime/persistence.ts:wrapDagJobLike`. The wrapper currently strips `dag` and `incomingByNode` on persist, re-injecting from the live values on read. Add a fingerprint guard:

```typescript
const expectedFingerprint = dagFingerprint(dag);
const wrappedAppendEvent: typeof jobLike.appendEvent = (event, dedupKey) => {
  // ... existing strip logic ...
};
const wrappedUpdateData = (data, key) => {
  const persistableData = { ...data, dagFingerprint: expectedFingerprint };
  return jobLike.updateData(persistableData, key);
};
// On read:
const data = await jobLike.readData?.();
if (data?.dagFingerprint && data.dagFingerprint !== expectedFingerprint) {
  return err({ kind: "checkpoint-version-mismatch", expected: expectedFingerprint, actual: data.dagFingerprint });
}
```

Add `dag-version-mismatch` test case in `__tests__/dag-runtime-stateful.test.ts`: enqueue with DAG v1, swap to DAG v2 (different edge), resume → `checkpoint-version-mismatch`.

### 4.7 `DagRunOpts.now` threaded into `runStateMachine`

`packages/framework/src/dag-runtime/run-dag-stateful.ts:178-183`. Currently omitted from `runOpts`. Trivial — pass `now` through. Required for 4.1's property test.

---

## 5. Wave 5 — Test coverage gaps

### 5.1 Span parent-child nesting

`packages/framework/src/__tests__/llm-tool-call.test.ts`. Extend `RecordedSpan` to capture `parentSpanId` from the active OTel context at `withSpan` entry. Assert `toolSpan.parentSpanId === llmSpan.spanId` for every recorded LLM-tool turn. Closes ADR 0023's primary invariant.

Implementation note: `makeRecordingTracer` already uses `context.with(ctx, fn)`. Add `parentSpanId = trace.getSpanContext(context.active())?.spanId` at span-creation time.

### 5.2 In-memory queue `concurrency > 1`

New file `__tests__/queue-in-memory-concurrency.test.ts`:

```typescript
test("concurrency: 3 runs three jobs in parallel", async () => {
  const barrier = createBarrier(3); // resolves when 3 jobs have arrived
  const handler = async () => { await barrier.arrive(); /* ... */ };
  const backend = createInMemoryBackend({ concurrency: 3 });
  await Promise.all([backend.enqueue({...}), backend.enqueue({...}), backend.enqueue({...})]);
  // assert all 3 reached the barrier
});

test("concurrency: 1 runs jobs sequentially", async () => {
  // same barrier with arrive-count = 1; second job must not advance until first completes
});
```

### 5.3 `InMemoryCheckpointer` framework-version enforcement

`packages/framework/src/__tests__/redis-checkpointer.test.ts`. The shared `checkpointerSuite` skips the four ADR-0017 cases for in-memory. Extend it: stale version, missing field, expired `createdAt`, corrupt JSON. Same four assertions against `new InMemoryCheckpointer()`.

If the in-memory implementation does not currently enforce these (the architecture review's claim is correct), add the enforcement to `InMemoryCheckpointer` in `checkpoint/checkpointer.ts`. The contract is identical to Redis.

### 5.4 Scheduler exponential backoff growth (W6.11 outstanding)

New file `__tests__/scheduler-backoff-growth.test.ts`. Drive `rescheduleTaskWithBackoff` with controlled `consecutiveFailures` of 1, 2, 3, 4, 10:

```typescript
expect(delay(1)).toBe(BACKOFF_BASE_MS);
expect(delay(2)).toBe(2 * BACKOFF_BASE_MS);
expect(delay(3)).toBe(4 * BACKOFF_BASE_MS);
expect(delay(4)).toBe(8 * BACKOFF_BASE_MS);
expect(delay(10)).toBe(BACKOFF_CAP_MS); // capped
```

Use `opts.now` injection to avoid wall-clock dependence.

### 5.5 MLflow parse-failure trigger

`packages/framework/src/__tests__/mlflow-otlp-exporter.test.ts:194`. The current isolation test creates two exporters but never triggers a parse failure. Add a span carrying `EVENT_NODE_INPUT` with `data: "not valid json"`. Assert:

- No throw.
- `parseFailureCounter` increments on exporter A but not on exporter B.
- `mlflow.spanInputs` is not set.

### 5.6 Rate-limit → transient → retry-exhausted DAG chain

`packages/framework/src/__tests__/llm-retry.test.ts`. Extend: DAG with a single LLM node whose client returns `err({ kind: "transient" })` for every attempt. Assert run terminates as `retry-exhausted` with `rootErrorKind === "transient"` (the new field from D2's Wave 3.1 path — wait, that's pass-3's `rootErrorKind`, already present per pass-3 plan §2.1).

### 5.7 `TailSamplingProcessor.forceFlush` drain ordering

`packages/framework/src/__tests__/tail-sampling-processor.test.ts`. Trigger a slow-resolving export (200ms `setTimeout` in the fake exporter), call `forceFlush()` before the export settles, assert `forceFlush` does not resolve until the in-flight export completes.

### 5.8 SC-003 BullMQ crash-resume

`packages/framework/src/queue-bullmq/__tests__/queue-bullmq-adapter.test.ts:1196`. The permanently-skipped `it.skip` test is superseded by `§6.11`. Delete the skipped block and its TODO comment; reference `§6.11` in the file header instead. Leaving a perpetual `it.skip` for a critical invariant is a maintenance hazard.

### 5.9 Three-way concurrent-dependents: barrier not wall-clock

`packages/framework/src/__tests__/scheduler-concurrent-dependents.test.ts:198-220`. Replace `makeDelayedMarkerStore(75)` with a three-way barrier identical to the two-way case at lines 78-171. CI-load false-passes drop to zero.

### 5.10 State-machine `runner` fake-clock robustness

`packages/framework/src/__tests__/state-machine-runner.test.ts:385-407`. The pre-scripted `stamps` array with `Math.min(idx++, stamps.length - 1)` couples the test to the runner's exact `now()` call count. Replace with a callable-stub clock that records call sites:

```typescript
const calls: string[] = [];
const fakeNow = (label: string) => () => { calls.push(label); return ...; };
```

Or simpler: assert only that `durationMs >= 0` and `< 100ms`, drop the exact-millisecond assertion. The exact value isn't load-bearing.

---

## 6. Wave 6 — Documentation drift sweep

All items mechanical text edits. Group by file for a single PR.

### 6.1 README.md corrections

- **Line 165:** `src/version.ts` → `src/checkpoint/fingerprint.ts` for `FRAMEWORK_VERSION`.
- **Line 92:** `Machine<S, C, E>`, `Executor<S, C, E>`, `JobLike<S, C, E>` → `Machine<S, E, C>`, `Executor<S, E, C>`, `JobLike<S, E, C>`. Match the type declarations in `state-machine/types.ts`.
- **Line 37:** Remove `onTrace` from the `RunOptions` field list. `onTrace` belongs to `DagRunOpts` (advanced subpath).
- **Line 146:** Replace `dag-runtime/transition-helpers.ts` (ghost file, split in W5.6) with `dag-runtime/retry-policy.ts`, `dag-runtime/wave-resolution.ts`, `dag-runtime/human-resolution.ts`. Match `check-imports.ts` rule set.
- Verify the named export lists in §"Authoring surface" against the new `types/index.ts` after Wave 4.5.

### 6.2 `types/dag.ts:151` — `defaultRetryLimit` comment

Current: `Setting any value routes runDag to the state-machine path; omit for the legacy fast path with no retries.`

ADR 0021 retired the legacy fast path. Rewrite:

```
Default retry limit applied to all nodes without an entry in `retryLimits`.
When `0` (the default), nodes are not retried.
```

### 6.3 `executor.ts:231` — stale line ref

Delete `(see runWave:341)`. The guard is visible in the same function; pinned line numbers rot on the first re-edit.

### 6.4 `AD-2` citations → ADR 0021

- `dag-runtime/executor.ts:179`
- `dag-runtime/run-dag-stateful.ts:85`

ADR 0002 is superseded. Rewrite to state the reason directly:

```
// Observer events are emitted here so consumers see the full run-start /
// node-start / node-end / run-end stream regardless of the execution path.
```

### 6.5 Plan-task opaque refs sweep

Remove or rewrite to remove plan-task citations:

- `retry-policy.ts:15` — `(Phase 3)` → delete
- `tracing/global-tracer.ts:1` — `(D5)` → delete
- `tracing/global-tracer.ts:19` — `matching the prior behaviour` → delete
- `run-dag-stateful.ts:4-8` — `after the W5.7 split` → delete the temporal clause; keep the structural description
- `run-dag-stateful.ts:62` — `preserving the legacy resumeRun(...) semantics` → drop `legacy` (resumeRun is still live public surface)
- `dag-runtime/types.ts:78` — `(W5.8)` → replace with the actual reason: "Computed once per wave to avoid re-evaluating predicates twice."
- `wave-resolution.ts:82` — same `(see W5.8)` rewrite
- `executor.ts:425` — `(W5.8)` → delete

### 6.6 `persistence.ts:71-73` — delete "Tightened from..." block

Changelog comment. Current type is correct; history adds no value.

### 6.7 `runner.ts:126-129` — reframe invariant comment

Drop "as the prior implementation did" framing. Keep the invariant. New text:

```typescript
// Keyed by (prevState, event-type) rather than stateKey alone, so successive
// retry cycles where prevState repeats (running → retrying → running) produce
// distinct dedup keys. Keying by stateKey alone collapses cross-cycle retries
// onto a single dedup slot and suppresses the second node-failed event.
```

### 6.8 README ADR-0017 citation precision

In `packages/framework/README.md`, the checkpoint section attributes version-mismatch enforcement to ADR 0017. ADR 0017 is "Derive per-node input wiring from edges"; it mentions a version bump but does not define the enforcement mechanism. Add a citation to the ADR that actually defines `FRAMEWORK_VERSION` enforcement (or, if no dedicated ADR exists, write one as part of Wave 4.6).

---

## 7. Wave 7 — Architectural questions

### 7.1 Q1: DAG topology versioning across redeploy — answered by D9 / Wave 4.6

Closed. Mid-flight resume on a redeployed worker with changed topology now produces `checkpoint-version-mismatch`.

### 7.2 Q2: LlmClient/NodeContext cycle — answered by D6 / Wave 4.2

Closed. The cycle is broken by moving `LlmClient` into `types/`. ADR 0012's structural widening is retired; ADR 0024 records the supersession.

### 7.3 Q3: Scheduler `enqueue` idempotency contract

The scheduler's `CronSchedulerOpts.enqueue` is currently untyped on idempotency. Update the JSDoc on `CronSchedulerOpts.enqueue` to require: "`enqueue` MUST be idempotent under a stable key derived from `(taskId, triggeredAt)`. Callers that cannot guarantee this must accept duplicate-execution risk." The framework's BullMQ adapter already uses `jobId = ${taskId}-${triggeredAt}` for this purpose; document the convention.

No code change beyond the JSDoc — the contract is being made explicit, not enforced.

### 7.4 Q4: Coherent telemetry factory — deferred per D12

Out of scope. Document as a known cleanup target in `docs/plans/2026-05-12-pass-4-followups.md` (new file) for when the first external consumer materialises.

### 7.5 Q5: Multi-process `resolveDependents` — deferred per D13

Out of scope. Add a single-paragraph note to `README.md` under §"Scheduler" stating: "`resolveDependents` reads the process-local `activeRegistry`; multi-process deployments require either co-locating the scheduler with workers or providing a shared `TaskRegistryStore` (not yet implemented)."

---

## 8. Acceptance criteria per wave

Each wave is a single PR with:

- All listed changes applied.
- Tests added/updated as specified.
- `bun test` passes.
- `bun run typecheck` (in `packages/framework`) passes.
- `bun test src/__tests__/boundary-imports.test.ts` passes (boundary lints unchanged).
- For Wave 1 only: smoke test (`apps/customer-summary/scripts/smoke.ts`) runs end-to-end against real MLflow.
- For Wave 4 only: ADR 0024 written and committed alongside the cycle-break.

---

## 9. Sequencing constraints

```
Wave 1 ───┐
          ├─► Wave 2 ───┐
          │             ├─► Wave 4 ───┐
          └─► Wave 3 ───┘             ├─► Wave 6
                                      │
                          Wave 5 ─────┘
                          (independent)
                          Wave 7 (docs + ADR; runs alongside Wave 6)
```

- Wave 1 and Wave 3 are independent; can land in either order.
- Wave 2 can begin once Wave 1's `fwLogger` audit lands (2.5, 2.6 depend on the seam being in place — it already is per pass 3).
- Wave 4 depends on the type-system shape from Wave 3 (Wave 4.2 imports types; Wave 4.6 uses `dagFingerprint`).
- Wave 5 is independent — tests can be added against current code, updated as Waves 1–4 land.
- Wave 6 lands last to capture all comment changes induced by code refactors above.

---

## 10. Out of scope (explicit non-goals)

- No changes to ADRs 0001–0023 other than the one new ADR 0024.
- No changes to `apps/customer-summary/**`.
- No new public surface beyond `createInMemoryEventLogReader` (Wave 4.3) and `runId`/`nodeId`/`dagId`/`toolName` smart constructors (Wave 3.3, 3.2).
- No package version bump; framework is still pre-1.0 with zero external consumers.
- The "coherent telemetry factory" (D12), multi-process `resolveDependents` (D13), and `Cache` ↔ `ContextCacheAdapter` collapse (carried from pass 3 D9) remain deferred.
