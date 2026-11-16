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

interface QueueDefaults {
  readonly defaultAttempts: number;
}

/**
 * One `createWorker` call: the processor plus the handlers registered on ITS
 * handle. Handlers are owned by the registration, not keyed by queue name, so
 * they leave with it — `backend.close()`, `worker.close()` and a replacing
 * `createWorker` on the same name all release them, and a handler never fires
 * for a worker it was not registered on. The lists are live views: a handler
 * registered mid-drain counts from the next failure on.
 */
interface WorkerRegistration {
  readonly process: (job: JobLike<unknown, unknown, unknown>) => Promise<void>;
  readonly concurrency: number;
  readonly failedHandlers: readonly FailedHandler[];
  readonly exhaustedHandlers: readonly ExhaustedHandler[];
  readonly errorHandlers: readonly ErrorHandler[];
}

const jobKey = (queueName: string, jobId: string): string => `${queueName} ${jobId}`;

// All mutable backend state lives in three tables, each reachable only through
// its named operations. No caller holds a Map, a function is handed only the
// tables it needs, and `clearBackendStore` is the one place that resets them.

/** Queued entries and per-queue defaults, by queue name. */
const createQueueTable = () => {
  const queues = new Map<string, QueueEntry<unknown, unknown>[]>();
  const queueDefaults = new Map<string, QueueDefaults>();

  const queueOf = (name: string): QueueEntry<unknown, unknown>[] => {
    const existing = queues.get(name);
    if (existing !== undefined) return existing;
    const created: QueueEntry<unknown, unknown>[] = [];
    queues.set(name, created);
    return created;
  };

  return {
    /** Make the queue visible in `_events` before its first enqueue. */
    ensureQueue(name: string): void {
      queueOf(name);
    },
    declareQueue(name: string, defaults: QueueDefaults): void {
      queueOf(name);
      queueDefaults.set(name, defaults);
    },
    defaultsOf(name: string): QueueDefaults {
      return queueDefaults.get(name) ?? { defaultAttempts: 1 };
    },
    /** Append, unless `dedup` and an entry with the same id is already queued. */
    enqueue(name: string, entry: QueueEntry<unknown, unknown>, dedup: boolean): void {
      const q = queueOf(name);
      if (dedup && q.some((e) => e.id === entry.id)) return;
      q.push(entry);
    },
    /** Remove and return the front entry; `undefined` when the queue is empty. */
    takeNext(name: string): QueueEntry<unknown, unknown> | undefined {
      return queueOf(name).shift();
    },
    entries(): ReadonlyMap<string, readonly QueueEntry<unknown, unknown>[]> {
      return queues;
    },
    clear(): void {
      queues.clear();
      queueDefaults.clear();
    },
  };
};

/** The current worker registration (and so its handlers), by queue name. */
const createRegistrationTable = () => {
  const workers = new Map<string, WorkerRegistration>();
  return {
    register(name: string, registration: WorkerRegistration): void {
      workers.set(name, registration);
    },
    /** Unregister only while `registration` is current: closing a superseded handle is a no-op. */
    unregister(name: string, registration: WorkerRegistration): void {
      if (workers.get(name) === registration) workers.delete(name);
    },
    of(name: string): WorkerRegistration | undefined {
      return workers.get(name);
    },
    clear(): void {
      workers.clear();
    },
  };
};

/**
 * One `InMemoryJob` per (queueName, jobId), kept across retries to mirror the
 * Redis Streams contract where the per-job event log survives attempt
 * boundaries. Read via `getJob(...)` / `createInMemoryEventLogReader`.
 */
const createJobTable = () => {
  const jobsByKey = new Map<string, InMemoryJob<unknown, unknown>>();
  return {
    /** The job for this entry, created on its first attempt and reused by retries. */
    jobFor(name: string, entry: QueueEntry<unknown, unknown>): InMemoryJob<unknown, unknown> {
      const key = jobKey(name, entry.id);
      const existing = jobsByKey.get(key);
      if (existing !== undefined) return existing;
      const created = createInMemoryJob(entry.data);
      jobsByKey.set(key, created);
      return created;
    },
    get(name: string, jobId: string): InMemoryJob<unknown, unknown> | undefined {
      return jobsByKey.get(jobKey(name, jobId));
    },
    clear(): void {
      jobsByKey.clear();
    },
  };
};

