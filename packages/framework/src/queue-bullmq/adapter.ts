// createBullMQBackend — QueueBackend adapter over BullMQ Queue/Worker
// Validates inputs, wraps BullMQ jobs as JobLike, manages worker lifecycle
// bullmq is imported only by queue-bullmq/**; ioredis is additionally imported by the
// three named Redis adapter files (see the check-imports.ts Enforces list)

import { Queue, Worker } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import Redis from "ioredis";
import type { RedisOptions } from "ioredis";
import type { JobLike } from "../state-machine/types.js";
import type {
  QueueBackend,
  QueueHandle,
  WorkerHandle,
  EnqueueOpts,
  QueueOpts,
  WorkerOpts,
  EventLogOpts,
} from "../queue/types.js";
import { adaptBullMQJob } from "./job.js";
import { serializeValue } from "../state-machine/serialize.js";
import { fwLogger } from "../logger.js";
import { safeErrorMessage } from "../types/safe-error.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Redis connection inputs accepted by the BullMQ infrastructure adapter. */
type ConnectionInput = string | { readonly host: string; readonly port: number };

/**
 * Parse the supported Redis URL surface once, retaining every connection
 * setting ioredis/BullMQ need: credentials, selected database, and TLS.
 */
export const __parseConnection = (connection: ConnectionInput): RedisOptions => {
  if (typeof connection !== "string") return connection;

  const url = new URL(connection);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new RangeError(`Redis connection URL must use redis: or rediss:, got ${url.protocol}`);
  }
  const dbSegment = url.pathname.slice(1);
  const db = dbSegment === "" ? undefined : Number(dbSegment);
  if (db !== undefined && (!Number.isInteger(db) || db < 0)) {
    throw new RangeError(`Redis connection URL has an invalid database index: ${url.pathname}`);
  }

  return {
    host: url.hostname,
    port: Number(url.port || "6379"),
    ...(url.username === "" ? {} : { username: decodeURIComponent(url.username) }),
    ...(url.password === "" ? {} : { password: decodeURIComponent(url.password) }),
    ...(db === undefined ? {} : { db }),
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
  };
};

/** Error-event handlers exist to contain failures; logging cannot reopen them. */
const logErrorWithoutThrowing = (message: string, error: unknown): void => {
  try {
    fwLogger().error(message, error);
  } catch {
    // Infrastructure event remains contained even when diagnostics fail.
  }
};

/**
 * Invoke a user failure handler inside a promise boundary. Deferring the call
 * is load-bearing: `Promise.resolve(handler())` evaluates `handler()` first, so
 * a synchronous throw would escape before the rejection handler exists.
 */
export const __dispatchFailureHandler = (
  handler: () => Promise<void> | void,
  report: (error: Error) => void,
): void => {
  void Promise.resolve()
    .then(handler)
    .catch((error) => {
      report(error instanceof Error ? error : new Error(safeErrorMessage(error)));
    });
};

// ---------------------------------------------------------------------------
// createBullMQBackend
// ---------------------------------------------------------------------------

/**
 * ONE positive-integer range guard for the two option fields that carry one
 * (round-38 cs-14). Both are counts BullMQ would otherwise accept as `0`,
 * `1.5` or `NaN` and then behave undefinedly on, so both fail loudly at the
 * call that supplied them.
 */
const assertPositiveInteger = (field: string, value: number | undefined): void => {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw new RangeError(`${field} must be a finite integer >= 1, got ${value}`);
  }
};

// Use `any` for BullMQ internals — the public API is typed via QueueHandle<S, C>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQueue = Queue<any, any, string>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWorker = Worker<any>;

/** Shared connection plus every queue/worker, so `close()` can wait on all of them. */
interface BullBackendState {
  /** Shared ioredis connection used by adaptBullMQJob for XADD/XRANGE. */
  readonly redis: Redis;
  readonly bullConnection: ConnectionOptions;
  readonly eventLogOpts: EventLogOpts | undefined;
  readonly queues: Set<AnyQueue>;
  readonly workers: Set<AnyWorker>;
  closed: boolean;
}

