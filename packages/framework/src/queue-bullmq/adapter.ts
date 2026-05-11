// createBullMQBackend — QueueBackend adapter over BullMQ Queue/Worker
// FR-045, FR-047, AD-3
// Only queue-bullmq/** may import bullmq/ioredis (FR-082)

import { Queue, Worker } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import Redis from "ioredis";
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a Redis URL (redis://host:port) or accept a {host,port} object and
 * return a { host, port } tuple.
 */
function parseConnection(connection: ConnectionInput): { host: string; port: number } {
  if (typeof connection === "string") {
    const url = new URL(connection);
    return {
      host: url.hostname,
      port: parseInt(url.port || "6379", 10),
    };
  }
  return connection;
}

type ConnectionInput = string | { host: string; port: number };

// ---------------------------------------------------------------------------
// createBullMQBackend
// ---------------------------------------------------------------------------

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
  const { host, port } = parseConnection(connection);

  // Shared ioredis connection used by adaptBullMQJob for XADD/XRANGE
  const redis = new Redis(port, host, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });

  // FR-082: attach default error listener to prevent unhandled-rejection crashes
  redis.on("error", (err) => {
    console.error("[BullMQ] Shared Redis connection error:", err);
  });

  const bullConnection: ConnectionOptions = { host, port };

  // Track every queue/worker so close() can wait on all of them.
  const queues = new Set<Queue<any, any, string>>();
  const workers = new Set<Worker<any>>();
  let closed = false;

  function createQueue<S, C>(name: string, opts?: QueueOpts): QueueHandle<S, C> {
    if (
      opts?.defaultAttempts !== undefined &&
      (!Number.isFinite(opts.defaultAttempts) || opts.defaultAttempts < 1)
    ) {
      throw new RangeError(
        `defaultAttempts must be a finite integer >= 1, got ${opts.defaultAttempts}`,
      );
    }

    // Use `any` for BullMQ internals — the public API is typed via QueueHandle<S, C>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queue = new Queue<any, any, string>(name, {
      connection: bullConnection,
      defaultJobOptions:
        opts?.defaultAttempts !== undefined
          ? { attempts: opts.defaultAttempts }
          : undefined,
    });
    queues.add(queue);

    return {
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
    };
  }

  function createWorker<S, C>(
    name: string,
    process: (job: JobLike<S, C>) => Promise<void>,
    opts?: WorkerOpts,
  ): WorkerHandle {
    if (
      opts?.concurrency !== undefined &&
      (!Number.isFinite(opts.concurrency) || opts.concurrency < 1)
    ) {
      throw new RangeError(
        `concurrency must be a finite integer >= 1, got ${opts.concurrency}`,
      );
    }

    const worker = new Worker<{ state: S; context: C }>(
      name,
      async (bullJob) => {
        const jobLike = adaptBullMQJob(bullJob, redis, name, eventLogOpts);
        await process(jobLike);
      },
      {
        connection: bullConnection,
        concurrency: opts?.concurrency ?? 1,
      },
    );
    workers.add(worker);

    // Attach default worker error listener so internal worker errors don't crash
    // the process when callers have not registered an onError handler.
    worker.on("error", (err) => {
      console.error("[BullMQ] Worker internal error:", err);
    });

    return {
      onFailed(
        handler: (
          id: string,
          err: unknown,
          attempts: number,
          max: number,
        ) => Promise<void> | void,
      ): void {
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
          // Per-job max — BullMQ resolves this from EnqueueOpts.attempts ??
          // QueueOpts.defaultAttempts (via defaultJobOptions) ?? 1.
          const max = job.opts?.attempts ?? 1;
          Promise.resolve(handler(id, error, attemptsMade, max)).catch((handlerErr) => {
            worker.emit(
              "error",
              handlerErr instanceof Error ? handlerErr : new Error(String(handlerErr)),
            );
          });
        });
      },

      onError(handler: (err: Error) => void): void {
        worker.on("error", handler);
      },

      async close(): Promise<void> {
        await worker.close();
      },
    };
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;

    // Wave 3 §3.3: collect partial-close failures into a single AggregateError
    // rather than swallowing them at `warn` level. The previous design
    // returned `Promise<void>` even when half the workers failed to drain,
    // so callers couldn't distinguish clean shutdown from partial drain.
    const errors: Error[] = [];

    // Close workers first so in-flight jobs settle before queues go away.
    const workerResults = await Promise.allSettled([...workers].map((w) => w.close()));
    for (const r of workerResults) {
      if (r.status === "rejected") {
        const e = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
        errors.push(new Error(`Worker close failed: ${e.message}`, { cause: e }));
      }
    }
    workers.clear();

    const queueResults = await Promise.allSettled([...queues].map((q) => q.close()));
    for (const r of queueResults) {
      if (r.status === "rejected") {
        const e = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
        errors.push(new Error(`Queue close failed: ${e.message}`, { cause: e }));
      }
    }
    queues.clear();

    // ioredis: quit() flushes pending commands then closes; falls back to
    // disconnect() if the client is already in an end state.
    try {
      if (redis.status !== "end") await redis.quit();
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
  }

  return {
    createQueue,
    createWorker,
    close,
  };
}
