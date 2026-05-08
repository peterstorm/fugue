// runStateMachine — the durable state-machine kernel loop
// FR-004, FR-005, FR-006, FR-007, FR-011, FR-012

import type { Machine, Executor, JobLike, RunOptions } from "./types.js";

const defaultClassifyError = (error: unknown): { retriable: boolean; message: string } => ({
  retriable: true,
  message: error instanceof Error ? error.message : String(error),
});

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
  job: JobLike<S, C>,
  machine: Machine<S, E, C>,
  executor: Executor<S, C, E>,
  opts?: RunOptions<S, C, E>,
): Promise<{ state: S; context: C }> => {
  const classify = opts?.classifyError ?? defaultClassifyError;

  // FR-011: reset transient retry counters for this invocation
  // Fresh map = counters start at 0 for every queue-level attempt
  const retryCounters = new Map<string, number>();

  let { state, context } = job.data;

  while (!machine.isTerminal(state)) {
    // FR-012: beforeExecute hook — abort if returns false
    if (opts?.beforeExecute !== undefined) {
      const proceed = opts.beforeExecute(state, context);
      if (!proceed) {
        // AD-4: emit skipped trace before aborting so consumers can observe the abort
        opts?.onTrace?.({
          state,
          nextState: state,
          outcome: "skipped",
          durationMs: 0,
          timestamp: new Date(),
        });
        throw new Error("runStateMachine: aborted by beforeExecute hook");
      }
    }

    const start = Date.now();
    let event: E;

    try {
      event = await executor(state, context);
    } catch (raw) {
      // FR-006: ALWAYS catch executor exceptions and deliver them to the machine
      // as a typed ERROR event. errorEventOf is required — callers must supply it.
      const classified = classify(raw);
      if (!opts?.errorEventOf) {
        throw new Error(
          "runStateMachine: executor threw but no errorEventOf adapter was supplied in opts. " +
          `Cannot deliver error to machine. Original: ${classified.message}`,
          { cause: raw },
        );
      }
      event = opts.errorEventOf(classified);
    }

    const prevState = state;
    const result = machine.transition(state, event, context);
    state = result.state;
    context = result.context;

    const durationMs = Date.now() - start;

    const isFailed = machine.isFailed(state);
    const isTerminal = machine.isTerminal(state);

    // FR-011: track retry counts per state key (for trace emission)
    const stateKey = JSON.stringify(state);
    const prevStateKey = JSON.stringify(prevState);
    const isRetry = stateKey === prevStateKey && !isFailed;
    if (isRetry) {
      retryCounters.set(stateKey, (retryCounters.get(stateKey) ?? 0) + 1);
    }

    // FR-005: checkpoint after every successful (non-failed) transition
    // FR-005: MUST NOT checkpoint when resulting state is terminal-failed
    if (!isFailed) {
      await job.updateData({ state, context });
      await job.appendEvent(event);
      // CRITICAL-3: updateProgress only when not failed (do not persist failed progress)
      await job.updateProgress(machine.stateProgress(state));
    }

    // Fire trace hook (AD-4)
    if (opts?.onTrace) {
      const outcome = isFailed ? "failed" : isRetry ? "retry" : "success";
      opts.onTrace({
        state: prevState,
        event,
        nextState: state,
        outcome,
        durationMs,
        timestamp: new Date(),
      });
    }

    // FR-007: throw after observing terminal-failed so queue can retry
    if (isFailed) {
      throw new Error(`State machine reached failed terminal state: ${JSON.stringify(state)}`);
    }

    // If terminal-succeeded, fall through to return below
    if (isTerminal) {
      break;
    }
  }

  return { state, context };
};
