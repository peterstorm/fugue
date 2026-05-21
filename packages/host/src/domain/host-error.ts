/**
 * HostError — Discriminated union for all host-level errors.
 *
 * Each variant maps to a specific HTTP status code. All domain functions
 * return Result<T, HostError> — no thrown exceptions.
 */

import { match } from "ts-pattern";
import type { z } from "zod";
import type { DagId, RunId } from "@fugue/framework";

// Zod 4 re-exports $ZodIssue as the canonical issue type
type ZodIssue = z.core.$ZodIssue;

export type HostError =
  | { readonly kind: "git-clone-failed"; readonly url: string; readonly message: string }
  | { readonly kind: "git-pull-failed"; readonly message: string }
  | { readonly kind: "git-timeout"; readonly operation: string }
  | { readonly kind: "git-spawn-failed"; readonly operation: string; readonly message: string }
  | { readonly kind: "import-failed"; readonly path: string; readonly message: string; readonly stack?: string }
  | { readonly kind: "validation-failed"; readonly path: string; readonly issues: readonly ZodIssue[] }
  | { readonly kind: "no-default-export"; readonly path: string }
  | { readonly kind: "dag-not-found"; readonly dagId: DagId; readonly available: readonly DagId[] }
  | { readonly kind: "dag-disabled"; readonly dagId: DagId; readonly reason: string }
  | { readonly kind: "concurrency-exceeded"; readonly scope: "global" | "dag"; readonly dagId?: DagId }
  | { readonly kind: "timeout"; readonly dagId: DagId; readonly runId: RunId; readonly timeoutMs: number }
  | { readonly kind: "redis-unavailable"; readonly operation: string }
  | { readonly kind: "bun-install-failed"; readonly message: string }
  | { readonly kind: "config-invalid"; readonly message: string }
  | { readonly kind: "input-validation-failed"; readonly dagId: DagId; readonly issues: readonly ZodIssue[] }
  | { readonly kind: "dag-validation-failed"; readonly dagId: DagId; readonly reason: string; readonly message: string }
  | { readonly kind: "body-parse-failed"; readonly dagId: DagId; readonly message: string }
  | { readonly kind: "discovery-failed"; readonly dagsRoot: string; readonly message: string }
  | { readonly kind: "async-result-expired"; readonly runId: RunId };

export type HostErrorKind = HostError["kind"];

/**
 * Maps each HostError kind to its corresponding HTTP status code.
 */
export const httpStatusFor = (error: HostError): number =>
  match(error)
    .with({ kind: "dag-not-found" }, () => 404)
    .with({ kind: "input-validation-failed" }, () => 400)
    .with({ kind: "validation-failed" }, () => 400)
    .with({ kind: "dag-validation-failed" }, () => 400)
    .with({ kind: "body-parse-failed" }, () => 400)
    .with({ kind: "concurrency-exceeded" }, () => 429)
    .with({ kind: "timeout" }, () => 408)
    .with({ kind: "dag-disabled" }, () => 503)
    .with({ kind: "redis-unavailable" }, () => 503)
    .with({ kind: "async-result-expired" }, () => 410)
    .with({ kind: "git-clone-failed" }, () => 500)
    .with({ kind: "git-pull-failed" }, () => 500)
    .with({ kind: "git-timeout" }, () => 500)
    .with({ kind: "git-spawn-failed" }, () => 500)
    .with({ kind: "import-failed" }, () => 500)
    .with({ kind: "no-default-export" }, () => 500)
    .with({ kind: "bun-install-failed" }, () => 500)
    .with({ kind: "config-invalid" }, () => 500)
    .with({ kind: "discovery-failed" }, () => 500)
    .exhaustive();

/**
 * Human-readable single-line summary of a HostError. Exhaustive —
 * adding a new `kind` without a case here is a compile error via
 * ts-pattern's `.exhaustive()`.
 */
export const formatHostError = (error: HostError): string =>
  match(error)
    .with({ kind: "git-clone-failed" }, (e) => `git clone failed for '${e.url}': ${e.message}`)
    .with({ kind: "git-pull-failed" }, (e) => `git pull failed: ${e.message}`)
    .with({ kind: "git-timeout" }, (e) => `git operation '${e.operation}' timed out`)
    .with({ kind: "git-spawn-failed" }, (e) => `git spawn failed for '${e.operation}': ${e.message}`)
    .with({ kind: "import-failed" }, (e) => `import failed for '${e.path}': ${e.message}`)
    .with({ kind: "validation-failed" }, (e) => `validation failed for '${e.path}': ${e.issues.length} issue(s)`)
    .with({ kind: "no-default-export" }, (e) => `no default export found in '${e.path}'`)
    .with({ kind: "dag-not-found" }, (e) => `DAG '${e.dagId}' not found (available: ${e.available.join(", ") || "none"})`)
    .with({ kind: "dag-disabled" }, (e) => `DAG '${e.dagId}' is disabled: ${e.reason}`)
    .with({ kind: "concurrency-exceeded" }, (e) =>
      e.scope === "global"
        ? `global concurrency limit exceeded`
        : `concurrency limit exceeded for DAG '${e.dagId}'`,
    )
    .with({ kind: "timeout" }, (e) => `DAG '${e.dagId}' run '${e.runId}' timed out after ${e.timeoutMs}ms`)
    .with({ kind: "redis-unavailable" }, (e) => `Redis unavailable during '${e.operation}'`)
    .with({ kind: "bun-install-failed" }, (e) => `bun install failed: ${e.message}`)
    .with({ kind: "config-invalid" }, (e) => `host configuration invalid: ${e.message}`)
    .with({ kind: "input-validation-failed" }, (e) => `input validation failed for DAG '${e.dagId}': ${e.issues.length} issue(s)`)
    .with({ kind: "dag-validation-failed" }, (e) => `DAG registration validation failed for '${e.dagId}': ${e.reason}`)
    .with({ kind: "body-parse-failed" }, (e) => `request body parse failed for DAG '${e.dagId}': ${e.message}`)
    .with({ kind: "discovery-failed" }, (e) => `DAG discovery failed for '${e.dagsRoot}': ${e.message}`)
    .with({ kind: "async-result-expired" }, (e) => `async result for run '${e.runId}' has expired`)
    .exhaustive();
