// runStateMachine — the durable state-machine kernel loop
// FR-004, FR-005, FR-006, FR-007, FR-011, FR-012

import { createHash } from "node:crypto";
import type { Machine, Executor, JobLike, RunOptions } from "./types.js";
import { fwLogger } from "../logger.js";

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
  // All four kernel surfaces (`JobLike`, `Machine`, `Executor`, `RunOptions`)
  // share the `<S, E, C>` generic order. Typed callers (e.g. the DAG layer
  // threading `DagEvent`) get type-checked `appendEvent` payloads; the `E`
  // slot on `JobLike` defaults to `unknown` so untyped callers remain valid.
  job: JobLike<S, E, C>,
  machine: Machine<S, E, C>,
  executor: Executor<S, E, C>,
  opts: RunOptions<S, E, C>,
): Promise<{ state: S; context: C }> => {
  const classify = opts.classifyError ?? defaultClassifyError;
  const nowFn = opts.now ?? Date.now;
  const stamp = (): Date => new Date(nowFn());

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
            fwLogger().error("[runStateMachine] onTrace threw — ignoring to preserve durability:", traceErr);
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

    // FR-005: checkpoint after every successful (non-failed) transition.
    // FR-005: MUST NOT checkpoint when resulting state is terminal-failed.
    // Order: appendEvent FIRST so the audit/event log is never missing a transition
    // whose post-state is already persisted. If appendEvent fails, the state is not
    // advanced and the queue layer can retry from the prior state.
    //
    // appendEvent carries a deterministic `dedupKey` so a worker crash between
    // `appendEvent` and `updateData` does not duplicate the event on retry —
    // the same transition re-derives the same key, and the adapter dedups.
    // Replay consumers see at-most-once delivery.
    if (!isFailed) {
      const attemptNumber = retryCounters.get(dedupSlot) ?? 0;
      const dedupKey = computeDedupKey(prevStateKey, attemptNumber, event);
      await job.appendEvent(event, dedupKey);
      await job.updateData({ state, context });
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
        fwLogger().error("[runStateMachine] onTrace threw — ignoring to preserve durability:", traceErr);
      }
    }

    // FR-007: throw after observing terminal-failed so queue can retry
    if (isFailed) {
      throw new Error(`State machine reached failed terminal state: ${JSON.stringify(state)}`);
    }

    // If terminal-succeeded, fall through to return below
    if (isTerminal) break;
  }

  return { state, context };
};
