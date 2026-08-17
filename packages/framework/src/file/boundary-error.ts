import { fwLogger } from "../logger.js";
import type { FrameworkError } from "../types/errors.js";
import { formatFrameworkError, isFrameworkError } from "../types/errors.js";
import { frameworkError as publicFrameworkError } from "../types/error-factories.js";
import { safeDiagnosticRender, safeErrorMessage } from "../types/safe-error.js";

/**
 * Total diagnostic rendering for a value thrown at a file-backend boundary.
 * A genuine framework value keeps its structured human rendering; malformed
 * lookalikes and hostile proxies fall back to the independently total caught-
 * value formatter. Diagnostics must never replace the failure being handled.
 */
export const fileThrownValueMessage = (value: unknown): string => {
  try {
    return isFrameworkError(value)
      ? formatFrameworkError(value)
      : safeErrorMessage(value);
  } catch {
    return safeErrorMessage(value);
  }
};

/**
 * Closed, backend-local operation vocabulary for every file error surface.
 * `FrameworkError` intentionally keeps `cache-error.operation: string` for
 * public compatibility; narrowing at this adapter boundary makes misspelled
 * file operations unrepresentable without changing that public contract.
 */
export type FileOperation =
  | "acquireFileLock"
  | "appendEvent"
  | "assertLosslessEvent"
  | "atomicWriteFile"
  | "createFileCheckpointer"
  | "createFileFreshnessIndex"
  | "createFileJob"
  | "createFileJournal"
  | "data"
  | "eventDigestOf"
  | "eventFileName"
  | "freshness:findConflict"
  | "freshness:recordWrite"
  | "keyDigest"
  | "load"
  | "readCheckpoint"
  | "readFileEventRecords"
  | "readFileEvents"
  | "releaseFileLock"
  | "resumeFileJob"
  | "saveNode"
  | "serializeFileCheckpoint"
  | "serializeFileEventRecord"
  | "setMeta"
  | "stealStaleFileLock"
  | "updateData"
  | "updateProgress"
  | "withFileLock"
  | "writeCheckpoint"
  | "writeProgress";

/** Preserve the public string field while constraining file-backend callers.
 * The public factory already branches on `failureClass === undefined` and
 * produces the identical object in both arms — delegate in one call; this
 * wrapper's only job is narrowing `operation` to the closed `FileOperation`
 * vocabulary. */
export const fileCacheError = (
  operation: FileOperation,
  message: string,
  failureClass?: "transient" | "permanent",
): FrameworkError =>
  publicFrameworkError.cacheError(operation, message, failureClass);

/**
 * Construct the closed typed throwing-shell failure used by file operations.
 *
 * `failureClass` is the additive permanent/transient discriminant (see
 * `FrameworkError`'s `cache-error`): deterministic failures that re-running
 * cannot clear are marked `"permanent"` so `retriabilityOf` fast-fails them.
 * When omitted, the class is INFERRED from a wrapped cache-error carrying an
 * explicit class — so the public boundary error preserves the classification
 * of the inner failure (e.g. an `appendEvent` fs-wrap around a permanent
 * codec rejection stays permanent) instead of erasing it.
 */
export const fileOperationError = (
  operation: FileOperation,
  location: unknown,
  reason: unknown,
  failureClass?: "transient" | "permanent",
): FrameworkError => {
  const inferred = failureClass ??
    (isFrameworkError(reason) && reason.kind === "cache-error"
      ? reason.failureClass
      : undefined);
  return fileCacheError(
    operation,
    `${operation} failed at ${
      typeof location === "string" ? location : safeDiagnosticRender(location)
    }: ${fileThrownValueMessage(reason)}`,
    inferred,
  );
};

/**
 * Best-effort diagnostics for low-level cleanup paths. Logger behavior is
 * untrusted too: a host logger must never replace the primary filesystem
 * failure or break lock release with a raw throw.
 */
export const warnWithoutThrowing = (message: string): void => {
  try {
    fwLogger().warn(message);
  } catch {
    // Cleanup and lock correctness take precedence. Result-bearing callers
    // that require an observable warning handle logger failure explicitly.
  }
};
