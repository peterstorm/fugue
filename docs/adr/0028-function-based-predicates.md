# ADR 0028: Function-based predicates with confidence gating

**Status:** Accepted
**Date:** 2026-05-16
**Supersedes:** ADR 0016 (structural-match predicates)
**Related:** ADR 0015 (conditional edges), ADR 0027 (confidence calibration)

## Context

ADR 0016 proposed replacing closure-typed guards with **structural-match predicates** — pure data values (`{ [K in keyof O]?: O[K] | { oneOf: ... } }`) that would be serializable, hashable, and inspectable. While the data-only approach solved replay determinism and fingerprinting, it imposed an expressivity squeeze: authors needing boolean composition, range checks, or multi-field logic had to add classifier nodes upstream.

During implementation, the confidence-gating requirement (ADR 0027) introduced a cross-cutting concern: predicates need access to the upstream node's confidence signal to short-circuit routing when confidence is below a threshold. Structural-match predicates cannot express `minConfidence` gating — it's a framework concern layered on top of the data match.

Additionally, the "classifier node" workaround for complex predicates adds authoring burden and topology complexity for what is often a one-line boolean check.

## Decision

Replace the structural-match predicate (ADR 0016) with a **function-based predicate** carrying metadata for fingerprinting and evidence:

```ts
export interface Predicate<T> {
  readonly label: string;
  readonly version: number;
  readonly check: (value: T, confidence: Confidence | null) => boolean;
  readonly minConfidence?: ConfidenceBucket;
}
```

### Key properties

1. **`label`** — Human-readable identifier for the predicate. Appears in `RouteEvidence.predicateResults` and observer events. Must be non-empty (validator rejects empty labels).

2. **`version`** — Author-maintained integer. Included in `dagFingerprint` via `${label}:${version}`. When predicate logic changes, the author bumps `version` — this invalidates cached checkpoints, solving the fingerprint-stability problem that ADR 0016 identified with closures.

3. **`check`** — The predicate function. Receives the upstream output and the upstream confidence signal. Returns `boolean`. May throw — `evaluatePredicate` catches exceptions and records `reason: "threw"` in evidence.

4. **`minConfidence`** — Optional confidence gate. When set, the framework short-circuits: if upstream confidence is below `minConfidence`, the predicate is recorded as `{ matched: false, reason: "below-min-confidence" }` and `check` is never called.

### Evaluation

`evaluatePredicate` is total — it never throws. It returns a structured result:

```ts
{
  predicateLabel: string;
  predicateVersion: number;
  matched: boolean;
  evaluatedConfidence: Confidence | null;
  reason?: string;  // "below-min-confidence" | "threw: ..." | undefined
}
```

### Fingerprint

Each conditional edge contributes `${from}->${to}|when:${label}:${version}` to the DAG fingerprint. This replaces ADR 0016's `stableJson(pred)` approach. The `version` field is the author's explicit contract that the predicate logic changed.

## Consequences

### Wins

- **Full expressivity.** No classifier-node workaround needed for boolean composition, range checks, or complex routing logic.
- **Confidence gating built in.** `minConfidence` is a first-class field, not a bolted-on wrapper.
- **Fingerprint safety.** The `version` field ensures checkpoint invalidation when predicate logic changes. This is an explicit author contract rather than an implicit JSON-serialization trick.
- **Evidence recording.** `evaluatePredicate` produces structured evidence with label, version, match result, and reason — visible in `RouteDecidedEvent`.
- **Edit-time type safety preserved.** `defineDag<const Nodes>(...)` parameterizes `Predicate<T>` against the actual `from`-node's output type via `EdgeDefInput`.

### Costs

- **Not serializable.** Closures don't survive `JSON.stringify` or process boundaries. Workflow definitions that must cross process boundaries need a serialization strategy (e.g., named predicate registry). This is acceptable for the current single-process execution model.
- **Not inspectable in observer events.** The `check` function appears as `[Function]` in logs. Mitigated by the `label` and `version` fields, plus the structured `predicateResults` in `RouteEvidence`.
- **Replay non-determinism is author's responsibility.** The `check` function could close over mutable state. This is a discipline contract, not a system guarantee. Property tests use random pure predicates by construction.
- **Fingerprint relies on author discipline.** If the author changes `check` logic without bumping `version`, the fingerprint won't change. This is documented and validated at definition time (version must be a non-negative integer).

### Migration from ADR 0016

ADR 0016's structural-match design was never adopted in production code. All test predicates were migrated from `{ kind: "yes" }` data shape to `{ label: "kind-is-yes", version: 1, check: (v) => v?.kind === "yes" }` function shape.
