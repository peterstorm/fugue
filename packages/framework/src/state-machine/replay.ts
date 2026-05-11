// replayEvents — pure event-log fold for event-sourced replay
// FR-003 (event log), US6
//
// All functions in this file are pure: no executor, no I/O, no side effects.
// Replay reconstructs *machine state* from a recorded event log; it does NOT
// re-invoke `node.run` or replay any external side effects.

import type { Machine, RecordedEvent } from "./types.js";

/**
 * Rebuild state by replaying a sequence of events through the pure
 * transition function starting from an initial checkpoint.
 *
 * Accepts either raw events `E[]` (legacy form, used internally by tests
 * and code that already stripped envelopes) or `RecordedEvent<E>[]` (the
 * shape returned by `EventLogReader.readEvents`). Envelopes are unwrapped
 * automatically — the timestamp metadata is irrelevant to the fold.
 */
export function replayEvents<S, E, C>(
  events: readonly RecordedEvent<unknown>[],
  machine: Machine<S, E, C>,
  initial: { state: S; context: C },
): { state: S; context: C };
export function replayEvents<S, E, C>(
  events: readonly E[],
  machine: Machine<S, E, C>,
  initial: { state: S; context: C },
): { state: S; context: C };
export function replayEvents<S, E, C>(
  events: readonly (E | RecordedEvent<unknown>)[],
  machine: Machine<S, E, C>,
  initial: { state: S; context: C },
): { state: S; context: C } {
  let current = initial;
  for (const entry of events) {
    // Envelope or raw event — same machine API.
    const event = (isRecordedEvent(entry) ? entry.event : entry) as E;
    current = machine.transition(current.state, event, current.context);
  }
  return current;
}

/**
 * Replay only events recorded strictly before `untilMs`. Returns the
 * machine state as of that wall-clock moment — i.e. "what state had the
 * machine reached just before time T?".
 *
 * Use for forensic queries against a recorded event log:
 *
 * ```ts
 * const events = await reader.readEvents(queueName, jobId);
 * const stateAtNoon = replayEventsUntil(events, machine, initial, noonMs);
 * ```
 *
 * Pure — does not invoke any executor or perform I/O.
 */
export const replayEventsUntil = <S, E, C>(
  events: readonly RecordedEvent<unknown>[],
  machine: Machine<S, E, C>,
  initial: { state: S; context: C },
  untilMs: number,
): { state: S; context: C } => {
  if (!Number.isFinite(untilMs)) {
    throw new RangeError(
      `[replayEventsUntil] untilMs must be a finite number; got ${untilMs}`,
    );
  }
  const filtered = events.filter((e) => e.recordedAtMs < untilMs);
  // Cast the inner event type at the boundary — the machine parameterization
  // (E) is the source of truth. Same pattern as JSON.parse → cast → use.
  return replayEvents(filtered, machine, initial);
};

/**
 * Replay only events whose `recordedAtMs` falls in the half-open interval
 * `[fromMs, toMs)`, starting from `initial`. Returns the state that results
 * from folding *only* that slice of the history through the machine.
 *
 * Useful for diff-style queries ("what changed in the last 5 minutes?") when
 * paired with a known prior state, e.g.:
 *
 * ```ts
 * const before = replayEventsUntil(events, machine, initial, fromMs);
 * const after  = replayEventsUntil(events, machine, initial, toMs);
 * // diff `before` vs. `after` for what happened in [fromMs, toMs)
 * ```
 *
 * For server-side filtering against Redis Streams, prefer
 * `EventLogReader.readEventsBetween(queueName, jobId, fromMs, toMs)` to
 * avoid transferring the full log over the wire, then pass the result to
 * `replayEvents`.
 *
 * Pure — does not invoke any executor or perform I/O.
 */
export const replayEventSlice = <S, E, C>(
  events: readonly RecordedEvent<unknown>[],
  machine: Machine<S, E, C>,
  initial: { state: S; context: C },
  fromMs: number,
  toMs: number,
): { state: S; context: C } => {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new RangeError(
      `[replayEventSlice] fromMs and toMs must be finite numbers; got fromMs=${fromMs}, toMs=${toMs}`,
    );
  }
  if (toMs < fromMs) {
    throw new RangeError(
      `[replayEventSlice] toMs (${toMs}) must be >= fromMs (${fromMs})`,
    );
  }
  const filtered = events.filter(
    (e) => e.recordedAtMs >= fromMs && e.recordedAtMs < toMs,
  );
  return replayEvents(filtered, machine, initial);
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isRecordedEvent(v: unknown): v is RecordedEvent<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    "recordedAtMs" in v &&
    typeof (v as { recordedAtMs: unknown }).recordedAtMs === "number" &&
    "event" in v
  );
}
