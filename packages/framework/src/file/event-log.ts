// Strict read side of the file event log (FR-008/FR-009, AD-2).
//
// `readFileEventRecords` / `readFileEvents` reconstruct the journal's
// records from the durable listing (`<directory>/events/*.json`, sorted —
// the 6-digit sequence prefix makes lexicographic order == append order).
// The reader is strict, and the event log is authoritative: EVERY record
// crosses the strict codec (raw-JSON parse → exact canonical serializer-
// grammar validation → `deserializeValue` → `parseFileEventRecord` from
// `event-record.ts`, fail closed with the source named), and the filename
// is verified against the content three ways:
//
//   1. prefix ↔ content sequence — `NNNNNN` must equal `pad6(record.sequence)`
//   2. strictly contiguous sequences — the i-th record must have `sequence === i`
//      (a gap or a duplicate fails closed; a 7-digit prefix is rejected
//      EARLIER by `parseEventFileName`'s 6-digit shape gate (check 1 above),
//      which structurally bounds the sequence at the 999999 lexicographic
//      ceiling even when the content sequence is within it, before the
//      listing order could be misread as append order)
//   3. filename digest ↔ content recompute — the suffix must equal
//      `eventDigestOf(record)` (keyed: `sha256hex(dedupKey)`; keyless:
//      `sha256hex(sequence|toJson(event))`), a stronger tamper/tear check
//      than Loom's verbatim naming
//
// ANY violation returns `err` with a message naming the offending file — the
// event log is authoritative, so a corrupt entry is never silently dropped
// mid-log (FR-009); the caller (e.g. `resumeFileJob`) decides how to fail
// closed from there. Unlike the journal (whose `JobLike` surface must throw,
// AD-6), the reader returns `Result<_, FrameworkError>` with kind
// `cache-error` (operation `readFileEventRecords` / `readFileEvents`) — the
// resume layer re-tags corruption as `checkpoint-corrupt` with the runId.
//
// Readers need NO lock: event files are immutable and written atomically
// (rename is the commit point); `append.lock/` is a directory and `.tmp.<unique-token>`
// litter never matches `*.json`, so they are invisible to this reader (any
// number of concurrent readers is part of the AD-4 single-writer contract).
//
// Import discipline (INV-1): `node:fs`, `node:path` only among node built-ins.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EVENTS_DIR, eventDigestOf, eventFileName, parseEventFileName } from "./layout.js";
import { parseFileEventRecord, tryParseEventRecordJson } from "./event-record.js";
import type { FileEventRecord } from "./event-record.js";
import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import {
  fileCacheError,
  fileOperationError,
  type FileOperation,
} from "./boundary-error.js";
import {
  probeErrorCode,
  safeErrorMessage,
  safeErrorMessageWithCodeProbe,
} from "../types/safe-error.js";
import type { RecordedEvent } from "../state-machine/types.js";

// ---------------------------------------------------------------------------
// Strict core — returns a precise fail-closed string error (source named)
// ---------------------------------------------------------------------------

type StrictReadFailure = Readonly<{
  readonly message: string;
  /**
   * Set only for deterministic on-disk conditions (corrupt record, broken
   * sequence, filename/digest mismatch) that re-running cannot clear. Fs I/O
   * failures leave it absent — the environment class that replay may clear.
   */
  readonly permanent?: true;
}>;

type StrictResult = Result<readonly FileEventRecord[], StrictReadFailure>;

/**
 * The single strict read path shared by both public readers. List `*.json`
 * in the events directory (sorted), then verify every record and its
 * filename. A missing events directory is an empty log — `ok([])`; the
 * caller (resume) distinguishes "no recoverable state" from corruption.
 */
