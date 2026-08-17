// Durable event journal + atomic projections for the file backend (AD-2/AD-4).
//
// `createFileJournal(directory)` is the WRITE side of the on-disk layout:
//
//   <directory>/events/<NNNNNN>-<digest>.json   immutable event records
//   <directory>/events/append.lock/             transient append lock
//   <directory>/checkpoint.json                 atomic projection of { schemaVersion, data: { state, context } }
//   <directory>/progress.json                   atomic projection of { percent }
//
// `appendEvent` runs the whole append transaction — list existing event
// files, keyed dedup by filename digest suffix, `sequence = count`, atomic
// rename commit — UNDER the per-directory lock (`events/append.lock`,
// `withFileLock` from `atomic.ts`), so persisted
// sequences are contiguous and replayable in lock-acquisition order. The
// relative order of genuinely concurrent calls is scheduler-dependent
// (FR-013, AD-4).
//
// The dedup decision is the durable file listing itself — no index. A keyed
// append (`dedupKey !== ""`) whose `sha256hex(dedupKey)` digest suffix
// already exists in the listing is a no-op. The durable invariant across a
// crash-retry boundary is exactly-ONE-record convergence: a crash before the
// rename leaves 0 records (the retry appends); a crash after the rename
// leaves 1 record (the retry no-ops) — either way the same key re-derives
// the same filename and the listing converges on exactly one record; a
// no-op only happens post-commit (SC-003). Keyless appends are
// content-addressed via `eventDigestOf` (which folds `sequence|toJson(event)`
// in) and NEVER dedup — parity with the in-memory/Redis keyless semantics.
// DedupKey parsing (FR-015) happens at this boundary via
// `parseOptionalDedupKey` from `event-record.ts`, so only omission/undefined
// normalizes to keyless and the store can never emit a record the strict
// reader would reject.
//
// `writeCheckpoint`/`writeProgress` commit atomically via `atomicWriteFile`
// (tmp + rename — a reader observes prior-complete or new-complete, never a
// partial file; FR-006/FR-007). They are deliberately LOCK-FREE: the
// single-writer contract (AD-4, documented on `createFileJob`'s surface in
// `job.ts`) guarantees exactly one writer per run directory, and the resume
// proof backstops any violation.
//
// Failure surface (AD-6): `JobLike` methods are `Promise<void>` — the port
// has no error channel — so fs I/O failures THROW a typed `FrameworkError`
// of kind `cache-error` with the failing operation and the run directory
// named in the message (operation field + message). A failed append is never
// swallowed: it must abort the transition so the retry re-derives it. This
// typed path covers the whole append: list failures, lock-acquire failures
// (e.g. a file squatting on `events/append.lock`), filename computation, the
// 6-digit sequence capacity ceiling, and the atomic rename itself. Capacity
// exhaustion is reported as the existing `cache-error` kind with operation
// `appendEvent` and precise sequence/directory context, as required by AD-6.
// Invariant violations (a non-FR-015 dedupKey, a non-serializable event, a
// non-finite clock value, or progress outside [0,100]) use the same closed
// typed throwing channel: `cache-error` with the exact operation and durable
// path. No plain runtime exception crosses this exported shell (FR-040).
//
// Import discipline (INV-1): `node:fs`, `node:path` only among node built-ins.

import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, withFileLock } from "./atomic.js";
import {
  APPEND_LOCK,
  CHECKPOINT_FILE,
  EVENTS_DIR,
  JOURNAL_SCHEMA_VERSION,
  MAX_LEXICOGRAPHIC_SEQUENCE,
  PROGRESS_FILE,
  keyDigest,
  eventFileName,
  eventDigestOf,
  parseEventFileName,
} from "./layout.js";
import {
  parseJournalSequence,
  parseOptionalDedupKey,
  serializeFileEventRecord,
} from "./event-record.js";
import type { FileEventRecord } from "./event-record.js";
import { isFileCheckpointCommit } from "./checkpoint-record.js";
import type { FileCheckpointCommit } from "./checkpoint-record.js";
import { toJson } from "../state-machine/serialize.js";
import type { FrameworkError } from "../types/errors.js";
import { probeErrorCode, safeDiagnosticRender } from "../types/safe-error.js";
import { parseFileFactoryClock } from "./options.js";
import {
  fileCacheError,
  fileOperationError,
  fileThrownValueMessage,
  isFileBackendPathString,
  type FileOperation,
} from "./boundary-error.js";

