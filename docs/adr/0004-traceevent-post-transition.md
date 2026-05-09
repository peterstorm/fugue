# ADR 0004: `TraceEvent` — single post-transition event with FROM/TO state

**Status:** Accepted
**Date:** 2026-05-09
**Spec ref:** OQ-2, FR-007, NFR-011 (`.claude/specs/2026-05-08-durable-state-machine-runtime/spec.md`)
**Related:** AD-4 (`.claude/plans/2026-05-08-durable-state-machine-runtime.md`), ADR 0001 (single-package layout).

## Context

The state-machine runtime exposes an `onTrace` observer hook so callers can build dashboards, DAG visualizers, log streams, and replay tooling without coupling to runtime internals. Spec OQ-2 left open *when* the trace fires and *what* shape its payload carries.

Three forces:

- **Visualization needs both ends of an edge.** A DAG/state-graph renderer drawing a transition `running → retrying` needs both endpoints in the same record. Splitting them across two events forces consumers to correlate by timestamp or sequence ID.
- **Hot-path cost (NFR-011).** Trace emission runs synchronously inside the transition function. Every event is overhead the runtime pays per transition. FR-007 mandates trace emission; NFR-011 caps its cost.
- **Reclaw convention.** The `state` field in reclaw-style payloads names the FROM state (the state that *was* active when the event occurred). Diverging from this surprises consumers porting integrations.

The runtime emits one transition per `event` applied via the reducer. The question: emit a `pre` event before the reducer, a `post` event after, or both?

## Options Considered

1. **Pre-only — emit before transition with `{ state, event }`.**
   - Pros: Cheapest to implement; fires even if the reducer throws.
   - Cons: No `nextState` — DAG visualizers can't render edges. No `outcome` — observers can't distinguish a successful run from a retry without re-deriving from the next event. Loses post-transition timing info.

2. **Pre + post pair — emit `{ phase: "pre" }` then `{ phase: "post", outcome }`.**
   - Pros: Symmetric; downstream filters can pick the half they want.
   - Cons: Doubles observer load on the hot path (NFR-011 violation). Forces consumers to dedup or correlate the two halves. Two events per transition complicates sequence-ID assignment and replay.

3. **Post-only — emit after transition with `{ state, event?, nextState, outcome, durationMs, timestamp }`.** **(Chosen.)**
   - Pros: One event per transition. Carries both FROM (`state`) and TO (`nextState`) so consumers needing either viewpoint are served by the same record. `outcome` discriminates success / retry / skipped / failed for log filtering. `durationMs` captures actual reducer cost. Single emission site keeps NFR-011 budget tight.
   - Cons: A reducer that throws emits no trace event for that transition (the throw bubbles). Acceptable: thrown reducer errors are runtime bugs, not observable transitions.

## Decision

**`onTrace` fires once *after* each transition with `{ state, event?, nextState, outcome, durationMs, timestamp }`.**

Field semantics:

- `state` — the state we transitioned **FROM**. Matches reclaw's convention: `state` always names the active state at the moment the event was applied.
- `nextState` — the state we transitioned **TO**. Same kind shape as `state`.
- `event` — the event that drove the transition; `undefined` when `outcome === "skipped"` (run aborted by `beforeExecute` before the executor was invoked).
- `outcome ∈ "success" | "retry" | "skipped" | "failed"` — discriminator derived from the post-transition phase:
  - `success` — normal forward progress.
  - `retry` — transitioned into a `retrying` / `retrying-hook` variant.
  - `skipped` — transition was a no-op (guard rejected, mismatched nodeId, `beforeExecute` aborted before the executor ran, etc.).
  - `failed` — transitioned into terminal `failed`.
- `durationMs` — wall-clock cost of the reducer call, measured around the pure transition.
- `timestamp` — emission time (post-transition), as a `Date`.

Emission site: `packages/framework/src/state-machine/runner.ts`, immediately after the reducer returns and before the next event is dequeued. The `TraceEvent` type lives in `packages/framework/src/state-machine/types.ts`.

No pre-transition event. No second event per transition.

## Consequences

**Positive:**

- One event per transition keeps observer integrations simple — no correlation, no dedup, no half-events.
- DAG visualizers, log streamers, and replay tools all read the same record. FROM/TO live together.
- `outcome` is a closed enum, cheap to filter on the consumer side without inspecting `nextState` shape.
- Hot-path cost stays at one synchronous callback per transition (NFR-011 budget honoured).
- Convention parity with reclaw — `state` continues to mean "FROM state" — reduces friction for ported integrations.

**Negative:**

- Reducer-thrown errors emit no trace for that transition. Observers that must see *every* attempted transition (including ones that crashed the reducer) need a separate error channel. We accept this; reducer throws are bugs, not observable runtime states.
- Consumers wanting "before" semantics (e.g. "log intent before doing the work") cannot get them from `onTrace` — they would need a different hook. None requested today; revisit if a real use case appears.
- Adding a fifth `outcome` value later (e.g. `"aborted"`) is a breaking change for consumers that pattern-match exhaustively. We accept the closed-enum tradeoff over an open string.

## Alternatives considered

See **Options Considered** above. Pre-only and pre+post both rejected for the reasons listed there. The post-only design with FROM+TO in one payload was chosen specifically because it serves both before- and after-style downstream consumers from a single event without firing twice.

## Implementation note

The `outcome` discriminator is computed from the *post-transition* phase, not from the event kind. A `retry` outcome means the runtime ended up in a retrying variant — regardless of whether the triggering event was `node-failed`, `hook-failed`, or a manual `force-retry`. This keeps the discriminator stable as new event kinds are added.
