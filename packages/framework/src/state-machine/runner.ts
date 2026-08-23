// runStateMachine — the durable state-machine kernel loop
// Transition loop, event sourcing, checkpoint persistence, idempotency, trace emission

import type { Machine, Executor, JobLike, KernelRunOpts } from "./types.js";

const defaultClassifyError = (error: unknown): { retriable: boolean; message: string } => ({
  retriable: true,
  message: error instanceof Error ? error.message : String(error),
});

/**
 * Fallback dedup key when no `computeDedupKey` is injected via opts.
 * Uses string concatenation (no crypto) so the kernel stays runtime-agnostic.
 * Callers wanting collision-resistant keys (e.g., the DAG runtime) inject a
 * SHA-256 variant via `KernelRunOpts.computeDedupKey`.
 */
const fallbackDedupKey = (
  prevStateKey: string,
  attemptNumber: number,
  event: unknown,
): string => {
  const eventType =
    typeof (event as { type?: unknown })?.type === "string"
      ? (event as { type: string }).type
      : "<event>";
  return `${prevStateKey}|${attemptNumber}|${eventType}`;
};

/**
 * Drive a machine to terminal state, checkpointing after every successful
 * transition (FR-005), wrapping executor errors via classifyError (FR-006),
 * throwing on terminal-failed so the queue layer can retry (FR-007).
 *
 * FR-011: retry counters are per-invocation (fresh Map) — a fresh queue
 * attempt never inherits stale counts from a prior attempt.
 *
 * NOTE: retry-cap enforcement is the machine's responsibility. The runner
 * tracks counts for trace emission only (`"retry"` outcome). When the machine
 * decides a state is terminal-failed, the runner throws regardless of counters.
 */