// ---------------------------------------------------------------------------
// Errors (AD-6)
// ---------------------------------------------------------------------------

/**
 * Wrap a low-level failure as a typed `cache-error` naming the run directory.
 * `failureClass` marks the deterministic rejection sites (`"permanent"` —
 * re-running the append cannot clear them); I/O sites leave it absent
 * (environment class that replay may clear).
 */
const fsFailure = (
  operation: FileOperation,
  directory: string,
  error: unknown,
  failureClass?: "transient" | "permanent",
): FrameworkError =>
  fileOperationError(operation, `run directory ${directory}`, error, failureClass);

/**
 * The event-file naming contract (AD-2) is parsed through
 * `parseEventFileName` in `layout.ts` — the single encoded inverse of
 * `eventFileName`'s output shape (6-digit zero-padded sequence, `-`,
 * 64-lowercase-hex digest, `.json`). The writer's listing enforces the same
 * contract the strict reader consumes (parity in both directions): an entry
 * that could never have been written by this journal fails the append fast
 * instead of silently inflating the sequence.
 */

/**
 * Build the AD-6 typed failure for the journal's permanent capacity ceiling.
 * The public error taxonomy stays closed: capacity exhaustion uses the
 * existing `cache-error` kind, with append operation and durable-layout
 * context sufficient to diagnose the non-transient condition.
 *
 * Exported at this narrow seam so the classification can be tested without
 * manufacturing a 1,000,000-record directory.
 */
export const journalCapacityError = (
  operation: Extract<FileOperation, "appendEvent">,
  directory: string,
  sequence: number,
): FrameworkError =>
  fileCacheError(
    operation,
    `${operation} failed for run directory ${directory}: sequence ${sequence} exceeds the 6-digit lexicographic ceiling ${MAX_LEXICOGRAPHIC_SEQUENCE} (${EVENTS_DIR} listing) — journal capacity exhausted`,
    // Deterministic: re-running the append reproduces the same ceiling.
    "permanent",
  );

// ---------------------------------------------------------------------------
// Journal options / interface
// ---------------------------------------------------------------------------

export interface FileJournalOptions {
  /**
   * Wall-clock source stamping `recordedAtMs` on appended records.
   * Injected for deterministic tests; defaults to `Date.now`.
   */
  readonly now?: () => number;
}

/**
 * The durable store behind `createFileJob` (and `resumeFileJob`'s read side).
 * Methods throw only typed `FrameworkError` per AD-6 — kind `cache-error`
 * with operation + directory/path named, for infrastructure, capacity, and
 * every runtime invariant rejection.
 */
export interface FileJournal {
  /**
   * Durable append. Keyed appends dedup by the durable listing (filename
   * digest suffix) — a re-derived key is a no-op; keyless appends never
   * dedup. Serialized against concurrent appends by the per-directory lock.
   * Throws typed `cache-error(appendEvent)` for every rejection — never swallows.
   */
  appendEvent(event: unknown, dedupKey?: string): Promise<void>;
  /**
   * Atomic projection of a losslessness-proved checkpoint (tmp + rename),
   * lock-free by the single-writer contract (AD-4). The opaque commit can be
   * created only through `serializeFileCheckpoint`; arbitrary JSON is rejected
   * at both the TypeScript and runtime boundaries.
   */
  writeCheckpoint(commit: FileCheckpointCommit<unknown, unknown>): Promise<void>;
  /** Atomic projection of `{ percent }` (tmp + rename). Invalid progress
   * throws typed `cache-error(writeProgress)` — never persists a
   * `null`-coerced percent. */
  writeProgress(percent: number): Promise<void>;
  /** Raw contents of `checkpoint.json` (the `writeCheckpoint` shape
   * contract), or `null` when the file is genuinely ABSENT (ENOENT only).
   * An existing-but-unreadable file is an fs failure, not absence: every
   * other errno (EACCES, ENOTDIR, …) throws a typed `FrameworkError` —
   * reporting a permission-broken run directory as "no checkpoint" would
   * be a silent fresh start. Parsing is the caller's business (the resume
   * layer's strict `parseCheckpoint`). */
  readCheckpoint(): string | null;
}

