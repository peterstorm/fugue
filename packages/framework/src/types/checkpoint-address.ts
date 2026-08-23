// The address half of the `checkpoint-write-failed` error variant: the two
// correlated address ADTs, their canonical placeholder inhabitants, and THE ONE
// construction path that parses a raw boundary value into them.
//
// This lives in its own leaf module — importing `ids.js` and nothing else — for
// two reasons. It is the whole of one concern (how a rejected boundary id is
// represented), and it keeps `types/errors.ts` (which needs the builder to
// re-correlate a parsed wire record) out of an import cycle with
// `types/error-factories.ts`.

import {
  ID_PATTERN,
  __brandNodeId,
  __brandRunId,
  nodeId as brandNodeId,
  runId as brandRunId,
} from "./ids.js";
import type { NodeId, RunId } from "./ids.js";

/**
 * Grammar-valid stand-in for a `checkpoint-write-failed` run address whose raw
 * boundary value was REJECTED. Deliberately NOT a `RunId`: the whole point is
 * that a fabricated placeholder must not be readable as the address of a real
 * run. `CheckpointWriteRunAddress` below correlates it with the additive
 * `invalidRunId` diagnostic, so the "inspect `invalidRunId` first" obligation
 * that used to live only in a doc comment is now checked by the compiler.
 */
export type CheckpointPlaceholderRunId = string & {
  readonly __checkpointPlaceholder: "run";
};

/** Node-address twin of {@link CheckpointPlaceholderRunId}. */
export type CheckpointPlaceholderNodeId = string & {
  readonly __checkpointPlaceholder: "node";
};

/**
 * Run address of a failed checkpoint write. Two arms, correlated on the
 * additive diagnostic: either the boundary supplied a grammar-valid id and
 * `runId` genuinely addresses that run, or it did not and `runId` holds the
 * placeholder while the REJECTED RAW bytes live in `invalidRunId`.
 *
 * Reading `.runId` without narrowing yields `RunId | CheckpointPlaceholderRunId`,
 * which is not assignable where a `RunId` is required — so a consumer cannot
 * treat a fabricated placeholder as a run address by forgetting to check. The
 * wire shape is unchanged: the same two field names, the same optionality.
 */
export type CheckpointWriteRunAddress =
  | { readonly runId: RunId; readonly invalidRunId?: undefined }
  | { readonly runId: CheckpointPlaceholderRunId; readonly invalidRunId: string };

/**
 * Node address of a failed checkpoint write — the twin of
 * {@link CheckpointWriteRunAddress}.
 *
 * KNOWN RESIDUAL: the metadata-record placeholder (`META_RECORD_NODE_ID`)
 * inhabits the FIRST arm, because a meta-scoped failure carries no
 * `invalidNodeId` to correlate against. Separating "no node was being written"
 * from "this node was being written" needs an additive on-the-wire
 * discriminant, i.e. a persisted-format change; it is recorded here rather than
 * left implicit.
 */
export type CheckpointWriteNodeAddress =
  | { readonly nodeId: NodeId; readonly invalidNodeId?: undefined }
  | { readonly nodeId: CheckpointPlaceholderNodeId; readonly invalidNodeId: string };

/**
 * A checkpoint write that failed at a persistence boundary. The run and node
 * addresses are correlated ADTs rather than four independent fields, so the
 * placeholder/real distinction is enforced by the type system instead of by the
 * "CONSUMER CONTRACT" prose this shape used to carry.
 */
export type CheckpointWriteFailedError = {
  readonly kind: "checkpoint-write-failed";
  readonly message: string;
} & CheckpointWriteRunAddress &
  CheckpointWriteNodeAddress;

/**
 * Grammar-valid diagnostic locations used ONLY when a rejected raw id cannot
 * inhabit the branded arm of a `checkpoint-write-failed` address (truthful
 * branding — the ADR-0080 surface). THE canonical placeholders: every
 * `checkpoint-write-failed` construction site (the public factory, the
 * in-memory adapter, the file backend's `writeFailed`) reaches them through the
 * builder below, so the naming rule has one encoding. The rejected bytes remain
 * available in the additive `invalidRunId` / `invalidNodeId` diagnostics.
 */
