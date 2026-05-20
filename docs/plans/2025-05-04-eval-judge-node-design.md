# EvalJudgeNode — Design

## Summary

A new framework-level node kind (`"eval-judge"`) that evaluates DAG output quality using a cheap LLM call. Generic, pluggable, and automatic — when the judge scores below threshold, the trace is marked ERROR and persisted to MLflow via the existing tail-sampling policy.

## Motivation

Code-level guardrails (topic keywords, schema validation) only catch structural failures. Semantic failures — hallucination, drift, incoherence — require an LLM to detect. The eval-judge node provides this as a framework primitive that any DAG can opt into.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Node kind | New `"eval-judge"` kind | Distinct semantics from LLM/guardrail nodes |
| Failure mode | `ok()` with `passed: false` (like guardrails) | Never blocks pipeline; observational only |
| Input wiring | Automatic — framework provides `{ input, output }` | Plug-and-play, no manual deps |
| LLM client | `ctx.judgeLlm ?? ctx.llm` | Cheap model for eval, expensive for generation |
| Prompt structure | Hybrid — framework frame + user rubric | Stable output format + domain-specific criteria |
| DAG placement | `DagDef.evalJudges` (separate array) | Explicit special handling, not mixed with normal nodes |
| Error behavior | Fail-open (judge failure = `passed: true`) | Don't break production for observability |
| Trace integration | Judge failure → span ERROR → tail-sampling persists | Zero changes to existing sampling infra |

## Interface

### Node Factory

```typescript
createEvalJudgeNode({
  id: string;
  criteria: string[];              // e.g. ["factuality", "relevance", "completeness"]
  threshold: number;               // 0.0-1.0, default 0.8
  rubricTemplateId?: string;       // prompt template name from ctx.prompts
  rubricInline?: string;           // alternative: inline rubric text
}): EvalJudgeNodeDef
```

### Output Type

```typescript
interface EvalJudgeResult {
  passed: boolean;
  score: number;                   // aggregate (average of criteria scores)
  criteriaScores: Record<string, number>;
  failedCriteria: string[];
  reason: string;
}
```

### NodeContext Addition

```typescript
interface NodeContext {
  // ... existing fields
  judgeLlm?: LlmClient | null;    // new — optional, falls back to ctx.llm
}
```

### DagDef Addition

```typescript
interface DagDef {
  // ... existing fields
  evalJudges?: readonly EvalJudgeNodeDef[];  // new — separate from nodes
}
```

## Executor Integration

1. Topo sort excludes eval-judge nodes from normal wave scheduling
2. After output node completes successfully, executor runs all eval judges in parallel
3. Executor assembles judge input: `{ input: dagInput, output: outputNodeResult }`
4. If any judge returns `passed: false`, executor marks root OTel span status = ERROR
5. Judge results attached to span as attributes (for observability)
6. DAG returns output node's result unchanged — judge doesn't alter it
7. If judge LLM call fails (network, timeout), log warning and default to `passed: true`

## Prompt Architecture

Three-layer structure:

### Layer 1 — System Frame (framework-owned)

```
You are a quality evaluation judge. You will receive an input that was given
to a system, and the output it produced. Evaluate the output against the
provided criteria.

Respond with JSON matching this schema:
{
  "score": <float 0.0-1.0>,
  "criteria_scores": { "<criterion>": <float>, ... },
  "failed_criteria": ["<criterion>", ...],
  "reason": "<1-2 sentence explanation>"
}
```

### Layer 2 — Rubric (user-owned)

Loaded from `ctx.prompts` via `rubricTemplateId`, or provided inline, or auto-generated from criteria names.

Example user rubric:
```
Evaluate against these criteria:
- Factuality: All claims must be traceable to the source material
- Relevance: Output addresses the core topic, no tangents
- Completeness: All key points from the input are represented
```

### Layer 3 — Instance (framework-assembled at runtime)

```
Input:
{dagInput}

Output:
{outputNodeResult}
```

### Template Resolution Order

1. `rubricTemplateId` set → load from `ctx.prompts`
2. `rubricInline` set → use directly
3. Neither → auto-generate from `criteria` array ("- {name}: scores 1.0 if fully met, 0.0 if absent")

## Tail-Sampling Integration

No changes needed to existing infrastructure:

1. Judge returns `passed: false`
2. Executor marks root OTel span status = ERROR
3. Span ends → flows into `TailSamplingExporter`
4. `extractRunSummary()` sees `status: "error"`
5. `PersistencePolicy.shouldFlush()` returns `true` (errors always persisted)
6. Trace ships to MLflow with full span data + judge scores as attributes

## Usage Example

```typescript
const summaryDag: DagDef = {
  id: "customer-summary",
  nodes: [fetchNode, transformNode, llmNode],
  edges: [
    { from: "fetch", to: "transform" },
    { from: "transform", to: "llm-summarize" },
  ],
  outputNodeId: "llm-summarize",
  evalJudges: [
    createEvalJudgeNode({
      id: "quality-check",
      criteria: ["factuality", "relevance", "completeness"],
      threshold: 0.8,
      rubricTemplateId: "summary-rubric",
    }),
  ],
};

// Bootstrap
const ctx: NodeContext = {
  llm: createLlmClient({ model: "gpt-4o" }),
  judgeLlm: createLlmClient({ model: "gpt-4o-mini" }),
  // ...
};
```

## Implementation Plan

### Files to Create

- `packages/framework/src/nodes/eval-judge.ts` — node factory + types
- `packages/framework/src/nodes/eval-judge-prompt.ts` — system frame + rubric assembly
- `packages/framework/src/__tests__/eval-judge.test.ts` — unit tests
- `packages/framework/src/__tests__/executor-eval-judge.test.ts` — integration tests

### Files to Modify

- `packages/framework/src/types/node.ts` — add `"eval-judge"` to `NodeKind`, add `EvalJudgeNodeDef`
- `packages/framework/src/types/dag.ts` — add `evalJudges?` to `DagDef`
- `packages/framework/src/types/context.ts` — add `judgeLlm?` to `NodeContext`
- `packages/framework/src/executor/executor.ts` — post-output judge execution + span marking
- `packages/framework/src/nodes/index.ts` — export new factory

### Implementation Order

1. Types (`NodeKind`, `EvalJudgeNodeDef`, `DagDef`, `NodeContext`)
2. Prompt assembly logic
3. Node factory (`createEvalJudgeNode`)
4. Executor integration
5. Tests
