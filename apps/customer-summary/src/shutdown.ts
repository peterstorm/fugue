/**
 * Graceful-shutdown orchestration — extracted from `bootstrap.ts` so the
 * per-step fault isolation is unit-testable with plain fakes (no live tracing /
 * redis / Azure).
 *
 * The guarantee (the "shutdown wedge" class fixed across prior rounds, observability spec FR-028 —
 * export stays off the run's critical path, including teardown):
 * each teardown step is guarded INDEPENDENTLY, so a step that throws/rejects is
 * logged and the REMAINING steps still run. A rejecting trace flush must never
 * strand the BufferedObserver sweep timer, the final Foundry domain-event batch,
 * or the redis connection.
 *
 * Order matters: flush+shutdown traces first (so spans land), then dispose the
 * observer (stop its sweep), then drain the Foundry sink (its isolated
 * Application Insights client batches track calls — the last batch is lost
 * without this), then disconnect redis.
 */
import type { AppLogger } from "./logger.js";

/** Trace-pipeline teardown surface (subset of `TracingHandle`). */
interface TraceShutdownHandle {
  readonly flush: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
}

/**
 * Disposable observer surface: `close()` (the Foundry path's `BufferedObserver`)
 * or `Symbol.dispose`. The default `NoopObserver` has neither, so the dispose
 * step is a no-op on the byte-for-byte-unchanged path.
 */
type DisposableObserver = Partial<Disposable> & { close?: () => void };

/** Foundry domain-event sink drain surface. */
interface SinkFlushHandle {
  readonly flush: () => Promise<void>;
}

/** Redis teardown surface. `ioredis.disconnect()` returns `void`; awaiting it is harmless. */
interface RedisShutdownHandle {
  readonly disconnect: () => void | Promise<void>;
}

/** The teardown handles the shell holds at shutdown time. Nulls = absent. */
export interface ShutdownHandles {
  readonly tracing: TraceShutdownHandle | null;
  readonly observer: DisposableObserver;
  readonly foundrySink: SinkFlushHandle | null;
  readonly redis: RedisShutdownHandle | null;
}

/**
 * Run every teardown step, each independently guarded. Never throws: a failing
 * step is logged at `warn` and the rest proceed.
 */
export const runGracefulShutdown = async (
  handles: ShutdownHandles,
  log: AppLogger,
): Promise<void> => {
  const { tracing, observer, foundrySink, redis } = handles;

  if (tracing) {
    log.info("Flushing traces...");
    try {
      await tracing.flush();
    } catch (e) {
      log.warn("Trace flush failed during shutdown:", e);
    }
    try {
      await tracing.shutdown();
    } catch (e) {
      log.warn("Tracing SDK shutdown failed during shutdown:", e);
    }
  }

  // Stop the BufferedObserver sweep so it doesn't outlive the process. Narrow
  // structurally so the NoopObserver default path is untouched.
  try {
    if (typeof observer.close === "function") {
      observer.close();
    } else if (typeof observer[Symbol.dispose] === "function") {
      observer[Symbol.dispose]!();
    }
  } catch (e) {
    log.warn("Observer dispose failed during shutdown:", e);
  }

  // Drain buffered Foundry domain events before exit. The isolated Application
  // Insights client batches track calls under BOTH auth modes (entra-id differs
  // only by attaching a credential — see foundry-sink.ts createAppInsightsClient),
  // so this final flush is required regardless of mode or the last batch is lost.
  if (foundrySink) {
    log.info("Flushing Foundry domain events...");
    try {
      await foundrySink.flush();
    } catch (e) {
      log.warn("Foundry sink flush failed during shutdown:", e);
    }
  }

  if (redis) {
    try {
      await redis.disconnect();
    } catch (e) {
      log.warn("Redis disconnect failed during shutdown:", e);
    }
  }
};
