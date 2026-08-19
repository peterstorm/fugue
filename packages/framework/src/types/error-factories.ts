// Ergonomic factory functions for constructing FrameworkError values.
//
// These accept plain strings for nodeId/runId and brand internally,
// providing the parse-don't-validate boundary for consumer code that
// constructs errors outside the framework's node factories. Grammar-invalid
// ids reach the brand smart constructors, which throw (the
// brand-constructor invariant). `checkpointWriteFailed` is the documented
// exception: per the `checkpoint-write-failed` consumer contract
// (types/errors.ts), a rejected raw id never inhabits the branded field — it
// takes the truthful placeholder and the rejected bytes are preserved
// additively in `invalidRunId`/`invalidNodeId`, never a raw throw.

import { ID_PATTERN, __brandNodeId, __brandRunId, nodeId as brandNodeId, runId as brandRunId } from "./ids.js";
import type { NodeId, RunId } from "./ids.js";
import type { FrameworkError, MissingCapability, Retriability } from "./errors.js";
import type { Capability } from "./node.js";

const toNodeId = (nid: string | NodeId): NodeId => brandNodeId(nid as string);
const toRunId = (rid: string | RunId): RunId => brandRunId(rid as string);

/**
 * Grammar-valid diagnostic locations used ONLY when a rejected raw id cannot
 * inhabit the required branded field of a `checkpoint-write-failed` value
 * (truthful branding — the ADR-0080 surface documented on the variant in
 * `errors.ts`). THE canonical placeholders: every `checkpoint-write-failed`
 * construction site (the public factory, the in-memory adapter, the file
 * backend's `writeFailed`) imports these, so the naming rule has one
 * encoding. The rejected bytes remain available in the additive
 * `invalidRunId` / `invalidNodeId` diagnostics.
 */
export const CHECKPOINT_INVALID_RUN_ID: RunId = brandRunId("checkpoint_invalid_run");
export const CHECKPOINT_INVALID_NODE_ID: NodeId = brandNodeId("checkpoint_invalid_node");

/**
 * Grammar-valid diagnostic location used for metadata-scoped write failures.
 * `checkpoint-write-failed.nodeId` is a legacy required field, so metadata
 * failures need a truthful internal address even though no DAG node was being
 * written. THE canonical placeholder — imported by the shared builder below
 * and re-exported from the file codec (`file/checkpointer-codec.ts`) so the
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
 * THE ONE `checkpoint-write-failed` construction path (the consolidation
 * of the manually-mirrored policy that used to live in the file
 * codec's `writeFailed` and the public factory below): valid raw identifiers
 * retain their own brands. Invalid raw identifiers are never branded as
 * themselves — the required legacy fields receive the documented, grammar-
 * valid placeholders while additive diagnostics preserve the rejected bytes
 * (`stringOf`). `nodeIdRaw === undefined` means "this is the meta record"
 * (distinct from "present but unparseable") and takes `META_RECORD_NODE_ID`
 * without an `invalidNodeId` field.
 *
 * `typeof` guard before the pattern test: `RegExp.test` coerces non-strings,
 * so a bypassed numeric brand would otherwise match `ID_PATTERN` and inhabit
 * the branded field instead of routing through the placeholder + `invalid*`
 * diagnostic. Every construction site (the public factory, the file codec,
 * the in-memory adapter) consumes this builder, so the naming rule has one
 * encoding — output for every input is byte-identical to the pre-consolidation
 * per-site encodings (pinned by the per-backend hostile corpora).
 */
export const buildCheckpointWriteFailed = (
  runIdRaw: unknown,
  nodeIdRaw: unknown | undefined,
  message: string,
): FrameworkError => {
  const runIdValid = typeof runIdRaw === "string" && ID_PATTERN.test(runIdRaw);
  const nodeIdValid = typeof nodeIdRaw === "string" && ID_PATTERN.test(nodeIdRaw);
  // Absent means "this is the meta record", which is distinct from "present but
  // unparseable" — the three cases are a chain, so they read as one.
  const nodeId = nodeIdRaw === undefined
    ? META_RECORD_NODE_ID
    : nodeIdValid ? __brandNodeId(nodeIdRaw) : CHECKPOINT_INVALID_NODE_ID;
  return {
    kind: "checkpoint-write-failed",
    runId: runIdValid ? __brandRunId(runIdRaw) : CHECKPOINT_INVALID_RUN_ID,
    nodeId,
    ...(!runIdValid ? { invalidRunId: stringOf(runIdRaw) } : {}),
    ...(nodeIdRaw !== undefined && !nodeIdValid
      ? { invalidNodeId: stringOf(nodeIdRaw) }
      : {}),
    message,
  };
};

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
