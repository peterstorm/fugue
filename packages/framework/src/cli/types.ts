// CLI result types — stable JSON shapes consumed by both human readers and
// machine harnesses (LLM authoring tools). These are intentionally simple
// discriminated unions so callers can pattern-match on `ok` and either
// proceed or surface the structured `errors` payload.

import type { FrameworkError } from "../types/errors.js";

/**
 * Lint outcome: either the DAG file imports cleanly and validates, or one or
 * more errors were captured. The error payload is always an array even when
 * exactly one error fires, so consumers don't branch on cardinality.
 */
export type LintResult =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly path: string;
      readonly errors: readonly LintError[];
    };

/**
 * Discriminated lint error. `kind` is a stable string that machine consumers
 * can switch on; the `dagId` is present when the failure was inside a
 * `defineDag` call (the validator surfaces it on `DagDefinitionError`).
 */
export type LintError =
  | {
      readonly kind: "import-failed";
      readonly message: string;
      readonly stack?: string;
    }
  | {
      readonly kind: "no-default-export";
      readonly message: string;
    }
  | {
      readonly kind: "missing-dag-field";
      readonly message: string;
    }
  | {
      readonly kind: "dag-definition-error";
      readonly dagId: string;
      readonly message: string;
      readonly detail: FrameworkError;
    };

/**
 * Describe outcome: a structured summary of a valid DAG file. Always wraps
 * a lint pass — a file that fails to lint also fails to describe, surfacing
 * the same `LintError` array.
 */
export type DescribeResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly dag: DescribedDag;
    }
  | {
      readonly ok: false;
      readonly path: string;
      readonly errors: readonly LintError[];
    };

export interface DescribedDag {
  readonly id: string;
  readonly route: string;
  readonly description: string;
  readonly version: string;
  readonly inputSchema: Record<string, unknown> | null;
  readonly outputSchema: Record<string, unknown> | null;
  readonly outputNodeId: string | null;
  readonly nodes: readonly DescribedNode[];
  readonly edges: readonly DescribedEdge[];
  readonly waves: readonly (readonly string[])[];
  readonly prompts: readonly string[];
  readonly capabilities: readonly string[];
}

export interface DescribedNode {
  readonly id: string;
  readonly kind: string;
  readonly sideEffects: string;
  readonly requires: readonly string[];
  readonly humanReview: boolean;
}

export interface DescribedEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: "unconditional" | "conditional" | "default";
  readonly predicateLabel?: string;
  readonly predicateVersion?: number;
}
