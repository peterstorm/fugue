# ADR 0007: `runDag` legacy fast path stays one-shot; state-machine path is opt-in

**Status:** Accepted (routing predicate amended by ADR 0009 and ADR 0019; `onBackground` guard superseded by ADR 0018)
**Date:** 2026-05-09
**Spec ref:** SC-001, SC-006 (`.claude/specs/2026-05-08-durable-state-machine-runtime/spec.md`)
**Related:** ADR 0002 (back-compat shim), ADR 0009 (HITL routing), ADR 0018 (`onBackground` on SM path), ADR 0019 (current routing predicate), AD-7 in `.claude/plans/2026-05-08-durable-state-machine-runtime.md`.

> **Amendment (ADR 0009 + ADR 0019):** the routing predicate documented in this ADR (`opts.jobLike || opts.onHumanReview || opts.retryLimits`) silently dropped HITL semantics for DAGs that declared `humanReview` nodes without an `onHumanReview` hook, and missed retries / conditional-edges entirely. The predicate has been replaced by one driven by node config plus call-site opts: `dagDeclaresHITL || dagDeclaresRetries || dagDeclaresConditionalEdges || opts.jobLike || opts.retryLimits`. See ADR 0019 for the current contract; this ADR remains as the rationale for *having* a routing shim at all.
>
> **Amendment (ADR 0018):** the `onBackground` guard documented below was removed. `onBackground` is now supported on both paths and is no longer a routing trigger.

## Context

The durable state-machine runtime introduces a new execution path for DAGs: `runDagStateful` runs each wave through the state-machine kernel (`runStateMachine`), persists checkpoints via `JobLike`, and supports human-in-the-loop pauses (`onHumanReview`) and per-node retry budgets (`retryLimits`). The pre-existing `runDag` (now the body of `runDagInner`) had none of these — it was a straightforward `Promise.all`-per-wave loop with observer/OTel instrumentation.

Two pressures are in tension:

- **SC-001** says every existing executor test must pass against the new `runDag` with **zero modifications** to those tests. Existing callers don't pass `jobLike`, don't use HITL, don't configure retries — they expect the old behavior, including its perf characteristics.
- **SC-006** caps per-transition kernel overhead at <2ms p95. Routing every legacy caller through `runStateMachine` would fold a multi-node `Promise.all` wave into transition steps, multiplying overhead and changing observer/span emission ordering. That's a non-trivial regression surface for callers who never asked for durability.

The question: should the new runtime *replace* the old one (force every caller through the state machine), or should it sit *alongside* the old one (opt-in)?

A full migration of consumers ("Phase 5") was scoped out of this delivery. So the runtime needs a story for the interim — what does `runDag` do today?

## Options Considered

1. **Always route through the state-machine path.** `runDag` becomes a thin wrapper over `runDagStateful` with a synthetic in-memory `JobLike` when none is supplied.
   - Pros:
     - One code path. No feature-detection branching. Less surface to maintain.
     - Forces the new path through the full existing test suite immediately — strongest possible regression signal for the kernel.
     - No throwaway shim code; whatever ships is what stays.
   - Cons:
     - Folds a multi-node `Promise.all` wave into a transition sequence. Preserving observer/span ordering across that change is delicate — every existing observer test becomes a potential break.
     - Risks SC-006: each wave node now incurs kernel overhead, checkpoint serialize/deserialize (even against a no-op `JobLike`), and an extra transition match.
     - Couples a kernel rewrite to a callsite migration. If the kernel has a bug, every legacy caller is affected on day one.

2. **Feature-detect at the shim; legacy callers take the unchanged fast path.** `runDag` inspects `opts` for `jobLike`, `onHumanReview`, or `retryLimits`. None present → call `runDagInner` (the old body, byte-for-byte). Any present → call `runDagStateful`.
   - Pros:
     - SC-001 is enforced trivially: legacy callers execute literally the old code, so existing tests are an exact oracle.
     - SC-006 is unaffected for legacy callers (no kernel involvement at all) and bounded for new callers (only paths that opt in pay).
     - The new code is reviewable in isolation. A bug in `runDagStateful` cannot regress the legacy callers.
     - Phase 5 (consumer migration) can collapse the two paths in a separate PR once the state-machine path is proven in production.
   - Cons:
     - Two execution paths, two sets of code to maintain until Phase 5.
     - Shared helpers (node execution, observer dispatch, OTel spans) must stay in sync between paths or behavior diverges.
     - Easy to forget to extend the feature-detect predicate when adding a new opt-in feature (e.g., a future `priority` option that needs durability would have to remember to flip the path).

## Decision

**`runDag` is a feature-detection shim. No durability features requested → unchanged fast path. Any durability feature requested → state-machine path.**

Concrete shape (in `packages/framework/src/executor/executor.ts`):