type QueueTable = ReturnType<typeof createQueueTable>;
type RegistrationTable = ReturnType<typeof createRegistrationTable>;
type JobTable = ReturnType<typeof createJobTable>;

interface BackendStore {
  readonly queues: QueueTable;
  readonly registrations: RegistrationTable;
  readonly jobs: JobTable;
}

/** Drop every queue, default, worker registration (handlers included) and job. */
const clearBackendStore = (store: BackendStore): void => {
  store.queues.clear();
  store.registrations.clear();
  store.jobs.clear();
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

// One failed attempt: run the failed/exhausted handlers of the worker that
// processed it (read at failure time, so handlers registered mid-drain count).
const routeJobFailure = async (
  worker: WorkerRegistration,
  entryId: string,
  jobErr: unknown,
  attempt: number,
  max: number,
): Promise<void> => {
  const isExhausted = attempt >= max;
  const handlers: readonly (FailedHandler | ExhaustedHandler)[] = isExhausted
    ? worker.exhaustedHandlers
    : worker.failedHandlers;
  if (handlers.length === 0) {
    // No matching handler registered — surface to onError so the
    // failure is at minimum observable, and emit a logger.error so
    // the failure does not disappear in test harnesses that wired
    // neither.
    fwLogger().error(
      `[InMemoryQueue] Job "${entryId}" failed (attempt ${attempt}/${max}, exhausted=${isExhausted}) with no handler:`,
      jobErr,
    );
    notifyErrorHandlers(worker.errorHandlers, jobErr);
  }
  for (const handler of handlers) {
    try {
      await (isExhausted
        ? (handler as ExhaustedHandler)(entryId, jobErr, attempt)
        : (handler as FailedHandler)(entryId, jobErr, attempt, max));
    } catch (handlerErr) {
      // Handler itself threw — route to onError handlers so the
      // exception is observable without interrupting the drain loop.
      // When NO onError handler is registered either, log like the
      // no-failed/exhausted-handler path above: a doubly-unhandled
      // failure must not disappear in a harness that wired neither.
      if (worker.errorHandlers.length === 0) {
        fwLogger().error(
          `[InMemoryQueue] ${isExhausted ? "onExhausted" : "onFailed"} handler for job "${entryId}" threw (attempt ${attempt}/${max}) with no onError handler:`,
          handlerErr,
        );
      }
      notifyErrorHandlers(worker.errorHandlers, handlerErr);
    }
  }
};

// Per-job max: enqueue-opts.attempts ?? queue.defaultAttempts ?? 1
// (mirrors BullMQ semantics — max travels with the job).
const runEntry = async (
  jobs: JobTable,
  name: string,
  worker: WorkerRegistration,
  defaults: QueueDefaults,
  entry: QueueEntry<unknown, unknown>,
): Promise<void> => {
  const max = entry.opts.attempts ?? defaults.defaultAttempts;
  const job = jobs.jobFor(name, entry);
  let attempt = 0;
  let succeeded = false;
  while (attempt < max && !succeeded) {
    attempt++;
    try {
      // Generic erasure boundary: enqueue is typed `<S, C>` but the
      // worker is registered for an erased queue. Re-injecting the
      // generics at dispatch would require threading S/C through the
      // store's queues and registrations. The single-point erasure here
      // is the load-bearing trade-off.
      await worker.process(job);
      succeeded = true;
    } catch (jobErr) {
      await routeJobFailure(worker, entry.id, jobErr, attempt, max);
    }
  }
};

const drainQueue = async ({ queues, registrations, jobs }: BackendStore, name: string): Promise<void> => {
  queues.ensureQueue(name);
  const worker = registrations.of(name);
  if (!worker) {
    fwLogger().warn(`[InMemoryQueue] drain() called on queue "${name}" with no registered worker — jobs will not be processed`);
    return;
  }
  const defaults = queues.defaultsOf(name);

  // Pool up to `concurrency` pullers; each takes from the front of the
  // queue and re-pulls on completion. Aligns in-memory backend with
  // BullMQ's `WorkerOpts.concurrency` semantics so concurrency bugs in
  // node code surface in fast unit tests. One puller (concurrency 1) runs
  // the entries strictly in FIFO order.
  const puller = async (): Promise<void> => {
    for (let entry = queues.takeNext(name); entry !== undefined; entry = queues.takeNext(name)) {
      await runEntry(jobs, name, worker, defaults, entry);
    }
  };
  await Promise.all(Array.from({ length: worker.concurrency }, () => puller()));
};

const createQueueOn = <S, C>(store: BackendStore, name: string, opts?: QueueOpts): QueueHandle<S, C> => {
  if (
    opts?.defaultAttempts !== undefined &&
    (!Number.isInteger(opts.defaultAttempts) || opts.defaultAttempts < 1)
  ) {
    throw new RangeError(
      `defaultAttempts must be a finite integer >= 1, got ${opts.defaultAttempts}`,
    );
  }
  store.queues.declareQueue(name, { defaultAttempts: opts?.defaultAttempts ?? 1 });

  return {
    async enqueue(id: string, data: { state: S; context: C }, opts?: EnqueueOpts): Promise<void> {
      // dedup: if jobId specified and already present, silently ignore
      store.queues.enqueue(
        name,
        {
          id: opts?.jobId ?? id,
          data: data as { state: unknown; context: unknown },
          opts: opts ?? {},
          enqueuedAt: Date.now(),
        },
        opts?.jobId !== undefined,
      );
    },

    drain: () => drainQueue(store, name),

    async close(): Promise<void> {
      // no-op for in-memory
    },
  };
};

const createWorkerOn = <S, C>(
  registrations: RegistrationTable,
  name: string,
  process: (job: JobLike<S, unknown, C>) => Promise<void>,
  opts?: WorkerOpts,
): WorkerHandle => {
  if (opts?.concurrency !== undefined && (!Number.isInteger(opts.concurrency) || opts.concurrency < 1)) {
    throw new RangeError(`concurrency must be a finite integer >= 1, got ${opts.concurrency}`);
  }
  // The handle is the only writer of its registration's handler lists.
  const failedHandlers: FailedHandler[] = [];
  const exhaustedHandlers: ExhaustedHandler[] = [];
  const errorHandlers: ErrorHandler[] = [];
  const registration: WorkerRegistration = {
    process: process as (job: JobLike<unknown, unknown, unknown>) => Promise<void>,
    concurrency: opts?.concurrency ?? 1,
    failedHandlers,
    exhaustedHandlers,
    errorHandlers,
  };
  registrations.register(name, registration);

  return {
    onFailed(handler: FailedHandler): void {
      failedHandlers.push(handler);
    },
    onExhausted(handler: ExhaustedHandler): void {
      exhaustedHandlers.push(handler);
    },
    onError(handler: ErrorHandler): void {
      errorHandlers.push(handler);
    },
    async close(): Promise<void> {
      registrations.unregister(name, registration);
    },
  };
};

/**
 * Creates an in-memory QueueBackend. All state lives in Maps.
 * `_events` exposes the raw enqueued entries per queue for test assertions.
 */
export function createInMemoryBackend(): InMemoryBackend {
  const store: BackendStore = {
    queues: createQueueTable(),
    registrations: createRegistrationTable(),
    jobs: createJobTable(),
  };

  return {
    createQueue: <S, C>(name: string, opts?: QueueOpts) => createQueueOn<S, C>(store, name, opts),
    createWorker: <S, C>(
      name: string,
      process: (job: JobLike<S, unknown, C>) => Promise<void>,
      opts?: WorkerOpts,
    ) => createWorkerOn<S, C>(store.registrations, name, process, opts),
    // No connections to release — kept for shape parity with BullMQ. Drops
    // every queue, job and worker registration (and with it, its handlers).
    async close(): Promise<void> {
      clearBackendStore(store);
    },
    get _events(): ReadonlyMap<string, readonly QueueEntry<unknown, unknown>[]> {
      return store.queues.entries();
    },
    getJob(queueName: string, jobId: string): InMemoryJob<unknown, unknown> | undefined {
      return store.jobs.get(queueName, jobId);
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
 * is compatible with vi.useFakeTimers().
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
