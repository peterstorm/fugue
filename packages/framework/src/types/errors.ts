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
