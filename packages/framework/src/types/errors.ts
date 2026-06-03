// Discriminated union of all framework errors

import { match } from "ts-pattern";
import type { RunId, NodeId } from "./ids.js";
// Type-only circular reference with `types/node.ts` (which imports
// `FrameworkError` from this module) — safe: type imports erase at compile
// time, so no runtime cycle exists.
import type { Capability } from "./node.js";

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
       * crash (`"node-crash"`) without parsing `lastError`. The recursive
       * `"retry-exhausted"` value is excluded — a retry-exhausted error
       * never wraps itself.
       */
      readonly rootErrorKind: Exclude<FrameworkError["kind"], "retry-exhausted">;
    }
  | { readonly kind: "checkpoint-missing"; readonly runId: RunId }
  | {
      readonly kind: "checkpoint-expired";
      readonly runId: RunId;
      /** ISO 8601 UTC timestamp. Stored as a string so the error round-trips
       * through `JSON.stringify` / `JSON.parse` without losing type fidelity. */
      readonly expiredAt: string;
    }
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
  | {
      readonly kind: "transient";
      readonly nodeId: NodeId;
      readonly message: string;
      /**
       * HTTP status code when the transient failure originated from an HTTP
       * response (e.g. the built-in http capability). Lets consumers branch
       * on `httpStatus === 404` instead of string-matching the message.
       */
      readonly httpStatus?: number;
    }
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

/** Discriminant union of all error kinds — use for consumer-side exhaustive switches. */
export type FrameworkErrorKind = FrameworkError["kind"];

/**
 * Human-readable single-line summary of a FrameworkError. Exhaustive —
 * adding a new `kind` without a case here is a compile error via
 * ts-pattern's `.exhaustive()`.
 */
export const formatFrameworkError = (e: FrameworkError): string =>
  match(e)
    .with({ kind: "validation" }, (e) => `${e.message} (node '${e.nodeId}')`)
    .with({ kind: "missing-default-edge" }, (e) => `node '${e.nodeId}' has conditional out-edges but no default edge`)
    .with({ kind: "output-unreachable-under-routing" }, (e) => `outputNodeId '${e.outputNodeId}' is not reachable along unconditional + default edges (frontier at '${e.missedFromNode}')`)
    .with({ kind: "duplicate-edge" }, (e) => `duplicate edge '${e.fromNodeId}' -> '${e.toNodeId}'`)
    .with({ kind: "predicate-malformed" }, (e) => `${e.message} (node '${e.nodeId}')`)
    .with({ kind: "cycle-detected" }, (e) => `cycle detected: ${e.nodeIds.join(" -> ")}`)
    .with({ kind: "retry-exhausted" }, (e) => `node '${e.nodeId}' exhausted ${e.attempts} retries (root: ${e.rootErrorKind}): ${e.lastError}`)
    .with({ kind: "node-crash" }, (e) => `node '${e.nodeId}' crashed (${e.retriability}): ${e.message}`)
    .with({ kind: "aborted" }, (e) => `run aborted: ${e.reason}`)
    .with({ kind: "rejected" }, (e) => `node '${e.nodeId}' rejected: ${e.reason}`)
    .with({ kind: "transient" }, (e) => `node '${e.nodeId}' transient failure: ${e.message}`)
    .with({ kind: "prompt-not-found" }, (e) => `prompt '${e.promptName}' not found: ${e.reason}`)
    .with({ kind: "cache-error" }, (e) => `cache ${e.operation} failed: ${e.message}`)
    .with({ kind: "invalid-reroute" }, (e) => `invalid reroute to '${e.targetNodeId}': ${e.message}`)
    .with({ kind: "checkpoint-missing" }, (e) => `checkpoint missing for run '${e.runId}'`)
    .with({ kind: "checkpoint-expired" }, (e) => `checkpoint for run '${e.runId}' expired at ${e.expiredAt}`)
    .with({ kind: "checkpoint-corrupt" }, (e) => `checkpoint corrupt for run '${e.runId}'${e.nodeId ? ` (node '${e.nodeId}')` : ""}: ${e.message}`)
    .with({ kind: "checkpoint-version-mismatch" }, (e) => `checkpoint version mismatch for run '${e.runId}': expected '${e.expected}', got '${e.actual ?? "undefined"}'`)
    .with({ kind: "checkpoint-write-failed" }, (e) => `checkpoint write failed for run '${e.runId}' node '${e.nodeId}': ${e.message}`)
    .with({ kind: "missing-capability" }, (e) => `missing capabilities: ${e.missing.map(m => `${m.capability} (node '${m.nodeId}')`).join(", ")}`)
    .exhaustive();

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
