/**
 * HostError — Discriminated union for all host-level errors.
 *
 * Each variant maps to a specific HTTP status code. All domain functions
 * return Result<T, HostError> — no thrown exceptions.
 */

import type { z } from "zod";

// Zod 4 re-exports $ZodIssue as the canonical issue type
type ZodIssue = z.core.$ZodIssue;

export type HostError =
  | { readonly kind: "git-clone-failed"; readonly url: string; readonly message: string }
  | { readonly kind: "git-pull-failed"; readonly message: string }
  | { readonly kind: "git-timeout"; readonly operation: string }
  | { readonly kind: "import-failed"; readonly path: string; readonly message: string; readonly stack?: string }
  | { readonly kind: "validation-failed"; readonly path: string; readonly issues: readonly ZodIssue[] }
  | { readonly kind: "no-default-export"; readonly path: string }
  | { readonly kind: "dag-not-found"; readonly dagId: string; readonly available: readonly string[] }
  | { readonly kind: "dag-disabled"; readonly dagId: string; readonly reason: string }
  | { readonly kind: "concurrency-exceeded"; readonly scope: "global" | "dag"; readonly dagId?: string }
  | { readonly kind: "timeout"; readonly dagId: string; readonly runId: string; readonly timeoutMs: number }
  | { readonly kind: "redis-unavailable"; readonly operation: string }
  | { readonly kind: "bun-install-failed"; readonly message: string }
  | { readonly kind: "config-invalid"; readonly message: string }
  | { readonly kind: "input-validation-failed"; readonly dagId: string; readonly issues: readonly ZodIssue[] }
  | { readonly kind: "dag-validation-failed"; readonly dagId: string; readonly reason: string; readonly message: string }
  | { readonly kind: "discovery-failed"; readonly dagsRoot: string; readonly message: string }
  | { readonly kind: "async-result-expired"; readonly runId: string };

/** Discriminant union of all host error kinds. */
export type HostErrorKind = HostError["kind"];

/**
 * Maps each HostError kind to its corresponding HTTP status code.
 */
export const httpStatusFor = (error: HostError): number => {
  switch (error.kind) {
    case "dag-not-found":
      return 404;
    case "input-validation-failed":
    case "validation-failed":
    case "dag-validation-failed":
      return 400;
    case "concurrency-exceeded":
      return 429;
    case "timeout":
      return 408;
    case "dag-disabled":
    case "redis-unavailable":
      return 503;
    case "async-result-expired":
      return 410;
    case "git-clone-failed":
    case "git-pull-failed":
    case "git-timeout":
    case "import-failed":
    case "no-default-export":
    case "bun-install-failed":
    case "config-invalid":
    case "discovery-failed":
      return 500;
    default: {
      const _exhaustive: never = error;
      return _exhaustive;
    }
  }
};

/**
 * Human-readable single-line summary of a HostError. Exhaustive —
 * adding a new `kind` without a case here is a compile error via the
 * `never` guard.
 */
export const formatHostError = (error: HostError): string => {
  switch (error.kind) {
    case "git-clone-failed":
      return `git clone failed for '${error.url}': ${error.message}`;
    case "git-pull-failed":
      return `git pull failed: ${error.message}`;
    case "git-timeout":
      return `git operation '${error.operation}' timed out`;
    case "import-failed":
      return `import failed for '${error.path}': ${error.message}`;
    case "validation-failed":
      return `validation failed for '${error.path}': ${error.issues.length} issue(s)`;
    case "no-default-export":
      return `no default export found in '${error.path}'`;
    case "dag-not-found":
      return `DAG '${error.dagId}' not found (available: ${error.available.join(", ") || "none"})`;
    case "dag-disabled":
      return `DAG '${error.dagId}' is disabled: ${error.reason}`;
    case "concurrency-exceeded":
      return error.scope === "global"
        ? `global concurrency limit exceeded`
        : `concurrency limit exceeded for DAG '${error.dagId}'`;
    case "timeout":
      return `DAG '${error.dagId}' run '${error.runId}' timed out after ${error.timeoutMs}ms`;
    case "redis-unavailable":
      return `Redis unavailable during '${error.operation}'`;
    case "bun-install-failed":
      return `bun install failed: ${error.message}`;
    case "config-invalid":
      return `host configuration invalid: ${error.message}`;
    case "input-validation-failed":
      return `input validation failed for DAG '${error.dagId}': ${error.issues.length} issue(s)`;
    case "dag-validation-failed":
      return `DAG registration validation failed for '${error.dagId}': ${error.reason}`;
    case "discovery-failed":
      return `DAG discovery failed for '${error.dagsRoot}': ${error.message}`;
    case "async-result-expired":
      return `async result for run '${error.runId}' has expired`;
    default: {
      const _exhaustive: never = error;
      return `unhandled host error kind: ${JSON.stringify(_exhaustive)}`;
    }
  }
};
