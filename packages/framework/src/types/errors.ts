// Discriminated union of all framework errors

export type FrameworkError =
  | { readonly kind: "validation"; readonly nodeId: string; readonly message: string; readonly path?: string }
  | {
      readonly kind: "retry-exhausted";
      readonly nodeId: string;
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
  | { readonly kind: "checkpoint-missing"; readonly runId: string }
  | { readonly kind: "checkpoint-expired"; readonly runId: string; readonly expiredAt: Date }
  | { readonly kind: "checkpoint-corrupt"; readonly runId: string; readonly nodeId?: string; readonly message: string }
  | {
      readonly kind: "checkpoint-version-mismatch";
      readonly runId: string;
      readonly expected: string;
      readonly actual: string | undefined;
    }
  | {
      readonly kind: "checkpoint-write-failed";
      readonly runId: string;
      readonly nodeId: string;
      readonly message: string;
    }
  | { readonly kind: "prompt-not-found"; readonly promptName: string; readonly reason: string }
  | { readonly kind: "cache-error"; readonly operation: string; readonly message: string }
  | {
      readonly kind: "node-crash";
      readonly nodeId: string;
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
  | { readonly kind: "cycle-detected"; readonly nodeIds: readonly string[] }
  | { readonly kind: "aborted"; readonly reason: string }
  | { readonly kind: "rejected"; readonly nodeId: string; readonly reason: string }
  | { readonly kind: "invalid-reroute"; readonly targetNodeId: string; readonly message: string }
  | { readonly kind: "transient"; readonly nodeId: string; readonly message: string }
  | { readonly kind: "missing-default-edge"; readonly nodeId: string }
  | {
      readonly kind: "output-unreachable-under-routing";
      readonly outputNodeId: string;
      readonly missedFromNode: string;
    }
  | { readonly kind: "predicate-malformed"; readonly nodeId: string; readonly message: string }
  | { readonly kind: "duplicate-edge"; readonly fromNodeId: string; readonly toNodeId: string }
  | {
      /**
       * Emitted at run start when a node declares a capability
       * (`requires: ["llm"]`, etc.) but the wired NodeContext does not supply
       * it. The run aborts before any `node.run` is called.
       */
      readonly kind: "missing-capability";
      readonly nodeId: string;
      readonly capability: Capability;
    };

// Imported here rather than at top of file to avoid a circular reference at
// the type-only boundary (Capability lives in `types/node.ts` which itself
// imports from this module only via the `FrameworkError` type alias).
import type { Capability } from "./node.js";