```ts
export const runDag = (opts: RunDagOpts) => {
  const useStateMachinePath =
    opts?.jobLike !== undefined ||
    opts?.onHumanReview !== undefined ||
    opts?.retryLimits !== undefined;

  if (useStateMachinePath && opts?.onBackground) {
    return err({
      kind: "invalid-input",
      message: "[runDag] `onBackground` is not supported on the state-machine path...",
    });
  }

  return useStateMachinePath ? runDagStateful(opts) : runDagInner(opts);
};
```

- `runDagInner` is the **byte-for-byte previous body** of `runDag`. No refactors, no "while we're here" cleanups. SC-001's oracle is the existing test suite running against unchanged code.
- `runDagStateful` lives in `packages/framework/src/dag-runtime/run-dag-stateful.ts` and drives `runStateMachine` against a `dag-machine` definition. It calls into the same node execution helpers and observer/OTel dispatch as `runDagInner` so behavior matches at the leaf level.
- The feature-detect predicate is a single `||` chain. Adding a new opt-in feature means adding one disjunct here and updating this ADR's predicate snippet.
- ~~**`onBackground` guard:** `onBackground` is a legacy fast-path-only option. If a caller opts into the state-machine path *and* passes `onBackground`, `runDag` returns `err({ kind: "invalid-input", ... })` rather than silently dropping the option. Background work belongs in a separate job under the state-machine model, not in a per-wave hook.~~ **Superseded by ADR 0018:** `onBackground` is now supported on both paths. `runDagStateful` schedules `finalize()` (judges + span close + `run-end`) detached when `opts.onBackground` is supplied.
- **Resume guard:** `runDagStateful` is also the resume entry point. When `runStateMachine` rehydrates a paused DAG (HITL or hook-crash retry), it dispatches back through this same path — ensuring resumed runs and fresh runs share one code body.

**Invariants preserved by this split:**

- A caller passing none of `{jobLike, onHumanReview, retryLimits}` runs the exact pre-refactor code. No transition overhead, no checkpoint round-trip, no behavior delta.
- Observer/span ordering for legacy callers is bit-for-bit identical to pre-refactor.
- New-feature callers (HITL, retries, durability) get the full state-machine semantics — including resumability, FR-028 sequential-HITL ordering, and FR-029a hook-crash retry (ADR 0013).

**Scope explicitly deferred:** Phase 5 — migrating all consumers to always pass a `JobLike` and removing the fast path — is a separate future PR. When that lands, this ADR should be **superseded** by the ADR that documents the unified path.

## Consequences

**Positive:**

- SC-001 trivially holds: existing tests run unchanged code.
- SC-006 is unaffected for legacy callsites (no kernel cost) and isolated to opt-in callsites where the perf budget is intentional.
- New state-machine code is reviewable as an additive change, not a behavior-altering rewrite. Bugs in `runDagStateful` cannot regress callers who don't use it.
- Production rollout is naturally gradual — features that need durability migrate one at a time by adopting the opts that flip the path.
- Clear migration story: this ADR and its successor will bracket Phase 5, making the intent legible to future readers.

**Negative:**

- Two execution paths exist in `executor.ts` until Phase 5. Code duplication risk for any logic that isn't already factored into shared helpers.
- The feature-detect predicate is implicit coupling. Adding a future opt-in feature without updating the predicate silently routes its callers to the legacy path with surprising behavior. Mitigated by a comment at the predicate site and by this ADR.
- Observer/span emission must stay aligned across paths. A drift caught only by a new-path-specific test could ship a subtle inconsistency for legacy callers, or vice versa. Mitigated by sharing the same node-execution and observer-dispatch helpers.
- Carrying both paths defers — but does not eliminate — the Phase 5 migration cost. We accept the carrying cost as the price of de-risking SC-001.

## Alternatives considered

1. **Always route through the state-machine path (option 1 above).** Rejected: couples kernel correctness to legacy-caller behavior on day one and threatens observer/span ordering across the existing test suite. Higher risk than a feature-detection shim for no near-term gain.

2. **Boolean opt-in flag (`opts.useStateMachine: true`) instead of feature-detection.** Rejected: forces every new-feature caller to remember an extra flag, and creates a confusing state where `onHumanReview` is supplied but the flag isn't. Feature-detection is self-consistent — passing a durability feature implies wanting the durable runtime.

3. **Branch in `runDagInner` itself rather than at a shim.** Rejected: would mean modifying the legacy code body, defeating the SC-001 "literally unchanged" oracle.

## Implementation note

The byte-for-byte preservation of `runDagInner` is load-bearing. Reviewers of this PR should diff `runDagInner` against the pre-refactor `runDag` and confirm zero semantic changes — only the rename and the extraction of the shim above it. Any "drive-by" refactor of `runDagInner` belongs in a separate PR with its own test justification.
