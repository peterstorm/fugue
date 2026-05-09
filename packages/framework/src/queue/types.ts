// Queue layer interfaces — FR-040, FR-041, FR-042, FR-043
// MUST NOT import bullmq, ioredis, or queue-bullmq/** (FR-082)

import type { JobLike } from "../state-machine/types.js";

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
    process: (job: JobLike<S, C>) => Promise<void>,
    opts?: WorkerOpts,
  ): WorkerHandle;
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
 * `onFailed` fires when a job fails; receives:
 *   - id        — job id
 *   - err       — the error that caused failure
 *   - attempts  — number of attempts consumed so far (1-based, after the current failure)
 *   - max       — per-job max attempts (from `EnqueueOpts.attempts` ?? `QueueOpts.defaultAttempts` ?? 1)
 *
 * When `attempts >= max` the job will NOT be retried by the queue; the dead-letter
 * handler (`attachDeadLetterHandler`) should be registered via `onFailed`.
 */
export interface WorkerHandle {
  /** Register a handler called on every job failure (including mid-retry failures) */
  onFailed(
    handler: (
      id: string,
      err: unknown,
      attempts: number,
      max: number,
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
   * Format the notification message from the job id and error description.
   * Called only when `attempts >= max`.
   */
  readonly formatMessage: (id: string, err: string) => string;
}
