// Pure checkpoint smart constructor for the file journal.
//
// A checkpoint commit is an opaque capability over validated, lossless JSON
// bytes for `{ schemaVersion: 1, data }`. The detached snapshot reconstructed
// from those exact bytes stays module-private; `file/job.ts` reaches it through
// the internal accessor below, while public callers cannot mutate decoded data
// until it disagrees with the proven `json`.
//
// `FileJournal.writeCheckpoint` accepts only values minted here. The nominal
// type prevents ordinary TypeScript callers from supplying arbitrary strings,
// while the module-private WeakSet prevents JavaScript callers from forging a
// structurally similar object.

import { deepJsonEqual, serializeValue } from "../state-machine/serialize.js";
import { safeDiagnosticRender } from "../types/safe-error.js";
import { fileOperationError, fileThrownValueMessage } from "./boundary-error.js";
import { assertLosslessEvent, losslessRoundTrip } from "./event-record.js";
import { JOURNAL_SCHEMA_VERSION } from "./layout.js";

export interface FileCheckpointData<S, C> {
  readonly state: S;
  readonly context: C;
}

/**
 * Runtime brand carried by every issued commit — the type says `true` and
 * the runtime object really carries it (see the mint site below); the
 * module-private WeakSet remains the unforgeability gate.
 */
const FILE_CHECKPOINT_COMMIT: unique symbol = Symbol("FILE_CHECKPOINT_COMMIT");
declare const FILE_CHECKPOINT_DATA_TYPE: unique symbol;

/** Opaque, losslessness-proved checkpoint bytes. Decoded data is not public. */
export interface FileCheckpointCommit<S, C> {
  readonly json: string;
  readonly [FILE_CHECKPOINT_COMMIT]: true;
  /** Compile-time-only invariant carried by the private module symbol. */
  readonly [FILE_CHECKPOINT_DATA_TYPE]?: FileCheckpointData<S, C>;
}

const issuedCommits = new WeakSet<object>();
const issuedCommitData = new WeakMap<object, FileCheckpointData<unknown, unknown>>();

// Module-instance-scoped by design: a commit minted under a DUPLICATED module
// instance (duplicate bundle, pnpm aliasing, two copies of this package)
// fails `isFileCheckpointCommit` as an apparent forgery. That is the safe
// direction — fail closed, never a forged accept — but if a legitimate
// commit starts being rejected after a packaging change, look for two live
// copies of this module before suspecting corruption (round-24 tda-5).

/** Runtime capability check used by the throwing journal boundary. */
export const isFileCheckpointCommit = (
  value: unknown,
): value is FileCheckpointCommit<unknown, unknown> =>
  typeof value === "object" && value !== null && issuedCommits.has(value);

/**
 * Package-internal decoded-data accessor used only by `file/job.ts` after a
 * commit has been minted. It is deliberately omitted from the public file
 * barrel, keeping `FileCheckpointCommit` opaque to package consumers.
 */
export const checkpointDataOf = <S, C>(
  commit: FileCheckpointCommit<S, C>,
): FileCheckpointData<S, C> => {
  const data = issuedCommitData.get(commit);
  if (data === undefined) throw new TypeError("checkpoint commit was not minted by this module instance");
  return data as FileCheckpointData<S, C>;
};

/**
 * Mint the `FileCheckpointCommit` capability: pre-scan the whole
 * `{ schemaVersion, data }` envelope through the shared FR-009 losslessness
 * gate, serialize it ONCE, round-trip verify the exact bytes, and take the
 * deep-equal verdict — the module-private snapshot is reconstructed from
 * those exact committed bytes, so in-memory state can never diverge from
 * `checkpoint.json` (the shared `deepJsonEqual` semantics — NaN equals NaN,
 * `-0` equals `0` — are documented on `state-machine/serialize.ts`).
 */
