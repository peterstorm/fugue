// On-disk layout contract for the file-backed durable runtime
// (`@fuguejs/framework/file`).
//
// This module is the SINGLE SOURCE OF TRUTH for the names and constants of the
// on-disk format: directory/file names, the journal schema version, and the
// fail-closed boundary rules used before path construction
// (FR-016/FR-029/NFR-010). Any raw identifier that becomes a path component
// must pass `isBoundaryId` BEFORE `join`. Intentionally digest-addressed values,
// such as freshness resources, instead pass through `keyDigest`; only the digest
// is joined, and the raw value never becomes a path component.
//
// AD-2 digest-filename adaptation: record filenames carry the sha256 hex digest
// of an identifier, never the identifier itself. A spec-valid 256-char
// dedupKey (or a composite checkpoint nodeKey, `dag@<128>@<16>@<16>` — 291
// bytes, the true worst case once namespace and nodeId (128 each) and the
// 16-digit safe-integer index/attempt fields are all at their ceilings)
// would exceed NAME_MAX (255) in a literal `<key>.json` filename;
// `<NNNNNN>-<64-hex>.json` is always 76 bytes for sequences under the
// 6-digit lexicographic ceiling (see `eventFileName`). The digest is REQUIRED —
// truncate-to-fit would silently conflate distinct keys sharing a prefix.
// Event records are key-addressed by `sha256hex(dedupKey)` (deterministic
// across retries, so the dedup decision — made "by filename" from the durable
// listing — is itself durable) or, for keyless appends, content-addressed by
// `sha256hex(`${sequence}|${toJson(event)}`)` so repeated keyless appends can
// never collide and never dedup (parity with in-memory/Redis keyless
// semantics). Every read verifies the filename digest against the parsed
// content; a mismatch fails closed.
//
// INV-1: this module imports only `node:crypto` among `node:*` modules (plus
// framework core) — no broker/queue modules (enforced by `check-imports.ts`,
// scope `file` + `file.ts`). Sibling `file/atomic.ts` legitimately imports
// `node:fs`/`node:path` for its durability primitives.
//
// Dedup-key charset validation (FR-015, `^[A-Za-z0-9:_-]{1,256}$` at the
// persistence boundary) lives in `event-record.ts` with the strict record
// codec; this module only digests keys, and the digest path accepts the full
// spec range without ever placing the raw key on disk.
//
// Keyed/keyless digest disjointness (load-bearing): keyless digest inputs are
// `${sequence}|${toJson(event)}` — they ALWAYS contain the `|` separator —
// while `|` is EXCLUDED from the FR-015 dedupKey charset, enforced by
// `event-record.ts` (the one enforcement point; this module never re-checks
// it). So keyed and keyless digest inputs are structurally disjoint: the
// domains could only collide if a keyed key were allowed to contain `|` —
// e.g. the keyed key `5|{"a":1}` would hash identically to the keyless
// record `(5, {a:1})`, two genuinely different events fighting for one
// filename and silently deduping one — which the charset exclusion makes
// impossible.

import { createHash } from "node:crypto";
import { ID_PATTERN } from "../types/ids.js";
import { toJson } from "../state-machine/serialize.js";
import { fileOperationError } from "./boundary-error.js";

// ---------------------------------------------------------------------------
// On-disk names — the layout contract itself
// ---------------------------------------------------------------------------

/** Subdirectory holding the immutable event log (`NNNNNN-<sha256hex>.json`). */
export const EVENTS_DIR = "events";
/** Atomic projection of the committed `{ schemaVersion: 1, data: { state, context } }` checkpoint (tmp+rename commit). */
export const CHECKPOINT_FILE = "checkpoint.json";
/** Atomic projection of `{ percent }` (tmp+rename commit). */
export const PROGRESS_FILE = "progress.json";
/** Per-run checkpointer metadata (`{ dagId, startedAt, nodeCount, createdAt, … }`). */
export const META_FILE = "meta.json";
/** Per-run checkpointer node entries (`<sha256hex(nodeKey)>.json`). */
export const NODES_DIR = "nodes";
/** Transient rename-born directory lock serializing appends into one journal. */
export const APPEND_LOCK = "append.lock";

