---

# Plan: State-Transition Observability

**Created:** 2026-05-13
**Status:** Draft
**Goal:** Promote Fugue from "structured traces" to "state-transition observability" — so that for any production failure, an operator can answer *why the system believed the next step was safe* directly from the event log, without joining across separate events or guessing.

---

## Motivation

Fugue today is a Level-2 observability system: every event carries `runId`, errors are categorized via `FrameworkError`, replay folds the event log through pure state transitions, and OTel + MLflow surfaces give per-node input/output snapshots. This catches *what* happened and *in what order*.

It does not catch the most common class of agentic failure: **a step acts on a belief produced by an upstream step, and that belief has quietly gone stale or was undersupported by evidence**. The bug lives in the boundary between steps, not in any single step's code.

Four primitives close the gap:

1. **Decision evidence** colocated with routing decisions — see the upstream output that triggered each predicate, not just which predicate fired.
2. **Confidence as a typed, bucketed channel** — every node declares a confidence policy; the canonical currency is a semantic bucket (`high | medium | low | unknown`) with declared provenance, *not* a raw float. Numeric values (logprobs, classifier probabilities) are allowed as the underlying signal but get bucketed at the framework boundary. Predicates gate on buckets, dashboards segment calibration by source.
3. **Side-effects taxonomy** — every node declares whether it reads, writes, or makes external calls; the taxonomy is required, not optional.
4. **Freshness witness contract** — reads emit witnesses, writes declare which witness they are conditioned on, framework detects skew in the event log and emits violation events.
5. **`HumanInterventionEvent`** as a first-class observer event with context drawn from the above three.

The end goal: for any production failure, a single query against the event log answers
- Which step's belief broke down?
- Was the model uncertain at the handoff?
- What did this run mutate?
- Did the world change between read and write?
- Did a human gate this decision, and what did they see?

---

## Scope

This is a **greenfield API change**. No backwards-compatibility shims. Breaking changes to:
- `RouteDecidedEvent` shape
- `NodeDef` shape (required `confidence` and `sideEffects` fields; refined for reads/writes nodes)
- `Predicate` shape (now an object with `label`, `check`, optional `minConfidence`)
- `Observer` interface (new `onHumanIntervention` method; renamed event variants)
- `ObserverEvent` union (three new variants for freshness)

