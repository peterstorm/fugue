# ADR 0021: Single-path runtime — legacy fast-path retired

**Status:** Accepted
**Date:** 2026-05-11
**Plan ref:** `docs/plans/2026-05-11-pr-review-remediation.md` §7.3
**Supersedes:** ADR 0002 (back-compat shim), ADR 0007 (legacy path retention)

## Context

Earlier ADRs documented a deliberate two-path runtime:

- A *legacy fast path* (`executor/executor.ts:runDagInner`) for DAGs without HITL, retries, conditional edges, or a durable `JobLike`. Straight `topoSort → Promise.all per wave → return`.
- A *state-machine path* (`dag-runtime/run-dag-stateful.ts`) for everything else, built on the kernel runner and a `JobLike`-backed durable handle.

A routing predicate in `runDag` selected between them (ADR 0009 + ADR 0019). The split existed for two reasons:

1. **Risk isolation.** The kernel runner was new; routing the most-trivial DAGs through the simpler path kept a known-good baseline available while the SM path matured.
2. **Implementation parity.** Several SM-only features (`onBackground`, validation error fail-fast, eval-judge background scheduling, `node-error` emission on crashes) lagged behind legacy parity.

Both reasons have since dissolved:

- ADR 0018 brought `onBackground` to the SM path.
- ADR 0019 made the routing predicate explicit and exposed an in-memory `JobLike` fallback so the SM path runs cleanly without a durable backend.
- Wave 7 §7.1 unified `runNode` into `shared/run-node.ts`. Both call sites already produced identical observer event sequences; with the duplication removed, there is no behavioral gap left to argue about.
- Wave 7 §7.2 broke the `executor/ ↔ dag-runtime/` cycle by moving shared utilities into `shared/`.

What remains is a routing predicate, a thin runDag wrapper around `runDagInner`, and a duplicate orchestration layer that does the same thing as `runDagStateful` minus the kernel.

## Decision

**Retire the legacy fast path. Every `runDag` call flows through `runDagStateful`.**

Concretely:

- `executor/executor.ts:runDagInner` is deleted.
- `runDag` keeps three responsibilities at the public API surface:
  1. **Bidirectional HITL contract** — reject if the DAG declares `humanReview` without an `onHumanReview` hook, and reject the inverse.
  2. **Durability advisory (ADR 0019)** — warn when the DAG declares retries or conditional edges but the caller did not provide a durable `JobLike`.
  3. **Translate `resume: { runId, checkpoint }`** into `DagRunOpts.resumeCheckpoint`, then delegate.
- The legacy `RunOptions.resume` field is preserved on the public surface; it is reinterpreted as a per-node checkpoint replay threaded through `runNodeShared` (see "Resume semantics" below).
- `resumeRun(runId, dag, ctx, checkpoint)` continues to work as a thin wrapper around `runDag(dag, undefined, ctx, { resume: { runId, checkpoint } })`.
- `executor/ ↔ dag-runtime/` cycle-prevention is enforced in `scripts/check-imports.ts`: neither folder may import from the other.

## Resume semantics

The legacy `opts.resume.checkpoint` was a `Map<string, unknown>` of pre-computed node outputs. The legacy executor consulted it per-node, validated against the current `outputSchema`, and emitted `node-skipped` for hits.

Post-§7.3 the same mechanism is implemented inside `runNodeShared`'s checkpoint-hit branch and threaded through `runDagStateful → buildDagExecutor → runWave`. `DagRunOpts.resumeCheckpoint?: Map<string, unknown>` is the durable surface; `RunOptions.resume.checkpoint` translates to it.

Behavior is preserved bit-for-bit:

- Cached values validated against current `outputSchema` on first encounter.
- Schema mismatch → `node-error` event + `Err({ kind: "validation", nodeId })`.
- Schema match → `node-skipped` event + cached value returned.

## Validation and checkpoint-write-failure fail-fast

The legacy path returned validation and `checkpoint-write-failed` errors directly. The SM path used to wrap them in `retry-exhausted` after the (zero) retry budget was consumed.

Unifying the paths required deciding on one semantic. **Determinism wins**: validation failures and missing/broken cache backends won't resolve by re-running the node, so they fail-fast. `handleNodeFailed` in `dag-runtime/transition-helpers.ts` now treats `validation`, `checkpoint-write-failed`, and `predicate-malformed` as terminal-failed without consuming the retry budget. The original error kind is preserved on `result.error.kind`.

## Consequences

**Positive:**

- One mental model. The runtime is the state-machine runner; everything is durable-handle-friendly by default.
- Dead code deletion. `runDagInner`, the routing predicate's branch logic, the `useStateMachinePath` calculation, the `resume + jobLike` incompatibility path, and the duplicate orchestration (~120 LOC in `executor/executor.ts`) are gone.
- Cycle is breakable. `executor/` and `dag-runtime/` no longer depend on each other. The boundary is enforceable in CI.

**Trade-offs:**

- DAGs that previously hit the legacy path pay the SM-path cost: an extra kernel-loop iteration per wave, plus `JobLike.updateData` calls. For in-memory `JobLike`, these are cheap (Map updates), but they are not free.
- `runDag` is now a wrapper. Any caller looking for "the runtime" should read `runDagStateful` directly.

## Migration notes

- The `RunOptions.resume.runId` field is informational. The authoritative `runId` is `ctx.runId`.
- `runDag` no longer needs `opts.resume` to be incompatible with `jobLike`, `humanReview`, or `retryLimits`. These now compose: `resume + jobLike` replays the per-node checkpoint inside a durable run; `resume + humanReview` skips the checkpointed nodes and gates on the reviewer for the remaining ones.
- Tests that previously asserted `Err({ kind: "node-crash", message: "incompatible" })` for resume + SM-only opts have been deleted (`packages/framework/src/__tests__/executor.test.ts`). Their replacements assert the composition behavior.

## Related

- ADR 0002 (legacy back-compat shim): superseded.
- ADR 0007 (legacy path retention until Phase 5): superseded.
- ADR 0018: `onBackground` on the SM path (precondition).
- ADR 0019: runtime routing predicate (superseded for routing; the advisory warning is retained verbatim because the durability story does not change).
- ADR 0022 (forthcoming): Phase-5 trigger criteria — generalized retirement playbook for future legacy paths.
