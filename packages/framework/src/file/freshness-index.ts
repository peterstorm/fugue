// Durable filesystem FreshnessIndex (FR-030..FR-032, ADR-0079/ADR-0080).
//
// ADR-0079 stores exactly one bounded latest-write singleton per resource:
//
//   <directory>/<sha256hex(resource)>.json
//   { writtenAtMs, runId, nodeId, executionEpoch, newWitness, succeededAtMs }
//
// History belongs to the event log; this index deliberately persists neither
// an append log nor a Redis member set. Writes for one digest are serialized,
// compared, and atomically replaced. While the current singleton is within
// TTL, a lower succeededAtMs cannot overwrite a newer singleton; an expired
// singleton is replaced by any incoming write (lazy supersede,
// `selectLatestWrite`). Equal scores use Redis's reverse unsigned-binary
// member ordering, making the winner deterministic regardless of arrival
// order. Every successful recordWrite refreshes writtenAtMs (Redis EXPIRE
// parity), including a stale write that loses the comparison. Readers therefore see
// either the complete previous singleton or the complete replacement, never a
// partial record. Expiry is evaluated lazily; there is no sweep or physical GC.
//
// The resource is intentionally unbounded by the port and is never a path
// component: only its sha256 digest reaches the filename. Persisted bytes pass
// through a strict singleton codec and a digest/content resource check.
// Corrupt singletons fail BOTH port methods closed (typed cache-error naming
// the corrupt record — parity with the Redis twin's undecodable-member
// verdict, ADR-0025); logger, filesystem, clock, and hostile runtime-accessor
// failures become typed freshness cache-errors. No raw exception crosses
// either port method.
//
// Symlink policy — a DELIBERATE divergence from the file checkpointer: the
// digest-addressed singletons are read with plain `readFileSync`, which
// FOLLOWS symlinks, while the checkpointer's `verifyExistingFile`/
// `verifyDirectory` lstat-verify every path component as a non-symlink under a
// canonical base anchor. The asymmetry is sound because the filename here is
// not caller-controlled path material — only the sha256 digest is — so the
// caller's `directory` is the sole trust boundary and a symlink inside that
// operator-owned directory is operator-controlled material. The checkpointer,
// by contrast, addresses files with arbitrary caller-supplied composite node
// keys, where a symlink is an in-band attack vector. The write side matches
// the read side: `atomicWriteFile`'s rename REPLACES a symlink at the digest
// path rather than writing through it (pinned in the symlink tests).

import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteFile, withFileLock } from "./atomic.js";
import type { AtomicWriteFileTestHooks } from "./atomic.js";
import { keyDigest } from "./layout.js";
import {
  decideConflict,
  isFiniteNumber,
  parseConditionedOn,
  prepareFreshnessWrite,
  parseStoredFreshnessEntry,
  selectLatestWrite,
  serializeRedisFreshnessMember,
  serializeStoredFreshnessEntry,
} from "./freshness-codec.js";
import type { StoredFreshnessEntry } from "./freshness-codec.js";
import type { WriteAttemptedEvent } from "../types/events.js";
import type { FreshnessIndex, Witness, WriteEntry } from "../types/freshness.js";
import { parseFileFactoryClock } from "./options.js";
import { isFrameworkError, type FrameworkError } from "../types/errors.js";
import { __brandNodeId, __brandRunId } from "../types/ids.js";
import type { Result } from "../types/result.js";
import { err, ok } from "../types/result.js";
import {
  isMissingPathError,
  isMissingPathProbe,
  probeErrorCode,
  safeDiagnosticRender,
  safeErrorMessage,
  safeErrorMessageWithCodeProbe,
  type ErrorCodeProbe,
} from "../types/safe-error.js";
import {
  fileCacheError,
  fileOperationError,
  fileThrownValueMessage,
  isFileBackendPathString,
  LOCK_PROTOCOL_OPERATIONS,
  type FileOperation,
} from "./boundary-error.js";

type FreshnessOperation = Extract<
  FileOperation,
  "freshness:recordWrite" | "freshness:findConflict"
>;

const cacheFailure = (
  operation: FreshnessOperation,
  digest: string | null,
  error: unknown,
  codeProbe?: ErrorCodeProbe,
  failureClass?: "transient" | "permanent",
): FrameworkError =>
  fileCacheError(
    operation,
    `${digest === null ? "resource digest unavailable" : `resource digest ${digest}`}: ${
      codeProbe === undefined
        ? safeErrorMessage(error)
        : safeErrorMessageWithCodeProbe(error, codeProbe)
    }`,
    failureClass,
  );

