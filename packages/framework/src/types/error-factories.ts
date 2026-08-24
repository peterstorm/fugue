// Ergonomic factory functions for constructing FrameworkError values.
//
// These accept plain strings for nodeId/runId and brand internally,
// providing the parse-don't-validate boundary for consumer code that
// constructs errors outside the framework's node factories. Grammar-invalid
// ids reach the brand smart constructors, which throw (the
// brand-constructor invariant). `checkpointWriteFailed` is the documented
// exception: per the correlated address ADTs in `types/checkpoint-address.ts`,
// a rejected raw id never inhabits the branded arm — it takes the placeholder
// and the rejected bytes are preserved additively in
// `invalidRunId`/`invalidNodeId`, never a raw throw.

import { nodeId as brandNodeId, runId as brandRunId } from "./ids.js";
import { buildCheckpointWriteFailed } from "./checkpoint-address.js";
import type { NodeId, RunId } from "./ids.js";
import type { FrameworkError, MissingCapability, Retriability } from "./errors.js";
import type { Capability } from "./node.js";

const toNodeId = (nid: string | NodeId): NodeId => brandNodeId(nid as string);
const toRunId = (rid: string | RunId): RunId => brandRunId(rid as string);

// The checkpoint-address concern — the correlated address ADTs, their
// canonical placeholders, the `stringOf` raw-value renderer and THE ONE
// `checkpoint-write-failed` builder — lives in its own leaf module. Re-exported
// here so every existing import path (`types/error-factories.js`, and the file
// codec's own re-export) keeps resolving.
export {
  buildCheckpointWriteFailed,
  CHECKPOINT_INVALID_NODE_ID,
  CHECKPOINT_INVALID_RUN_ID,
  META_RECORD_NODE_ID,
  stringOf,
} from "./checkpoint-address.js";
export type {
  CheckpointPlaceholderNodeId,
  CheckpointPlaceholderRunId,
  CheckpointWriteFailedError,
  CheckpointWriteNodeAddress,
  CheckpointWriteRunAddress,
} from "./checkpoint-address.js";

