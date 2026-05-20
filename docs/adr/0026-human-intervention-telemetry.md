# ADR 0026 — Human Intervention as First-Class Telemetry

**Status:** Accepted
**Date:** 2026-05-14
**Relates to:** State-Transition Observability Phase 4

## Context

Fugue's DAG runtime already records human approvals, rejections, and reroutes
as state transitions (`awaiting-human → running`, `awaiting-human → failed`,
etc.). The existing `HumanAction` discriminated union captures *what* the human
decided — but not *what they saw* when they decided it.

This gap makes several important questions unanswerable from the event log:

- "What confidence level did the model have when the human approved?"
- "Was the freshness state clean or violated when the human rerouted?"
- "Which side-effect kind was being authorized?"
- "How long did the human take to respond?"

These questions matter because human decisions are labeled-data gold for offline
calibration. A human approving a `low`-confidence node with `external-call`
side-effects and a stale witness is a qualitatively different signal than a
human approving a `high`-confidence `none` node with no witnesses. Without
colocating the decision context alongside the action, any analysis requires
brittle cross-event joins that lose atomicity and are fragile to event ordering.

Phases 1–3 built the raw material — side-effect taxonomy, bucketed confidence
with route evidence, and freshness witnesses — but that material is spread
across separate event types. Phase 4 unifies it at the moment a human acts.

## Options Considered

1. **New `HumanInterventionEvent` observer event with colocated context**
   - Pros: Single atomic event answers "what did the human see + what did they
     decide?"; no cross-event joins needed; MLflow tags enable segmentation by
     confidence source and bucket; natural extension of the observer pattern
     already used for Phases 1–3.
   - Cons: Adds a new event type to the observer contract; the `context` field
     duplicates data that exists in prior events (denormalization); payload size
     grows with the number of prior witnesses.

2. **Emit human actions as `NodeEndEvent` variants**
   - Pros: Reuses existing event type; fewer event variants to maintain.
   - Cons: Conflates machine execution with human judgment — a `NodeEndEvent`
     represents the framework completing a computation, not a human exercising
     discretion. Consumers filtering on `NodeEndEvent` would receive a mix of
     automated and manual outcomes, complicating downstream pipelines. The
     semantic mismatch would grow worse as more human-specific fields (actor,
     elapsed time, diff) are added.

3. **Separate context-lookup at query time (no colocated context)**
   - Pros: No denormalization; event payloads stay small; context is always
     "fresh" at query time.
   - Cons: Requires joining across `ConfidenceEvent`, `WitnessCapturedEvent`,
     and `NodeStartEvent` to reconstruct what the human saw. Joins are fragile
     to event ordering, especially under concurrent waves. Loses atomicity —
     the context at query time may not match the context at decision time if
     events were replayed or backfilled.

4. **Full recursive JSON Patch for `approve-with-edit` diffs**
   - Pros: Captures every nested change for complete forensic reconstruction.
   - Cons: Recursive diffing is expensive for large outputs; deeply nested
     patches are hard to read in dashboards; most human edits are shallow
     (changing a field value, not restructuring an object tree). Shallow
     object-level RFC 6902 patches cover the practical forensics use case
     without the complexity budget.

## Decision

**Introduce `HumanInterventionEvent` as a first-class observer event that
colocates the human's action with the decision context from Phases 1–3.**

### Event shape

The canonical types live in `packages/framework/src/types/events.ts`.

```ts
type HumanActionDetailed =
  | { readonly kind: "approve" }
  | {
      readonly kind: "approve-with-edit";
      readonly originalOutput: unknown;
      readonly replacedOutput: unknown;
      readonly diff: JsonPatch;    // RFC 6902, shallow object-level
    }
  | { readonly kind: "reject"; readonly reason: string }
  | { readonly kind: "reroute"; readonly targetNodeId: NodeId; readonly reason?: string };

interface HumanInterventionEvent {
  readonly type: "human-intervention";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
  readonly action: HumanActionDetailed;
  readonly actor: string;                       // defaults to "unknown"
  readonly elapsedMsSinceAwait: number;
  readonly context: {
    readonly nodeConfidence: Confidence | null;   // Phase 2 bucket + source
    /** Kind only — full SideEffectProfile on preceding NodeStartEvent. */
    readonly nodeSideEffects: SideEffectKind;     // Phase 1 taxonomy
    readonly priorWitnesses: readonly Witness[];  // Phase 3 witnesses in scope
  };
  readonly timestamp: Date;
}
```

