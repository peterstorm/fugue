/**
 * Signal handlers — graceful shutdown on SIGTERM/SIGINT, crash on uncaught exceptions.
 *
 * @satisfies FR-060 — Host MUST exit cleanly on SIGTERM after draining in-flight requests
 * @satisfies NFR-020 — Host MUST log startup/shutdown lifecycle events
 * INVARIANT: Double-SIGTERM forces immediate exit (prevents zombie processes during deployment)
 * INVARIANT: Uncaught exceptions and unhandled rejections exit with code 1 (fail-fast)
 */

import type { SyncLogger } from "../sync/sync-loop.js";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Callbacks for signal handling — wired by host.ts.
 */
export interface SignalHandlerDeps {
  readonly onShutdown: () => Promise<void>;
  readonly logger: SyncLogger;
}

/**
 * Handle returned from registerSignalHandlers — used to unregister in tests.
 */
export interface SignalHandlerHandle {
  readonly unregister: () => void;
}

// ── Implementation ─────────────────────────────────────────────────────────

/**
 * Register signal handlers for graceful shutdown.
 *
 * - SIGTERM → begin drain, stop accepting, wait for inflight, exit 0
 * - SIGINT → same (for dev mode Ctrl+C)
 * - Uncaught exception → log, exit 1
 * - Unhandled rejection → log, exit 1
 */
export const registerSignalHandlers = (deps: SignalHandlerDeps): SignalHandlerHandle => {
  const { onShutdown, logger } = deps;
  let shutdownInProgress = false;

  const handleShutdown = async (signal: string) => {
    if (shutdownInProgress) {
      logger.warn(`Received ${signal} again — forcing immediate exit`);
      process.exit(1);
    }
    shutdownInProgress = true;
    logger.info(`Received ${signal} — beginning graceful shutdown`);

    try {
      await onShutdown();
      logger.info("Graceful shutdown complete");
      process.exit(0);
    } catch (e) {
      logger.error("Error during shutdown", {
        error: e instanceof Error ? e.message : String(e),
      });
      process.exit(1);
    }
  };

  const sigterm = () => { handleShutdown("SIGTERM").catch(() => process.exit(1)); };
  const sigint = () => { handleShutdown("SIGINT").catch(() => process.exit(1)); };

  const uncaughtException = (err: Error) => {
    logger.error("Uncaught exception — exiting", {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  };

  const unhandledRejection = (reason: unknown) => {
    logger.error("Unhandled promise rejection — exiting", {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    process.exit(1);
  };

  process.on("SIGTERM", sigterm);
  process.on("SIGINT", sigint);
  process.on("uncaughtException", uncaughtException);
  process.on("unhandledRejection", unhandledRejection);

  return {
    unregister: () => {
      process.off("SIGTERM", sigterm);
      process.off("SIGINT", sigint);
      process.off("uncaughtException", uncaughtException);
      process.off("unhandledRejection", unhandledRejection);
    },
  };
};
