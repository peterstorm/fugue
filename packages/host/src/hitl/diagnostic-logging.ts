import type { LogPort } from "../ports.js";

/** Emit a HITL diagnostic without allowing logger failure to replace the modeled outcome. */
export const logWithoutThrowing = (
  logger: LogPort | undefined,
  level: "warn" | "error",
  message: string,
  data: Record<string, unknown>,
): void => {
  try {
    logger?.[level]?.(message, data);
  } catch {
    // Diagnostics are subordinate to the caller's typed or durable outcome.
  }
};
