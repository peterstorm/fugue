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
  | "spendStore:create"
  | "spendStore:read"
  | "spendStore:add"
  | "data"
  | "eventDigestOf"
  | "eventFileName"
  | "freshness:findConflict"
  | "freshness:hasRecordedWrite"
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

/**
 * The closed set of `FileOperation` values the file-lock protocol (atomic.ts)
 * produces — acquire / with / release / steal. These are the lock's INTERNAL
 * mechanics, not the caller-facing port operation: when one surfaces through
 * a public boundary (the journal's `appendEvent`, the freshness index's
 * `recordWrite` / `findConflict`), the boundary re-tags it to its own
 * operation — the lock detail (lock path, the primary body failure nested
 * inside the `withFileLock` diagnostic) stays in the diagnostic chain,
 * ADR-0080.
 */
export const LOCK_PROTOCOL_OPERATIONS: ReadonlySet<FileOperation> = new Set<FileOperation>([
  "acquireFileLock",
  "withFileLock",
  "releaseFileLock",
  "stealStaleFileLock",
]);

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
 * Path-string domain gate for the file backend's entry points (ADR-0080): a
 * brand-bypassed non-string, empty, or NUL-bearing path must fail closed at
 * the factory/operation boundary, before it can reach `join`/fs as a raw
 * TypeError. ONE encoding for every file-backend entry point, including the
 * atomic, journal, checkpointer, freshness-index, resume, and spend-store
 * surfaces; the per-site DIAGNOSTIC stays at each call site (the message names
 * the site-specific field).
 */
export const isFileBackendPathString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !value.includes("\u0000");

/**
 * Best-effort diagnostics for low-level cleanup paths. Logger behavior is
 * untrusted too: a host logger must never replace the primary filesystem
 * failure or break lock release with a raw throw.
 */
export const warnWithoutThrowing = (
  message: string,
  writeFallback: (diagnostic: string) => unknown = (diagnostic) => process.stderr.write(diagnostic),
): void => {
  try {
    fwLogger().warn(message);
  } catch {
    // Preserve the primary filesystem outcome, but make one last guarded
    // attempt when the configured logger itself is broken.
    try {
      writeFallback(`[file-backend warning fallback] ${message}\n`);
    } catch {
      // Cleanup and lock correctness still take precedence over diagnostics.
    }
  }
};
