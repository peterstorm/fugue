// In-memory QueueBackend, adaptInMemoryJob, and MarkerStore
// MUST NOT import bullmq, ioredis, or queue-bullmq/** (enforced by check-imports.ts)

import type { JobLike, RecordedEvent } from "../state-machine/types.js";
import { createInMemoryJob, type InMemoryJob, type InMemoryJobOptions } from "./in-memory-job.js";
import { fwLogger } from "../logger.js";
import type {
  QueueBackend,
  QueueHandle,
  WorkerHandle,
  MarkerStore,
  EnqueueOpts,
  EventLogReader,
  QueueOpts,
  WorkerOpts,
} from "./types.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface QueueEntry<S, C> {
  readonly id: string;
  readonly data: { state: S; context: C };
  readonly opts: EnqueueOpts;
  readonly enqueuedAt: number;
}

type FailedHandler = (
  id: string,
  err: unknown,
  attempts: number,
  max: number,
) => Promise<void> | void;

type ExhaustedHandler = (
  id: string,
  err: unknown,
  attempts: number,
) => Promise<void> | void;

// ---------------------------------------------------------------------------
// adaptInMemoryJob — constructs a JobLike from plain initial data
// (wraps createInMemoryJob; does not duplicate event-log logic)
// ---------------------------------------------------------------------------

/**
 * Constructs an in-memory `JobLike` with an observable event log.
 * Delegates to `createInMemoryJob`; exists so queue-layer consumers do not
 * import from `state-machine/`.
 */
export function adaptInMemoryJob<S, C>(
  initial: { state: S; context: C },
  opts?: InMemoryJobOptions,
): JobLike<S, unknown, C> & { readonly events: readonly RecordedEvent<unknown>[] } {
  return createInMemoryJob(initial, opts);
}

// ---------------------------------------------------------------------------
// createInMemoryBackend — QueueBackend backed by Map-based queues
// ---------------------------------------------------------------------------

export interface InMemoryBackend extends QueueBackend {
  /** Exposed for test introspection — map of queueName → ordered entries */
  readonly _events: ReadonlyMap<string, readonly QueueEntry<unknown, unknown>[]>;
  /**
   * Sanctioned accessor for the event-log of a job after `drain()` completes.
   * Returns the persisted `InMemoryJob` (and therefore its recorded events) or
   * `undefined` if no job with that id ran on the named queue. Used by
   * `createInMemoryEventLogReader`; prefer that wrapper unless you genuinely
   * need the raw `JobLike`.
   */
  getJob(queueName: string, jobId: string): InMemoryJob<unknown, unknown> | undefined;
}

type ErrorHandler = (err: Error) => void;

interface WorkerDef {
  readonly process: (job: JobLike<unknown, unknown, unknown>) => Promise<void>;
  readonly concurrency: number;
}

/** All mutable backend state — Maps keyed by queue (= worker) name. */
interface BackendState {
  readonly queues: Map<string, QueueEntry<unknown, unknown>[]>;
  readonly queueDefaults: Map<string, { defaultAttempts: number }>;
  readonly workers: Map<string, WorkerDef>;
  // Persists the `InMemoryJob` instance per (queueName, jobId) across retries,
  // mirroring the Redis Streams contract where the per-job event log survives
  // attempt boundaries. Read via `getJob(...)` / `createInMemoryEventLogReader`.
  readonly jobsByKey: Map<string, InMemoryJob<unknown, unknown>>;
  // per-queue handlers (keyed by worker name = queue name)
  readonly failedHandlers: Map<string, FailedHandler[]>;
  readonly exhaustedHandlers: Map<string, ExhaustedHandler[]>;
  readonly errorHandlers: Map<string, ErrorHandler[]>;
}

const createBackendState = (): BackendState => ({
  queues: new Map(),
  queueDefaults: new Map(),
  workers: new Map(),
  jobsByKey: new Map(),
  failedHandlers: new Map(),
  exhaustedHandlers: new Map(),
  errorHandlers: new Map(),
});

