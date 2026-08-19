// replayEvents — pure event-log fold for event-sourced replay
//
// All functions in this file are pure: no executor, no I/O, no side effects.
// Replay reconstructs *machine state* from a recorded event log; it does NOT
// re-invoke `node.run` or replay any external side effects.

import type { Machine, RecordedEvent } from "./types.js";

/**
 * ONE fold step of an event-log replay: apply a single entry — a raw
 * event `E` or a `RecordedEvent` envelope (unwrapped automatically, the
 * timestamp metadata is irrelevant to the fold) — to a machine state
 * through the pure transition function.
 *
 * This is the ONLY place where envelopes are unwrapped and the `E` cast
 * is made: `replayEvents` and the resume agreement proof's strict-prefix
 * scan (`resume-proof.ts` `proveResumeAgreement`) share this step, so the
 * transition+unwrap implementation cannot drift between the full replay and
 * the scan (and the `as E` cast lives in exactly one file).
 *
 * Unwrap narrowing (`isRecordedEvent`) is deliberately structural — an entry
 * carrying `recordedAtMs` + `event` (+ optional `synthetic`) is treated as
 * an envelope; a raw machine event payload that happens to match that exact
 * shape is unwrapped too (in-scope consumers always pass real envelopes, so
 * this remains a documented narrowing contract, not a reachable hazard).
 *
 * Pure — no executor, no I/O, no side effects. May throw only because
 * `machine.transition` throws (hostile/version-drifted event payloads);
 * callers at I/O boundaries use a total exception-to-`Result` mapper whose
 * diagnostics are safe for arbitrary thrown values (FR-040).
 */
export const foldStep = <S, E, C>(
  current: { state: S; context: C },
  entry: E | RecordedEvent<unknown>,
  machine: Machine<S, E, C>,
): { state: S; context: C } => {
  // Envelope or raw event — same machine API. The cast is confined to this
  // one step; every replay consumer folds through it.
  const event = (isRecordedEvent(entry) ? entry.event : entry) as E;
  return machine.transition(current.state, event, current.context);
};

/**
 * Rebuild state by replaying a sequence of events through the pure
 * transition function starting from an initial checkpoint.
 *
 * Accepts either raw events `E[]` (callers that already stripped envelopes)
 * or `RecordedEvent<E>[]` (the shape returned by `EventLogReader.readEvents`).
 * Envelopes are unwrapped automatically — the timestamp metadata is
 * irrelevant to the fold.
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
    current = foldStep(current, entry, machine);
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
  // The envelope unwrap + `as E` cast lives in `foldStep` (its JSDoc marks
  // it the single cast site); this boundary delegates to `replayEvents`.
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
  // Envelope discrimination by shape: `RecordedEvent` is exactly
  // `{ recordedAtMs, event, synthetic? }`. A raw event payload carrying the
  // same keys cannot be distinguished structurally — the typed overloads
  // keep envelope vs. raw-event callers apart at compile time; this runtime
  // check only needs to agree with the envelope the readers construct.
  return (
    typeof v === "object" &&
    v !== null &&
    "recordedAtMs" in v &&
    typeof (v as { recordedAtMs: unknown }).recordedAtMs === "number" &&
    "event" in v &&
    ("synthetic" in v
      ? typeof (v as { synthetic: unknown }).synthetic === "boolean"
      : true)
  );
}
