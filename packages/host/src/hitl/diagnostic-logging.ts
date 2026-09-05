/**
 * Shell binding of the host diagnostic rule: `domain/diagnostic-logging.ts`
 * owns the behaviour and performs no I/O; this supplies stderr as the
 * independent fallback channel, which is I/O and so belongs out here.
 */

import {
  logWithoutThrowingTo,
  type DiagnosticFallback,
  type DiagnosticLogger,
} from "../domain/diagnostic-logging.js";

export type { DiagnosticLogger } from "../domain/diagnostic-logging.js";

/** Emit a host diagnostic without allowing logger failure to replace the modeled outcome. */
export const logWithoutThrowing = (
  logger: DiagnosticLogger | undefined,
  level: "info" | "warn" | "error",
  message: string,
  data: Record<string, unknown>,
  writeFallback: DiagnosticFallback = (diagnostic) => process.stderr.write(diagnostic),
): void => logWithoutThrowingTo(logger, level, message, data, writeFallback);