const jobKey = (queueName: string, jobId: string): string => `${queueName} ${jobId}`;

const getOrCreateQueue = (state: BackendState, name: string): QueueEntry<unknown, unknown>[] => {
  if (!state.queues.has(name)) state.queues.set(name, []);
  return state.queues.get(name)!;
};

// Route a failure to every onError handler so it is observable without
// interrupting the drain loop; a handler that itself throws is logged.
const notifyErrorHandlers = (handlers: readonly ErrorHandler[], cause: unknown): void => {
  for (const eh of handlers) {
    try {
      eh(cause instanceof Error ? cause : new Error(String(cause)));
    } catch (swallowed) {
      fwLogger().error("[in-memory-queue] onError handler itself threw:", swallowed);
    }
  }
};

// One failed attempt: run the failed/exhausted handlers registered for the
// queue (read at failure time, so handlers registered mid-drain count).
const routeJobFailure = async (
  state: BackendState,
  name: string,
  entryId: string,
  jobErr: unknown,
  attempt: number,
  max: number,
): Promise<void> => {
  const isExhausted = attempt >= max;
  const handlers: readonly (FailedHandler | ExhaustedHandler)[] = isExhausted
    ? (state.exhaustedHandlers.get(name) ?? [])
    : (state.failedHandlers.get(name) ?? []);
  if (handlers.length === 0) {
    // No matching handler registered — surface to onError so the
    // failure is at minimum observable, and emit a logger.error so
    // the failure does not disappear in test harnesses that wired
    // neither.
    fwLogger().error(
      `[InMemoryQueue] Job "${entryId}" failed (attempt ${attempt}/${max}, exhausted=${isExhausted}) with no handler:`,
      jobErr,
    );
    notifyErrorHandlers(state.errorHandlers.get(name) ?? [], jobErr);
  }
  for (const handler of handlers) {
    try {
      await (isExhausted
        ? (handler as ExhaustedHandler)(entryId, jobErr, attempt)
        : (handler as FailedHandler)(entryId, jobErr, attempt, max));
    } catch (handlerErr) {
      // Handler itself threw — route to onError handlers so the
      // exception is observable without interrupting the drain loop.
      notifyErrorHandlers(state.errorHandlers.get(name) ?? [], handlerErr);
    }
  }
};

// Persist one JobLike per (queue, id); subsequent attempts reuse it so the
// event log survives retries, matching Redis Streams.
const jobFor = (
  state: BackendState,
  name: string,
  entry: QueueEntry<unknown, unknown>,
): InMemoryJob<unknown, unknown> => {
  const key = jobKey(name, entry.id);
  let job = state.jobsByKey.get(key);
  if (job === undefined) {
    job = createInMemoryJob(entry.data);
    state.jobsByKey.set(key, job);
  }
  return job;
};

// Per-job max: enqueue-opts.attempts ?? queue.defaultAttempts ?? 1
// (mirrors BullMQ semantics — max travels with the job).
const runEntry = async (
  state: BackendState,
  name: string,
  workerDef: WorkerDef,
  defaults: { readonly defaultAttempts: number },
  entry: QueueEntry<unknown, unknown>,
): Promise<void> => {
  const max = entry.opts.attempts ?? defaults.defaultAttempts;
  const job = jobFor(state, name, entry);
  let attempt = 0;
  let succeeded = false;
  while (attempt < max && !succeeded) {
    attempt++;
    try {
      // Generic erasure boundary: enqueue is typed `<S, C>` but the
      // worker is registered for an erased queue. Re-injecting the
      // generics at dispatch would require threading S/C through
      // `getOrCreateQueue` / `workers`. The single-point erasure here
      // is the load-bearing trade-off.
      await workerDef.process(job);
      succeeded = true;
    } catch (jobErr) {
      await routeJobFailure(state, name, entry.id, jobErr, attempt, max);
    }
  }
};