/** Schema version stamped on every journal record file (`event-record.ts`). */
export const JOURNAL_SCHEMA_VERSION = 1;

/**
 * Lazy TTL for checkpointer meta and freshness entries, in seconds (24h) —
 * matches the Redis backend's expiry window. Lazy evaluation happens at read
 * time per Redis load-order parity (the validity check mirrors the Redis
 * checkpointer's load path; the freshness side applies the same lazy window
 * per AD-5). The file backend performs no background sweeps.
 */
export const TTL_SECONDS = 86_400;

// ---------------------------------------------------------------------------
// Boundary validation (FR-016/FR-029) and digest/filename mapping (AD-2)
// ---------------------------------------------------------------------------

/**
 * Fail-closed boundary validator for identifiers that will become path
 * components (runId, nodeId, namespace): must be a string matching
 * `ID_PATTERN` (`^[A-Za-z0-9_:-]{1,128}$`). The `typeof` check is load-bearing
 * — `RegExp.prototype.test` coerces non-strings, so `isBoundaryId(123)` would
 * otherwise return `true`. `@`/`|`/`.`/`/`/`\`/NUL/etc. are all rejected, so a
 * validated id can never address anything outside the caller-supplied
 * directory, and composite checkpoint keys (`namespace@nodeId@index@attempt`,
 * AD-1) can never collide with a canonical id by construction.
 */
export const isBoundaryId = (value: unknown): boolean =>
  typeof value === "string" && ID_PATTERN.test(value);

/**
 * sha256 hex digest (64 lowercase hex chars) of a key — the identifier form
 * used in every on-disk filename (`<NNNNNN>-<digest>.json`, `nodes/<digest>.json`,
 * `<digest>.json` freshness files).
 *
 * Well-formed Unicode strings retain the original `sha256(UTF-8(key))`
 * mapping. JavaScript also admits ill-formed UTF-16 strings containing lone
 * surrogates; passing those strings directly to `Hash.update` would first
 * replace every lone surrogate with U+FFFD and conflate distinct resources.
 * Ill-formed strings therefore use an injective code-unit encoding:
 *
 *   0xff || "FUGUE-UTF16-BE\0\x01" || UTF-16BE(code units)
 *
 * `0xff` cannot occur in any well-formed UTF-8 byte sequence, so this domain
 * cannot alias a well-formed UTF-8 preimage. Fixed-width big-endian code units
 * preserve every distinction in JavaScript's string domain, including the
 * exact surrogate value and position.
 */
const ILL_FORMED_UTF16_DOMAIN = Uint8Array.of(
  0xff,
  0x46, 0x55, 0x47, 0x55, 0x45, 0x2d, 0x55, 0x54, 0x46, 0x31, 0x36, 0x2d, 0x42, 0x45,
  0x00, 0x01,
);

const isWellFormedUtf16 = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const encodeIllFormedUtf16 = (value: string): Uint8Array => {
  const encoded = new Uint8Array(ILL_FORMED_UTF16_DOMAIN.length + value.length * 2);
  encoded.set(ILL_FORMED_UTF16_DOMAIN);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    const offset = ILL_FORMED_UTF16_DOMAIN.length + index * 2;
    encoded[offset] = codeUnit >>> 8;
    encoded[offset + 1] = codeUnit & 0xff;
  }
  return encoded;
};

export const keyDigest = (key: string): string => {
  try {
    return createHash("sha256")
      .update(isWellFormedUtf16(key) ? key : encodeIllFormedUtf16(key))
      .digest("hex");
  } catch (error) {
    throw fileOperationError("keyDigest", "digest input", error);
  }
};

/** Zero-pad a sequence to exactly 6 digits (the ceiling guard in
 * `eventFileName` rejects any value past 999999, so padding beyond 6 digits
 * is unreachable). */
const pad6 = (sequence: number): string => String(sequence).padStart(6, "0");

