// In-memory QueueBackend, adaptInMemoryJob, and MarkerStore — FR-040, FR-043, Gap-4
// MUST NOT import bullmq, ioredis, or queue-bullmq/** (FR-082)

import type { JobLike } from "../state-machine/types.js";
import { createInMemoryJob } from "../state-machine/in-memory-job.js";
import type {
  QueueBackend,
  QueueHandle,
  WorkerHandle,
  MarkerStore,
  EnqueueOpts,
  QueueOpts,
  WorkerOpts,
} from "./types.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface QueueEntry<J> {
  readonly id: string;
  readonly data: J;
  readonly opts: EnqueueOpts;
  readonly enqueuedAt: number;
}

type FailedHandler = (
  id: string,
  err: unknown,
  attempts: number,
  max: number,
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
export function adaptInMemoryJob<S, C>(initial: {
  state: S;
  context: C;
}): JobLike<S, C> & { readonly events: readonly unknown[] } {
  return createInMemoryJob(initial);
}

// ---------------------------------------------------------------------------
// createInMemoryBackend — QueueBackend backed by Map-based queues
// ---------------------------------------------------------------------------

export interface InMemoryBackend extends QueueBackend {
  /** Exposed for test introspection — map of queueName → ordered entries */
  readonly _events: ReadonlyMap<string, readonly QueueEntry<unknown>[]>;
}

/**
 * Creates an in-memory QueueBackend. All state lives in Maps.
 * `_events` exposes the raw enqueued entries per queue for test assertions.
 */
export function createInMemoryBackend(): InMemoryBackend {
  // mutable internal maps
  const queues = new Map<string, QueueEntry<unknown>[]>();
  const workers = new Map<
    string,
    {
      process: (job: JobLike<unknown, unknown>) => Promise<void>;
      maxAttempts: number;
    }
  >();

  function getOrCreateQueue(name: string): QueueEntry<unknown>[] {
    if (!queues.has(name)) queues.set(name, []);
    return queues.get(name)!;
  }

  function createQueue<J>(name: string, _opts?: QueueOpts): QueueHandle<J> {
    getOrCreateQueue(name);

    return {
      async enqueue(id: string, data: J, opts?: EnqueueOpts): Promise<void> {
        const q = getOrCreateQueue(name);
        // dedup: if jobId specified and already present, silently ignore
        if (opts?.jobId !== undefined) {
          const existing = q.find((e) => e.id === opts.jobId);
          if (existing) return;
        }
        q.push({
          id: opts?.jobId ?? id,
          data: data as unknown,
          opts: opts ?? {},
          enqueuedAt: Date.now(),
        });
      },

      async drain(): Promise<void> {
        const q = getOrCreateQueue(name);
        const workerDef = workers.get(name);
        if (!workerDef) return;

        const { process: processFn, maxAttempts } = workerDef;
        // drain FIFO — shift from front
        while (q.length > 0) {
          const entry = q.shift()!;
          let attempt = 0;
          let succeeded = false;
          while (attempt < maxAttempts && !succeeded) {
            attempt++;
            try {
              const job = createInMemoryJob({
                state: entry.data as unknown,
                context: undefined as unknown,
              });
              await processFn(job as unknown as JobLike<unknown, unknown>);
              succeeded = true;
            } catch (jobErr) {
              for (const handler of failedHandlers.get(name) ?? []) {
                try {
                  await handler(entry.id, jobErr, attempt, maxAttempts);
                } catch (handlerErr) {
                  // Failed-handler itself threw — route to onError handlers so the
                  // exception is observable without interrupting the drain loop.
                  for (const eh of errorHandlers.get(name) ?? []) {
                    try {
                      eh(handlerErr instanceof Error ? handlerErr : new Error(String(handlerErr)));
                    } catch {
                      // Swallow: onError handler must not break drain.
                    }
                  }
                }
              }
            }
          }
        }
      },

      async close(): Promise<void> {
        // no-op for in-memory
      },
    };
  }

  // per-queue failed handlers (keyed by worker name = queue name)
  const failedHandlers = new Map<string, FailedHandler[]>();
  const errorHandlers = new Map<string, ((err: Error) => void)[]>();

  function createWorker<S, C>(
    name: string,
    process: (job: JobLike<S, C>) => Promise<void>,
    opts?: WorkerOpts,
  ): WorkerHandle {
    if (opts?.maxAttempts !== undefined && (!Number.isFinite(opts.maxAttempts) || opts.maxAttempts < 1)) {
      throw new RangeError(`maxAttempts must be a finite integer >= 1, got ${opts.maxAttempts}`);
    }
    if (opts?.concurrency !== undefined && (!Number.isFinite(opts.concurrency) || opts.concurrency < 1)) {
      throw new RangeError(`concurrency must be a finite integer >= 1, got ${opts.concurrency}`);
    }
    const maxAttempts = opts?.maxAttempts ?? 1;
    workers.set(name, {
      process: process as (job: JobLike<unknown, unknown>) => Promise<void>,
      maxAttempts,
    });
    if (!failedHandlers.has(name)) failedHandlers.set(name, []);
    if (!errorHandlers.has(name)) errorHandlers.set(name, []);

    return {
      onFailed(handler: FailedHandler): void {
        failedHandlers.get(name)!.push(handler);
      },
      onError(handler: (err: Error) => void): void {
        errorHandlers.get(name)!.push(handler);
      },
      async close(): Promise<void> {
        workers.delete(name);
        failedHandlers.delete(name);
        errorHandlers.delete(name);
      },
    };
  }

  return {
    createQueue,
    createWorker,
    get _events(): ReadonlyMap<string, readonly QueueEntry<unknown>[]> {
      return queues as ReadonlyMap<string, readonly QueueEntry<unknown>[]>;
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
export function createInMemoryMarkerStore(): MarkerStore {
  const markers = new Map<string, ReturnType<typeof setTimeout>>();

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
  };
}
