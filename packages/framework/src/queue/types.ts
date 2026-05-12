// Queue layer interfaces — FR-040, FR-041, FR-042, FR-043
// MUST NOT import bullmq, ioredis, or queue-bullmq/** (FR-082)

import type { JobLike, RecordedEvent } from "../state-machine/types.js";

// FR-041: Options types

/** Options for enqueueing a job */
export interface EnqueueOpts {
  /** Job priority (lower = higher priority) */
  readonly priority?: number;
  /** Delay in milliseconds before the job becomes active */
  readonly delayMs?: number;
  /** Queue-level max attempts (outer crash-fallback loop, AD-5) */
  readonly attempts?: number;
  /** Unique dedup key — if set, duplicate enqueues are silently ignored */
  readonly jobId?: string;
}

/** Options for creating a queue */
export interface QueueOpts {
  /**
   * Default max attempts applied to every enqueued job (overridable per-enqueue
   * via `EnqueueOpts.attempts`). When omitted, jobs run with `attempts = 1`
   * (no retry).
   */
  readonly defaultAttempts?: number;
}

/** Options for creating a worker */
export interface WorkerOpts {
  /** Max concurrent jobs processed by this worker */
  readonly concurrency?: number;
}

/**
 * Read-side interface for the per-job event log. Symmetric across backends —
 * BullMQ implements it over Redis Streams (`createRedisStreamReader`),
 * in-memory implements it by reading the `events` array on the persisted
 * `InMemoryJob` (`createInMemoryEventLogReader`). The write-side
 * (`appendEvent`) lives on `JobLike`.
 *
 * Returns `RecordedEvent<unknown>` envelopes — each entry has the
 * domain `event` plus the `recordedAtMs` wall-clock timestamp captured
 * at the original `appendEvent` call.
 */
export interface EventLogReader {
  /**
   * Read all events for a job in insertion order, wrapped in
   * `RecordedEvent<unknown>` envelopes.
   */
  readEvents(queueName: string, jobId: string): Promise<readonly RecordedEvent<unknown>[]>;

  /**
   * Read only events recorded in the half-open interval `[fromMs, toMs)`.
   * Backends that can push the filter down (Redis: `XRANGE` with
   * ms-prefixed entry IDs) should do so. Backends without ID-based
   * filtering should filter post-fetch.
   */
  readEventsBetween(
    queueName: string,
    jobId: string,
    fromMs: number,
    toMs: number,
  ): Promise<readonly RecordedEvent<unknown>[]>;
}

/** Options for the per-job event log (AD-3, FR-048) */
export interface EventLogOpts {
  /** Maximum number of events to retain per stream (default 10000) */
  readonly maxLen?: number;
  /** Use approximate XADD MAXLEN ~ trimming (default true) */
  readonly approximate?: boolean;
  /** Override the Redis Stream key for a given queue + job (default: `events:${queueName}:${jobId}`) */
  readonly streamKey?: (queueName: string, jobId: string) => string;
  /**
   * Wall-clock source stamped onto each event as `recordedAtMs` before
   * `XADD`. Injected for deterministic tests; defaults to `Date.now`.
   */
  readonly now?: () => number;
}

// FR-040: Factory abstraction

/**
 * Backend-agnostic queue factory — FR-040
 *
 * Producers MUST enqueue `{state, context}` envelopes; both the in-memory and
 * BullMQ backends expose the envelope to workers via `job.data` (matches the
 * `JobLike` contract).
 */
export interface QueueBackend {
  createQueue<S, C>(name: string, opts?: QueueOpts): QueueHandle<S, C>;
  createWorker<S, C>(
    name: string,
    process: (job: JobLike<S, unknown, C>) => Promise<void>,
    opts?: WorkerOpts,
  ): WorkerHandle;
  /**
   * Shut the backend down — closes every queue/worker created by this backend
   * and disconnects the shared Redis client (BullMQ). Idempotent: calling
   * `close()` more than once resolves without error. Call from SIGTERM/SIGINT
   * handlers in long-lived processes to free connections cleanly.
   */
  close(): Promise<void>;
}

// FR-041: Runtime handles

/**
 * Enqueue API exposed to producers — FR-041
 *
 * The payload shape is fixed to `{state, context}` so both backends produce
 * identical `job.data` (see `QueueBackend` and `JobLike`).
 */
export interface QueueHandle<S, C> {
  enqueue(id: string, data: { state: S; context: C }, opts?: EnqueueOpts): Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Worker lifecycle handle — FR-041, FR-042
 *
 * Two failure callbacks split the prior "every failure" stream:
 *
 *   - `onFailed`    — fires on *mid-retry* failures only (`attempts < max`).
 *                     Use this when you want to observe each attempt.
 *   - `onExhausted` — fires once when a job's retry budget is exhausted
 *                     (`attempts >= max`). Use this for dead-letter routing
 *                     and operator notifications.
 *
 * The split removes the manual `if (attempts >= max)` check every
 * dead-letter caller used to perform. `attachDeadLetterHandler` now wires
 * `onExhausted` directly.
 */
export interface WorkerHandle {
  /**
   * Register a handler called on **mid-retry** failures only (attempts < max).
   * Callbacks fire after each failed attempt while the queue retries; once
   * the retry budget is exhausted, `onExhausted` fires instead.
   */
  onFailed(
    handler: (
      id: string,
      err: unknown,
      attempts: number,
      max: number,
    ) => Promise<void> | void,
  ): void;
  /**
   * Register a handler called exactly once when a job exhausts its retry
   * budget. `attempts === max` at this point. Use for dead-letter routing.
   */
  onExhausted(
    handler: (
      id: string,
      err: unknown,
      attempts: number,
    ) => Promise<void> | void,
  ): void;
  /** Register a handler called on unhandled worker-level errors */
  onError(handler: (err: Error) => void): void;
  close(): Promise<void>;
}

// FR-043: Idempotency marker store

/**
 * TTL-bounded keyed markers for idempotency and scheduler dependency resolution — FR-043
 */
export interface MarkerStore {
  /** Persist a marker with a TTL. Re-setting an existing key resets its TTL. */
  set(key: string, ttlSeconds: number): Promise<void>;
  /** Returns true if the key exists and has not expired */
  exists(key: string): Promise<boolean>;
  /** Remove a marker immediately */
  delete(key: string): Promise<void>;
}

// Dead-letter notification

/**
 * Async notification sink called when a job exhausts its queue-level retries — FR-044
 *
 * Implementations: email, Slack, PagerDuty, etc. The queue layer never imports any
 * concrete notifier; callers supply it.
 */
export interface DeadLetterNotifier {
  notify(recipients: readonly string[], message: string): Promise<void>;
}

/** Options for `attachDeadLetterHandler` */
export interface DeadLetterOpts {
  /**
   * Derive the notification recipient list from the job id and the error that caused exhaustion.
   * Called only when `attempts >= max` (i.e. job is exhausted).
   *
   * Receives `id` (the job id) and `err` (the raw error value from `onFailed`) so callers can
   * route notifications based on job identity or error type without needing a separate `getData`
   * lookup. This matches the `WorkerHandle.onFailed` signature which does not expose job data.
   */
  readonly getRecipients: (id: string, err: unknown) => readonly string[];
  /**
   * Format the notification message from the job id and the raw error value.
   * Implementations decide how to stringify (Error.message, JSON, custom);
   * the framework no longer pre-serializes the error to a string, since that
   * threw away the structured `Error` object that callers may want to format.
   * Called only when `attempts >= max`.
   */
  readonly formatMessage: (id: string, err: unknown) => string;
}
