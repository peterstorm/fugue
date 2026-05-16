// Discriminated union of all framework errors

import type { RunId, NodeId } from "./ids.js";

export type FrameworkError =
  | { readonly kind: "validation"; readonly nodeId: NodeId; readonly message: string; readonly path?: string }
  | {
      readonly kind: "retry-exhausted";
      readonly nodeId: NodeId;
      readonly attempts: number;
      /**
       * Human-readable summary of the final failure. For `node-crash` and
       * `transient` this is the original `message` field; for other kinds it
       * is `JSON.stringify(error)` so the structured payload is still
       * legible. Prefer `rootErrorKind` for programmatic pattern-matching.
       */
      readonly lastError: string;
      /**
       * Discriminant of the underlying error that exhausted the budget.
       * Lets consumers tell a rate-limit storm (`"transient"`) from a logic
       * crash (`"node-crash"`) without parsing `lastError`.
       */
      readonly rootErrorKind: FrameworkError["kind"];
    }
  | { readonly kind: "checkpoint-missing"; readonly runId: RunId }
  | { readonly kind: "checkpoint-expired"; readonly runId: RunId; readonly expiredAt: Date }
  | { readonly kind: "checkpoint-corrupt"; readonly runId: RunId; readonly nodeId?: NodeId; readonly message: string }
  | {
      readonly kind: "checkpoint-version-mismatch";
      readonly runId: RunId;
      readonly expected: string;
      readonly actual: string | undefined;
    }
  | {
      readonly kind: "checkpoint-write-failed";
      readonly runId: RunId;
      readonly nodeId: NodeId;
      readonly message: string;
    }
  | { readonly kind: "prompt-not-found"; readonly promptName: string; readonly reason: string }
  | { readonly kind: "cache-error"; readonly operation: string; readonly message: string }
  | {
      readonly kind: "node-crash";
      readonly nodeId: NodeId;
      readonly message: string;
      readonly stack?: string;
      /**
       * Explicit retriability discriminant. `"non-retriable"` makes the DAG
       * transition fast-fail this error without consuming the retry budget;
       * use it for deterministic failures (tool-call iteration exhaustion,
       * schema mismatches, prompt-defect loops). `"retriable"` is the default
       * and goes through the standard backoff path.
       */
      readonly retriability: "retriable" | "non-retriable";
    }
  | { readonly kind: "cycle-detected"; readonly nodeIds: readonly NodeId[] }
  | { readonly kind: "aborted"; readonly reason: string }
  | { readonly kind: "rejected"; readonly nodeId: NodeId; readonly reason: string }
  | { readonly kind: "invalid-reroute"; readonly targetNodeId: NodeId; readonly message: string }
  | { readonly kind: "transient"; readonly nodeId: NodeId; readonly message: string }
  | { readonly kind: "missing-default-edge"; readonly nodeId: NodeId }
  | {
      readonly kind: "output-unreachable-under-routing";
      readonly outputNodeId: NodeId;
      readonly missedFromNode: NodeId;
    }
  | { readonly kind: "predicate-malformed"; readonly nodeId: NodeId; readonly message: string }
  | { readonly kind: "duplicate-edge"; readonly fromNodeId: NodeId; readonly toNodeId: NodeId }
  | {
      /**
       * Emitted at run start when one or more nodes declare a capability
       * (`requires: ["llm"]`, etc.) that the wired NodeContext does not
       * supply. The run aborts before any `node.run` is called.
       *
       * `nodeId` and `capability` describe the first miss (kept for
       * backwards-compatible programmatic access); `missing` lists every
       * `(nodeId, capability)` pair so callers can fix all gaps in one pass
       * instead of replaying the run for each missing field.
       */
      readonly kind: "missing-capability";
      readonly nodeId: NodeId;
      readonly capability: Capability;
      readonly missing: readonly { readonly nodeId: NodeId; readonly capability: Capability }[];
    };

// Imported here rather than at top of file to avoid a circular reference at
// the type-only boundary (Capability lives in `types/node.ts` which itself
// imports from this module only via the `FrameworkError` type alias).
import type { Capability } from "./node.js";

/**
 * Human-readable single-line summary of a FrameworkError. Exhaustive —
 * adding a new `kind` without a case here is a compile error via the
 * `never` guard.
 */
export const formatFrameworkError = (e: FrameworkError): string => {
  switch (e.kind) {
    case "validation":
      return `${e.message} (node '${e.nodeId}')`;
    case "missing-default-edge":
      return `node '${e.nodeId}' has conditional out-edges but no default edge`;
    case "output-unreachable-under-routing":
      return `outputNodeId '${e.outputNodeId}' is not reachable along unconditional + default edges (frontier at '${e.missedFromNode}')`;
    case "duplicate-edge":
      return `duplicate edge '${e.fromNodeId}' -> '${e.toNodeId}'`;
    case "predicate-malformed":
      return `${e.message} (node '${e.nodeId}')`;
    case "cycle-detected":
      return `cycle detected: ${e.nodeIds.join(" -> ")}`;
    case "retry-exhausted":
      return `node '${e.nodeId}' exhausted ${e.attempts} retries (root: ${e.rootErrorKind}): ${e.lastError}`;
    case "node-crash":
      return `node '${e.nodeId}' crashed (${e.retriability}): ${e.message}`;
    case "aborted":
      return `run aborted: ${e.reason}`;
    case "rejected":
      return `node '${e.nodeId}' rejected: ${e.reason}`;
    case "transient":
      return `node '${e.nodeId}' transient failure: ${e.message}`;
    case "prompt-not-found":
      return `prompt '${e.promptName}' not found: ${e.reason}`;
    case "cache-error":
      return `cache ${e.operation} failed: ${e.message}`;
    case "invalid-reroute":
      return `invalid reroute to '${e.targetNodeId}': ${e.message}`;
    case "checkpoint-missing":
      return `checkpoint missing for run '${e.runId}'`;
    case "checkpoint-expired":
      return `checkpoint for run '${e.runId}' expired at ${e.expiredAt.toISOString()}`;
    case "checkpoint-corrupt":
      return `checkpoint corrupt for run '${e.runId}'${e.nodeId ? ` (node '${e.nodeId}')` : ""}: ${e.message}`;
    case "checkpoint-version-mismatch":
      return `checkpoint version mismatch for run '${e.runId}': expected '${e.expected}', got '${e.actual ?? "undefined"}'`;
    case "checkpoint-write-failed":
      return `checkpoint write failed for run '${e.runId}' node '${e.nodeId}': ${e.message}`;
    case "missing-capability":
      return `missing capabilities: ${e.missing.map(m => `${m.capability} (node '${m.nodeId}')`).join(", ")}`;
    default: {
      const _exhaustive: never = e;
      return `unhandled error kind: ${JSON.stringify(_exhaustive)}`;
    }
  }
};

/**
 * Error subclass thrown by `runDagAsWorkerJob` so queue adapters (BullMQ)
 * can access the structured framework error after serialization round-trips.
 *
 * Queue workers catch this and see typed fields (`frameworkErrorKind`,
 * `frameworkErrorJson`) instead of parsing the message string. The original
 * `FrameworkError` is also available via `Error.cause`.
 */
export class FrameworkAugmentedError extends Error {
  readonly frameworkErrorKind: FrameworkError["kind"];
  readonly frameworkErrorJson: string;

  constructor(message: string, error: FrameworkError) {
    super(message, { cause: error });
    this.name = "FrameworkAugmentedError";
    this.frameworkErrorKind = error.kind;
    this.frameworkErrorJson = JSON.stringify(error);
  }
}
