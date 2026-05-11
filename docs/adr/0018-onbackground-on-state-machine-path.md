# ADR 0018: `onBackground` is supported on the state-machine path

**Status:** Accepted
**Date:** 2026-05-11
**Plan ref:** `docs/plans/2026-05-11-pr-review-remediation.md` §5.1
**Supersedes (in part):** ADR 0002, ADR 0007 — both stated that `onBackground` was rejected on the state-machine path.

## Context

`onBackground` is a `runDag` option: a hook that receives a `Promise<void>` resolving after the run's tail work (eval-judge calls, OTel root-span finalization, terminal `run-end` event) completes. Callers use it to release a request-bound timeout *before* judges finish — the foreground result resolves as soon as the DAG output is known; the trailing work runs detached.

ADR 0002 and ADR 0007 reasoned about this as a legacy-only concern:

> `onBackground` is rejected on the state-machine path (eval-judge background scheduling is Phase 5 work). Callers that supply both `onBackground` and any state-machine opt receive an explicit error. — ADR 0002

The reasoning at the time was that the SM path needed time to grow up before we trusted it with detached promises, and the planned Phase-5 collapse of the two paths would address it then.

Since that decision was written, three things changed:

1. The SM path is now the default for any DAG with HITL, retries, conditional edges, or `jobLike` (ADR 0009 + ADR 0019). The legacy fast path is reserved for the *least* configured DAGs — exactly the ones least likely to need background eval-judge.
2. Eval-judge implementations and the SM path's `finalize()` block have stabilized. `runDagStateful` already builds a `finalize` closure (`packages/framework/src/dag-runtime/run-dag-stateful.ts`) that wraps judge invocation plus span finalization plus `emitRunEnd("ok")`. Detaching that closure is a code reshape, not a redesign.
3. Wave 2 §2.3 of the remediation plan hardened the detached path: every cleanup step in the catch handler now closes the root span and emits `run-end("error")` independently, so a judge failure cannot leak an open span or starve observers.

Continuing to reject `onBackground` on the SM path forces callers to choose between durability (SM path) and tail-latency control (legacy path) — a false choice. The dual-path shim was an SC-001 oracle, not a feature gate.

## Decision

**`runDag` accepts `onBackground` on both paths. The state-machine path schedules `finalize()` detached when `opts.onBackground` is supplied; the foreground resolves with the DAG output as soon as `runStateMachine` returns `succeeded`.**

Concrete shape (`packages/framework/src/dag-runtime/run-dag-stateful.ts:281-313`):

```ts
if (opts?.onBackground) {
  const p = finalize().catch((e) => {
    console.error("[runDagStateful] background finalize failed:", e);
    try { rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: e.message ?? String(e) }); } catch { /* span SDK */ }
    try { rootSpan.end(); }                                                                       catch { /* already ended */ }
    try { emitRunEnd("error"); }                                                                  catch { /* observer */ }
  });
  opts.onBackground(p);
} else {
  await finalize();
}
return ok(s.output as O);
```

**Invariants preserved by this split:**

- The foreground `Result<O, FrameworkError>` is byte-for-byte identical between background and foreground modes — `s.output` is the same value, classified the same way. `onBackground` does not change *what* the caller sees, only *when*.
- `finalize().catch` is total: every cleanup step is wrapped in its own `try`, so a failure in `setStatus` cannot prevent `end()`, and a failure in `end()` cannot prevent `emitRunEnd`. The root span always closes and observers always receive exactly one `run-end` per run (Wave 2 §2.3).
- Eval-judge background results are **not persisted** in the durable state-machine. They are computed inside the detached `finalize()` closure and emitted as observer events / span attributes; the SM context (`DagMachineContext`) does not carry them. This rides on the same eventual-consistency boundary as ADR 0003's `run-end` event — the durable record is the per-node output map, not the judge verdict.
- The detached promise is unbounded in time. Callers that need a bound (e.g., a worker shutdown sequence) should `await` the returned promise themselves; the framework does not impose a deadline.

**Why eval-judge results stay out of the durable context:**

- Judges are read-only verdicts over the run's final output. They do not gate downstream nodes (no DAG can branch on a judge result) and they do not affect resume semantics.
- Persisting them inside `DagMachineContext` would force every `updateData` write during the run to carry stale, in-progress judge state — the SM doesn't *transition* on judges, so they would be dead weight on the hot path.
- Operators who need durable judge outcomes can attach an observer that writes them downstream of `run-end`. The framework records them on the OTel root span (`evalJudgeResults` attribute) and emits them through the observer event payload; both are durable in the operator's chosen sink, independent of the framework's own checkpoint.

## Consequences

**Positive:**

- Tail-latency control is uniform across both paths. A DAG that adds HITL or retries no longer regresses on its request-bound timeout budget.
- The detached-path failure mode is now codified: span closure and observer notification are guaranteed, so detached judge failures are *visible* (operator-side log + observer event) instead of *silent* (span leak + missing `run-end`).
- The legacy/SM equivalence claim from ADR 0002 strengthens: foreground behavior is identical; background behavior is now also identical-ish (judges run in both, span+run-end close in both).
- Removes the sharpest edge in the old routing predicate. Callers no longer get a `node-crash` error from supplying `onBackground` alongside `jobLike` — a combination that, in retrospect, was the *normal* configuration for production workers.

**Negative:**

- Two `finalize()` invocation shapes (awaited vs. detached) to keep in sync. Mitigated by extracting `finalize` as a closure inside `runDagStateful` — both branches share the same body.
- The detached promise can outlive the worker process. If the host exits before judges complete, those results are lost. Callers that need at-least-once judge delivery should not use `onBackground` (use the foreground path or persist judge requests downstream of `run-end`).
- The observer contract for `run-end` ordering is now path-dependent in a subtle way: in foreground mode `run-end` fires inside the returned `Result`'s resolution stack; in background mode it fires after. Callers that race a follow-on action against `run-end` must `await` the `onBackground` promise. Documented in ADR 0020.

## Rejected alternatives

1. **Reject `onBackground` on the SM path; document as legacy-only.** Rejected — forces callers to choose between durability and tail-latency control. The reasons for the original rejection (untested judge background, fragile `finalize.catch`) no longer hold post-Wave 2.

2. **Persist eval-judge results inside `DagMachineContext`.** Rejected — judges do not participate in transitions and would balloon every `updateData` write on the SM hot path with stale state. Operators who want durable judges should subscribe to the observer event or scrape the OTel root span; the framework's own checkpoint is not the right durability tier for read-only verdicts.

3. **Have `onBackground` block worker shutdown by tracking the detached promise globally.** Rejected — couples framework lifecycle to host-process lifecycle and re-introduces the "detached promise outlives worker" problem in a different shape (worker now refuses to exit). Operators that need at-least-once judge delivery should run judges outside `onBackground` entirely.

## Forward links

- ADR 0002 — back-compat shim. The "rejected on SM path" line in §Consequences is superseded by this ADR.
- ADR 0007 — legacy fast path. The "`onBackground` guard" wording in §Decision is superseded by this ADR.
- ADR 0019 — current routing predicate. `onBackground` is no longer a routing trigger.
- ADR 0020 — `onTrace` vs `run-end` ordering contract, which depends on this ADR's foreground/background split.