/**
 * The public freshness surface for a thrown/returned failure (ADR-0080,
 * mirroring the journal's `appendEvent` re-tag at its public boundary):
 *
 * - a typed failure whose operation is in the CLOSED lock-protocol set
 *   (`acquireFileLock` / `withFileLock` / `releaseFileLock` /
 *   `stealStaleFileLock` — atomic.ts internals) is RE-TAGGED to this
 *   operation: the lock's internal mechanics must not name the caller's
 *   port call. The re-tag preserves the inner `failureClass` (inferred from
 *   the wrapped cache-error) and the full diagnostic chain — the
 *   `withFileLock` diagnostic names the lock path and carries the primary
 *   body failure (e.g. the `atomicWriteFile` commit error) nested inside;
 * - any OTHER typed failure already carries its own operation (this port's
 *   operation, or a body-internal one such as `keyDigest`) and rides through
 *   unchanged — re-wrapping it would double-nest the diagnostic and drop
 *   the class;
 * - anything not yet typed is wrapped as this operation's failure.
 */
const surfaceFailure = (
  operation: FreshnessOperation,
  digest: string | null,
  error: unknown,
): FrameworkError => {
  if (
    isFrameworkError(error) &&
    error.kind === "cache-error" &&
    // The public `cache-error.operation` is deliberately `string`-typed for
    // adapter compatibility; narrowing to the closed `FileOperation`
    // vocabulary at this file-backend boundary (boundary-error.ts contract)
    // makes the set-membership test unrepresentable-misspelling safe.
    LOCK_PROTOCOL_OPERATIONS.has(error.operation as FileOperation)
  ) {
    return fileOperationError(
      operation,
      digest === null ? "resource digest unavailable" : `resource digest ${digest}`,
      error,
    );
  }
  if (isFrameworkError(error)) return error;
  return cacheFailure(operation, digest, error);
};

const corruptRecordContext = (
  directory: string,
  recordPath: string,
  digest: string,
  reason: string,
): string =>
  `directory=${JSON.stringify(resolve(directory))} recordPath=${JSON.stringify(resolve(recordPath))} digest=${digest} reason=${reason}`;

/**
 * Freshness-index factory options (the port itself lives in
 * `types/freshness.ts`).
 *
 * Corrupt-singleton semantics (ADR-0079/ADR-0025): a stored freshness entry
 * that fails the strict codec fails `findConflict` CLOSED — a typed
 * `cache-error` naming the corrupt record, exactly like `recordWrite`'s
 * deterministic fail-closed branch. This is Redis twin parity (the Redis
 * adapter withholds the conflict verdict on an undecodable latest member) and
 * the caller's ADR-0025 contract: proceeding without conflict detection
 * would allow undetectable stale writes, so "cannot read the latest write"
 * must never read as "verified no conflict". The corrupted file is never
 * silently replaced by a stale write.
 */
export interface FileFreshnessIndexOptions {
  /** Clock stamping writes and evaluating the lazy 24h TTL. */
  readonly now?: () => number;
}

/** Implementation-module-only options for deterministic failure injection. */
export interface FileFreshnessIndexTestOptions extends FileFreshnessIndexOptions {
  readonly atomicWriteFileHooks?: AtomicWriteFileTestHooks;
}

