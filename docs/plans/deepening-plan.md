# Deepening Plan — DAG Runtime & LLM Layer

**Branch:** `feat/initial-setup`  
**Date:** 2026-05-18  
**Status:** Ready for implementation  

---

## Overview

Five architectural deepenings to improve locality, leverage, and testability in the Fugue framework's runtime layer. Each is a self-contained PR. Implementation order is dependency-driven.

| # | Title | Scope | Est. LOC Δ | Risk |
|---|-------|-------|-----------|------|
| §3 | Collapse `DagTransitionContext` | Type simplification | -40 | Low |
| §4 | Disentangle OTel from domain events | Internal refactor | +30 net | Low |
| §1 | Wave execution module | Internal refactor | -100 net | Low |
| §2 | Consolidate `runDag`/`runDagStateful` | Semi-public API | -80 net | Medium |
| §5 | Extract provider-agnostic tool-use loop | Internal to `llm/` | -200 net | Medium |

**Rejected:** §6 (NodeContext capability typing) — current phantom-brand design is sound.

---

## §3 — Collapse `DagTransitionContext` Into `DagMachineContextPersisted`

### Goal

Eliminate the middle type in the three-layer context hierarchy. The transition layer operates on `DagMachineContextPersisted` directly; `outgoingByNode` moves to `DagMachineContext` (live/executor only).

### Prerequisite

Make `routingDecisions` **mandatory** on `wave-done` events so the pure transition never needs to evaluate predicates itself.

### File Changes

