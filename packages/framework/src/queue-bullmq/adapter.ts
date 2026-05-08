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

  // BullMQ connection options (separate from the shared redis client above —
  // BullMQ manages its own connection pool internally)
  const bullConnection: ConnectionOptions = { host, port };

  function createQueue<J>(name: string, _opts?: QueueOpts): QueueHandle<J> {
    // Use `any` for BullMQ internals — the public API is typed via QueueHandle<J>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queue = new Queue<any, any, string>(name, {
      connection: bullConnection,
    });

    return {
      async enqueue(id: string, data: J, opts?: EnqueueOpts): Promise<void> {
        try {
          await queue.add(id, data, {
            priority: opts?.priority,
            delay: opts?.delayMs,
            attempts: opts?.attempts,
            jobId: opts?.jobId,
            // Dedup: BullMQ ignores duplicate jobId by default
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
      opts?.maxAttempts !== undefined &&
      (!Number.isFinite(opts.maxAttempts) || opts.maxAttempts < 1)
    ) {
      throw new RangeError(
        `maxAttempts must be a finite integer >= 1, got ${opts.maxAttempts}`,
      );
    }
    if (
      opts?.concurrency !== undefined &&
      (!Number.isFinite(opts.concurrency) || opts.concurrency < 1)
    ) {
      throw new RangeError(
        `concurrency must be a finite integer >= 1, got ${opts.concurrency}`,
      );
    }

    const maxAttempts = opts?.maxAttempts ?? 1;

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
          Promise.resolve(handler(id, error, attemptsMade, maxAttempts)).catch((handlerErr) => {
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

  return {
    createQueue,
    createWorker,
  };
}
