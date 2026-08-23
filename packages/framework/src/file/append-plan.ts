// The PURE decision core of a journal append — everything `appendEvent` decides
// once it holds the per-directory lock and the durable listing, with no
// filesystem, no lock and no clock of its own.
//
// `journal.ts`'s `appendEvent` is the imperative shell around this: it lists,
// stamps the injected clock, executes the returned plan with `atomicWriteFile`,
// and normalizes failures at the public journal boundary. The split mirrors the
// `checkpointer.ts` → `checkpointer-codec.ts` template already used by this
// subsystem, and gives the SC-003 convergence / FR-015 dedup / sequence-ceiling
// rules a test surface that needs no temp directory.
//
// Imports no Node built-ins (FR-041).

import {
  EVENTS_DIR,
  JOURNAL_SCHEMA_VERSION,
  MAX_LEXICOGRAPHIC_SEQUENCE,
  keyDigest,
  eventFileName,
  eventDigestOf,
} from "./layout.js";
import {
  parseJournalSequence,
  serializeFileEventRecord,
} from "./event-record.js";
import type { DedupKey, FileEventRecord, RecordedAtMs } from "./event-record.js";
import type { FrameworkError } from "../types/errors.js";
import { fileCacheError, type FileOperation } from "./boundary-error.js";

/**
 * Build the ADR-0080 typed failure for the journal's permanent capacity ceiling.
 * The public error taxonomy stays closed: capacity exhaustion uses the existing
 * `cache-error` kind, with append operation and durable-layout context
 * sufficient to diagnose the non-transient condition.
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

/**
 * Has this keyed append already been committed?
 *
 * Keyed dedup reads the durable listing: the filename digest suffix IS the
 * durable fact, so a crash at any point before/after the rename re-checks the
 * same fact on retry and converges on exactly one record (a no-op only after
 * the commit — SC-003). Callers pass a listing whose entries have already been
 * verified name-contract-valid AND regular files, so a match here is a genuine
 * committed record — never a directory squat that would silently swallow the
 * append.
 *
 * Kept SEPARATE from `planAppend` so the shell can answer it BEFORE reading its
 * clock: a deduped append must not stamp (and so must not be able to fail on) a
 * clock it never needed.
 */
export const isAlreadyCommitted = (
  existing: readonly string[],
  dedupKey: DedupKey,
): boolean => {
  if (dedupKey === "") return false;
  const digest = keyDigest(dedupKey);
  return existing.some((name) => name.endsWith(`-${digest}.json`));
};

/** The bytes and the durable name a planned append commits. */
export interface AppendPlan {
  /** File name (not path) under the run's events directory. */
  readonly fileName: string;
  /** Round-trip-verified canonical record bytes. */
  readonly json: string;
}

/**
 * Decide the record an append commits: sequence assignment, record
 * construction, canonical serialization, and the durable file name.
 *
 * Throws the journal's own typed capacity failure when the listing has reached
 * the lexicographic ceiling, and rides through the already-typed failures
 * `serializeFileEventRecord` raises. Callers must have answered
 * `isAlreadyCommitted` first.
 */
export const planAppend = (args: {
  readonly existing: readonly string[];
  readonly dedupKey: DedupKey;
  readonly recordedAtMs: RecordedAtMs;
  readonly event: unknown;
  /** Diagnostics only — named in the capacity failure. */
  readonly directory: string;
}): AppendPlan => {
  const { existing, dedupKey, recordedAtMs, event, directory } = args;

  const parsedSequence = parseJournalSequence(existing.length);
  if (!parsedSequence.ok) {
    // An array length is always a non-negative safe integer, so the parse can
    // fail on the lexicographic ceiling ONLY — throw the capacity-specific
    // rejection directly (it names the established message contract and the
    // durable listing fact).
    throw journalCapacityError("appendEvent", directory, existing.length);
  }

  const record: FileEventRecord = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    sequence: parsedSequence.value,
    dedupKey,
    recordedAtMs,
    event,
  };

  const json = serializeFileEventRecord(
    record.sequence,
    record.dedupKey,
    record.recordedAtMs,
    record.event,
  );

  // The filename digest is derived from the ROUND-TRIP-VERIFIED canonical bytes
  // just produced (ONE observation of the persisted content, recomputed from
  // `json` exactly as the strict reader will) — never a fresh `toJson` walk over
  // the CALLER-owned event. A stateful proxy event could otherwise serialize one
  // value and digest another, emitting a record whose filename disagrees with
  // its persisted content (the strict reader would fail closed at resume,
  // FR-009). `serializeFileEventRecord` already accomplished the lossless
  // round-trip, so parsing its output is deterministic.
  const canonicalEvent = (JSON.parse(json) as { readonly event: unknown }).event;

  return {
    fileName: eventFileName(
      record.sequence,
      eventDigestOf({
        dedupKey,
        sequence: parsedSequence.value,
        event: canonicalEvent,
      }),
    ),
    json,
  };
};