const drainQueue = async (state: BackendState, name: string): Promise<void> => {
  const q = getOrCreateQueue(state, name);
  const workerDef = state.workers.get(name);
  if (!workerDef) {
    fwLogger().warn(`[InMemoryQueue] drain() called on queue "${name}" with no registered worker — jobs will not be processed`);
    return;
  }
  const defaults = state.queueDefaults.get(name) ?? { defaultAttempts: 1 };

  // Pool up to `concurrency` workers; each pulls from the front of the
  // queue and re-pulls on completion. Aligns in-memory backend with
  // BullMQ's `WorkerOpts.concurrency` semantics so concurrency bugs in
  // node code surface in fast unit tests.
  if (workerDef.concurrency === 1) {
    while (q.length > 0) {
      const entry = q.shift()!;
      await runEntry(state, name, workerDef, defaults, entry);
    }
    return;
  }

  const worker = async (): Promise<void> => {
    while (q.length > 0) {
      const entry = q.shift();
      if (entry === undefined) return;
      await runEntry(state, name, workerDef, defaults, entry);
    }
  };
  const pool = Array.from({ length: workerDef.concurrency }, () => worker());
  await Promise.all(pool);
};

const createQueueOn = <S, C>(state: BackendState, name: string, opts?: QueueOpts): QueueHandle<S, C> => {
  if (
    opts?.defaultAttempts !== undefined &&
    (!Number.isFinite(opts.defaultAttempts) || opts.defaultAttempts < 1)
  ) {
    throw new RangeError(
      `defaultAttempts must be a finite integer >= 1, got ${opts.defaultAttempts}`,
    );
  }
  getOrCreateQueue(state, name);
  state.queueDefaults.set(name, { defaultAttempts: opts?.defaultAttempts ?? 1 });

  return {
    async enqueue(id: string, data: { state: S; context: C }, opts?: EnqueueOpts): Promise<void> {
      const q = getOrCreateQueue(state, name);
      // dedup: if jobId specified and already present, silently ignore
      if (opts?.jobId !== undefined) {
        const existing = q.find((e) => e.id === opts.jobId);
        if (existing) return;
      }
      q.push({
        id: opts?.jobId ?? id,
        data: data as { state: unknown; context: unknown },
        opts: opts ?? {},
        enqueuedAt: Date.now(),
      });
    },

    drain: () => drainQueue(state, name),

    async close(): Promise<void> {
      // no-op for in-memory
    },
  };
};

const createWorkerOn = <S, C>(
  state: BackendState,
  name: string,
  process: (job: JobLike<S, unknown, C>) => Promise<void>,
  opts?: WorkerOpts,
): WorkerHandle => {
  if (opts?.concurrency !== undefined && (!Number.isFinite(opts.concurrency) || opts.concurrency < 1)) {
    throw new RangeError(`concurrency must be a finite integer >= 1, got ${opts.concurrency}`);
  }
  state.workers.set(name, {
    process: process as (job: JobLike<unknown, unknown, unknown>) => Promise<void>,
    concurrency: opts?.concurrency ?? 1,
  });
  if (!state.failedHandlers.has(name)) state.failedHandlers.set(name, []);
  if (!state.exhaustedHandlers.has(name)) state.exhaustedHandlers.set(name, []);
  if (!state.errorHandlers.has(name)) state.errorHandlers.set(name, []);

  return {
    onFailed(handler: FailedHandler): void {
      state.failedHandlers.get(name)!.push(handler);
    },
    onExhausted(handler: ExhaustedHandler): void {
      state.exhaustedHandlers.get(name)!.push(handler);
    },
    onError(handler: ErrorHandler): void {
      state.errorHandlers.get(name)!.push(handler);
    },
    async close(): Promise<void> {
      state.workers.delete(name);
      state.failedHandlers.delete(name);
      state.exhaustedHandlers.delete(name);
      state.errorHandlers.delete(name);
    },
  };
};

/**
 * Creates an in-memory QueueBackend. All state lives in Maps.
 * `_events` exposes the raw enqueued entries per queue for test assertions.
 */