/**
 * Event-record filename for the journal: `${pad6(sequence)}-${digest}.json`.
 * The zero-padded sequence prefix makes lexicographic (sorted) listing equal
 * append order — but ONLY within the 6-digit ceiling: `"1000000-…"` would
 * sort before `"999999-…"`, silently breaking the invariant, so any sequence
 * past `MAX_LEXICOGRAPHIC_SEQUENCE` throws. The digest suffix carries the
 * AD-2 identity.
 *
 * Always 76 bytes for a 64-hex digest — within NAME_MAX (255) for every
 * spec-valid key — for every sequence under the 6-digit ceiling.
 *
 * Guards are programmer-error invariants (constructor-invariant throws per the
 * functional-core rules): a malformed sequence or digest would otherwise
 * silently corrupt the durable log's ordering/dedup keys.
 */

/**
 * The 6-digit lexicographic sequence ceiling (999999) — the shared sequence
 * domain of the NAMING layer (`eventFileName`, `eventDigestOf`) and the
 * CODEC (`serializeFileEventRecord` throws and `parseFileEventRecord` errs
 * on any sequence past it, naming the rule). `"1000000-…"` would sort
 * before `"999999-…"` in a listing, silently breaking sorted-listing =
 * append order, so the ceiling is enforced everywhere a sequence becomes
 * durable — never truncated, never silently out-of-order (AD-2).
 */
export const MAX_LEXICOGRAPHIC_SEQUENCE = 999_999;

const eventFileNameUnchecked = (sequence: number, digest: string): string => {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(
      `eventFileName: sequence must be a non-negative safe integer, got ${sequence}`,
    );
  }
  if (sequence > MAX_LEXICOGRAPHIC_SEQUENCE) {
    throw new Error(
      `eventFileName: sequence ${sequence} exceeds the 6-digit lexicographic ceiling ${MAX_LEXICOGRAPHIC_SEQUENCE} — a 7-digit prefix would sort before "999999-" and break sorted-listing = append order`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(
      `eventFileName: digest must be 64 lowercase hex chars, got "${digest}"`,
    );
  }
  return `${pad6(sequence)}-${digest}.json`;
};

export const eventFileName = (sequence: number, digest: string): string => {
  try {
    return eventFileNameUnchecked(sequence, digest);
  } catch (error) {
    throw fileOperationError("eventFileName", "event filename", error);
  }
};

/**
 * Content digest of an event record, deciding its filename:
 * - keyed (`dedupKey !== ""`): `sha256hex(dedupKey)` — deterministic across
 *   crash-retry boundaries, so a re-derived append of the same key lands on
 *   the same filename and the durable listing dedups it as a no-op.
 * - keyless (`dedupKey === ""`): `sha256hex(`${sequence}|${toJson(event)}`)` —
 *   content-addressed, so repeated keyless appends never collide (parity with
 *   in-memory/Redis keyless semantics). `toJson` preserves Map/Set/Date, so
 *   the digest is stable for the same logical event.
 *
 * The keyed and keyless input domains are structurally DISJOINT: every
 * keyless seed contains `|` (between sequence and JSON), while `|` is
 * excluded from the FR-015 dedupKey charset (enforced by event-record.ts, not
 * here) — so no keyed key can equal a keyless seed, and the filename can
 * never ambiguously address two genuinely different records.
 *
 * The `sequence` guard mirrors `eventFileName`'s on the same domain (a
 * non-negative safe integer): a keyless seed out of that domain would be
 * un-nameable by `eventFileName` anyway, and accepting it would hash a
 * record the rest of the layout contract rejects.
 */
const eventDigestOfUnchecked = (record: {
  readonly dedupKey: string;
  readonly sequence: number;
  readonly event: unknown;
}): string => {
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 0) {
    throw new Error(
      `eventDigestOf: sequence must be a non-negative safe integer — the same domain guard as eventFileName — got ${record.sequence}`,
    );
  }
  return record.dedupKey !== ""
    ? keyDigest(record.dedupKey)
    : keyDigest(`${record.sequence}|${toJson(record.event)}`);
};

export const eventDigestOf = (record: {
  readonly dedupKey: string;
  readonly sequence: number;
  readonly event: unknown;
}): string => {
  try {
    return eventDigestOfUnchecked(record);
  } catch (error) {
    throw fileOperationError("eventDigestOf", "event digest", error);
  }
};
