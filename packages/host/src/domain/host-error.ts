/**
 * HostError — Discriminated union for all host-level errors.
 *
 * Each variant maps to a specific HTTP status code. All domain functions
 * return Result<T, HostError> — no thrown exceptions.
 */

import { match } from "ts-pattern";
import type { z } from "zod";
import type { DagId, RunId } from "@fuguejs/framework";

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
  | { readonly kind: "global-concurrency-exceeded" }
  | { readonly kind: "dag-concurrency-exceeded"; readonly dagId: DagId }
  | { readonly kind: "timeout"; readonly dagId: DagId; readonly runId: RunId; readonly timeoutMs: number }
  | { readonly kind: "redis-unavailable"; readonly operation: string }
  | { readonly kind: "bun-install-failed"; readonly message: string }
  | { readonly kind: "config-invalid"; readonly message: string }
  | { readonly kind: "input-validation-failed"; readonly dagId: DagId; readonly issues: readonly ZodIssue[] }
  | { readonly kind: "dag-validation-failed"; readonly dagId: DagId; readonly reason: string; readonly message: string }
  | { readonly kind: "body-parse-failed"; readonly dagId: DagId; readonly message: string }
  | { readonly kind: "discovery-failed"; readonly dagsRoot: string; readonly message: string }
  | { readonly kind: "async-result-expired"; readonly runId: RunId }
  | { readonly kind: "unauthorized"; readonly reason: string }
  | { readonly kind: "forbidden"; readonly dagId: DagId; readonly callerTeam: string; readonly dagTeam: string }
  | { readonly kind: "team-already-exists"; readonly team: string }
  | { readonly kind: "team-not-found"; readonly team: string }
  | { readonly kind: "internal-invariant-violated"; readonly message: string; readonly context: Record<string, unknown> };

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
    .with({ kind: "global-concurrency-exceeded" }, () => 429)
    .with({ kind: "dag-concurrency-exceeded" }, () => 429)
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
    .with({ kind: "unauthorized" }, () => 401)
    .with({ kind: "forbidden" }, () => 403)
    .with({ kind: "team-already-exists" }, () => 409)
    .with({ kind: "team-not-found" }, () => 404)
    .with({ kind: "internal-invariant-violated" }, () => 500)
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
    .with({ kind: "global-concurrency-exceeded" }, () => `global concurrency limit exceeded`)
    .with({ kind: "dag-concurrency-exceeded" }, (e) => `concurrency limit exceeded for DAG '${e.dagId}'`)
    .with({ kind: "timeout" }, (e) => `DAG '${e.dagId}' run '${e.runId}' timed out after ${e.timeoutMs}ms`)
    .with({ kind: "redis-unavailable" }, (e) => `Redis unavailable during '${e.operation}'`)
    .with({ kind: "bun-install-failed" }, (e) => `bun install failed: ${e.message}`)
    .with({ kind: "config-invalid" }, (e) => `host configuration invalid: ${e.message}`)
    .with({ kind: "input-validation-failed" }, (e) => `input validation failed for DAG '${e.dagId}': ${e.issues.length} issue(s)`)
    .with({ kind: "dag-validation-failed" }, (e) => `DAG registration validation failed for '${e.dagId}': ${e.reason}`)
    .with({ kind: "body-parse-failed" }, (e) => `request body parse failed for DAG '${e.dagId}': ${e.message}`)
    .with({ kind: "discovery-failed" }, (e) => `DAG discovery failed for '${e.dagsRoot}': ${e.message}`)
    .with({ kind: "async-result-expired" }, (e) => `async result for run '${e.runId}' has expired`)
    .with({ kind: "unauthorized" }, (e) => `unauthorized: ${e.reason}`)
    .with({ kind: "forbidden" }, (e) => `token for team '${e.callerTeam}' cannot access DAG '${e.dagId}' (owned by '${e.dagTeam}')`)
    .with({ kind: "team-already-exists" }, (e) => `team '${e.team}' already has a token`)
    .with({ kind: "team-not-found" }, (e) => `team '${e.team}' not found`)
    .with({ kind: "internal-invariant-violated" }, (e) => `internal invariant violated: ${e.message}`)
    .exhaustive();

// ── Smart Constructors ─────────────────────────────────────────────────────

export const redisUnavailable = (operation: string): HostError => ({ kind: "redis-unavailable", operation });
export const teamAlreadyExists = (team: string): HostError => ({ kind: "team-already-exists", team });
export const teamNotFound = (team: string): HostError => ({ kind: "team-not-found", team });
export const importFailed = (path: string, message: string, stack?: string): HostError => ({ kind: "import-failed", path, message, stack });
export const noDefaultExport = (path: string): HostError => ({ kind: "no-default-export", path });
export const discoveryFailed = (dagsRoot: string, message: string): HostError => ({ kind: "discovery-failed", dagsRoot, message });
export const internalInvariantViolated = (message: string, context: Record<string, unknown>): HostError => ({ kind: "internal-invariant-violated", message, context });
