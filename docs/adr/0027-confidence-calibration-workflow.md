# ADR-0027: Bucketed Confidence Calibration Workflow

## Status

Accepted

## Context

The framework exposes a typed `Confidence` signal with `bucket` (high / medium / low / unknown), `source` provenance, and an optional forensic `raw` value. Predicates gate on bucket ordering via `meetsConfidence`. However, the framework takes no position on how the *mapping* from raw model outputs to buckets is determined or maintained — that is a calibration concern.

Without a documented calibration workflow, teams will either:

1. Hard-code thresholds once and never revisit them, or
2. Skip confidence gating entirely because the setup cost is unclear.

Both outcomes defeat the purpose of the confidence system.

## Decision

Confidence calibration is a **segmented, offline workflow** powered by the telemetry pipeline:

### 1. Bucketing is always explicit

The framework never coerces a raw number into a bucket. Every `Confidence` value carries its `source` discriminant so calibration can be segmented — a `logprob`-sourced 0.85 has different meaning than a `self-reported-numeric` 0.85.

### 2. Calibration data flows through existing telemetry

- `RouteDecidedEvent.evidence.predicateResults` captures per-predicate evaluation with the confidence signal.
- `HumanInterventionEvent.context.nodeConfidence` captures what confidence the human reviewer saw.
- MLflow spans carry `ai.confidence.bucket`, `ai.confidence.source`, and `ai.confidence.raw` attributes.

### 3. Threshold tuning via MLflow

Teams use MLflow's experiment tracking to:

1. **Collect**: Run production traffic with broad thresholds (e.g., `minConfidence: "low"`).
2. **Segment**: Group by `source` — `logprob` thresholds are calibrated separately from `self-reported-bucket`.
3. **Measure**: For each segment, compute the false-positive rate of human overrides (reject/edit actions where confidence was "high").
4. **Adjust**: Tighten or loosen `minConfidence` per predicate based on the measured override rate.
5. **Deploy**: Update predicate definitions with new thresholds; the framework's `meetsConfidence` enforces them.

### 4. Sugar helpers for common patterns

The `sugar/confidence-buckets.ts` module provides helpers for the most common bucketing patterns (numeric thresholds, logprob ranges) so teams don't have to write raw `extract` functions.

## Consequences

- Calibration is a data-driven workflow, not a framework feature — the framework provides the signals, not the policy.
- The `source` provenance field is essential: without it, calibration conflates differently-distributed signals.
- Teams that skip calibration still get meaningful gating via the bucket ordering (`high > medium > low > unknown`).
- The `raw` field is preserved for forensics but the framework never compares raw values directly (per `types/confidence.ts` contract).
