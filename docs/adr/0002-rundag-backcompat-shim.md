# ADR 0002: `runDag` becomes a back-compat shim, not a rewrite

**Status:** Accepted
**Date:** 2026-05-09
**Spec ref:** SC-001 (`.claude/specs/2026-05-08-durable-state-machine-runtime/spec.md`)
**Related:** ADR 0001 (single-package layout), ADR 0007 (state-machine model boundary).

## Context

The durable state-machine runtime introduces a `Machine<DagPhase, DagEvent, DagMachineContext>` plus a `JobLike`-backed event loop (`runStateMachine`). Existing callers do not know about jobs, phases, or events — they call the original `runDag(def, opts)` and depend on its observable surface:

- A single OTel root span wrapping the run, with the legacy attribute set.
- An observer event stream of `run-start`, `run-end`, `node-start`, `node-end`, `node-error`, `node-skipped`.
- Background eval-judge nodes whose lifecycle goes through `onBackground`.
- `RunOptions.resume` semantics for restart-from-checkpoint on the legacy executor.
- The exact return shape from `runDag` (results map plus run metadata).

SC-001 is explicit: the existing executor test suite must pass with **zero source modifications**. Any call site or test that exercises `runDag(def, opts)` today must keep working byte-for-byte.

The forces:

- We need new behavior (durable state, hook-crash retry, jobLike-backed resume, retry limits) reachable from the same entry point so users adopt it without rewriting call sites.
- We cannot afford silent semantic drift on the legacy path — the test suite is the oracle for "did we break anything?", and that oracle only works if the legacy path is the *same code* it always was.
- A flag-gated rewrite would mean every legacy call still flows through the new machine, which moves the oracle from "is the diff small?" to "did we re-implement correctly?" — a much harder thing to verify.

## Options Considered

1. **Dual-path shim (chosen).** `runDag` keeps its exported signature. Internally it routes: legacy callers hit `runDagInner` (the existing body, untouched); new-feature callers hit `runDagStateful`, which builds an in-memory `JobLike`, compiles `DagDef` into a `Machine`, and drives it via `runStateMachine`.
   - Pros:
     - Legacy path is the *same code path* it always was — bit-identical semantics, no oracle problem.
     - New path is reached only when caller opts in via `opts.jobLike`, `opts.onHumanReview`, or `opts.retryLimits`. Adoption is incremental.
     - SC-001 is satisfied trivially: tests that don't pass those opts never hit new code.
     - Fits the public surface — no new exported entry point to teach users about.
   - Cons:
     - Two execution paths to maintain. Bug fixes must be considered for both.
     - Routing rule is implicit; a reader has to grep `runDag` to find it.
     - Some features (e.g. retry limits) are not available on the legacy path; mixing them with `resume` requires explicit guards.

2. **Parallel `runDagDurable` export.** Add a new entry point alongside `runDag`. Leave `runDag` untouched.
   - Pros: Cleanest separation. No routing logic. Legacy path is provably untouched.
   - Cons: Existing call sites never get the new behavior unless they migrate. Bloats the public surface with two near-identical functions. Defeats the "drop-in upgrade" goal — you'd have to change every call site to opt in to durability.

3. **Big-bang rewrite of `runDag` body.** Replace the implementation with a single state-machine path; reproduce legacy observable behavior on top of it. Optionally gate with a flag.
   - Pros: One execution path. Future maintenance is uniform.
   - Cons: SC-001 becomes a re-implementation correctness proof. Every test failure on the legacy path is now an open question — "is this a bug we introduced or a clarification of undocumented behavior?" Risk of silent drift in span attributes, observer event ordering, eval-judge lifecycle, background semantics. Too risky for a refactor whose explicit goal is zero behavioral change for existing callers.

## Decision

**`runDag` stays a back-compat shim that routes to `runDagInner` (legacy) or `runDagStateful` (new) based on opts; legacy observable behavior is preserved bit-for-bit.**

Concretely, in `packages/framework/src/executor/executor.ts`:

- `runDag(def, opts)` keeps its exported signature and return type.
- Routing rule, evaluated at the top of `runDag`:
  - If `opts.jobLike` is unset **and** `opts.onHumanReview` is unset **and** `opts.retryLimits` is unset → call `runDagInner(def, opts)` — the legacy fast path, unchanged.
  - Otherwise → call `runDagStateful(def, opts)`, which constructs an in-memory `JobLike`, compiles the DAG into a `Machine<DagPhase, DagEvent, DagMachineContext>`, and drives it via `runStateMachine`.
- Mixing `opts.resume` with `opts.jobLike` is rejected at the boundary with an explicit error. Resume on the legacy path uses the existing checkpoint format; resume on the stateful path uses the job's persisted phase state. Bridging the two is out of scope.
- The legacy path's OTel root span, observer event ordering, eval-judge background scheduling, and `onBackground` semantics are guaranteed by *not modifying `runDagInner`*. There is no re-implementation to drift.
- The new path emits the same observer event vocabulary (`run-start`, `run-end`, `node-start`, etc.) by translating `DagEvent` transitions in `runDagStateful`. Tests that subscribe to the observer surface work on both paths.

This shim was introduced in T6 of the implementation plan. AD-7 covers the `JobLike` boundary that the stateful path depends on.

## Consequences

**Positive:**

- SC-001 holds by construction: legacy callers execute legacy code. The test suite passing is evidence the legacy path is unchanged, not evidence that we faithfully re-implemented it.
- Users adopt new behavior incrementally — pass `jobLike` to get durability, supply `onHumanReview` to get HITL, supply `retryLimits` to get bounded retries. No call-site rewrites required.
- New features (hook-crash retry, durable resume, retry budgets) are reachable through the existing public API. No second entry point to document or teach.
- The routing rule is a small, mechanical predicate — easy to audit and easy to extend (a future opt would add one more disjunct).

**Negative:**

- Two execution paths. A bug that exists on both must be fixed twice; a bug that exists on only one must be diagnosed against the routing rule first.
- The routing predicate is implicit knowledge — a reader debugging "why didn't my retry limit apply?" needs to know that omitting `retryLimits` keeps them on the legacy path.
- `runDagInner` accumulates the label "legacy" but is still load-bearing. We accept that it will outlive the migration and may need a deprecation plan if/when the stateful path reaches feature parity.
- Resume + jobLike rejection is a sharp edge. Callers who want durable resume on a job-backed run get an error, not silent fallback. We prefer the loud failure.
- `onBackground` is rejected on the state-machine path (eval-judge background scheduling is Phase 5 work). Callers that supply both `onBackground` and any state-machine opt receive an explicit error.

## Rejected alternatives

1. **Parallel `runDagDurable` export.** Rejected — bloats the public surface and prevents existing call sites from picking up new behavior without migration. Defeats the drop-in goal.

2. **Big-bang rewrite of `runDag` body.** Rejected — turns SC-001 into a re-implementation correctness proof. Span attributes, observer ordering, and eval-judge background semantics are subtle enough that we do not trust a rewrite to preserve them silently. The dual-path shim is the cheaper oracle.
