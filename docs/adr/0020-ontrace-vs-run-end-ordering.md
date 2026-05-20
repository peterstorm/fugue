# ADR 0020: `onTrace` callbacks precede the `run-end` observer event

**Status:** Accepted
**Date:** 2026-05-11
**Plan ref:** `docs/plans/2026-05-11-pr-review-remediation.md` §5.3
**Related:** ADR 0018 (`onBackground` on SM path), ADR 0019 (current routing predicate), ADR 0004 (post-transition trace event).

## Context

The DAG runtime fires two distinct end-of-run signals to two distinct subscribers, and reviewers kept asking "which one fires first?" The answer is implicit in the code today but never documented as a contract:

- **`onTrace`** — `RunOptions.onTrace?: (t: TraceEvent<S, E>) => void`. Called by `runStateMachine` *after every transition*, including the terminal one (FR-004, ADR 0004). The callback is synchronous from the runner's perspective — it returns `void`, not `Promise<void>`, so the runner does not await it.
- **`run-end`** — `ObserverEvent` of type `"run-end"`. Emitted by `runDagStateful`'s `emitRunEnd(status)` helper *after* `runStateMachine` returns and the SM path runs `finalize()` (eval-judges, root-span closure). Dispatched through `dispatchEvent` to the caller's `Observer`.

The two are not redundant. `onTrace` is the kernel-level transition log (timing of every step, including retries, abort, success/failed outcome). `run-end` is the run-level lifecycle event (single, terminal, status-bearing). Operators consume `onTrace` for per-step telemetry; observers consume `run-end` for "this run is finished, you can release the run buffer / unsubscribe / move on."

Without a stated ordering contract, callers that subscribe to *both* (a common case: tracing pipeline reads `onTrace`, BufferedObserver reads `run-end`) had no guarantee that the kernel-side stream was complete by the time the lifecycle event arrived. In foreground mode the ordering held by construction but no test enforced it; in background mode (ADR 0018) the ordering changes shape — `run-end` fires inside the detached `finalize()` promise — so it needed an explicit contract.

## Decision

**For every run, every `onTrace(t)` callback fires (synchronously, inside `runStateMachine`) before the `run-end` observer event is dispatched.**

This holds across all three terminal paths:

1. **Foreground succeeded** (`opts.onBackground` undefined, machine reaches `succeeded`):
   - `runStateMachine` returns. All `onTrace` invocations have already fired synchronously.
   - `await finalize()` runs eval-judges, closes the root span.
   - `emitRunEnd("ok")` dispatches `run-end` to the observer.
   - `runDag` returns `ok(s.output)`.

2. **Background succeeded** (`opts.onBackground` supplied, machine reaches `succeeded`):
   - `runStateMachine` returns. All `onTrace` invocations have already fired.
   - `finalize()` is scheduled detached; `opts.onBackground(p)` is called with the detached promise.
   - `runDag` returns `ok(s.output)` to the caller.
   - Later, inside the detached `finalize()`: eval-judges run, root span closes, `emitRunEnd("ok")` dispatches `run-end`.

3. **Failed terminal** (machine reaches `failed`, or `runStateMachine` throws):
   - All `onTrace` invocations (including the one with `nextState.kind === "failed"`) have already fired before the throw / return.
   - `runDagStateful`'s `catch` (or `.with({ kind: "failed" })`) closes the span and calls `emitRunEnd("error")` synchronously.
   - `runDag` returns `err(error)`.

4. **Compile-time failure** (`compileDagToMachine` rejects before `runStateMachine` runs):
   - Zero `onTrace` invocations.
   - `emitRunEnd("error")` fires; returns `err`.
   - The contract holds vacuously: 0 traces precede the 1 run-end.

**Invariants stated as the contract:**

- The set of `onTrace` callbacks for run R is fully invoked before `run-end` for run R reaches any observer.
- The ordering is path-independent: foreground vs. background, succeeded vs. failed, machine-run vs. compile-failed — `onTrace` ⊕ `run-end` is monotone in that order.
- `onTrace` itself is synchronous from the runner's view. Callers whose `onTrace` does async I/O must not depend on the I/O completing before `run-end` — only on the *callback being entered* before `run-end`. Persisting trace events durably requires the caller to either block inside the callback or buffer + flush on `run-end`.

**What this contract does *not* guarantee:**

- It does not say anything about *intra-trace* ordering between observer events emitted during the run (`node-start`, `node-end`, `node-error`, `run-start`). Those are emitted from the executor closure, not the kernel, and their relative ordering with `onTrace` callbacks is governed by the executor implementation, not this ADR.
- It does not bound the wall-clock delay between the last `onTrace` and `run-end` in background mode. The detached `finalize()` may take seconds (eval-judge LLM I/O); callers needing tighter coupling should stay in foreground mode.
- It does not survive observer drop. An observer that throws inside `onRunEnd` is the caller's bug; the kernel-side `onTrace` callbacks have already happened, and the framework cannot retroactively unfire them.

## Consequences

**Positive:**

- Callers can `await` the `run-end` event and trust that all `onTrace` callbacks have completed entry-wise. The single observer event becomes a safe "kernel is done" signal.
- Background mode (ADR 0018) is no longer ambiguous — the ordering contract is preserved by virtue of `finalize()` always running *after* `runStateMachine` returns, regardless of whether it's awaited or detached.
- Test fortification: the ordering is now property-tested over random DAGs (`packages/framework/src/__tests__/ontrace-run-end-ordering.test.ts`), 100 runs per shape × succeeded/failed × foreground/background. A regression that fires `run-end` before the last `onTrace` produces a deterministic failure.

**Negative:**

- The contract pins down implementation detail that may want to change. If a future refactor moves `onTrace` to fire asynchronously (e.g., batched, off the runner thread), this contract must be re-stated or weakened. The contract should be revisited if such a refactor is proposed.
- Async `onTrace` work cannot be assumed complete by `run-end` time. Callers that want "trace I/O finished before run-end" must do their own coordination. The contract is "callback entered," not "callback's downstream work done."

## Rejected alternatives

1. **Stronger contract: `run-end` fires after all `onTrace` *promises* resolve.** Rejected — `onTrace` is sync (`void`-returning) by design; widening it to `Promise<void>` would force the runner to await every callback, doubling per-transition overhead and blocking the kernel on user code. Operators who need durable trace shipping should buffer in-process and flush on `run-end`.

2. **No documented ordering; let callers coordinate.** Rejected — leaves the implementation detail load-bearing. Reviewers will keep asking the same question, and a future refactor could silently break the ordering without anyone noticing.

3. **Document the ordering as path-dependent (foreground only).** Rejected — the ordering is path-independent in the current implementation; downgrading the guarantee to one path would be a regression of the actual behavior. ADR 0018 explicitly preserves the ordering across the foreground/background split.

## Forward links

- ADR 0004 — `onTrace` post-transition firing semantics.
- ADR 0018 — `onBackground` foreground/background split; preserves this ordering by construction.
- Wave 7 §7.3 — legacy-path retirement. When the legacy path is gone, this contract describes the *only* path and the test should still pass unchanged.
