import { safeErrorMessage } from "@fuguejs/framework";
import type { LogPort } from "../ports.js";

const renderDiagnosticData = (data: Record<string, unknown>): string => {
  try {
    return Object.entries(data)
      .map(([key, value]) => `${key}=${safeErrorMessage(value)}`)
      .join(" ");
  } catch {
    return safeErrorMessage(data);
  }
};

/** Emit a HITL diagnostic without allowing logger failure to replace the modeled outcome. */
export const logWithoutThrowing = (
  logger: LogPort | undefined,
  level: "warn" | "error",
  message: string,
  data: Record<string, unknown>,
  writeFallback: (diagnostic: string) => unknown = (diagnostic) => process.stderr.write(diagnostic),
): void => {
  try {
    logger?.[level]?.(message, data);
  } catch (loggerError) {
    // Preserve the caller's typed or durable outcome, but make one last guarded
    // attempt through a channel independent of the configured logger.
    try {
      writeFallback(
        `[hitl diagnostic fallback] ${level} ${message}; ${renderDiagnosticData(data)}; ` +
          `loggerError=${safeErrorMessage(loggerError)}\n`,
      );
    } catch {
      // The modeled outcome remains authoritative when every diagnostic channel fails.
    }
  }
};