const readStrict = (directory: string): StrictResult => {
  const eventsDir = join(directory, EVENTS_DIR);
  let names: string[];
  try {
    names = readdirSync(eventsDir).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    // ENOENT = no events dir yet = empty journal; anything else is a real
    // read failure (fail closed with the directory named). A hostile errno
    // getter cannot escape and its inspection failure remains diagnostic.
    const codeProbe = probeErrorCode(error);
    if (codeProbe.kind === "code" && codeProbe.code === "ENOENT") return ok([]);
    return err({
      message: `read ${eventsDir}: ${safeErrorMessageWithCodeProbe(error, codeProbe)}`,
    });
  }

  const records: FileEventRecord[] = [];
  for (const name of names) {
    const source = join(eventsDir, name);
    let contents: string;
    try {
      contents = readFileSync(source, "utf-8");
    } catch (error) {
      // A directory (or symlink to one) squatting a record name is a
      // deterministic squat — re-running cannot clear it, only manual
      // removal — so pin "permanent", parity with the append-time gate in
      // journal.ts listEventFiles. `readFileSync` on a directory throws
      // EISDIR; ENOTDIR would require a path component to substitute between
      // the successful listing and this read — a race, which is environment
      // class. Every other errno is an environment failure replay may clear
      // (a rename racing the listing, a transient I/O fault).
      const codeProbe = probeErrorCode(error);
      const squattingEntry = codeProbe.kind === "code" && codeProbe.code === "EISDIR";
      return err({
        message: `${source}: read failed: ${safeErrorMessage(error)} (FR-009)`,
        ...(squattingEntry ? { permanent: true } : {}),
      });
    }
    // Raw-JSON seam: `tryParseEventRecordJson` validates the complete exact
    // serializer grammar BEFORE `deserializeValue` may reinterpret tags or
    // erase sibling/pollution fields, then restores Map/Set/Date/undefined.
    const raw = tryParseEventRecordJson(contents, source);
    if (!raw.ok) return err({ message: raw.error, permanent: true });
    const parsed = parseFileEventRecord(raw.value, source);
    if (!parsed.ok) return err({ message: parsed.error, permanent: true });
    const record = parsed.value;

    // 1. Filename prefix ↔ content sequence (FR-009). The name is parsed
    // through the SAME encoded inverse of `eventFileName` the journal's
    // listing gate uses (`parseEventFileName` in layout.ts) — no private
    // padding re-encoding: a name the writer can never produce, or a name
    // whose sequence disagrees with the content, fails here.
    const parsedName = parseEventFileName(name);
    if (parsedName === null || parsedName.sequence !== record.sequence) {
      return err({
        message: `${source}: filename prefix "${name.slice(0, 6)}" does not match record sequence ${record.sequence} (FR-009)`,
        permanent: true,
      });
    }

    // 2. Strictly contiguous sequences: the i-th record (sorted listing =
    // append order) must carry sequence i. A gap, a duplicate, or a
    // mis-sorted file is authoritative-log corruption, never a silent drop.
    if (record.sequence !== records.length) {
      return err({
        message: `${source}: sequence ${record.sequence} breaks strict contiguity — expected ${records.length} (FR-009)`,
        permanent: true,
      });
    }

    // 3. Filename digest ↔ content recompute (AD-2 tamper/tear check).
    // `eventFileName` re-validates both sides, so this equality is exact.
    const expected = eventFileName(record.sequence, eventDigestOf(record));
    if (name !== expected) {
      return err({
        message: `${source}: filename digest does not match the recomputed content digest (expected ${expected}, FR-009)`,
        permanent: true,
      });
    }

    records.push(record);
  }
  return ok(records);
};

// ---------------------------------------------------------------------------
// Public readers
// ---------------------------------------------------------------------------

/** Tag a strict-read failure with the entry-point operation (AD-6).
 *
 * The class comes from the failure's own construction site, never from its
 * message text: strict reads fail either on deterministic on-disk conditions
 * (corruption — `permanent`, re-running cannot clear it) or on genuine fs I/O
 * (environment class — left unclassified, replay may clear it). */
const failure = (operation: FileOperation, reason: StrictReadFailure): FrameworkError =>
  fileCacheError(operation, reason.message, reason.permanent === true ? "permanent" : undefined);

/**
 * Strictly read every validated `FileEventRecord` of the journal, in append
 * order. Fails closed on ANY corrupt record, sequence break, or filename
 * mismatch, naming the offending file. Missing events directory ⇒ `ok([])`.
 */
export const readFileEventRecords = (directory: string): Result<readonly FileEventRecord[], FrameworkError> => {
  try {
    const result = readStrict(directory);
    return result.ok ? ok(result.value) : err(failure("readFileEventRecords", result.error));
  } catch (error) {
    return err(fileOperationError("readFileEventRecords", "event-log directory", error));
  }
};

/**
 * Strictly read the journal as kernel `RecordedEvent` envelopes
 * (`{ recordedAtMs, event }`, FR-008) — directly replayable through the pure
 * `replayEvents` fold. Same strictness and failure mode as
 * `readFileEventRecords` (FR-009); envelopes preserve append order.
 */
export const readFileEvents = (directory: string): Result<readonly RecordedEvent<unknown>[], FrameworkError> => {
  try {
    const result = readStrict(directory);
    if (!result.ok) return err(failure("readFileEvents", result.error));
    return ok(result.value.map((r) => ({ recordedAtMs: r.recordedAtMs, event: r.event })));
  } catch (error) {
    return err(fileOperationError("readFileEvents", "event-log directory", error));
  }
};