type FailedHandler = (id: string, err: unknown, attempts: number, max: number) => Promise<void> | void;
type ExhaustedHandler = (id: string, err: unknown, attempts: number) => Promise<void> | void;

const openQueue = (state: BullBackendState, name: string, opts: QueueOpts | undefined): AnyQueue => {
  const queue: AnyQueue = new Queue(name, {
    connection: state.bullConnection,
    defaultJobOptions:
      opts?.defaultAttempts !== undefined
        ? { attempts: opts.defaultAttempts }
        : undefined,
  });

  // Attach the default queue error listener: BullMQ re-emits failures of the
  // Queue's INTERNAL connection (a separate ioredis instance, since
  // `bullConnection` is a plain {host, port}) as an "error" event on the
  // Queue itself. An unhandled "error" event would crash the process with
  // ERR_UNHANDLED_ERROR — the same hazard the shared-connection and Worker
  // listeners defend against; log it instead (with the queue name for
  // correlation).
  queue.on("error", (err) => {
    logErrorWithoutThrowing(`[BullMQ] Queue "${name}" error:`, err);
  });
  state.queues.add(queue);
  return queue;
};

const queueHandleFor = <S, C>(queue: AnyQueue, name: string): QueueHandle<S, C> => ({
  async enqueue(id: string, data: { state: S; context: C }, opts?: EnqueueOpts): Promise<void> {
    try {
      // Map/Set in state or context must be tagged for JSON; the getter on
      // adaptBullMQJob inverts this on read.
      await queue.add(id, serializeValue(data), {
        priority: opts?.priority,
        delay: opts?.delayMs,
        attempts: opts?.attempts,
        jobId: opts?.jobId,
        // Dedup: BullMQ rejects a duplicate jobId only while the original
        // is still in waiting/delayed/active state. Once the original
        // completes/fails and is removed (per BullMQ retention), a
        // re-enqueue with the same jobId is accepted as a fresh job.
      });
    } catch (err) {
      throw new Error(
        `[BullMQ] enqueue failed for queue "${name}" job "${id}": ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  },

  async drain(): Promise<void> {
    await queue.drain();
  },

  async close(): Promise<void> {
    await queue.close();
  },
});

const createQueueOn = <S, C>(state: BullBackendState, name: string, opts?: QueueOpts): QueueHandle<S, C> => {
  assertPositiveInteger("defaultAttempts", opts?.defaultAttempts);
  return queueHandleFor<S, C>(openQueue(state, name, opts), name);
};

// Single `worker.on("failed")` listener with internal dispatch.
// Eliminates double-invocation and ordering dependencies from the prior
// dual-listener pattern. Handlers are read at failure time, so ones
// registered after the worker starts still fire.
const dispatchWorkerFailures = (
  worker: AnyWorker,
  name: string,
  failedHandlers: readonly FailedHandler[],
  exhaustedHandlers: readonly ExhaustedHandler[],
): void => {
  worker.on("failed", (job, error) => {
    if (!job?.id) {
      worker.emit(
        "error",
        new Error(`[BullMQ] "failed" event with no job id on queue "${name}"`),
      );
      return;
    }
    const id = job.id;
    const attemptsMade = job.attemptsMade ?? 1;
    const max = job.opts?.attempts ?? 1;

    const reportHandlerFailure = (handlerError: Error): void => {
      worker.emit("error", handlerError);
    };
    if (attemptsMade >= max) {
      for (const handler of exhaustedHandlers) {
        __dispatchFailureHandler(
          () => handler(id, error, attemptsMade),
          reportHandlerFailure,
        );
      }
    } else {
      for (const handler of failedHandlers) {
        __dispatchFailureHandler(
          () => handler(id, error, attemptsMade, max),
          reportHandlerFailure,
        );
      }
    }
  });
};

const createWorkerOn = <S, C>(
  state: BullBackendState,
  name: string,
  process: (job: JobLike<S, unknown, C>) => Promise<void>,
  opts?: WorkerOpts,
): WorkerHandle => {
  assertPositiveInteger("concurrency", opts?.concurrency);

  const worker = new Worker<{ state: S; context: C }>(
    name,
    async (bullJob) => {
      const jobLike = adaptBullMQJob(bullJob, state.redis, name, state.eventLogOpts);
      await process(jobLike);
    },
    {
      connection: state.bullConnection,
      concurrency: opts?.concurrency ?? 1,
    },
  );
  state.workers.add(worker);

  // Attach default worker error listener so internal worker errors don't crash
  // the process when callers have not registered an onError handler.
  worker.on("error", (err) => {
    logErrorWithoutThrowing("[BullMQ] Worker internal error:", err);
  });

  const failedHandlers: FailedHandler[] = [];
  const exhaustedHandlers: ExhaustedHandler[] = [];
  dispatchWorkerFailures(worker, name, failedHandlers, exhaustedHandlers);

  return {
    onFailed(handler: FailedHandler): void {
      failedHandlers.push(handler);
    },

    onExhausted(handler: ExhaustedHandler): void {
      exhaustedHandlers.push(handler);
    },

    onError(handler: (err: Error) => void): void {
      worker.on("error", handler);
    },

    async close(): Promise<void> {
      await worker.close();
    },
  };
};

// Wrap each rejected close in a labelled error (cause preserved).
const closeFailures = (label: string, results: readonly PromiseSettledResult<unknown>[]): Error[] => {
  const errors: Error[] = [];
  for (const r of results) {
    if (r.status === "rejected") {
      const e = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
      errors.push(new Error(`${label} close failed: ${e.message}`, { cause: e }));
    }
  }
  return errors;
};

const closeBackend = async (state: BullBackendState): Promise<void> => {
  if (state.closed) return;
  state.closed = true;

  // Collect partial-close failures into a single AggregateError rather
  // than swallowing them at `warn` level — without this, half-failed
  // shutdowns are indistinguishable from clean ones at the call site.
  const errors: Error[] = [];

  // Close workers first so in-flight jobs settle before queues go away.
  const workerResults = await Promise.allSettled([...state.workers].map((w) => w.close()));
  errors.push(...closeFailures("Worker", workerResults));
  state.workers.clear();

  const queueResults = await Promise.allSettled([...state.queues].map((q) => q.close()));
  errors.push(...closeFailures("Queue", queueResults));
  state.queues.clear();

  // ioredis: quit() flushes pending commands then closes; falls back to
  // disconnect() if the client is already in an end state.
  try {
    if (state.redis.status !== "end") await state.redis.quit();
  } catch (e) {
    errors.push(
      new Error(`Redis quit failed: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e instanceof Error ? e : undefined,
      }),
    );
  }

  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `[BullMQ] close() encountered ${errors.length} partial failure(s); see .errors for details`,
    );
  }
};

