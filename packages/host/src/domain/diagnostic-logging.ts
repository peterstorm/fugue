/**
 * THE host's "emit a diagnostic without letting a broken logger replace the
 * modeled outcome" rule, as a pure function.
 *
 * A diagnostic is subordinate: the caller already holds the authoritative
 * `Result`/`HostError`/shutdown outcome, and a logger that throws must not
 * strand it — a broken logger mid-shutdown must not leave a Redis connection or
 * a live listener behind. One last guarded attempt goes to a channel
 * independent of the configured logger so the failure is not simply lost.
 *
 * This was reimplemented three more times before round 13 (`host.ts`'s
 * `logSafely`, `capability-manager.ts`'s `logLifecycleWithoutThrowing`,
 * `error-handler.ts`'s `logErrorWithoutThrowing`), where a change to the rule
 * would have had to be remembered in each — and where only some had a fallback
 * channel at all.
 *
 * It lives in `domain/` and takes `writeFallback` as a REQUIRED parameter so it
 * performs no I/O of its own: the functional core may use it (the capability
 * lifecycle does) without importing a shell module. `hitl/diagnostic-logging.ts`
 * is the shell binding that supplies stderr as that channel.
 */

import { safeErrorMessage } from "@fuguejs/framework";

/**
 * Any logger a host diagnostic might be handed. Every method is optional
 * because the call sites disagree about which they require (`LogPort` has all
 * three, the capability lifecycle's has none mandatory, the error-handler
 * middleware's has only `error`) — and the body calls through optionally, so
 * the permissive type simply matches what it does.
 */
export type DiagnosticLogger = {
  readonly info?: (msg: string, data?: Record<string, unknown>) => void;
  readonly warn?: (msg: string, data?: Record<string, unknown>) => void;
  readonly error?: (msg: string, data?: Record<string, unknown>) => void;
};

export type DiagnosticFallback = (diagnostic: string) => unknown;

/** Render diagnostic data to a flat string, tolerating a hostile value. */
export const renderDiagnosticData = (data: Record<string, unknown>): string => {
  try {
    return Object.entries(data)
      .map(([key, value]) => `${key}=${safeErrorMessage(value)}`)
      .join(" ");
  } catch {
    return safeErrorMessage(data);
  }
};

/** See the module doc: log, and if the logger throws, say so on `writeFallback`. */
export const logWithoutThrowingTo = (
  logger: DiagnosticLogger | undefined,
  level: "info" | "warn" | "error",
  message: string,
  data: Record<string, unknown>,
  writeFallback: DiagnosticFallback,
): void => {
  try {
    logger?.[level]?.(message, data);
  } catch (loggerError) {
    // Preserve the caller's typed or durable outcome, but make one last guarded
    // attempt through a channel independent of the configured logger.
    try {
      writeFallback(
        `[host diagnostic fallback] ${level} ${message}; ${renderDiagnosticData(data)}; ` +
          `loggerError=${safeErrorMessage(loggerError)}\n`,
      );
    } catch {
      // The modeled outcome remains authoritative when every channel fails.
    }
  }
};
