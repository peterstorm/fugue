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

// Structural equality over canonical `serializeValue` forms — the SHARED
// `deepJsonEqual` from state-machine/serialize.ts (the one FR-009 verdict
// definition shared with the event-record codec). NaN equals NaN so the JSON
// round-trip can expose its coercion to null; -0 intentionally equals 0
// because JSON canonicalizes that one documented representation.

const serializeFileCheckpointUnchecked = <S, C>(
  data: FileCheckpointData<S, C>,
): FileCheckpointCommit<S, C> => {
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
    throw fileOperationError("serializeFileCheckpoint", "checkpoint data", error);
  }
};