/**
 * Creates a `QueueBackend` backed by BullMQ (Queue + Worker).
 *
 * @param connection  Redis connection: URL string or `{ host, port }` object.
 * @param eventLogOpts  Options for the per-job Redis Stream event log (AD-3).
 *
 * FR-045, FR-047
 */
export function createBullMQBackend(
  connection: ConnectionInput,
  eventLogOpts?: EventLogOpts,
): QueueBackend {
  const redisConnection = __parseConnection(connection);

  // Shared ioredis connection used by adaptBullMQJob for XADD/XRANGE
  const redis = new Redis({
    ...redisConnection,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });

  // default error listener: an unhandled ioredis "error" rejection would crash
  // the process; log it instead
  redis.on("error", (err) => {
    logErrorWithoutThrowing("[BullMQ] Shared Redis connection error:", err);
  });

  const state: BullBackendState = {
    redis,
    bullConnection: redisConnection,
    eventLogOpts,
    queues: new Set(),
    workers: new Set(),
    closed: false,
  };

  return {
    createQueue: <S, C>(name: string, opts?: QueueOpts) => createQueueOn<S, C>(state, name, opts),
    createWorker: <S, C>(
      name: string,
      process: (job: JobLike<S, unknown, C>) => Promise<void>,
      opts?: WorkerOpts,
    ) => createWorkerOn<S, C>(state, name, process, opts),
    close: () => closeBackend(state),
  };
}
