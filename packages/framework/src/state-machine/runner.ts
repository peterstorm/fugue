// runStateMachine — the durable state-machine kernel loop
// FR-004, FR-005, FR-006, FR-007, FR-011, FR-012

import { createHash } from "node:crypto";
import type { Machine, Executor, JobLike, RunOptions } from "./types.js";

const defaultClassifyError = (error: unknown): { retriable: boolean; message: string } => ({
  retriable: true,
  message: error instanceof Error ? error.message : String(error),
});

/**
 * Deterministic per-transition key. Stamped on every `appendEvent` call so
 * adapters can dedup if the worker crashes between `appendEvent` and
 * `updateData` (and the same transition gets re-derived on restart).
 *
 * Inputs: the prior `stateKey`, the per-state attempt counter, and the event
 * type tag. These three together uniquely identify a transition slot. 16 hex
 * chars is plenty for collision resistance within a single job's stream.
 */
const computeDedupKey = (
  prevStateKey: string,
  attemptNumber: number,
  event: unknown,
): string => {
  const eventType =
    typeof (event as { type?: unknown })?.type === "string"
      ? (event as { type: string }).type
      : "<event>";
  const key = `${prevStateKey}|${attemptNumber}|${eventType}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
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
  // Wave 4 §4.3: tie the job's event type to the machine's event type so
  // `appendEvent` is type-checked against the machine's event union.
  // `JobLike<S, C, E>` is structurally compatible with the legacy
  // `JobLike<S, C>` (third generic defaults to `unknown`).
  job: JobLike<S, C, E>,
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

    // FR-011: track retry counts per state key (for dedup-key continuity
    // across self-looping retries). The counter is meaningful only for
    // machines whose retries keep the same state — for state-changing retry
    // cycles (e.g. the DAG machine's running → retrying → running), the
    // dedup-key derivation is unaffected because the prev-state changes too.
    const stateKey = JSON.stringify(state);
    const prevStateKey = JSON.stringify(prevState);
    const isSelfLoop = stateKey === prevStateKey && !isFailed;
    if (isSelfLoop) {
      retryCounters.set(stateKey, (retryCounters.get(stateKey) ?? 0) + 1);
    }

    // Trace outcome classification (AD-4). Machines may override the default
    // self-loop heuristic by implementing `isRetryTransition`; this is what
    // the DAG machine uses so `running → retrying` reports `outcome: "retry"`.
    const isRetry =
      !isFailed &&
      (machine.isRetryTransition !== undefined
        ? machine.isRetryTransition(prevState, state)
        : isSelfLoop);

    // FR-005: checkpoint after every successful (non-failed) transition
    // FR-005: MUST NOT checkpoint when resulting state is terminal-failed
    // Order: appendEvent FIRST so the audit/event log is never missing a transition
    // whose post-state is already persisted. If appendEvent fails, the state is not
    // advanced and the queue layer can retry from the prior state.
    //
    // appendEvent carries a deterministic `dedupKey` so a worker crash between
    // `appendEvent` and `updateData` does not duplicate the event on retry —
    // the same transition re-derives the same key, and the adapter dedups.
    // Replay consumers see at-most-once delivery.
    if (!isFailed) {
      const attemptNumber = retryCounters.get(prevStateKey) ?? 0;
      const dedupKey = computeDedupKey(prevStateKey, attemptNumber, event);
      await job.appendEvent(event, dedupKey);
      await job.updateData({ state, context });
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