export function createInMemoryBackend(): InMemoryBackend {
  const state = createBackendState();

  return {
    createQueue: <S, C>(name: string, opts?: QueueOpts) => createQueueOn<S, C>(state, name, opts),
    createWorker: <S, C>(
      name: string,
      process: (job: JobLike<S, unknown, C>) => Promise<void>,
      opts?: WorkerOpts,
    ) => createWorkerOn<S, C>(state, name, process, opts),
    // No connections to release — kept for shape parity with BullMQ.
    async close(): Promise<void> {
      state.queues.clear();
      state.queueDefaults.clear();
      state.workers.clear();
      state.jobsByKey.clear();
    },
    get _events(): ReadonlyMap<string, readonly QueueEntry<unknown, unknown>[]> {
      return state.queues as ReadonlyMap<string, readonly QueueEntry<unknown, unknown>[]>;
    },
    getJob(queueName: string, jobId: string): InMemoryJob<unknown, unknown> | undefined {
      return state.jobsByKey.get(jobKey(queueName, jobId));
    },
  };
}

// ---------------------------------------------------------------------------
// createInMemoryEventLogReader — symmetric counterpart to
// `createRedisStreamReader`. Lets tests replay-to-timestamp without Redis.
// ---------------------------------------------------------------------------

/**
 * Read-side `EventLogReader` for an in-memory queue backend. Returns the
 * `RecordedEvent` envelopes appended to the persisted `InMemoryJob`. Unknown
 * `(queueName, jobId)` returns an empty array — same shape as Redis.
 */
export function createInMemoryEventLogReader(backend: InMemoryBackend): EventLogReader {
  return {
    async readEvents(queueName, jobId) {
      return backend.getJob(queueName, jobId)?.events ?? [];
    },
    async readEventsBetween(queueName, jobId, fromMs, toMs) {
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
        throw new RangeError(
          `[readEventsBetween] fromMs and toMs must be finite numbers; got fromMs=${fromMs}, toMs=${toMs}`,
        );
      }
      if (toMs < fromMs) {
        throw new RangeError(
          `[readEventsBetween] toMs (${toMs}) must be >= fromMs (${fromMs})`,
        );
      }
      const events = backend.getJob(queueName, jobId)?.events ?? [];
      // Half-open: [fromMs, toMs)
      return events.filter(
        (e: RecordedEvent<unknown>) => e.recordedAtMs >= fromMs && e.recordedAtMs < toMs,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// createInMemoryMarkerStore — MarkerStore with TTL via setTimeout (Gap-4)
// Compatible with vitest fake timers.
// ---------------------------------------------------------------------------

/**
 * In-memory MarkerStore. TTL expiry uses `setTimeout`/`clearTimeout` so it
 * is compatible with `vi.useFakeTimers()`.
 */
export interface InMemoryMarkerStoreHandle extends MarkerStore, Disposable {
  /** Cancel all pending TTL timers. Call when discarding the store. */
  close(): void;
}

export function createInMemoryMarkerStore(): InMemoryMarkerStoreHandle {
  const markers = new Map<string, ReturnType<typeof setTimeout>>();

  const close = (): void => {
    for (const handle of markers.values()) clearTimeout(handle);
    markers.clear();
  };

  return {
    async set(key: string, ttlSeconds: number): Promise<void> {
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
        throw new RangeError(
          `ttlSeconds must be a finite positive number, got ${ttlSeconds}`,
        );
      }
      // Clear any existing timer for this key first (re-set resets TTL)
      const existing = markers.get(key);
      if (existing !== undefined) clearTimeout(existing);

      const handle = setTimeout(() => {
        markers.delete(key);
      }, ttlSeconds * 1000);

      markers.set(key, handle);
    },

    async exists(key: string): Promise<boolean> {
      return markers.has(key);
    },

    async delete(key: string): Promise<void> {
      const handle = markers.get(key);
      if (handle !== undefined) {
        clearTimeout(handle);
        markers.delete(key);
      }
    },

    close,

    [Symbol.dispose](): void {
      close();
    },
  };
}