// ---------------------------------------------------------------------------
// createFileJournal
// ---------------------------------------------------------------------------

/**
 * Create the journal store for one run directory. No directory is created
 * until the first write; run-directory lifecycle is the consumer's concern
 * (FR-044).
 */
export const createFileJournal = (
  directory: string,
  opts: FileJournalOptions = {},
): FileJournal => {
  let now: () => number;
  try {
    // One wrap per failure — the body throws plain diagnostic strings (as
    // `parseFileFactoryClock` already does) and the single outer catch wraps
    // once at `"factory configuration"`, structurally identical to the
    // `createFileCheckpointer` / `createFileFreshnessIndex` factories.
    if (!isFileBackendPathString(directory)) {
      throw new Error(
        `directory must be a non-empty NUL-free string, got ${safeDiagnosticRender(directory)}`,
      );
    }
    now = parseFileFactoryClock(opts);
  } catch (error) {
    throw fileOperationError("createFileJournal", "factory configuration", error);
  }
  const eventsDir = join(directory, EVENTS_DIR);
  const checkpointPath = join(directory, CHECKPOINT_FILE);
  const progressPath = join(directory, PROGRESS_FILE);

  /**
   * List the durable event files (`*.json`) in append order (AD-2: the
   * 6-digit sequence prefix makes lexicographic order == append order).
   *
   * Classification is by name SUFFIX only — `append.lock/` (a directory) and
   * `.tmp.<unique-token>` litter is invisible because it does not end in `.json`;
   * there is no stat in the filter, so a DIRECTORY wearing a `*.json` name
   * IS listed (a name-only counter would count it). Every listed name is
   * therefore verified against the event-file naming contract
   * (`parseEventFileName` — the single encoded inverse of the `eventFileName`
   * output shape in layout.ts: 6-digit zero-padded sequence + `-` + 64-hex
   * digest + `.json`) and its entry type
   * (must be a regular file): a foreign `*.json` entry (e.g. `README.json`),
   * a renamed (externally moved) record, or a non-regular file squatting on
   * a record name would otherwise silently inflate `sequence = count` (and
   * a squat could dedup a keyed append as a no-op), committing a record the
   * journal's own strict reader rejects at resume time — the failure
   * deferred from append-time to read-time. (A DELETED record, by contrast,
   * cannot appear in the durable listing at all: it produces a contiguity
   * gap that the strict reader catches, not a count inflation.) Fail fast
   * instead, with a typed `cache-error` naming the offending entry
   * (fail-fast parity with the strict reader in `event-log.ts`).
   */
  const listEventFiles = (): readonly string[] => {
    let names: string[];
    try {
      names = readdirSync(eventsDir).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      throw fsFailure("appendEvent", directory, error);
    }
    for (const name of names) {
      const entryPath = join(eventsDir, name);
      if (parseEventFileName(name) === null) {
        throw fsFailure(
          "appendEvent",
          directory,
          new Error(
            `${entryPath} does not match the event-file naming contract (eventFileName: 6-digit zero-padded sequence + "-" + 64-hex digest + ".json") — a foreign or stale *.json entry would silently inflate the sequence and commit a record the strict reader rejects; fail closed at append time (FR-009)`,
          ),
          // Deterministic: the foreign entry reproduces the identical rejection
          // on every retry of the same append; only manual removal clears it.
          "permanent",
        );
      }
      let isRegular: boolean;
      try {
        isRegular = statSync(entryPath).isFile();
      } catch (error) {
        throw fsFailure("appendEvent", directory, error);
      }
      if (!isRegular) {
        throw fsFailure(
          "appendEvent",
          directory,
          new Error(
            `${entryPath} is not a regular file — a directory (or other non-regular file) wearing a record name is listed by the name-only *.json filter but must not be counted as an event: it would silently inflate the sequence and could dedup a keyed append as a no-op; fail closed at append time, parity with the strict reader (FR-009)`,
          ),
          // Deterministic: the squatting entry reproduces the identical rejection
          // on every retry of the same append; only manual removal clears it.
          "permanent",
        );
      }
    }
    return names;
  };

  const appendEvent = async (event: unknown, suppliedDedupKey?: unknown): Promise<void> => {
    // Snapshot and parse the runtime argument exactly once. Only omission or
    // explicit `undefined` maps to the durable keyless sentinel; in
    // particular, `null` must not be erased by nullish coalescing. The parser
    // rejects non-string objects without rendering/coercing them, so hostile
    // getters, Proxies, and stateful conversion hooks cannot execute here.
    const parsedKey = parseOptionalDedupKey(suppliedDedupKey);
    if (!parsedKey.ok) {
      // Deterministic FR-015 violation — the same key fails identically on
      // every retry, so the retry machinery must fast-fail it.
      throw fileOperationError(
        "appendEvent",
        `run directory ${directory}`,
        `${parsedKey.error}; value is not FR-015-valid — expected omitted/undefined, explicit keyless "", or keyed ^[A-Za-z0-9:_-]{1,256}$ with no "|"; if this came from runStateMachine's "|"-bearing fallback, inject a digest-based computeDedupKey`,
        "permanent",
      );
    }
    const key = parsedKey.value;
    try {
      mkdirSync(eventsDir, { recursive: true });
    } catch (error) {
      throw fsFailure("appendEvent", directory, error);
    }

    // The whole append transaction — list, dedup, sequence, commit — runs
    // under the per-directory lock. Persisted sequences are therefore
    // contiguous and replayable in acquisition order (in-process via
    // Promise.all or across processes); concurrent relative order is chosen
    // by the scheduler.
    //
    // Acquisition, lock-body, and owned-release failures are all normalized
    // at the append boundary (AD-6). `withFileLock` arbitrates body vs cleanup:
    // release failure rejects an otherwise successful body, while a body
    // failure remains primary if cleanup also fails.
    const lockPath = join(eventsDir, APPEND_LOCK);
    try {
      await withFileLock(lockPath, () => {
        const existing = listEventFiles();

        // Keyed dedup by the durable listing: the filename digest suffix IS
        // the durable fact, so a crash at any point before/after the rename
        // re-checks the same fact on retry and converges on exactly one record
        // (a no-op only after the commit — SC-003). Every listed entry has
        // already been verified name-contract-valid AND a regular file
        // (listEventFiles), so a match here is a genuine committed record —
        // never a directory squat that would silently swallow the append.
        if (key !== "") {
          const digest = keyDigest(key);
          if (existing.some((name) => name.endsWith(`-${digest}.json`))) return;
        }

        const parsedSequence = parseJournalSequence(existing.length);
        if (!parsedSequence.ok) {
          // An array length is always a non-negative safe integer, so the
          // parse can fail on the lexicographic ceiling ONLY — throw the
          // capacity-specific rejection directly (it names the established
          // message contract and the durable listing fact).
          throw journalCapacityError("appendEvent", directory, existing.length);
        }
        // The injected clock is stamped inside the append critical section
        // and is the one dependency that can fail without touching the
        // filesystem — name it explicitly so a throwing or non-finite clock
        // is diagnosed as a clock failure, not misattributed to the lock
        // machinery or the record codec (parity with the checkpointer and
        // freshness-index clock guards).
        let recordedAtMs: number;
        try {
          recordedAtMs = now();
          if (!Number.isFinite(recordedAtMs)) {
            throw new Error(
              `clock returned a non-finite timestamp ${safeDiagnosticRender(recordedAtMs)}`,
            );
          }
        } catch (error) {
          // Deterministic: a clock that throws or stamps non-finite fails
          // identically on every retry of the same append — the same class
          // the other code-constructed invariant rejections pin "permanent".
          throw fileOperationError(
            "appendEvent",
            `run directory ${directory}`,
            `clock failed while stamping the append: ${fileThrownValueMessage(error)}`,
            "permanent",
          );
        }
        const record: FileEventRecord = {
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          sequence: parsedSequence.value,
          dedupKey: key,
          recordedAtMs,
          event,
        };

        let json: string;
        try {
          json = serializeFileEventRecord(
            record.sequence,
            record.dedupKey,
            record.recordedAtMs,
            record.event,
          );
        } catch (error) {
          throw fsFailure("appendEvent", directory, error);
        }
        try {
          atomicWriteFile(
            join(eventsDir, eventFileName(record.sequence, eventDigestOf(record))),
            json,
          );
        } catch (error) {
          throw fsFailure("appendEvent", directory, error);
        }
      });
    } catch (error) {
      // withFileLock preserves a primary append-body failure when release also
      // fails, and rejects on a release failure after an otherwise successful
      // body. Re-tag both paths at the public journal boundary.
      throw fsFailure("appendEvent", directory, error);
    }
  };

  const writeCheckpoint = async (
    commit: FileCheckpointCommit<unknown, unknown>,
  ): Promise<void> => {
    let validCommit: FileCheckpointCommit<unknown, unknown>;
    try {
      if (!isFileCheckpointCommit(commit)) {
        throw new TypeError(
          `checkpoint must be an opaque commit minted by serializeFileCheckpoint, got ${safeDiagnosticRender(commit)}`,
        );
      }
      validCommit = commit;
    } catch (error) {
      // Deterministic caller bug (not an opaque commit) — retrying cannot
      // clear it; the TypeError's rendered value stays in the message.
      throw fileOperationError(
        "writeCheckpoint",
        checkpointPath,
        error,
        "permanent",
      );
    }
    try {
      mkdirSync(directory, { recursive: true });
      atomicWriteFile(checkpointPath, validCommit.json);
    } catch (error) {
      throw fsFailure("writeCheckpoint", directory, error);
    }
  };

  const writeProgress = async (percent: number): Promise<void> => {
    // NaN/±Infinity/out-of-range percent would otherwise persist as
    // `{"percent":null}`. Reject through the same typed throwing shell before
    // any filesystem touch.
    if (
      typeof percent !== "number" ||
      !Number.isFinite(percent) ||
      percent < 0 ||
      percent > 100
    ) {
      throw fileOperationError(
        "writeProgress",
        progressPath,
        `percent must be a finite number in [0, 100], got ${safeDiagnosticRender(percent)}`,
        // Deterministic: the same value fails identically on retry.
        "permanent",
      );
    }
    const json = toJson({ percent });
    try {
      mkdirSync(directory, { recursive: true });
      atomicWriteFile(progressPath, json);
    } catch (error) {
      throw fsFailure("writeProgress", directory, error);
    }
  };

  const readCheckpoint = (): string | null => {
    try {
      return readFileSync(checkpointPath, "utf-8");
    } catch (error) {
      // Absence is ENOENT ONLY: `existsSync` swallows EACCES/ENOTDIR and
      // would misreport a permission-broken directory as "no checkpoint".
      // The sibling strict readers (event-log.ts, file/checkpointer.ts)
      // probe the same way.
      const probe = probeErrorCode(error);
      if (probe.kind === "code" && probe.code === "ENOENT") return null;
      throw fsFailure("readCheckpoint", directory, error);
    }
  };

  return { appendEvent, writeCheckpoint, writeProgress, readCheckpoint };
};