Out of scope:
- Confidence calibration tooling (downstream MLflow concern)
- Failure-category time-series dashboards (existing `FrameworkError.kind` is sufficient; aggregation belongs in Grafana)
- Resource exhaustion / latency-budget observability (OTel's existing job)

---

## Current Architecture Reference

For each phase below, the key code locations the change touches.

| Concern | File | Lines |
|---|---|---|
| `ObserverEvent` union | `packages/framework/src/types/events.ts` | 108–117 |
| `RouteDecidedEvent` | `packages/framework/src/types/events.ts` | 86–97 |
| `NodeStart/End/Error/SubSpanEvent` | `packages/framework/src/types/events.ts` | 13–75 |
| `NodeDef` | `packages/framework/src/types/node.ts` | 178–206 |
| `HumanAction` | `packages/framework/src/dag-runtime/types.ts` | 12–16 |
| Human resolution | `packages/framework/src/dag-runtime/human-resolution.ts` | 18–51 |
| `withNodeSpan` (OTel wrap) | `packages/framework/src/dag-runtime/node-span.ts` | 69–129 |
| OTel semantic conventions | `packages/framework/src/tracing/semantic-conventions.ts` | (full file) |
| MLflow OTLP exporter | `packages/framework/src/tracing/mlflow-otlp-exporter.ts` | (full file) |
| `RouteDecidedEvent` emission | `packages/framework/src/dag-runtime/executor.ts` | (route emit site in `runWave`) |
| Observer interface | `packages/framework/src/observer/observer.ts` | 14–36 |
| Observer dispatch | `packages/framework/src/observer/buffered.ts` | 41–86 |
| `RecordedEvent` envelope | `packages/framework/src/state-machine/types.ts` | 70–84 |
| Replay | `packages/framework/src/state-machine/replay.ts` | — |
| `FrameworkError` union | `packages/framework/src/types/errors.ts` | 5–84 |

---

## Phase ordering and rationale

Recommended order: **Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5.**

- Phase 1 (`sideEffects` taxonomy) is the smallest and unblocks Phase 3's `resource` matching.
- Phase 2 (route evidence + confidence) is standalone and useful immediately; defines the predicate shape Phases 3 and 5 reuse.
- Phase 3 (freshness witness) depends on `sideEffects.resource` from Phase 1.
- Phase 4 (`HumanInterventionEvent`) capstones with context fields from Phases 1, 2, 3.
- Phase 5 is documentation, ADRs, MLflow exporter polish.

Each phase is independently shippable; each PR keeps CI architectural boundary checks (transport-agnostic kernel) intact.

---

## Phase 1 — `sideEffects` taxonomy (required declaration)

### New types

```ts
// packages/framework/src/types/side-effects.ts (new file)
export type SideEffectKind = "none" | "reads" | "writes" | "external-call";

export type SideEffectProfile =
  | { readonly kind: "none"; readonly resource?: undefined }
  | { readonly kind: "reads"; readonly resource: string }
  | { readonly kind: "writes"; readonly resource: string; readonly idempotencyKey?: (input: unknown) => string }
  | { readonly kind: "external-call"; readonly resource: string; readonly idempotencyKey?: (input: unknown) => string };
```

The discriminated union enforces that `resource` is mandatory when `kind !== "none"` at the type level. `idempotencyKey` is a callback because the input type at definition site is `I` — the field is invoked at run time inside `withNodeSpan`.

### `NodeDef` extension

Add a required field:

```ts
// packages/framework/src/types/node.ts
export interface NodeDef<I, O, ...> {
  // ... existing fields ...
  readonly sideEffects: SideEffectProfile;
}
```

### Event propagation

Add `sideEffects: SideEffectProfile` to:
- `NodeStartEvent`
- `NodeEndEvent`
- `NodeErrorEvent`

Executor already has the `NodeDef`; thread the field through to the emit sites.

### OTel attributes

Add to `tracing/semantic-conventions.ts`:

```ts
export const AI_NODE_SIDE_EFFECTS_KIND = "ai.node.side_effects.kind";
export const AI_NODE_SIDE_EFFECTS_RESOURCE = "ai.node.side_effects.resource";
export const AI_NODE_IDEMPOTENCY_KEY = "ai.node.idempotency_key";
```

Set inside `withNodeSpan` (node-span.ts:69–129). Idempotency key evaluated lazily at span start if present; cached on the span attributes for downstream exporters.

### MLflow exporter

Promote `sideEffects.kind === "writes" | "external-call"` to a top-level `mlflow.side_effects` MLflow tag for run-level filterability.

### Tests

- `__tests__/node-side-effects-propagation.test.ts` — kind survives through start/end/error events; OTel attrs set; idempotency callback invoked exactly once.
- Type-level test: `kind: "writes"` without `resource` is a compile error.

### Estimated diff

~120 LoC + ~80 LoC tests. No new event variants.

---

## Phase 2 — Route evidence with bucketed confidence

### Why bucketed, not numeric

LLM-emitted numeric self-confidence is well-documented to be miscalibrated: bunching around round numbers (0.7/0.8/0.9), distorted by RLHF, and correlating worse with accuracy than verbal categories (Tian et al. "Just Ask for Calibration", 2023, and follow-up work). The framework should not enshrine `number` as the canonical handoff currency.

Instead, the framework currency is a **semantic bucket with declared provenance**. Raw numeric values are kept for forensics but never compared directly; predicates gate on bucket ordering.

### New types

```ts
// packages/framework/src/types/confidence.ts (new file)
export type ConfidenceBucket = "high" | "medium" | "low" | "unknown";

export type ConfidenceSource =
  | "self-reported-bucket"      // LLM picked from {high, medium, low}
  | "self-reported-numeric"     // LLM emitted a number — least trusted, requires explicit bucketing
  | "logprob"                   // token-level softmax over closed-domain answer
  | "classifier-probability"    // dedicated calibrated classifier
  | "ensemble-agreement"        // N/M samples agreed
  | "heuristic";                // deterministic rule

export interface Confidence {
  readonly bucket: ConfidenceBucket;
  readonly source: ConfidenceSource;
  readonly raw?: number | string;        // original value, forensics only — never compared by framework
}

// Total ordering for predicate gating
export const CONFIDENCE_ORDER: Readonly<Record<ConfidenceBucket, number>> = {
  high: 3, medium: 2, low: 1, unknown: 0,
};

// Bucketing helpers exported under packages/framework/src/sugar/confidence-buckets.ts
export const bucketFromProbability = (
  p: number,
  thresholds: { high: number; medium: number } = { high: 0.85, medium: 0.6 },
): ConfidenceBucket => p >= thresholds.high ? "high" : p >= thresholds.medium ? "medium" : "low";
```

The `thresholds` defaults are intentionally opinionated and overridable per node. Documented in the README.

### Route evidence shape

```ts
// packages/framework/src/types/events.ts (replaces existing RouteDecidedEvent)
export interface RouteEvidence {
  readonly upstreamOutput: unknown;
  readonly upstreamConfidence: Confidence | null;       // null only when node opted out
  readonly predicateResults: ReadonlyArray<{
    readonly predicateLabel: string;
    readonly matched: boolean;
    readonly evaluatedConfidence: Confidence | null;
    readonly errorKind?: "malformed" | "threw" | "below-min-confidence";
  }>;
  readonly decidedAtMs: number;
}

export interface RouteDecidedEvent {
  readonly type: "route-decided";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly fromNodeId: NodeId;
  readonly chosenTargets: readonly NodeId[];
  readonly prunedTargets: readonly NodeId[];
  readonly defaultTaken: boolean;
  readonly evidence: RouteEvidence;
  readonly timestamp: Date;
}
```

`matchedPredicate` field is removed — `predicateResults` is authoritative.

### Confidence as a typed channel on `NodeDef`

```ts
// packages/framework/src/types/node.ts
export type ConfidenceMode<O> =
  | { readonly mode: "none" }
  | { readonly mode: "value"; readonly extract: (output: O) => Confidence };

export interface NodeDef<I, O, ...> {
  // ... existing fields ...
  readonly confidence: ConfidenceMode<O>;
}
```

No silent nulls. The author either declares `mode: "none"` (explicitly opting out) or supplies an extractor that returns a `Confidence` object including the source. The framework never coerces a bare number into a confidence value.

For LLM-self-reporting nodes, the recommended pattern is to have the LLM output one of `{high, medium, low}` directly in its structured response, so `extract` is a pass-through and `source: "self-reported-bucket"`. For classifier nodes, the extractor calls `bucketFromProbability(p)` and sets `source: "classifier-probability"`. For deterministic guardrails, `source: "heuristic"` with `bucket: "high"`.

### Predicate shape change

```ts
// packages/framework/src/types/predicate.ts
export interface Predicate<T> {
  readonly label: string;                                                  // required
  readonly check: (value: T, confidence: Confidence | null) => boolean;
  readonly minConfidence?: ConfidenceBucket;                                // framework short-circuits
}
```

Framework owns the threshold check, comparing buckets via `CONFIDENCE_ORDER`. If upstream confidence bucket is below `minConfidence`, the predicate is recorded as `{ matched: false, errorKind: "below-min-confidence" }` and the route is not taken. The recorded evidence shows the bucket and source, not just a number — so dashboards can answer "are our self-reported-numeric predicates below threshold more often than our logprob predicates?"

### Producer changes

In `dag-runtime/executor.ts` (route emit site), `decideRoute` must now return:

```ts
type RouteDecision = {
  readonly chosenTargets: NodeId[];
  readonly prunedTargets: NodeId[];
  readonly defaultTaken: boolean;
  readonly predicateResults: RouteEvidence["predicateResults"];
  readonly upstreamOutput: unknown;
  readonly upstreamConfidence: Confidence | null;
};
```

The executor extracts `upstreamConfidence` by calling the upstream node's `confidence.extract(output)` if `mode === "value"`, else `null`.

### MLflow exporter

Map `evidence.upstreamOutput` to `spanInputs.route_evidence`. Map `upstreamConfidence` to **two** MLflow tags (not one numeric):
- `mlflow.route.confidence_bucket` — `"high" | "medium" | "low" | "unknown"`
- `mlflow.route.confidence_source` — the source enum

This is the calibration-segmentation payoff: you can now group dashboard panels by source and see which sources are well-calibrated and which aren't.

### Tests

- `__tests__/route-decided-evidence.test.ts`: default-taken, single-match, multi-match, predicate-malformed, below-min-confidence (per bucket) cases.
- Update `predicate-malformed-event-sequence.test.ts` — evidence records the throw.
- `__tests__/confidence-bucket-ordering.test.ts` — `CONFIDENCE_ORDER` total ordering invariants (property test).
- Type-level tests: `Predicate<T>` rejected without `label`; `confidence.extract` must return `Confidence`, not bare `number`.

### Estimated diff

~250 LoC + ~180 LoC tests.

---

## Phase 3 — Freshness witness contract

This is the largest phase and the highest-value one. The framework cannot mint witness values (those are domain-specific), but it can **define the schema, require the extractors at definition time, and detect skew during replay**.

### New types

```ts
// packages/framework/src/types/freshness.ts (new file)
export type WitnessKind =
  | "version"          // monotonic integer (Hibernate @Version, Mongo __v)
  | "etag"             // hash-based (HTTP, S3, DynamoDB)
  | "timestamp"        // ms-precision timestamp (poor man's version)
  | "lsn"              // log sequence number (Postgres WAL)
  | "idempotency-key"  // request-scoped (Stripe, Plaid)
  | "custom";

export interface Witness {
  readonly kind: WitnessKind;
  readonly resource: string;     // must match NodeDef.sideEffects.resource
  readonly value: string;        // opaque to the framework
}
```

### `NodeDef` refinement for reads/writes

Discriminated by `sideEffects.kind`:

```ts
// packages/framework/src/types/node.ts
export type NodeDef<I, O, ...> =
  | NodeDefBase<I, O, ...> & { sideEffects: { kind: "none" | "external-call"; ... } }
  | NodeDefBase<I, O, ...> & {
      sideEffects: { kind: "reads"; resource: string };
      extractWitness: (output: O) => Witness;
    }
  | NodeDefBase<I, O, ...> & {
      sideEffects: { kind: "writes"; resource: string; idempotencyKey?: ... };
      extractConditionedOn: (input: I) => Witness;
      extractNewWitness: (output: O) => Witness;
    };
```

The extractors are required at definition time when the node reads or writes. The author writes a one-liner like `extractWitness: (output) => ({ kind: "version", resource: "postgres:refunds:555", value: String(output.row.xmin) })`.

### New event variants

Add to `ObserverEvent`:

```ts
export interface WitnessCapturedEvent {
  readonly type: "witness-captured";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
  readonly witness: Witness;
  readonly capturedAtMs: number;
  readonly timestamp: Date;
}

export interface WriteAttemptedEvent {
  readonly type: "write-attempted";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
  readonly conditionedOn: Witness;
  readonly newWitness: Witness;
  readonly succeededAtMs: number;
  readonly timestamp: Date;
}

export interface FreshnessViolationEvent {
  readonly type: "freshness-violation";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
  readonly resource: string;
  readonly conditionedOnWitness: Witness;
  readonly conflictingWrite: {
    readonly runId: RunId;
    readonly nodeId: NodeId;
    readonly newWitness: Witness;
    readonly succeededAtMs: number;
  };
  readonly detectedAtMs: number;
  readonly timestamp: Date;
}
```

Update the `Observer` interface with `onWitnessCaptured`, `onWriteAttempted`, `onFreshnessViolation`. Update `dispatchEvent` switch.

### Runtime contract

1. After every `reads` node completes, executor invokes `extractWitness(output)` and emits `WitnessCapturedEvent`.
2. Before every `writes` node executes, executor invokes `extractConditionedOn(input)` and queries the event log: "between any prior `WitnessCapturedEvent` whose witness matches `conditionedOn` and now, has any `WriteAttemptedEvent` for the same `resource` succeeded?"
3. If yes → emit `FreshnessViolationEvent`. The node still runs; the policy of "abort vs proceed on violation" is owned by the node author via routing on `freshness-violation` events.
4. After write succeeds, executor invokes `extractNewWitness(output)` and emits `WriteAttemptedEvent`.

### Event-log indexing

Cross-run freshness detection requires an index. Add to `checkpoint/redis-checkpointer.ts`:

```
fugue:freshness:{resource} → ZSET of (succeededAtMs, "{runId}:{nodeId}:{newWitness.value}")
```

Updated atomically with `WriteAttemptedEvent` emission. The freshness check is then a `ZRANGEBYSCORE` over the time window since `conditionedOn` was captured.

Single-process fallback: in-memory map of `resource → write events`, scoped to the active run set.

### New file: `dag-runtime/freshness-check.ts`

Hosts the cross-run scan logic. Pure module that takes an event log reader and returns a `FreshnessCheckResult`. Tested in isolation with synthetic event sequences.

### Tests

- `__tests__/freshness-witness-no-conflict.test.ts` — single read, single write, no other writes.
- `__tests__/freshness-witness-conflict-detected.test.ts` — interleaved runs producing a violation.
- `__tests__/freshness-witness-cross-process.test.ts` — Redis-backed, two simulated workers.
- `__tests__/freshness-extraction-types.test.ts` — type-level test: a `writes` node without `extractConditionedOn` fails compilation.
- Property test (fast-check): for any sequence of read/write events, the violation set computed by the framework equals the set computed by a reference impl.

### ADR

ADR-0024: Freshness Witness Contract. Documents:
- Why this is feasible in Fugue (DAGs declared, event log authoritative).
- What's on the node author vs. the framework.
- The cost (Redis secondary index, one extra round-trip per write).
- Why not distributed locks (slower, doesn't give you the audit log).

### Estimated diff

~450 LoC framework + ~300 LoC tests + ADR.

---

## Phase 4 — `HumanInterventionEvent`

### New event variant

```ts
// packages/framework/src/types/events.ts
export type HumanActionDetailed =
  | { readonly kind: "approve" }
  | { readonly kind: "approve-with-edit"; readonly originalOutput: unknown; readonly replacedOutput: unknown; readonly diff: JsonPatch }
  | { readonly kind: "reject"; readonly reason: string }
  | { readonly kind: "reroute"; readonly targetNodeId: NodeId; readonly reason: string };

export interface HumanInterventionEvent {
  readonly type: "human-intervention";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
  readonly action: HumanActionDetailed;
  readonly actor: string;                              // required
  readonly elapsedMsSinceAwait: number;
  readonly context: {
    readonly nodeConfidence: Confidence | null;          // from Phase 2 — bucket + source, not raw number
    readonly nodeSideEffects: SideEffectKind;             // from Phase 1
    readonly priorWitnesses: readonly Witness[];          // from Phase 3 — the freshness state the human saw
  };
  readonly timestamp: Date;
}
```

The `context` field is the payoff for Phases 1–3 happening first. A human approval now captures *what the human saw* — model confidence, side-effects being authorized, freshness state of involved resources. This is labeled-data gold for offline analysis.

### Observer interface

Add `onHumanIntervention(e: HumanInterventionEvent): void`. Update `dispatchEvent`.

### Emission site

In `dag-runtime/human-resolution.ts:18-51`, `handleHumanResponse`:
1. Translate the inbound `HumanAction` to `HumanActionDetailed`. For `approve-with-edit`, compute the `JsonPatch` between original and replaced output.
2. Capture `elapsedMsSinceAwait` from the awaiting-human state timestamp.
3. Pull `context.nodeConfidence` from the upstream `NodeEndEvent` (or compute via `confidence.extract`).
4. Pull `context.nodeSideEffects` from the node's `sideEffects.kind`.
5. Scan recent `WitnessCapturedEvent`s for the run to populate `context.priorWitnesses`.
6. Emit `HumanInterventionEvent`. Then proceed with existing state mutation.

### MLflow exporter

Map intervention events to MLflow tags:
- `mlflow.human.action` (kind)
- `mlflow.human.actor`
- `mlflow.human.diff` (for approve-with-edit, the JsonPatch as JSON)
- `mlflow.human.confidence_bucket_at_intervention`
- `mlflow.human.confidence_source_at_intervention`

Enables queries like "show me all runs a human edited" and "show me runs where humans intervened at confidence_bucket = 'low' grouped by confidence_source" — useful for finding which confidence-emitting nodes are systematically miscalibrated.

### Tests

- `__tests__/human-intervention-event.test.ts` — each `HumanActionDetailed` variant fires; context populated correctly.
- `__tests__/human-intervention-diff.test.ts` — JsonPatch diff is correct for nested edits.
- `__tests__/observer-port-completeness.test.ts` — extend to require `onHumanIntervention`.

### ADR

ADR-0025: Human Intervention as First-Class Telemetry. Documents the why and the context-field rationale.

### Estimated diff

~180 LoC + ~140 LoC tests + ADR.

---

## Phase 5 — Documentation and exporter polish

- Update root README with the five new primitives and a worked example showing the full event log for a refund pipeline with a freshness violation and a human override.
- README section: "Patterns for node authors" covering how to fill in `sideEffects`, `confidence`, `extractWitness`, `extractConditionedOn`.
- Add a `docs/observability/state-transitions.md` document with the dashboard queries that exploit the new schema (MLflow SQL examples).
- MLflow exporter: refine the SpanAttributeRegistry side-channel to handle the new attribute objects without bloating attribute counts.

### Estimated diff

~80 LoC + ~600 LoC docs.

---

## Risks and tradeoffs

| Risk | Mitigation |
|---|---|
| Phase 3 freshness check adds a Redis round-trip per write. | Make it pluggable. Default to in-memory single-process; opt in to Redis-backed cross-process. Documented in ADR-0024. |
| Required `sideEffects`, `confidence`, `extractWitness` fields raise the cost of writing a node. | Provide `defineSimpleNode()` helpers in `packages/framework/src/sugar/` that fill in `sideEffects: { kind: "none" }`, `confidence: { mode: "none" }` for the trivial case. Authors only pay the cost when they have side effects to declare. |
| Event payload size grows (evidence.upstreamOutput, witnesses). | Reuse the existing `withNodeSpan` redaction policy with a configurable size cap. Default 64 KB per event. |
| Predicate shape change breaks every existing DAG. | Greenfield. Acknowledged in CHANGELOG; ADR-0026 documents the new shape (including bucket-based confidence). |
| Bucket thresholds (high/medium/low boundaries) are opinionated. | Defaults in `bucketFromProbability` are overridable per node. ADR-0027 documents the rationale and the calibration workflow for tuning thresholds against MLflow-observed outcomes. |
| Cross-run freshness detection has correctness boundaries (eventual consistency in Redis, etc.). | Document the consistency model in ADR-0024. Property tests pin the contract. |

---

## Deliverables

- 5 PRs (one per phase)
- ADRs: 0024 (freshness), 0025 (human intervention), 0026 (predicate shape change), 0027 (bucketed confidence and calibration workflow)
- README + `docs/observability/state-transitions.md`
- New test files listed under each phase

---

## Acceptance criteria

A new operator joining the team should be able to:

1. Take any production run from the event log.
2. Within 5 minutes, answer all five questions in the goal section using only the event log + MLflow UI.
3. Without grepping source code or asking the original author.

This is the "Level 3 observability" bar. Today Fugue is around 70% of it; the four phases together push to ~95%.