| File | Action | Detail |
|------|--------|--------|
| `dag-runtime/types.ts` | **Edit** | Delete `DagTransitionContext`. Change `DagMachineContext extends DagMachineContextPersisted` (add `outgoingByNode` here). |
| `dag-runtime/types.ts` | **Edit** | On `DagEvent` type `wave-done`: change `routingDecisions` from optional (`?`) to required. |
| `dag-runtime/transition.ts` | **Edit** | Change signature: `dagTransition(phase, event, ctx: DagMachineContextPersisted)`. Update internal `TransitionResult` context type. |
| `dag-runtime/wave-resolution.ts` | **Edit** | All helpers accept `DagMachineContextPersisted` instead of `DagTransitionContext`. Remove the fallback `decideRoute` path in `handleWaveDone` (predicate evaluation inline). |
| `dag-runtime/retry-policy.ts` | **Edit** | Accept `DagMachineContextPersisted` in signatures. |
| `dag-runtime/human-resolution.ts` | **Edit** | Accept `DagMachineContextPersisted` in signatures. |
| `dag-runtime/machine.ts` | **Edit** | `compileDagToMachine` — move `outgoingByNode` from initial context's persisted fields to the live-only extension. Update `Machine.transition` wrapper to spread correctly. |
| `dag-runtime/persistence.ts` | **Edit** | `stripNonPersistable` no longer needs to strip `outgoingByNode` (it's live-only now). |
| `dag-runtime/conditional.ts` | **Edit** | `expandActive` takes `edges` (plain data) instead of `outgoingByNode`. Build the adjacency map locally or accept it as param. |
| `docs/adr/0029-mandatory-routing-decisions.md` | **Create** | ADR documenting the decision to make `routingDecisions` mandatory on `wave-done`. |

### Test Changes

| Test File | Action |
|-----------|--------|
| `dag-transition.test.ts` | Update fixtures: remove `outgoingByNode` from context construction, ensure `routingDecisions` is always present on `wave-done` events. |
| `dag-transition-property.test.ts` | Same fixture updates. |
| `wave-resolution.test.ts` | Remove tests for "fallback decideRoute when routingDecisions absent". Add test asserting `expandActive` works from edges directly. |
| `conditional-edges-routing.test.ts` | Verify routing still works with mandatory decisions. |
| `serialize-roundtrip.test.ts` | Confirm persisted context no longer carries `outgoingByNode`. |

### Acceptance Criteria

- [ ] `DagTransitionContext` type no longer exists anywhere in codebase
- [ ] `dagTransition` accepts `DagMachineContextPersisted`
- [ ] Constructing a `wave-done` event without `routingDecisions` is a **type error**
- [ ] All existing tests pass (with fixture updates)
- [ ] `bun run check-imports` passes (boundary enforcement)

### ADR-0029 Draft

```markdown
# ADR-0029: Mandatory Routing Decisions on wave-done Events

## Status: Accepted

## Context

The `wave-done` DagEvent previously carried `routingDecisions` as an optional field.
When absent, the pure transition layer fell back to calling `decideRoute` inline —
which evaluates predicate functions (closures). This made the transition layer
impure on the fallback path and required `outgoingByNode` (containing closures) to
live on the intermediate `DagTransitionContext` type.

## Decision

`routingDecisions` is now **mandatory** on `wave-done` events. The executor always
computes routing decisions before emitting `wave-done`. The transition layer never
evaluates predicates — it only reads the precomputed decisions.

## Consequences

- The pure transition layer is genuinely pure (no closure invocations).
- `DagTransitionContext` is eliminated; `dagTransition` operates on `DagMachineContextPersisted`.
- Event-log replay of historical events from before this change (which lacked `routingDecisions`)
  is no longer supported by the transition layer directly. Since this is a greenfield project
  with no production event logs, this is acceptable.
- `outgoingByNode` moves to `DagMachineContext` (live/executor-only).
```

---

## §4 — Disentangle OTel Spans From Domain Event Emission

### Goal

Split `withNodeSpan` into (a) a pure OTel span wrapper and (b) a pure guardrail-outcome classifier. Observer event emission stays at the `runNodeShared` call site, not buried inside span infrastructure.

### File Changes

| File | Action | Detail |
|------|--------|--------|
| `dag-runtime/node-span.ts` | **Rewrite** | Keep `DagRunMeta`, `foldOutcomes`, `createDagRunMeta`. Replace `withNodeSpan` with two functions: `withTracedNodeSpan` (span lifecycle only) and `classifyGuardrailOutcome` (pure). |
| `dag-runtime/run-node.ts` | **Edit** | Call `withTracedNodeSpan` for the span, call `classifyGuardrailOutcome` on the result after the span closes. |
| `tracing/semantic-conventions.ts` | No change | Already exports constants used by both. |

### New Module Shape: `dag-runtime/node-span.ts`

```typescript
// ── Types (unchanged) ──────────────────────────────────────────────
export interface NodeSpanOutcome { ... }
export interface DagRunMeta { ... }
export const createDagRunMeta = (): DagRunMeta => ...
export const foldOutcomes = (meta, outcomes): DagRunMeta => ...

// ── Pure guardrail classifier ──────────────────────────────────────
/**
 * Classify a node's result into a guardrail outcome. Pure — no OTel dependency.
 * Examines the result value for guardrail failure shape.
 */
export const classifyGuardrailOutcome = (
  kind: NodeKind,
  result: Result<unknown, FrameworkError>,
): NodeSpanOutcome => {
  if (!result.ok) return EMPTY_OUTCOME;
  if (kind !== "guardrail") return EMPTY_OUTCOME;
  if (result.value && typeof result.value === "object" && "passed" in result.value) {
    const v = result.value as { passed: boolean; warnings?: string[] };
    if (!v.passed) {
      return { guardrailFailed: true, guardrailWarnings: v.warnings ?? [] };
    }
  }
  return EMPTY_OUTCOME;
};

// ── Span wrapper (infrastructure only) ────────────────────────────
/**
 * Wrap node execution in an OTel span. No domain logic — just creates a span,
 * sets attributes, records input/output events, and propagates the result.
 * Does NOT inspect the result for guardrail semantics.
 */
export const withTracedNodeSpan = async (
  nodeId: string,
  kind: string,
  input: unknown,
  contentFilter: ContentFilter | null,
  sideEffects: SideEffectProfile,
  fn: () => Promise<Result<unknown, FrameworkError>>,
): Promise<Result<unknown, FrameworkError>> => {
  // Span lifecycle only — no guardrail inspection
  return fwTracer().startActiveSpan(`node:${nodeId}`, { attributes: ... }, async (span) => {
    span.addEvent(EVENT_NODE_INPUT, ...);
    let result: Result<unknown, FrameworkError>;
    try {
      result = await fn();
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, ... });
      span.end();
      return err({ kind: "node-crash", ... });
    }
    if (result.ok) {
      span.addEvent(EVENT_NODE_OUTPUT, ...);
    } else {
      span.setStatus({ code: SpanStatusCode.ERROR, ... });
    }
    span.end();
    return result;
  });
};
```

### Changes to `run-node.ts`

```typescript
// Before:
return withNodeSpan(nodeId, node.kind, input, contentFilter, sideEffects, async () => {
  // ... entire node execution including emit(node-start) / emit(node-end)
});
// Returns: { result, outcome }

// After:
const result = await withTracedNodeSpan(nodeId, node.kind, input, contentFilter, sideEffects, async () => {
  emit(ctx, { type: "node-start", ... });
  // ... run node ...
  emit(ctx, { type: "node-end", ... });
  return ok(output);
});
const outcome = classifyGuardrailOutcome(node.kind, result);
return { result, outcome };
```

### Test Changes

| Test File | Action |
|-----------|--------|
| New: `classify-guardrail-outcome.test.ts` | Unit tests for `classifyGuardrailOutcome` — pure function, plain data in/out. Test guardrail-passed, guardrail-failed, non-guardrail node, error result. |
| `node-span-leak.test.ts` | Update to use `withTracedNodeSpan` if it tests span lifecycle directly. |
| `guardrail.test.ts` | Verify guardrail outcomes still surface correctly through the full pipeline. |
| Existing integration tests | No change — they test through `runDag`. |

### Acceptance Criteria

- [ ] `withNodeSpan` no longer exists (replaced by `withTracedNodeSpan` + `classifyGuardrailOutcome`)
- [ ] `classifyGuardrailOutcome` has standalone unit tests with no OTel imports
- [ ] `withTracedNodeSpan` has no knowledge of guardrails, `passed`, or `warnings`
- [ ] All existing tests pass
- [ ] Guardrail failures still surface in `DagRunMeta` and root span status

---

## §1 — Wave Execution Module

### Goal

Merge `emitFreshnessWitnessEvents`, `emitRoutingDecisions`, and the inline `runWave` body into a single deep module (`wave-execution.ts`) with one entry point.

### Depends On

- §3 (type simplification — `DagMachineContext` shape is settled)
- §4 (OTel/domain split — we merge the clean version, not the tangled one)

### File Changes

| File | Action | Detail |
|------|--------|--------|
| `dag-runtime/wave-execution.ts` | **Create** | New file. Contains `executeWave` + all wave-internal logic (node dispatch, output collection, freshness witnesses, routing decisions). |
| `dag-runtime/freshness-emission.ts` | **Delete** | Logic moves into `wave-execution.ts`. |
| `dag-runtime/route-emission.ts` | **Delete** | Logic moves into `wave-execution.ts`. |
| `dag-runtime/executor.ts` | **Shrink** | `buildDagExecutor` becomes a thin pattern-match dispatcher. `runWave` removed (replaced by import of `executeWave`). Remove `RunWaveConfig` type. |
| `dag-runtime/run-node.ts` | No change | Still the per-node execution module, called by `executeWave`. |
| `dag-runtime/human-emission.ts` | No change | Called from the `awaiting-human` executor branch, not from wave execution. |
| `dag-runtime/index.ts` | **Edit** | Update exports (remove freshness-emission/route-emission re-exports if any). |

### New Module: `wave-execution.ts`

```typescript
/**
 * Wave execution — the deep module behind DAG wave dispatch.
 *
 * Single entry point: `executeWave(waveIndex, machineCtx, config)`.
 * Owns the full lifecycle from "dispatch all wave nodes" through
 * "emit freshness witnesses and routing decisions" to "produce a
 * wave-done or node-failed DagEvent".
 *
 * Callers (buildDagExecutor) pattern-match on DagPhase and call this
 * for `running` and `retrying` states. Everything else (human hooks,
 * sleep/jitter) stays in the executor.
 */

export interface WaveConfig {
  readonly dag: DagDef;
  readonly nodeMap: ReadonlyMap<NodeId, NodeDef<unknown, unknown>>;
  readonly nodeCtx: ValidatedNodeContext;
  readonly freshnessIndex: FreshnessIndex;
  readonly nowFn: () => number;
  readonly resumeCheckpoint?: ReadonlyMap<string, unknown>;
  readonly witnessAccumulator: Map<string, Witness>;
}

export interface WaveResult {
  readonly event: DagEvent;
  readonly outcomes: readonly NodeSpanOutcome[];
}

/**
 * Execute all active nodes in a wave concurrently, then:
 * 1. Collect outputs and detect failures
 * 2. Emit freshness witness events for reads/writes nodes
 * 3. Compute routing decisions for conditional out-edges
 * 4. Return wave-done (success) or node-failed (first failure)
 */
export const executeWave = async (
  waveIndex: number,
  machineCtx: DagMachineContext,
  config: WaveConfig,
): Promise<WaveResult> => {
  // ... merged logic from current runWave + emitFreshnessWitnessEvents + emitRoutingDecisions
};
```

### Executor Becomes Thin Dispatcher

```typescript
// dag-runtime/executor.ts — after §1
export const buildDagExecutor = (
  dag: DagDef,
  nodeCtx: ValidatedNodeContext,
  hooks?: ExecutorHooks,
): Executor<DagPhase, DagEvent, DagMachineContext> => {
  const config: WaveConfig = { ... };
  const random = hooks?.random ?? Math.random;
  const nowFn = hooks?.now ?? Date.now;

  return async (phase, machineCtx) =>
    match(phase)
      .with({ kind: "pending" }, () => ({ type: "start" } as DagEvent))
      .with({ kind: "running" }, async (p) => {
        const { event, outcomes } = await executeWave(p.wave, machineCtx, config);
        hooks?.recordOutcomes?.(outcomes);
        return event;
      })
      .with({ kind: "retrying" }, async (p) => {
        const jittered = applyJitter(p.nextDelayMs, ...);
        await sleep(jittered, nodeCtx.signal);
        if (nodeCtx.signal?.aborted) return { type: "abort", reason: "signal" };
        const { event, outcomes } = await executeWave(p.wave, machineCtx, config);
        hooks?.recordOutcomes?.(outcomes);
        return event;
      })
      .with({ kind: "awaiting-human" }, async (p) => {
        const awaitStartMs = nowFn();
        const event = await callHumanReviewHook(...);
        if (event.type === "human-responded") emitHumanIntervention(...);
        return event;
      })
      .with({ kind: "retrying-hook" }, async (p) => {
        await sleep(...);
        // same as awaiting-human
      })
      .with({ kind: "succeeded" }, () => { throw ... })
      .with({ kind: "failed" }, () => { throw ... })
      .exhaustive();
};
```

### Test Changes

| Test | Action |
|------|--------|
| New: `wave-execution.test.ts` | Direct unit tests of `executeWave`. Use `InMemoryFreshnessIndex`, `FakeLlmClient`, scripted node outputs. Assert on returned `DagEvent` shape + `outcomes`. |
| `freshness-emission.test.ts` | **Delete** (if it exists as standalone — check). Logic tested through `wave-execution.test.ts`. |
| `route-emission.test.ts` | **Delete** (same). |
| `executor.test.ts` | Update imports. Verify executor still integrates correctly. |
| `dag-runtime-stateful.test.ts` | No change — integration-level. |
| Property tests | Add: "for N succeeding nodes, executeWave returns wave-done with N outputs". |

### Acceptance Criteria

- [ ] `freshness-emission.ts` and `route-emission.ts` deleted
- [ ] `executor.ts` is ≤200 LOC (down from 558)
- [ ] `wave-execution.ts` is ≤450 LOC
- [ ] All existing integration tests pass unchanged
- [ ] New `wave-execution.test.ts` covers: success path, first-failure short-circuit, freshness conflict detection, routing decision emission, checkpoint-skipped nodes

---

## §2 — Consolidate `runDag` / `runDagStateful` Into Single Entry Point

### Goal

One public entry point (`runDag`), one options type (`RunOptions`), one internal orchestrator. `runDagStateful` becomes a non-exported implementation detail.

### Depends On

- §1 (executor restructuring is stable — this touches the same call chain)

### File Changes

| File | Action | Detail |
|------|--------|--------|
| `executor/run-dag.ts` | **Rewrite** | Becomes the sole orchestrator. Absorbs capability validation, telemetry, job wiring, fingerprint checks, kernel invocation, judge finalization. |
| `dag-runtime/run-dag-stateful.ts` | **Delete** | All logic moves into `executor/run-dag.ts`. |
| `dag-runtime/run-dag-stateful.ts` → re-export shim | **Create** (temporary) | One-line re-export for `/advanced` subpath backward compat during transition. |
| `advanced.ts` | **Edit** | `runDagAsWorkerJob` moves here (wraps `runDag` + rethrows). Remove `runDagStateful` export or mark deprecated. |
| `index.ts` (main barrel) | **Edit** | Remove `DagRunOpts` re-export. `RunOptions` is the public type. |
| `executor/preflight.ts` | **Create** | Pure preflight validation extracted: HITL contract, capability check, durability advisory. Returns `Result<PreflightContext, FrameworkError>`. |

### New Public Types

```typescript
// executor/run-dag.ts

export interface RunOptions {
  /** Crash-resume checkpoint. */
  readonly resume?: { readonly runId: string; readonly checkpoint: Map<string, unknown> };
  /** Background eval-judge completion hook. */
  readonly onBackground?: (p: Promise<BackgroundResult>) => void;
  /** Durable job handle for checkpoint/resume. */
  readonly jobLike?: JobLike<DagPhase, unknown, DagMachineContextPersisted>;
  /** Human-review hook — required when DAG declares humanReview. */
  readonly onHumanReview?: (req: { nodeId: string; output: unknown; prompt: string }) => Promise<HumanAction>;
  /** Per-call retry limit overrides. */
  readonly retryLimits?: Readonly<Record<string, number>>;
  /** Suppress routing/durability warnings. */
  readonly suppressRoutingWarnings?: boolean;
  /** Wall-clock source for timestamps. Default: Date.now. */
  readonly now?: () => number;
  /** RNG seam for retry jitter. Default: Math.random. */
  readonly random?: () => number;
  /** Shared freshness index for cross-DAG detection. */
  readonly freshnessIndex?: FreshnessIndex;
}
```

### New Internal Module: `executor/preflight.ts`

```typescript
/**
 * Pure pre-flight validation. Runs before any I/O.
 * Returns all information needed to proceed, or a structured error.
 */
export interface PreflightContext {
  readonly validatedCtx: ValidatedNodeContext;
  readonly effectiveDag: DagDef;
}

export const validatePreflight = (
  dag: DagDef,
  ctx: NodeContext,
  opts: RunOptions | undefined,
): Result<PreflightContext, FrameworkError> => {
  // 1. HITL contract: DAG declares humanReview ↔ onHumanReview supplied
  // 2. Merge retryLimits into effective DAG
  // 3. Capability validation
  // 4. Durability advisory (warn, not error)
  // Return: { validatedCtx, effectiveDag }
};
```

### Orchestrator Shape

```typescript
export const runDag = async <I, O>(
  dag: DagDef, input: I, ctx: NodeContext, opts?: RunOptions,
): Promise<Result<O, FrameworkError>> => {
  // Phase 1: Pre-flight (pure)
  const preflight = validatePreflight(dag, ctx, opts);
  if (!preflight.ok) return preflight;
  const { validatedCtx, effectiveDag } = preflight.value;

  // Phase 2: Telemetry (side-effect: emits run-start)
  const { emitRunEnd } = beginRunTelemetry(ctx, dag, { now: opts?.now });

  // Phase 3: Compile + execute (kernel invocation)
  return startRunSpan(dag, ctx, async (rootSpan) => {
    const compiled = compileDagToMachine(effectiveDag, input);
    if (!compiled.ok) { closeRootSpan(...); emitRunEnd("error"); return err(...); }

    let meta = createDagRunMeta();
    const executor = buildDagExecutor(effectiveDag, validatedCtx, { ... });
    const job = resolveJob(opts, compiled);
    
    // ... kernel invocation (same logic as current runDagStateful) ...
    
    // Phase 4: Finalize (judges, span close, run-end)
    return finalizeRun(rootSpan, dag, result, meta, ctx, opts, emitRunEnd);
  });
};
```

### Migration Path for `/advanced` Consumers

```typescript
// advanced.ts — transition period
/** @deprecated Use `runDag` from the main barrel with `opts.jobLike`. */
export const runDagStateful = runDag; // Type-compatible after options merge

export { runDagAsWorkerJob } from "./executor/run-dag.js";
```

### Test Changes

| Test | Action |
|------|--------|
| New: `preflight.test.ts` | Unit tests for `validatePreflight` — HITL mismatch, missing capability, retryLimits merge. Pure function, no async. |
| `run-dag-as-worker-job.test.ts` | Update import path. |
| `dag-runtime-stateful.test.ts` → rename `run-dag.test.ts` | Update to call `runDag` directly with the unified `RunOptions`. |
| All test files importing `DagRunOpts` | Switch to `RunOptions`. |

### Acceptance Criteria

- [ ] `DagRunOpts` type no longer exported from any barrel
- [ ] `runDagStateful` is not importable from the main barrel (only deprecated re-export on `/advanced` if needed)
- [ ] `validatePreflight` has standalone pure tests
- [ ] `RunOptions` is the single options type in documentation and tests
- [ ] All existing integration tests pass

---

## §5 — Extract Provider-Agnostic Tool-Use Loop

### Goal

Extract the duplicated `sendWithTools` loop from Anthropic and OpenAI clients into a shared deep module. Each adapter becomes a thin wire-format translator + delegation to the shared loop.

### Independent Of

§1-§4 (can be implemented in parallel).

### File Changes

| File | Action | Detail |
|------|--------|--------|
| `llm/tool-use-loop.ts` | **Create** | The deep module: provider-agnostic tool-use loop with schema validation, iteration limit, deadline, abort, token accumulation. |
| `llm/anthropic-client.ts` | **Shrink** | `sendWithTools` delegates to `toolUseLoop` via an `AnthropicToolLoopProvider`. |
| `llm/openai-client.ts` | **Shrink** | `sendWithTools` delegates to `toolUseLoop` via an `OpenaiToolLoopProvider`. |
| `llm/index.ts` | **Edit** | Export new types if needed for advanced consumers building custom providers. |
| `llm/tool-dispatch.ts` | No change | Still dispatches individual tool calls. Called by the loop. |

### New Module: `llm/tool-use-loop.ts`

```typescript
/**
 * Provider-agnostic tool-use loop.
 *
 * Deep module: callers supply a ToolLoopProvider (wire-format adapter) and
 * configuration. The loop owns:
 * - Iteration limit enforcement
 * - Total deadline enforcement
 * - Abort signal propagation
 * - Token accumulation across turns
 * - Tool call dispatch (via dispatchToolCallsWithSpans)
 * - Final-answer JSON parsing and schema validation
 * - Span enrichment per turn
 *
 * Adding a new LLM provider requires implementing ToolLoopProvider (~50 LOC)
 * rather than reimplementing the full loop (~200 LOC).
 */

import type { z } from "zod";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import type { LlmResponse, ToolDef } from "../types/llm.js";
import type { NodeContext } from "../types/node.js";

// ── Normalized intermediate types ──────────────────────────────────

/** Provider-agnostic representation of one LLM turn result. */
export interface TurnResult {
  /** Tool calls requested by the model. Empty array = final answer turn. */
  readonly toolCalls: readonly import("./tool-dispatch.js").ToolCall[];
  /** Text content from the model (present on final-answer turns). */
  readonly textContent: string | undefined;
  /** Tokens consumed this turn (input). */
  readonly tokensIn: number;
  /** Tokens produced this turn (output). */
  readonly tokensOut: number;
  /** Extended thinking content (if model supports it). */
  readonly thinking?: string;
}

/** Provider-agnostic message (opaque to the loop — provider creates and consumes). */
export type ProviderMessage = unknown;

/** What each provider adapter implements. */
export interface ToolLoopProvider {
  /** Build the initial message list from system + user prompts. */
  buildInitialMessages(system: string, user: string): ProviderMessage[];
  /** Append the assistant's response to the conversation. */
  appendAssistantTurn(messages: ProviderMessage[], turnResult: TurnResult): void;
  /** Format tool dispatch results and append to the conversation. */
  appendToolResults(
    messages: ProviderMessage[],
    results: readonly import("./tool-dispatch.js").ToolDispatchResult[],
  ): void;
  /** Execute one LLM turn. Provider handles SDK call, timeout, abort detection. */
  call(messages: readonly ProviderMessage[]): Promise<Result<TurnResult, FrameworkError>>;
}

/** Configuration for the tool-use loop. */
export interface ToolUseLoopConfig<O> {
  readonly nodeId: NodeId;
  readonly model: string;
  readonly schema: z.ZodType<O>;
  readonly tools: readonly ToolDef<any, any>[];
  readonly system: string;
  readonly user: string;
  readonly maxIterations: number;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Run the tool-use loop until the model emits a final answer matching `schema`,
 * or a terminal condition (iteration limit, deadline, abort) is reached.
 */
export const toolUseLoop = async <O>(
  provider: ToolLoopProvider,
  config: ToolUseLoopConfig<O>,
  ctx: NodeContext,
): Promise<Result<LlmResponse<O>, FrameworkError>> => {
  const messages = provider.buildInitialMessages(config.system, config.user);
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let lastThinking: string | undefined;
  const deadline = config.deadlineMs ? Date.now() + config.deadlineMs : Infinity;

  for (let turn = 0; turn < config.maxIterations; turn++) {
    // Deadline check
    if (Date.now() >= deadline) {
      return err({ kind: "transient", nodeId: config.nodeId, message: `deadline exceeded after ${turn} turns` });
    }
    // Abort check
    if (config.signal?.aborted || ctx.signal?.aborted) {
      return err({ kind: "aborted", reason: "signal" });
    }

    // Call provider
    const turnResult = await provider.call(messages);
    if (!turnResult.ok) return turnResult;

    const turn_ = turnResult.value;
    totalTokensIn += turn_.tokensIn;
    totalTokensOut += turn_.tokensOut;
    if (turn_.thinking) lastThinking = turn_.thinking;

    provider.appendAssistantTurn(messages, turn_);

    // No tool calls = final answer
    if (turn_.toolCalls.length === 0) {
      if (turn_.textContent === undefined) {
        return err({ kind: "node-crash", retriability: "retriable", nodeId: config.nodeId, message: "final turn had no text content" });
      }
      return parseFinalAnswer(turn_.textContent, config, totalTokensIn, totalTokensOut, lastThinking);
    }

    // Dispatch tools
    const results = await dispatchToolCallsWithSpans(turn_.toolCalls, config.tools, ctx, { model: config.model });
    provider.appendToolResults(messages, results);
  }

  return err({
    kind: "node-crash",
    nodeId: config.nodeId,
    message: `Tool-call iteration limit (${config.maxIterations}) reached`,
    retriability: "non-retriable",
  });
};

/** Parse final text answer: strip code fences, JSON.parse, schema validate. */
const parseFinalAnswer = <O>(
  text: string,
  config: ToolUseLoopConfig<O>,
  tokensIn: number,
  tokensOut: number,
  thinking: string | undefined,
): Result<LlmResponse<O>, FrameworkError> => {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    return err({ kind: "node-crash", retriability: "retriable", nodeId: config.nodeId, message: `Not valid JSON: ${text.slice(0, 200)}` });
  }
  const validated = config.schema.safeParse(parsed);
  if (!validated.success) {
    return err({ kind: "node-crash", retriability: "retriable", nodeId: config.nodeId, message: `Schema validation failed: ${validated.error.message}` });
  }
  return ok({ output: validated.data as O, tokensIn, tokensOut, thinking, rawText: text });
};
```

### Provider Adapter: Anthropic (~80 LOC)

```typescript
// Inside anthropic-client.ts or as llm/anthropic-tool-provider.ts

const createAnthropicToolLoopProvider = (
  anthropic: AnthropicSdkLike,
  model: string,
  requestTimeoutMs: number,
  thinking?: { type: "enabled"; budgetTokens: number },
): ToolLoopProvider => ({
  buildInitialMessages(system, user) {
    // Returns the Anthropic message array shape
    return [{ role: "user", content: user }] as ProviderMessage[];
    // system is handled separately in Anthropic's API (params.system)
    // Store it in closure for use in call()
  },
  appendAssistantTurn(messages, turn) {
    // Push the raw Anthropic content blocks
    messages.push({ role: "assistant", content: /* reconstruct from turn */ });
  },
  appendToolResults(messages, results) {
    messages.push(buildToolResultMessage(results));
  },
  async call(messages) {
    const t = createTimeoutSignal(requestTimeoutMs);
    try {
      const response = await withLlmSpan(null, { provider: "anthropic", model, operation: "chat" }, async () => {
        const r = await anthropic.messages.create({ model, messages, ... }, { signal: t.signal });
        setLlmUsageAttributes(r.usage.input_tokens, r.usage.output_tokens);
        return r;
      });
      return ok(anthropicResponseToTurnResult(response));
    } catch (e) {
      return classifyLlmError(e, ...);
    } finally {
      t.cleanup();
    }
  },
});
```

### Test Changes

| Test | Action |
|------|--------|
| New: `tool-use-loop.test.ts` | Core loop tests with a **scripted fake provider** (no SDK mock). Test: iteration limit, deadline, abort, token accumulation, schema validation, code-fence stripping, tool dispatch integration. |
| New: `tool-use-loop-property.test.ts` | Property: "for any sequence of ≤N tool turns followed by a schema-valid answer, loop returns ok with correct token sums." |
| `anthropic-client.test.ts` | Keep wire-format translation tests. Remove loop-logic tests (iteration cap, deadline) — now tested at loop level. |
| `openai-client.test.ts` | Same — keep wire-format, remove loop logic. |
| `llm-tool-call.test.ts` | Verify end-to-end still works through `createLlmWithToolsNode`. |

### Acceptance Criteria

- [ ] `toolUseLoop` has standalone tests with zero SDK imports
- [ ] `anthropic-client.ts` `sendWithTools` is ≤30 LOC (provider construction + delegation)
- [ ] `openai-client.ts` `sendWithTools` is ≤30 LOC (same)
- [ ] Iteration-limit, deadline, abort, and token-accumulation logic exist in exactly one place
- [ ] Adding a hypothetical third provider requires only implementing `ToolLoopProvider` (~80 LOC)
- [ ] All existing LLM integration tests pass

---

## Cross-Cutting Concerns

### Import Boundary Enforcement

After all changes, run `bun run check-imports` to verify:
- `dag-runtime/transition.ts` imports nothing from `dag-runtime/executor.ts` or `llm/`
- `dag-runtime/wave-execution.ts` does not import from `executor/run-dag.ts`
- `llm/tool-use-loop.ts` does not import from `anthropic-client.ts` or `openai-client.ts`
- `executor/preflight.ts` imports only from `types/` and `shared/`

### Documentation Updates

| File | Update |
|------|--------|
| `README.md` (if it documents architecture) | Update module map |
| `docs/adr/0029-mandatory-routing-decisions.md` | New ADR (drafted above in §3) |
| `advanced.ts` JSDoc | Note deprecation of `runDagStateful` |
| `index.ts` barrel comments | Update the comment block describing public surface |

### Barrel Export Changes

```typescript
// index.ts — after all changes
// Remove: DagRunOpts (internal)
// Remove: DagTransitionContext (deleted)
// Keep: DagMachineContext, DagMachineContextPersisted (renamed from DagTransitionContext usages)
// Add: RunOptions (was already there, becomes the sole options type)
```

```typescript
// advanced.ts — after all changes
// Keep: runDagAsWorkerJob (wraps runDag)
// Keep: compileDagToMachine, buildDagExecutor, dagTransition, topoSort
// Deprecate: runDagStateful (re-export of runDag for transition)
```

---

## Verification Plan

After all 5 PRs land:

```bash
# Full test suite
bun test

# Type checking
bun run typecheck

# Import boundary enforcement
bun run check-imports

# Verify no regressions in customer-summary app
cd apps/customer-summary && bun test
```

### Metrics (Before → After)

| Metric | Before | Target |
|--------|--------|--------|
| `dag-runtime/executor.ts` LOC | 558 | ≤200 |
| `dag-runtime/` total files | 16 | 13 (-3: freshness-emission, route-emission, run-dag-stateful) |
| Types to understand context hierarchy | 3 | 2 |
| `llm/anthropic-client.ts` LOC | 341 | ≤200 |
| `llm/openai-client.ts` LOC | 623 | ≤350 |
| Option types for public DAG entry | 2 (RunOptions + DagRunOpts) | 1 (RunOptions) |
| Files to read for "what happens in a wave" | 6 | 1 (wave-execution.ts) |

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| §3 breaks event-log replay | Greenfield project, no production logs. ADR documents decision. |
| §2 breaks `/advanced` consumers | Deprecated re-export shim during transition. |
| §5 changes LLM error semantics | Scripted-turn tests reproduce exact error shapes. FakeLlmClient tests remain. |
| §1 increases single-file complexity | Wave-execution is ~400 LOC for one cohesive operation. Property tests guard invariants. |
| §4 loses guardrail span attributes | `classifyGuardrailOutcome` result is used to set span status AFTER span closes — verify span attributes are set before `end()`. |

---

## Implementation Checklist

### PR 1: §3 — Type Simplification
- [ ] Delete `DagTransitionContext` from `types.ts`
- [ ] Make `routingDecisions` mandatory on `wave-done`
- [ ] Update `dagTransition` signature
- [ ] Remove fallback `decideRoute` from `wave-resolution.ts`
- [ ] Move `outgoingByNode` to `DagMachineContext` only
- [ ] Update `persistence.ts` (`stripNonPersistable`)
- [ ] Update all test fixtures
- [ ] Write ADR-0029
- [ ] `bun test` green

### PR 2: §4 — OTel/Domain Split
- [ ] Split `withNodeSpan` → `withTracedNodeSpan` + `classifyGuardrailOutcome`
- [ ] Update `run-node.ts` call site
- [ ] Write `classify-guardrail-outcome.test.ts`
- [ ] Verify guardrail span attributes still set correctly
- [ ] `bun test` green

### PR 3: §1 — Wave Execution Module
- [ ] Create `wave-execution.ts` with `executeWave`
- [ ] Inline freshness-emission logic
- [ ] Inline route-emission logic
- [ ] Delete `freshness-emission.ts` and `route-emission.ts`
- [ ] Shrink `executor.ts` to thin dispatcher
- [ ] Write `wave-execution.test.ts`
- [ ] Write property test for wave outcomes
- [ ] `bun test` green

### PR 4: §2 — Consolidate Entry Points
- [ ] Create `executor/preflight.ts`
- [ ] Rewrite `executor/run-dag.ts` as sole orchestrator
- [ ] Delete `dag-runtime/run-dag-stateful.ts` (or convert to re-export shim)
- [ ] Unify option types (`RunOptions` only)
- [ ] Update `/advanced` exports
- [ ] Write `preflight.test.ts`
- [ ] Update all tests importing `DagRunOpts`
- [ ] `bun test` green

### PR 5: §5 — Tool-Use Loop (parallel-safe)
- [ ] Create `llm/tool-use-loop.ts`
- [ ] Implement `ToolLoopProvider` interface
- [ ] Create `anthropicToolLoopProvider` (in anthropic-client.ts)
- [ ] Create `openaiToolLoopProvider` (in openai-client.ts)
- [ ] Shrink `sendWithTools` in both clients to delegation
- [ ] Write `tool-use-loop.test.ts` with scripted fake provider
- [ ] Write property test for token accumulation
- [ ] Remove duplicate loop-logic tests from client test files
- [ ] `bun test` green