/** Ergonomic factories for constructing FrameworkError values with string node/run IDs. */
export const frameworkError = {
  // --- Node-scoped errors ---

  validation: (nid: string | NodeId, message: string, path?: string): FrameworkError =>
    ({ kind: "validation", nodeId: toNodeId(nid), message, ...(path !== undefined ? { path } : {}) }),

  nodeCrash: (nid: string | NodeId, message: string, opts?: {
    retriability?: Retriability;
    stack?: string;
  }): FrameworkError => ({
    kind: "node-crash",
    nodeId: toNodeId(nid),
    message,
    retriability: opts?.retriability ?? "retriable",
    ...(opts?.stack !== undefined ? { stack: opts.stack } : {}),
  }),

  transient: (nid: string | NodeId, message: string, httpStatus?: number): FrameworkError =>
    ({ kind: "transient", nodeId: toNodeId(nid), message, ...(httpStatus !== undefined ? { httpStatus } : {}) }),

  rejected: (nid: string | NodeId, reason: string): FrameworkError =>
    ({ kind: "rejected", nodeId: toNodeId(nid), reason }),

  invalidReroute: (targetNodeId: string | NodeId, message: string): FrameworkError =>
    ({ kind: "invalid-reroute", targetNodeId: toNodeId(targetNodeId), message }),

  retryExhausted: (
    nid: string | NodeId,
    attempts: number,
    lastError: string,
    rootErrorKind: Exclude<FrameworkError["kind"], "retry-exhausted">,
  ): FrameworkError =>
    ({ kind: "retry-exhausted", nodeId: toNodeId(nid), attempts, lastError, rootErrorKind }),

  missingDefaultEdge: (nid: string | NodeId): FrameworkError =>
    ({ kind: "missing-default-edge", nodeId: toNodeId(nid) }),

  predicateMalformed: (nid: string | NodeId, message: string): FrameworkError =>
    ({ kind: "predicate-malformed", nodeId: toNodeId(nid), message }),

  rootExpectsInput: (nid: string | NodeId, message: string): FrameworkError =>
    ({ kind: "root-expects-input", nodeId: toNodeId(nid), message }),

  sourceHasIncoming: (nid: string | NodeId, message: string): FrameworkError =>
    ({ kind: "source-has-incoming", nodeId: toNodeId(nid), message }),

  invalidDagInputEdge: (edge: { readonly from: string; readonly to: string }, message: string): FrameworkError =>
    ({ kind: "invalid-dag-input-edge", edge: { from: edge.from, to: edge.to }, message }),

  outputUnreachable: (outputNodeId: string | NodeId, missedFromNode: string | NodeId): FrameworkError =>
    ({ kind: "output-unreachable-under-routing", outputNodeId: toNodeId(outputNodeId), missedFromNode: toNodeId(missedFromNode) }),

  duplicateEdge: (fromNodeId: string | NodeId, toNodeId_: string | NodeId): FrameworkError =>
    ({ kind: "duplicate-edge", fromNodeId: toNodeId(fromNodeId), toNodeId: toNodeId(toNodeId_) }),

  missingCapability: (
    nid: string | NodeId,
    capability: Capability,
    rest: readonly { readonly nodeId: string | NodeId; readonly capability: Capability }[] = [],
  ): FrameworkError => {
    // `nid`/`capability` are the guaranteed first miss; `rest` adds any further
    // gaps. Building the tuple head-first proves the non-empty `missing` field
    // to the type system without a cast. Consumers read `missing[0]` for the
    // first miss — it is never duplicated as a scalar field.
    const head: MissingCapability = { nodeId: toNodeId(nid), capability };
    const tail = rest.map((m) => ({ nodeId: toNodeId(m.nodeId as string), capability: m.capability }));
    return {
      kind: "missing-capability",
      missing: [head, ...tail],
    };
  },

  // --- Run-scoped errors ---

  checkpointMissing: (rid: string | RunId): FrameworkError =>
    ({ kind: "checkpoint-missing", runId: toRunId(rid) }),

  checkpointExpired: (rid: string | RunId, expiredAt: Date | string): FrameworkError =>
    ({
      kind: "checkpoint-expired",
      runId: toRunId(rid),
      expiredAt: typeof expiredAt === "string" ? expiredAt : expiredAt.toISOString(),
    }),

  checkpointCorrupt: (rid: string | RunId, message: string, nid?: string | NodeId): FrameworkError =>
    ({ kind: "checkpoint-corrupt", runId: toRunId(rid), message, ...(nid !== undefined ? { nodeId: toNodeId(nid) } : {}) }),

  checkpointVersionMismatch: (rid: string | RunId, expected: string, actual: string | undefined): FrameworkError =>
    ({ kind: "checkpoint-version-mismatch", runId: toRunId(rid), expected, actual }),

  // Truthful branding (the documented exception to this module's
  // brand-throwing default) — delegates to `buildCheckpointWriteFailed`, THE
  // one construction path shared with the file backend and the in-memory
  // adapter (the `checkpoint-write-failed` consumer contract in `errors.ts`).
  // This entry point's typed signature is the frozen public surface: `nid`
  // is always present, so the meta-record case is unreachable here.
  checkpointWriteFailed: (rid: string | RunId, nid: string | NodeId, message: string): FrameworkError =>
    buildCheckpointWriteFailed(rid, nid, message),

  // --- Structural errors ---

  cycleDetected: (nodeIds: readonly (string | NodeId)[]): FrameworkError =>
    ({ kind: "cycle-detected", nodeIds: nodeIds.map((n) => toNodeId(n as string)) }),

  aborted: (reason: string): FrameworkError =>
    ({ kind: "aborted", reason }),

  // --- Infrastructure errors ---

  promptNotFound: (promptName: string, reason: string): FrameworkError =>
    ({ kind: "prompt-not-found", promptName, reason }),

  cacheError: (
    operation: string,
    message: string,
    failureClass?: "transient" | "permanent",
  ): FrameworkError =>
    failureClass === undefined
      ? { kind: "cache-error", operation, message }
      : { kind: "cache-error", operation, message, failureClass },
} as const;