export const runStateMachine = async <S, E, C>(
  // All four kernel surfaces (`JobLike`, `Machine`, `Executor`, `RunOptions`)
  // share the `<S, E, C>` generic order. Typed callers (e.g. the DAG layer
  // threading `DagEvent`) get type-checked `appendEvent` payloads; the `E`
  // slot on `JobLike` defaults to `unknown` so untyped callers remain valid.
  job: JobLike<S, E, C>,
  machine: Machine<S, E, C>,
  executor: Executor<S, E, C>,
  opts: KernelRunOpts<S, E, C>,
): Promise<{ state: S; context: C }> => {
  const classify = opts.classifyError ?? defaultClassifyError;
  const nowFn = opts.now ?? Date.now;
  const stamp = (): Date => new Date(nowFn());
  const dedupKeyFn = opts.computeDedupKey ?? fallbackDedupKey;
  const log = opts.logger ?? { warn: () => {}, error: () => {} };

  // FR-011: retry counters are per-invocation (fresh map = counters start
  // at 0 for every queue-level attempt).
  const retryCounters = new Map<string, number>();

  let { state, context } = job.data;

  while (!machine.isTerminal(state)) {
    // FR-012: beforeExecute hook — abort if returns false
    if (opts.beforeExecute !== undefined) {
      const proceed = opts.beforeExecute(state, context);
      if (!proceed) {
        // AD-4: emit skipped trace before aborting so consumers can observe the abort
        if (opts.onTrace !== undefined) {
          try {
            opts.onTrace({
              state,
              nextState: state,
              outcome: "skipped",
              durationMs: 0,
              timestamp: stamp(),
            });
          } catch (traceErr) {
            log.error("[runStateMachine] onTrace threw — ignoring to preserve durability:", traceErr);
          }
        }
        throw new Error("runStateMachine: aborted by beforeExecute hook");
      }
    }

    const start = nowFn();
    let event: E;

    try {
      event = await executor(state, context);
    } catch (raw) {
      // FR-006: ALWAYS catch executor exceptions and deliver them to the machine
      // as a typed ERROR event. errorEventOf is required by the type system —
      // callers without one cannot construct a valid `RunOptions`.
      const classified = classify(raw);
      event = opts.errorEventOf(classified);
    }

    const prevState = state;
    const result = machine.transition(state, event, context);
    state = result.state;
    context = result.context;

    const durationMs = nowFn() - start;

    const isFailed = machine.isFailed(state);
    const isTerminal = machine.isTerminal(state);

    const keyer = machine.stateKey ?? ((s: S) => JSON.stringify(s));
    const stateKey = keyer(state);
    const prevStateKey = keyer(prevState);

    // Trace outcome classification (AD-4). Machines may override the default
    // self-loop heuristic by implementing `isRetryTransition`; this is what
    // the DAG machine uses so `running → retrying` reports `outcome: "retry"`.
    const isRetry =
      !isFailed &&
      (machine.isRetryTransition !== undefined
        ? machine.isRetryTransition(prevState, state)
        : stateKey === prevStateKey);

    // Keyed by (prevState, event-type) rather than stateKey alone, so
    // successive retry cycles where prevState repeats (running → retrying →
    // running → retrying in the DAG machine) produce distinct dedup keys.
    // Keying by stateKey alone collapses cross-cycle retries onto a single
    // dedup slot and suppresses the second node-failed event in the audit log.
    const eventType =
      typeof (event as { type?: unknown })?.type === "string"
        ? (event as { type: string }).type
        : "<event>";
    const dedupSlot = `${prevStateKey}::${eventType}`;
    if (isRetry) {
      retryCounters.set(dedupSlot, (retryCounters.get(dedupSlot) ?? 0) + 1);
    }

    // FR-005: checkpoint after every successful transition.
    // Order: appendEvent FIRST so the audit/event log is never missing a transition
    // whose post-state is already persisted. If appendEvent fails, the state is not
    // advanced and the queue layer can retry from the prior state.
    //
    // Guard: `!isFailed` means terminal-failed states are NOT checkpointed
    // (FR-005 requirement). Terminal-succeeded states ARE checkpointed here
    // because they satisfy `!isFailed` — the runner then breaks out of the
    // loop normally on the `isTerminal` check below.
    //
    // appendEvent carries a deterministic `dedupKey` so a worker crash between
    // `appendEvent` and `updateData` does not duplicate the event on retry —
    // the same transition re-derives the same key, and the adapter dedups.
    // Replay consumers see at-most-once delivery.
    if (!isFailed) {
      const attemptNumber = retryCounters.get(dedupSlot) ?? 0;
      const dedupKey = dedupKeyFn(prevStateKey, attemptNumber, event);
      await job.appendEvent(event, dedupKey);
      await job.updateData({ state, context });
      // ADR-0060: post-commit hook — fires ONLY after the post-state is durably
      // persisted, so a caller's effectively-once side effect (e.g. consuming a
      // human decision) is ordered strictly after durability. A crash between
      // `updateData` and here leaves the side effect un-run, which is the safe
      // direction: the decision is re-read on resume rather than lost. Unlike
      // telemetry, this callback may enforce a business invariant; a failure is
      // rethrown after durability so the owning shell can fail the run closed.
      if (opts.onCommitted !== undefined) {
        try {
          await opts.onCommitted({ prevState, event, state, context });
        } catch (commitErr) {
          try {
            log.error("[runStateMachine] onCommitted threw — failing closed after checkpoint:", commitErr);
          } catch {
            // The committed-callback failure remains authoritative.
          }
          throw commitErr;
        }
      }
      // Do not persist progress for failed states — the runner throws below
      // before reaching here in the failed branch, and FR-005 forbids
      // checkpointing terminal-failed.
      await job.updateProgress(machine.stateProgress(state));
    }

    if (opts.onTrace) {
      const outcome = isFailed ? "failed" : isRetry ? "retry" : "success";
      // A throwing onTrace must not escape: the transition is already persisted
      // and surfacing the throw would surface a successful transition as a fatal
      // executor crash via run-dag-stateful's outer catch.
      try {
        opts.onTrace({
          state: prevState,
          event,
          nextState: state,
          outcome,
          durationMs,
          timestamp: stamp(),
        });
      } catch (traceErr) {
        log.error("[runStateMachine] onTrace threw — ignoring to preserve durability:", traceErr);
      }
    }

    // FR-007: throw after observing terminal-failed so queue can retry.
    // DESIGN: We throw here intentionally. The BullMQ queue layer catches
    // this and triggers its built-in retry mechanism. Returning a Result
    // would require every queue adapter to unwrap and re-throw, adding
    // complexity at every boundary for a pattern that only applies here.
    // CONTROL FLOW: This throw is caught by handleKernelError() in
    // run-dag-stateful.ts which converts it back to Err<FrameworkError>.
    // See ADR-0005 for the two-layer retry rationale.
    if (isFailed) {
      throw new Error(
        `State machine reached failed terminal state: ${JSON.stringify(state)}`,
        { cause: { state, context } },
      );
    }

    // ADR-0060: durable HALT. A halted state (e.g. `suspended` at a human gate)
    // is non-terminal and non-failed, so it was checkpointed above — a later
    // re-enqueue resumes from it. Break and return the paused state so the
    // worker is freed. The check is post-transition only: a loop that STARTS in
    // a halted state (a resumed job) re-enters via `!isTerminal` and re-runs the
    // executor; the break fires only when a transition PRODUCES the halt here.
    if (machine.isHalted?.(state)) break;

    // If terminal-succeeded, fall through to return below
    if (isTerminal) break;
  }

  return { state, context };
};