### `actor` field: optional on `HumanAction`, required on the event

The existing `HumanAction` type returned by `onHumanReview` hooks does not
include an `actor` field. Adding it as required would break every existing hook
implementation. Instead:

- `HumanAction` gains an optional `actor?: string` field.
- `HumanInterventionEvent` requires `actor` and defaults to `"unknown"` when
  the hook omits it.
- Production deployments should always supply `actor` for audit compliance.

### `approve-with-edit` diff format

Edits are captured as RFC 6902 JSON Patch operations at the shallow object
level (top-level keys only). The framework does not recurse into nested objects.
This is sufficient for the primary use case — forensic analysis of what the
human changed — without the complexity of recursive structural diffing.

### Emission site

The executor emits `HumanInterventionEvent` in the `awaiting-human` and
`retrying-hook` branches, immediately after `callHumanReviewHook` returns the
human's action. At this point all context fields are in scope:

- `nodeConfidence` from the node's `ConfidenceResult` (Phase 2).
- `nodeSideEffects` from `NodeDef.sideEffects` (Phase 1).
- `priorWitnesses` from the run's `WitnessCapturedEvent` history (Phase 3).

### MLflow tags

Each `HumanInterventionEvent` maps to four MLflow tags:

| Tag | Value |
|---|---|
| `mlflow.human.action` | `HumanActionKind` string |
| `mlflow.human.actor` | `actor` string |
| `mlflow.human.confidence_bucket_at_intervention` | `high \| medium \| low \| unknown \| null` |
| `mlflow.human.confidence_source_at_intervention` | confidence source string or `null` |

These tags enable MLflow queries like "show all human rejections where the model
reported high confidence" — the core offline calibration workflow.

### What's on the framework vs. the hook author

| Concern | Owner |
|---|---|
| Returning `HumanAction` (with optional `actor`) | Hook author |
| Assembling `HumanInterventionContext` from Phases 1–3 data | Framework |
| Emitting `HumanInterventionEvent` | Framework |
| Computing `elapsedMsSinceAwait` | Framework |
| Computing shallow JSON Patch for `approve-with-edit` | Framework |
| Setting MLflow tags | Framework (via `BufferedObserver`) |

## Consequences

**Positive:**
- Operators can answer "what did the human see when they approved?" from a
  single event — no cross-event joins required.
- MLflow queries can segment human interventions by confidence source, bucket,
  side-effect kind, and actor.
- The `context` field is the payoff for Phases 1–3: side-effects, confidence,
  and freshness data are colocated with the human decision in one atomic event.
- Human-edited outputs are captured with their diff, creating training data for
  offline analysis of model-vs-human disagreement.
- `elapsedMsSinceAwait` enables latency analysis of the human review bottleneck.

**Negative:**
- The `context` field denormalizes data from prior events. If the canonical
  event shapes change (e.g., `Witness` gains a field), `HumanInterventionEvent`
  must be updated to match.
- Event payload size grows with the number of prior witnesses. For nodes with
  many upstream reads, this could approach the per-event size cap (64 KB).
  Mitigation: witnesses are small (kind + resource + opaque string), so this
  is unlikely in practice.
- The `actor` default of `"unknown"` means audit logs may contain uninformative
  entries until all hook implementations are updated. This is an intentional
  tradeoff for backwards compatibility.
- Shallow JSON Patch intentionally loses deep structural diffs. If forensic
  needs evolve to require recursive diffing, the patch format will need to be
  versioned or extended.
