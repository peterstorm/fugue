// State-machine kernel types — pure machine, executor, event journal, job handle

import type { RunId } from "../types/ids.js";
// Re-export so `state-machine` consumers can import `RunId` from a single
// place rather than reaching into `types/`. The brand types are referenced
// in `RunOptions` and downstream `TraceEvent` consumers.
export type { RunId };

// FR-001: Pure state-machine definition
export interface Machine<S, E, C> {
  readonly transition: (state: S, event: E, context: C) => { state: S; context: C };
  readonly isTerminal: (state: S) => boolean;
  /** Distinct from isTerminal — needed for don't-checkpoint-failed invariant (FR-005) */
  readonly isFailed: (state: S) => boolean;
  readonly stateProgress: (state: S) => number; // 0..100
  /**
   * Classify a transition as a retry attempt. Used by the runner only for
   * trace-outcome reporting (`outcome: "retry"`). When omitted, the runner
   * falls back to detecting self-loops via state-equality — appropriate for
   * machines whose retry semantics keep the same state. Machines whose retry
   * cycles cross distinct phases (e.g. the DAG machine's `running → retrying`)
   * must implement this to surface accurate retry telemetry.
   */
  readonly isRetryTransition?: (prevState: S, nextState: S) => boolean;
  /**
   * Structural keyer used by the runner to derive `prevStateKey` /
   * `stateKey` for the retry-counter and dedup-key derivation. Required:
   * `JSON.stringify` is unreliable for `Map`/`Set`/`Date` state, so the
   * machine MUST opt into a concrete keyer. Implementations should produce
   * a key that is stable across attempts — i.e. `stateKey(s)` returns the
   * same string for any two structurally-equivalent values of `s`.
   */
  readonly stateKey: (state: S) => string;
}

// FR-002: Side-effect dispatcher — returns an event, not a state
export type Executor<S, E, C> = (state: S, context: C) => Promise<E>;

// FR-003: Abstract job handle — checkpoint + progress + event-log writes
//
// Generic order `<S, E, C>` matches the rest of the kernel API surface.
// The `E` slot defaults to `unknown` so callers that don't supply an event
// type still compile; callers that thread the machine event type (e.g. the
// DAG layer uses `DagEvent`) get type-checked `appendEvent` payloads.
export interface JobLike<S, E = unknown, C = unknown> {
  readonly data: { readonly state: S; readonly context: C };
  updateData(d: { state: S; context: C }): Promise<void>;
  updateProgress(pct: number): Promise<void>;
  /**
   * Append an event to the durable log.
   *
   * `dedupKey` (optional) — when supplied, the adapter MUST guarantee that a
   * second call with the same key is a no-op for this job's stream. Used by
   * the runner to make appendEvent idempotent under worker crashes between
   * `appendEvent` and `updateData`. Adapters that don't support dedup ignore
   * the key and accept a small at-least-once window.
   */
  appendEvent(event: E, dedupKey?: string): Promise<void>;
}

/**
 * Event-log envelope. Wraps a domain event with the wall-clock time at which
 * it was committed to the durable log. Captured by `JobLike.appendEvent`
 * implementations, so it is transport-independent (Redis Streams, in-memory,
 * Postgres, etc. all stamp the same way).
 *
 * The domain event itself is unchanged; the envelope is metadata only. The
 * pure `Machine.transition` consumes raw `event`s, not envelopes.
 */
export interface RecordedEvent<E> {
  /** ms-since-epoch when the event was appended to the durable log. */
  readonly recordedAtMs: number;
  /** The domain event itself. */
  readonly event: E;
  /**
   * Set to `true` when `recordedAtMs` was synthesised (e.g. defaulted to `0`
   * after a malformed Redis Stream entry ID) rather than read from the
   * envelope. Forensic time-range queries should skip synthesised
   * timestamps — they cannot be ordered reliably against real wall-clock
   * recordings. Omitted (treated as `false`) on real timestamps to keep the
   * common-case envelope size unchanged.
   */
  readonly synthetic?: boolean;
}

// FR-012: beforeExecute hook — returning false aborts the run
// FR-006: classifyError + errorEventOf for typed error wrapping
export interface KernelRunOpts<S, E, C> {
  beforeExecute?: (state: S, context: C) => boolean;
  classifyError?: (error: unknown) => { retriable: boolean; message: string };
  onTrace?: (t: TraceEvent<S, E>) => void;
  /** Adapter from classified error to typed event E — REQUIRED for FR-006 wrapping */
  errorEventOf: (classified: { retriable: boolean; message: string }) => E;
  /**
   * Injectable clock used to stamp `TraceEvent.durationMs`. Tests that need
   * deterministic trace durations can supply a stub; defaults to `Date.now`.
   */
  now?: () => number;
}

// AD-4: Post-transition trace event with FROM + TO state
// NOTE: event is optional — abort traces (outcome: "skipped") have no event
//       since execution was aborted before the executor was invoked.
export interface TraceEvent<S, E> {
  readonly state: S;       // FROM
  readonly event?: E;
  readonly nextState: S;   // TO
  readonly outcome: "success" | "retry" | "skipped" | "failed";
  readonly durationMs: number;
  readonly timestamp: Date;
}