const serializeFileCheckpointUnchecked = <S, C>(
  data: FileCheckpointData<S, C>,
): FileCheckpointCommit<S, C> => {
  // Write-boundary shape gate, mirroring the strict reader's contract: `data`
  // is the `{ state, context }` envelope the caller's `parseCheckpoint`
  // decodes at resume. This gate EXCLUSIVELY catches shapes the rest of the
  // pipeline admits: a non-object `data` (undefined, null, array, primitive —
  // e.g. `data: [1, 2]`) keeps the envelope own-key check below, passes the
  // FR-009 losslessness pre-scan, and the deep-equal verdict can only catch
  // loss, never shape — so it would fail closed only at the caller's decode,
  // late. (A PLAIN-OBJECT data wearing a reserved tag key like
  // `{"__undefined__":true}` is NOT such a shape: `assertLosslessEvent`
  // below already rejects it at write time.) Refuse the gate-only shapes
  // here, the way the event-side sibling codec refuses a top-level
  // `undefined` event with a named FR-009 reason.
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(
      `serializeFileCheckpoint: data must be a plain object (the { state, context } envelope), got ${data === null ? "null" : Array.isArray(data) ? "Array" : typeof data}: ${safeDiagnosticRender(data)} (FR-009)`,
    );
  }

  const payload = { schemaVersion: JOURNAL_SCHEMA_VERSION, data };
  try {
    // The shared FR-009 walk names this codec (not the event codec) and the
    // payload root (not "event") so a rejected checkpoint data value is
    // attributed to the operation that actually refused it.
    assertLosslessEvent(payload, {
      operation: "serializeFileCheckpoint",
      root: "data",
    });
  } catch (error) {
    throw new Error(
      `checkpoint payload is not losslessly serializable — ${fileThrownValueMessage(error)} (FR-009)`,
    );
  }

  // The toJson → parse-back → envelope-gate → deep-equal verdict pipeline is
  // the SHARED codec core (`losslessRoundTrip`, ONE encoding with the event
  // codec — round-22 cs-4); the message tails below are this codec's
  // byte-pinned inventory, and the envelope shape gate is the `validate` hook.
  const { json, parsed } = losslessRoundTrip(
    payload,
    {
      unserializable: (inner) =>
        `checkpoint payload is not toJson-serializable — ${inner} (FR-009)`,
      notAString: (rendered) =>
        `serialized checkpoint did not produce a JSON string (${rendered}) (FR-009)`,
      parseBackFailed: (inner) =>
        `serialized checkpoint failed to parse back — ${inner} (FR-009)`,
      verdictExcepted: (inner) =>
        `serialized checkpoint failed the losslessness round-trip verification — ${inner} (FR-009)`,
      verdictFailed:
        "checkpoint data is not lossless through toJson — JSON silently drops or mutates non-JSON values (for example, non-finite numbers become null); refusing to persist bytes that diverge from caller state (FR-009)",
    },
    (parsedValue) => {
      if (
        typeof parsedValue !== "object" || parsedValue === null ||
        Array.isArray(parsedValue) ||
        !Object.prototype.hasOwnProperty.call(parsedValue, "data")
      ) {
        throw new Error("serialized checkpoint did not round-trip to the required data envelope (FR-009)");
      }
    },
    (parsedValue) => {
      const detached = (parsedValue as { readonly data: FileCheckpointData<S, C> }).data;
      return deepJsonEqual(serializeValue(detached), serializeValue(data));
    },
  );

  // `parsed` is the RESTORED round-trip value (Map/Set/Date tags decoded):
  // the detached snapshot is what the caller's own parseCheckpoint would
  // receive, so the commit's data and the persisted bytes can never diverge.
  const detached = (parsed as { readonly data: FileCheckpointData<S, C> }).data;

  const commit = Object.freeze({
    json,
    // The nominal brand is carried by the runtime object itself (the
    // interface says `[FILE_CHECKPOINT_COMMIT]: true`), so the type does not
    // lie about what exists; the module-private WeakSet remains the real
    // unforgeability gate.
    [FILE_CHECKPOINT_COMMIT]: true as const,
  }) as FileCheckpointCommit<S, C>;
  issuedCommits.add(commit);
  issuedCommitData.set(commit, detached as FileCheckpointData<unknown, unknown>);
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