export const CHECKPOINT_INVALID_RUN_ID: CheckpointPlaceholderRunId =
  brandRunId("checkpoint_invalid_run") as string as CheckpointPlaceholderRunId;
export const CHECKPOINT_INVALID_NODE_ID: CheckpointPlaceholderNodeId =
  brandNodeId("checkpoint_invalid_node") as string as CheckpointPlaceholderNodeId;

/**
 * Grammar-valid diagnostic location used for metadata-scoped write failures.
 * `checkpoint-write-failed.nodeId` is a required field, so metadata failures
 * need a truthful internal address even though no DAG node was being written.
 * THE canonical placeholder — imported by the builder below and re-exported
 * from the file codec (`file/checkpointer-codec.ts`) so the
 * `@fuguejs/framework/file` barrel and test imports keep their paths.
 */
export const META_RECORD_NODE_ID: NodeId = __brandNodeId("checkpoint_meta");

/**
 * Total renderer for a rejected raw boundary value: strings are carried
 * UNMODIFIED — the additive `invalidRunId`/`invalidNodeId` fields preserve the
 * rejected RAW bytes, and log-line bounding is `formatFrameworkError`'s single
 * job; non-strings stringify safely, degrading to the unprintable placeholder
 * when `toString` itself throws (FR-040). The ONE encoding shared by every
 * `checkpoint-write-failed` construction site.
 */
export const stringOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "<unprintable>";
  }
};

/**
 * Parse a raw boundary run value into the correlated `CheckpointWriteRunAddress`
 * ADT: a grammar-valid id keeps its own brand; anything else takes the
 * placeholder AND carries the rejected raw bytes, so the two can never be
 * confused by a consumer that forgot to look.
 *
 * `typeof` guard before the pattern test: `RegExp.test` coerces non-strings, so
 * a bypassed numeric brand would otherwise match `ID_PATTERN` and inhabit the
 * branded arm instead of routing through the placeholder + `invalid*` arm.
 */
const checkpointRunAddress = (runIdRaw: unknown): CheckpointWriteRunAddress =>
  typeof runIdRaw === "string" && ID_PATTERN.test(runIdRaw)
    ? { runId: __brandRunId(runIdRaw) }
    : { runId: CHECKPOINT_INVALID_RUN_ID, invalidRunId: stringOf(runIdRaw) };

/**
 * Node twin of `checkpointRunAddress`. `nodeIdRaw === undefined` means "this is
 * the meta record" (distinct from "present but unparseable") and takes
 * `META_RECORD_NODE_ID` with no `invalidNodeId` field.
 */
const checkpointNodeAddress = (
  nodeIdRaw: unknown | undefined,
): CheckpointWriteNodeAddress =>
  nodeIdRaw === undefined
    ? { nodeId: META_RECORD_NODE_ID }
    : typeof nodeIdRaw === "string" && ID_PATTERN.test(nodeIdRaw)
      ? { nodeId: __brandNodeId(nodeIdRaw) }
      : { nodeId: CHECKPOINT_INVALID_NODE_ID, invalidNodeId: stringOf(nodeIdRaw) };

/**
 * THE ONE `checkpoint-write-failed` construction path (the consolidation of the
 * manually-mirrored policy that used to live in the file codec's `writeFailed`
 * and the public factory). Every construction site — the public factory, the
 * file codec, the in-memory adapter, and the persisted-record parser — consumes
 * this builder, so the naming rule has one encoding; output for every input is
 * byte-identical to the pre-consolidation per-site encodings (pinned by the
 * per-backend hostile corpora), and the ADT split is a type-level change only.
 */
export const buildCheckpointWriteFailed = (
  runIdRaw: unknown,
  nodeIdRaw: unknown | undefined,
  message: string,
): CheckpointWriteFailedError => ({
  kind: "checkpoint-write-failed",
  ...checkpointRunAddress(runIdRaw),
  ...checkpointNodeAddress(nodeIdRaw),
  message,
});
