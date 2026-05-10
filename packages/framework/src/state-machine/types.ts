// State-machine kernel types — FR-001, FR-002, FR-003, FR-004

// FR-001: Pure state-machine definition
export interface Machine<S, E, C> {
  readonly transition: (state: S, event: E, context: C) => { state: S; context: C };
  readonly isTerminal: (state: S) => boolean;
  /** Distinct from isTerminal — needed for don't-checkpoint-failed invariant (FR-005) */
  readonly isFailed: (state: S) => boolean;
  readonly stateProgress: (state: S) => number; // 0..100
}

// FR-002: Side-effect dispatcher — returns an event, not a state
export type Executor<S, C, E> = (state: S, context: C) => Promise<E>;

// FR-003: Abstract job handle — checkpoint + progress + event-log writes
export interface JobLike<S, C> {
  readonly data: { state: S; context: C };
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
  appendEvent(event: unknown, dedupKey?: string): Promise<void>;
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
}

// FR-012: beforeExecute hook — returning false aborts the run
// FR-006: classifyError + errorEventOf for typed error wrapping
export interface RunOptions<S, C, E> {
  beforeExecute?: (state: S, context: C) => boolean;
  classifyError?: (error: unknown) => { retriable: boolean; message: string };
  onTrace?: (t: TraceEvent<S, E>) => void;
  /** Adapter from classified error to typed event E — REQUIRED for FR-006 wrapping */
  errorEventOf: (classified: { retriable: boolean; message: string }) => E;
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
