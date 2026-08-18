// Pure checkpoint smart constructor for the file journal.
//
// A checkpoint commit is both:
//   1. validated, lossless JSON bytes for `{ schemaVersion: 1, data }`; and
//   2. a detached snapshot reconstructed from those exact bytes.
//
// `FileJournal.writeCheckpoint` accepts only values minted here. The nominal
// type prevents ordinary TypeScript callers from supplying arbitrary strings,
// while the module-private WeakSet prevents JavaScript callers from forging a
// structurally similar object. The detached `data` value is what createFileJob
// installs after the bytes commit, so caller-owned references can never make
// the in-memory snapshot diverge from checkpoint.json.

import { deepJsonEqual, serializeValue, toJson, tryFromJson } from "../state-machine/serialize.js";
import { tryCatch } from "../types/result.js";
import { safeDiagnosticRender } from "../types/safe-error.js";
import { fileOperationError, fileThrownValueMessage } from "./boundary-error.js";
import { assertLosslessEvent } from "./event-record.js";
import { JOURNAL_SCHEMA_VERSION } from "./layout.js";

export interface FileCheckpointData<S, C> {
  readonly state: S;
  readonly context: C;
}

declare const FILE_CHECKPOINT_COMMIT: unique symbol;

/** Opaque, losslessness-proved checkpoint bytes plus their detached data. */
export interface FileCheckpointCommit<S, C> {
  readonly json: string;
  readonly data: FileCheckpointData<S, C>;
  readonly [FILE_CHECKPOINT_COMMIT]: true;
}

const issuedCommits = new WeakSet<object>();

/** Runtime capability check used by the throwing journal boundary. */
export const isFileCheckpointCommit = (
  value: unknown,
): value is FileCheckpointCommit<unknown, unknown> =>
  typeof value === "object" && value !== null && issuedCommits.has(value);

/**
 * Mint the `FileCheckpointCommit` capability: pre-scan the whole
 * `{ schemaVersion, data }` envelope through the shared FR-009 losslessness
 * gate, serialize it ONCE, round-trip verify the exact bytes, and take the
 * deep-equal verdict — the returned `data` snapshot is reconstructed from
 * those exact committed bytes, so in-memory state can never diverge from
 * `checkpoint.json` (the shared `deepJsonEqual` semantics — NaN equals NaN,
 * `-0` equals `0` — are documented on `state-machine/serialize.ts`).
 */
const serializeFileCheckpointUnchecked = <S, C>(
  data: FileCheckpointData<S, C>,
): FileCheckpointCommit<S, C> => {
  // Write-boundary shape gate, mirroring the strict reader's contract: `data`
  // is the `{ state, context }` envelope the caller's `parseCheckpoint`
  // decodes at resume. A non-object `data` (undefined, null, array, primitive)
  // slips through the envelope own-key check below — `{"data":{"__undefined__":true}}`
  // keeps the own key, and the deep-equal verdict can only catch loss, never
  // shape — so it would fail closed only at the caller's decode, late. Refuse
  // it here, the way the event-side sibling codec refuses a top-level
  // `undefined` event with a named FR-009 reason.
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(
      `serializeFileCheckpoint: data must be a plain object (the { state, context } envelope), got ${data === null ? "null" : Array.isArray(data) ? "Array" : typeof data}: ${safeDiagnosticRender(data)} (FR-009)`,
    );
  }

  const payload = { schemaVersion: JOURNAL_SCHEMA_VERSION, data };
  try {
    assertLosslessEvent(payload);
  } catch (error) {
    throw new Error(
      `checkpoint payload is not losslessly serializable — ${fileThrownValueMessage(error)} (FR-009)`,
    );
  }

  const serialized = tryCatch(() => toJson(payload));
  if (!serialized.ok) {
    throw new Error(
      `checkpoint payload is not toJson-serializable — ${serialized.error.message} (FR-009)`,
    );
  }
  const roundTrip = tryFromJson(serialized.value);
  if (!roundTrip.ok) {
    throw new Error(
      `serialized checkpoint failed to parse back — ${roundTrip.error.message} (FR-009)`,
    );
  }
  if (
    typeof roundTrip.value !== "object" || roundTrip.value === null ||
    Array.isArray(roundTrip.value) ||
    !Object.prototype.hasOwnProperty.call(roundTrip.value, "data")
  ) {
    throw new Error("serialized checkpoint did not round-trip to the required data envelope (FR-009)");
  }

  const detached = (roundTrip.value as { readonly data: FileCheckpointData<S, C> }).data;
  if (!deepJsonEqual(serializeValue(detached), serializeValue(data))) {
    throw new Error(
      "checkpoint data is not lossless through toJson — JSON silently drops or mutates non-JSON values (for example, non-finite numbers become null); refusing to persist bytes that diverge from caller state (FR-009)",
    );
  }

  const commit = Object.freeze({
    json: serialized.value,
    data: detached,
  }) as FileCheckpointCommit<S, C>;
  issuedCommits.add(commit);
  return commit;
};

/**
 * Parse caller checkpoint data into an opaque commit and detached snapshot.
 * This exported throwing codec never leaks raw exceptions.
 */
export const serializeFileCheckpoint = <S, C>(
  data: FileCheckpointData<S, C>,
): FileCheckpointCommit<S, C> => {
  try {
    return serializeFileCheckpointUnchecked(data);
  } catch (error) {
    // Deterministic: every rejection in the unchecked codec (top-level shape
    // gate, losslessness pre-scan, toJson, round-trip parse, envelope shape,
    // deep-equal verdict)
    // reproduces identically for the same payload — re-running the transition
    // cannot clear it. Marked permanent so `retriabilityOf` fast-fails instead
    // of burning the retry budget (the event-side twin
    // `serializeFileEventRecord` carries the same class; the taxonomy example
    // in `types/errors.ts` names this exact class).
    throw fileOperationError("serializeFileCheckpoint", "checkpoint data", error, "permanent");
  }
};