const createFileFreshnessIndexUnchecked = (
  directory: string,
  opts: FileFreshnessIndexTestOptions = {},
  allowTestHooks = false,
): FreshnessIndex => {
  if (!isFileBackendPathString(directory)) {
    throw new TypeError(`directory must be a non-empty NUL-free string, got ${safeDiagnosticRender(directory)}`);
  }
  // The public options grammar is clock-only. Focused tests opt into the
  // implementation hook through a non-barrel factory below; production callers
  // cannot couple to atomic-write temp-path mechanics.
  const now = parseFileFactoryClock(opts, allowTestHooks ? ["atomicWriteFileHooks"] : []);

  /**
   * Clock read + representability gate, shared by `recordWrite` (write
   * stamp) and `findConflict` (lazy TTL evaluation). Both rejections are
   * code-constructed and deterministic — a throwing or non-finite injected
   * clock fails identically on every retry — so both are pinned
   * "permanent". The checkpointer backends consolidate the same pair the
   * same way (file/checkpointer.ts `readClock`, checkpoint/checkpointer.ts
   * `readClock`); this module keeps that same guard shape for its own two
   * clock sites (`recordWrite`, `findConflict`) — the shared invariant is
   * the guard shape, not a site count, which is what keeps this comment
   * from silently drifting when clock sites are added or removed.
   */
  const readClock = (
    operation: "freshness:recordWrite" | "freshness:findConflict",
    digest: string,
    clockFailedContext: "stamping the write" | "evaluating the freshness TTL",
  ): Result<number, FrameworkError> => {
    try {
      const nowMs = now();
      if (!isFiniteNumber(nowMs)) {
        // Deterministic: a non-finite injected clock fails identically on
        // every retry — pin "permanent" like the other code-constructed
        // invariant rejections.
        return err(
          cacheFailure(
            operation,
            digest,
            "clock must return a finite timestamp",
            undefined,
            "permanent",
          ),
        );
      }
      return ok(nowMs);
    } catch (error) {
      // Deterministic: a throwing injected clock fails identically on
      // every retry — pin "permanent" like the sibling clock sites
      // (journal appendEvent, checkpointer setMeta/load).
      return err(
        cacheFailure(
          operation,
          digest,
          `clock failed while ${clockFailedContext}: ${fileThrownValueMessage(error)}`,
          undefined,
          "permanent",
        ),
      );
    }
  };

  return {
    async recordWrite(event: WriteAttemptedEvent): Promise<Result<void, FrameworkError>> {
      let digest: string | null = null;
      try {
        const prepared = prepareFreshnessWrite(event);
        if (!prepared.ok) {
          // Deterministic: the same invalid event fails identically on retry.
          return err(cacheFailure("freshness:recordWrite", null, prepared.error, undefined, "permanent"));
        }

        const resourceDigest = keyDigest(prepared.value.resource);
        digest = resourceDigest;
        mkdirSync(directory, { recursive: true });
        const recordPath = join(directory, `${resourceDigest}.json`);
        const lockPath = join(directory, `${resourceDigest}.lock`);

        return await withFileLock(lockPath, () => {
          const clocked = readClock("freshness:recordWrite", resourceDigest, "stamping the write");
          if (!clocked.ok) throw clocked.error;
          const nowMs = clocked.value;

          let current: StoredFreshnessEntry | null = null;
          try {
            // Follows symlinks deliberately — module header, "Symlink policy".
            const text = readFileSync(recordPath, "utf-8");
            const parsed = parseStoredFreshnessEntry(text, prepared.value.resource);
            if (!parsed.ok) {
              // Deterministic fail-closed (ADR-0079): the corrupted bytes
              // reproduce the same rejection on every retry — retrying can
              // neither clear them nor make the write safe. Thrown, not
              // returned: the lock body signals failure by throwing so
              // `withFileLock`'s release-failure arbitration preserves this
              // PERMANENT verdict as primary (journal appendEvent parity).
              throw cacheFailure(
                "freshness:recordWrite",
                resourceDigest,
                `stored freshness record is corrupt ${corruptRecordContext(directory, recordPath, resourceDigest, parsed.error)}`,
                undefined,
                "permanent",
              );
            }
            current = parsed.value;
          } catch (error) {
            // A TYPED rejection thrown above (the deterministic corrupt-record
            // verdict) rides through unchanged — only raw fs throws get the
            // ENOENT probe + class inference. Re-wrapping the typed verdict
            // would drop its pinned permanent class (journal parity).
            if (isFrameworkError(error)) throw error;
            const codeProbe = probeErrorCode(error);
            if (!isMissingPathProbe(codeProbe)) {
              // Thrown, not returned: arbitrary non-ENOENT read failures also
              // signal by throwing so the primary failure (with its inferred
              // failureClass) survives a simultaneous release failure.
              throw cacheFailure("freshness:recordWrite", resourceDigest, error, codeProbe);
            }
          }

          const next = selectLatestWrite(current, prepared.value, nowMs);
          atomicWriteFile(recordPath, serializeStoredFreshnessEntry(next), opts.atomicWriteFileHooks);
          return ok(undefined);
        });
      } catch (error) {
        // Public-surface ride-through + lock-protocol re-tag (ADR-0080 —
        // `surfaceFailure`, mirroring the journal's `appendEvent` re-tag):
        // lock-protocol operations name THIS port call, other typed
        // failures keep their own operation, untyped throws are wrapped.
        return err(surfaceFailure("freshness:recordWrite", digest, error));
      }
    },

    async findConflict(
      conditionedOn: Witness,
      sinceMs: number,
    ): Promise<Result<WriteEntry | null, FrameworkError>> {
      let digest: string | null = null;
      try {
        const parsedWitness = parseConditionedOn(conditionedOn);
        if (!parsedWitness.ok) {
          // Deterministic: the same conditioned-on value reproduces the
          // identical rejection on every retry — pin "permanent" like the
          // recordWrite twin's code-constructed rejections.
          return err(cacheFailure("freshness:findConflict", null, parsedWitness.error, undefined, "permanent"));
        }
        if (!isFiniteNumber(sinceMs)) {
          // Deterministic: a non-finite sinceMs fails identically on every
          // retry — pin "permanent" like the recordWrite twin.
          return err(cacheFailure("freshness:findConflict", null, "sinceMs must be finite", undefined, "permanent"));
        }

        digest = keyDigest(parsedWitness.value.resource);
        const recordPath = join(directory, `${digest}.json`);
        let text: string;
        try {
          // Follows symlinks deliberately — module header, "Symlink policy".
          text = readFileSync(recordPath, "utf-8");
        } catch (error) {
          // Absence is ENOENT ONLY — a missing singleton means "no recent
          // write", every other read failure fails closed (parity with
          // recordWrite's non-ENOENT handling).
          if (isMissingPathError(error)) return ok(null);
          const codeProbe = probeErrorCode(error);
          return err(cacheFailure("freshness:findConflict", digest, error, codeProbe));
        }

        const parsed = parseStoredFreshnessEntry(text, parsedWitness.value.resource);
        if (!parsed.ok) {
          // Deterministic fail-closed (ADR-0079/ADR-0025): a corrupt singleton
          // reproduces the same rejection on every read, and an unreadable
          // latest write is NOT a verified no-conflict verdict — the caller
          // must abort the wave rather than proceed without conflict
          // detection (parity with the Redis adapter's undecodable-member
          // rejection and with recordWrite's corrupt branch above).
          return err(
            cacheFailure(
              "freshness:findConflict",
              digest,
              `stored freshness record is corrupt ${corruptRecordContext(directory, recordPath, digest, parsed.error)} — conflict verdict withheld (fail closed)`,
              undefined,
              "permanent",
            ),
          );
        }

        const clocked = readClock("freshness:findConflict", digest, "evaluating the freshness TTL");
        if (!clocked.ok) return clocked;
        const nowMs = clocked.value;
        return ok(
          decideConflict(
            parsed.value,
            parsedWitness.value.value,
            sinceMs,
            nowMs,
          ),
        );
      } catch (error) {
        // Public-surface ride-through + lock-protocol re-tag — the
        // recordWrite twin (ADR-0080, `surfaceFailure`).
        return err(surfaceFailure("freshness:findConflict", digest, error));
      }
    },
  };
};

const createFileFreshnessIndexBoundary = (
  directory: string,
  opts: FileFreshnessIndexTestOptions,
  allowTestHooks: boolean,
): FreshnessIndex => {
  try {
    return createFileFreshnessIndexUnchecked(directory, opts, allowTestHooks);
  } catch (error) {
    throw fileOperationError(
      "createFileFreshnessIndex",
      "factory configuration",
      error,
    );
  }
};

/** Typed factory shell: invalid configuration cannot leak a runtime throw. */
export const createFileFreshnessIndex = (
  directory: string,
  opts: FileFreshnessIndexOptions = {},
): FreshnessIndex => createFileFreshnessIndexBoundary(directory, opts, false);

/** Focused-test factory; intentionally omitted from `@fuguejs/framework/file`. */
export const createFileFreshnessIndexForTesting = (
  directory: string,
  opts: FileFreshnessIndexTestOptions,
): FreshnessIndex => createFileFreshnessIndexBoundary(directory, opts, true);

// Exported only for equal-score parity tests; omitted from the file barrel.
export {
  serializeRedisFreshnessMember as __testSerializeRedisFreshnessMember,
};
