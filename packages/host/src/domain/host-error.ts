/**
 * HostError — Discriminated union for all host-level errors.
 *
 * Each variant maps to a specific HTTP status code. Expected domain failures
 * use Result<T, HostError>; value-object smart constructors may throw when a
 * caller attempts to forge an invalid invariant (for example Retry-After).
 */

import { match } from "ts-pattern";
import type { z } from "zod";
import type { DagId, RunId } from "@fuguejs/framework";
// Type-only import — `TenantId` is a branded string used in the tenant error
// payloads below. `tenant.ts` imports the VALUE `tenantUnknown` from this
// module; this back-reference is type-only, so there is no runtime import cycle.
import type { TenantId } from "./tenant.js";

// Zod 4 re-exports $ZodIssue as the canonical issue type
type ZodIssue = z.core.$ZodIssue;

declare const __retryAfterSecondsBrand: unique symbol;
export type RetryAfterSeconds = number & {
  readonly [__retryAfterSecondsBrand]: "RetryAfterSeconds";
};

/** HTTP Retry-After delay-seconds grammar (RFC integer form). */
export const retryAfterSeconds = (value: number): RetryAfterSeconds => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("retryAfterSeconds must be a non-negative safe integer");
  }
  return value as RetryAfterSeconds;
};

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
  | {
      readonly kind: "spend-ledger-unavailable";
      readonly backend: "file";
      readonly operation: "create" | "read" | "add";
      readonly message: string;
    }
  | { readonly kind: "bun-install-failed"; readonly message: string }
  | { readonly kind: "config-invalid"; readonly message: string }
  // A CLIENT-SUPPLIED tenant register/reconfigure body that is semantically
  // invalid (e.g. negative `maxConcurrentRuns`, missing `team`). Distinct from
  // `config-invalid` (a HOST config-load fault → 500): a bad request body is the
  // CALLER's error → 400. Carries a non-leaking message naming only the field
  // class at fault, never another tenant.
  | { readonly kind: "tenant-config-invalid"; readonly message: string }
  | { readonly kind: "input-validation-failed"; readonly dagId: DagId; readonly issues: readonly ZodIssue[] }
  | { readonly kind: "dag-validation-failed"; readonly dagId: DagId; readonly reason: string; readonly message: string }
  | { readonly kind: "body-parse-failed"; readonly dagId: DagId; readonly message: string }
  | { readonly kind: "discovery-failed"; readonly dagsRoot: string; readonly message: string }
  | { readonly kind: "async-result-expired"; readonly runId: RunId }
  | { readonly kind: "run-not-found"; readonly runId: RunId }
  | { readonly kind: "run-lease-lost"; readonly runId: RunId }
  | { readonly kind: "run-not-suspended"; readonly runId: RunId; readonly status: string }
  | { readonly kind: "notification-failed"; readonly operation: string }
  | { readonly kind: "unauthorized"; readonly reason: string }
  | { readonly kind: "forbidden"; readonly dagId: DagId; readonly callerTeam: string; readonly dagTeam: string }
  | { readonly kind: "team-already-exists"; readonly team: string }
  | { readonly kind: "team-not-found"; readonly team: string }
  // ── Multi-tenant supervisor errors (AD-10) ────────────────────────────────
  // These three are the supervisor-boundary tenant errors. They live in the
  // SAME union as every other host error so the single `httpStatusFor` /
  // `formatHostError` mapping stays authoritative and exhaustive (rejected
  // alternative: a separate supervisor error type whose status mapping could
  // drift from this one).
  //
  // `tenant-unknown` (FR-040, US3): the caller did not resolve to a registered
  // tenant — either no such tenant, or the caller is not authorized for it. It
  // carries NO tenant id and NO discriminating field ON PURPOSE: the response
  // (404/401) must never let a caller probe the existence or state of another
  // tenant. Keeping "no such tenant" and "not your tenant" structurally
  // identical is the non-leakage guarantee, enforced in the type, not a comment.
  | { readonly kind: "tenant-unknown" }
  // `tenant-over-quota` (SC-012, FR-041): THIS tenant exceeded its own
  // admission ceiling. 429 + Retry-After. The `retryAfterSeconds` is carried on
  // the error (data, not a hardcoded header) so admission can compute a tenant-
  // specific backoff. It names no other tenant — one tenant's saturation can
  // never surface as another tenant's error (FR-041).
  | { readonly kind: "tenant-over-quota"; readonly tenant: TenantId; readonly retryAfterSeconds: RetryAfterSeconds }
  // `worker-unavailable` (SC-012, FR-041, AD-8): the owning tenant's worker is
  // crashed/draining/unreachable. 503 for THAT tenant only — a worker fault is
  // contained to its tenant and never bleeds into another's request path.
  | { readonly kind: "worker-unavailable"; readonly tenant: TenantId }
  | { readonly kind: "internal-invariant-violated"; readonly message: string; readonly context: Record<string, unknown> }
  // A FILESYSTEM purge step failed (EPERM/EBUSY/ENOENT etc.) while reclaiming a
  // deregistered tenant's on-disk mount during the grace-window purge. Distinct
  // from `redis-unavailable` ON PURPOSE: this is a local-fs fault, NOT a Redis
  // outage, so anything alerting on `redis-unavailable` must not be tripped by an
  // fs failure. 500 (a local IO fault is a host-side error, not a downstream
  // unavailability). Best-effort: collected into the purge's `failedSteps`.
  | { readonly kind: "fs-purge-failed"; readonly message: string };

export type HostErrorKind = HostError["kind"];

type SnapshotResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

const snapshotUnknown = (
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
  depth = 0,
): SnapshotResult => {
  if (
    value === null || value === undefined || typeof value === "string" ||
    typeof value === "number" || typeof value === "boolean" ||
    typeof value === "bigint" || typeof value === "symbol"
  ) return { ok: true, value };
  if (typeof value !== "object" || depth > 32) return { ok: false };

  try {
    if (ancestors.has(value)) return { ok: false };
    ancestors.add(value);
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const item = snapshotUnknown(value[index], ancestors, depth + 1);
        if (!item.ok) return item;
        copy.push(item.value);
      }
      return { ok: true, value: Object.freeze(copy) };
    }

    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") continue;
      const property = snapshotUnknown(
        (value as Record<string, unknown>)[key],
        ancestors,
        depth + 1,
      );
      if (!property.ok) return property;
      Object.defineProperty(copy, key, {
        value: property.value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return { ok: true, value: Object.freeze(copy) };
  } catch {
    return { ok: false };
  } finally {
    ancestors.delete(value);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(isString);
const hasStrings = (value: Record<string, unknown>, ...keys: readonly string[]): boolean =>
  keys.every((key) => isString(value[key]));

const ZOD_ISSUE_CODES: ReadonlySet<string> = new Set([
  "invalid_type",
  "too_big",
  "too_small",
  "invalid_format",
  "not_multiple_of",
  "unrecognized_keys",
  "invalid_union",
  "invalid_key",
  "invalid_element",
  "invalid_value",
  "custom",
]);

const isIssue = (value: unknown): value is ZodIssue =>
  isRecord(value) &&
  isString(value.code) && ZOD_ISSUE_CODES.has(value.code) &&
  isString(value.message) &&
  Array.isArray(value.path) &&
  value.path.every((part) =>
    typeof part === "string" || typeof part === "number" || typeof part === "symbol"
  );
const isIssueArray = (value: unknown): value is readonly ZodIssue[] =>
  Array.isArray(value) && value.every(isIssue);

/**
 * Total parser for errors crossing the throwing HTTP seam. Every source value
 * is read once into a fresh deeply frozen snapshot before variant checks, so
 * getters, proxies, and later mutation cannot drift response policy.
 */
export const parseHostError = (value: unknown): HostError | undefined => {
  const snapshotted = snapshotUnknown(value);
  if (!snapshotted.ok || !isRecord(snapshotted.value)) return undefined;
  const snapshot = snapshotted.value;
  if (!isString(snapshot.kind)) return undefined;

  let valid: boolean;
  switch (snapshot.kind) {
    case "git-clone-failed":
      valid = hasStrings(snapshot, "url", "message");
      break;
    case "git-pull-failed":
    case "bun-install-failed":
    case "config-invalid":
    case "tenant-config-invalid":
    case "fs-purge-failed":
      valid = hasStrings(snapshot, "message");
      break;
    case "git-timeout":
    case "redis-unavailable":
    case "notification-failed":
      valid = hasStrings(snapshot, "operation");
      break;
    case "git-spawn-failed":
      valid = hasStrings(snapshot, "operation", "message");
      break;
    case "import-failed":
      valid = hasStrings(snapshot, "path", "message") &&
        (snapshot.stack === undefined || isString(snapshot.stack));
      break;
    case "validation-failed":
      valid = hasStrings(snapshot, "path") && isIssueArray(snapshot.issues);
      break;
    case "no-default-export":
      valid = hasStrings(snapshot, "path");
      break;
    case "dag-not-found":
      valid = hasStrings(snapshot, "dagId") && isStringArray(snapshot.available);
      break;
    case "dag-disabled":
      valid = hasStrings(snapshot, "dagId", "reason");
      break;
    case "global-concurrency-exceeded":
    case "tenant-unknown":
      valid = true;
      break;
    case "dag-concurrency-exceeded":
      valid = hasStrings(snapshot, "dagId");
      break;
    case "timeout":
      valid = hasStrings(snapshot, "dagId", "runId") &&
        typeof snapshot.timeoutMs === "number" && Number.isFinite(snapshot.timeoutMs);
      break;
    case "spend-ledger-unavailable":
      valid = snapshot.backend === "file" &&
        (snapshot.operation === "create" || snapshot.operation === "read" || snapshot.operation === "add") &&
        hasStrings(snapshot, "message");
      break;
    case "input-validation-failed":
      valid = hasStrings(snapshot, "dagId") && isIssueArray(snapshot.issues);
      break;
    case "dag-validation-failed":
      valid = hasStrings(snapshot, "dagId", "reason", "message");
      break;
    case "body-parse-failed":
      valid = hasStrings(snapshot, "dagId", "message");
      break;
    case "discovery-failed":
      valid = hasStrings(snapshot, "dagsRoot", "message");
      break;
    case "async-result-expired":
    case "run-not-found":
    case "run-lease-lost":
      valid = hasStrings(snapshot, "runId");
      break;
    case "run-not-suspended":
      valid = hasStrings(snapshot, "runId", "status");
      break;
    case "unauthorized":
      valid = hasStrings(snapshot, "reason");
      break;
    case "forbidden":
      valid = hasStrings(snapshot, "dagId", "callerTeam", "dagTeam");
      break;
    case "team-already-exists":
    case "team-not-found":
      valid = hasStrings(snapshot, "team");
      break;
    case "tenant-over-quota":
      valid = hasStrings(snapshot, "tenant") && typeof snapshot.retryAfterSeconds === "number" &&
        Number.isSafeInteger(snapshot.retryAfterSeconds) && snapshot.retryAfterSeconds >= 0;
      break;
    case "worker-unavailable":
      valid = hasStrings(snapshot, "tenant");
      break;
    case "internal-invariant-violated":
      valid = hasStrings(snapshot, "message") && isRecord(snapshot.context);
      break;
    default:
      valid = false;
  }

  return valid ? snapshot as HostError : undefined;
};

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
    .with({ kind: "spend-ledger-unavailable" }, () => 500)
    .with({ kind: "async-result-expired" }, () => 410)
    .with({ kind: "run-not-found" }, () => 404)
    .with({ kind: "run-lease-lost" }, () => 503)
    .with({ kind: "run-not-suspended" }, () => 409)
    .with({ kind: "notification-failed" }, () => 502)
    .with({ kind: "git-clone-failed" }, () => 500)
    .with({ kind: "git-pull-failed" }, () => 500)
    .with({ kind: "git-timeout" }, () => 500)
    .with({ kind: "git-spawn-failed" }, () => 500)
    .with({ kind: "import-failed" }, () => 500)
    .with({ kind: "no-default-export" }, () => 500)
    .with({ kind: "bun-install-failed" }, () => 500)
    .with({ kind: "config-invalid" }, () => 500)
    .with({ kind: "tenant-config-invalid" }, () => 400)
    .with({ kind: "discovery-failed" }, () => 500)
    .with({ kind: "unauthorized" }, () => 401)
    .with({ kind: "forbidden" }, () => 403)
    .with({ kind: "team-already-exists" }, () => 409)
    .with({ kind: "team-not-found" }, () => 404)
    // tenant-unknown → 404 (FR-040, US3). 404 is chosen over 401 deliberately:
    // a not-found response does NOT confirm the tenant exists, so a caller can
    // never distinguish "no such tenant" from "not authorized for it" and so
    // cannot probe other tenants' existence/state. (Spec allows 404 OR 401; the
    // non-leakage requirement makes 404 the safer of the two.)
    .with({ kind: "tenant-unknown" }, () => 404)
    // tenant-over-quota → 429 (SC-012). Retry-After comes from the error's own
    // `retryAfterSeconds` (see `retryAfterSecondsFor` below).
    .with({ kind: "tenant-over-quota" }, () => 429)
    // worker-unavailable → 503 (SC-012, AD-8). Contained to this tenant.
    .with({ kind: "worker-unavailable" }, () => 503)
    .with({ kind: "internal-invariant-violated" }, () => 500)
    .with({ kind: "fs-purge-failed" }, () => 500)
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
    .with(
      { kind: "spend-ledger-unavailable" },
      (e) => `file spend ledger unavailable during '${e.operation}': ${e.message}`,
    )
    .with({ kind: "bun-install-failed" }, (e) => `bun install failed: ${e.message}`)
    .with({ kind: "config-invalid" }, (e) => `host configuration invalid: ${e.message}`)
    .with({ kind: "tenant-config-invalid" }, (e) => `tenant configuration invalid: ${e.message}`)
    .with({ kind: "input-validation-failed" }, (e) => `input validation failed for DAG '${e.dagId}': ${e.issues.length} issue(s)`)
    .with({ kind: "dag-validation-failed" }, (e) => `DAG registration validation failed for '${e.dagId}': ${e.reason}`)
    .with({ kind: "body-parse-failed" }, (e) => `request body parse failed for DAG '${e.dagId}': ${e.message}`)
    .with({ kind: "discovery-failed" }, (e) => `DAG discovery failed for '${e.dagsRoot}': ${e.message}`)
    .with({ kind: "async-result-expired" }, (e) => `async result for run '${e.runId}' has expired`)
    .with({ kind: "run-not-found" }, (e) => `run '${e.runId}' not found`)
    .with({ kind: "run-lease-lost" }, (e) => `run '${e.runId}' lease ownership was lost`)
    .with({ kind: "run-not-suspended" }, (e) => `run '${e.runId}' is '${e.status}', not awaiting human review`)
    .with({ kind: "notification-failed" }, (e) => `review notification failed during '${e.operation}'`)
    .with({ kind: "unauthorized" }, (e) => `unauthorized: ${e.reason}`)
    .with({ kind: "forbidden" }, (e) => `token for team '${e.callerTeam}' cannot access DAG '${e.dagId}' (owned by '${e.dagTeam}')`)
    .with({ kind: "team-already-exists" }, (e) => `team '${e.team}' already has a token`)
    .with({ kind: "team-not-found" }, (e) => `team '${e.team}' not found`)
    // NON-LEAKING (FR-040): the message is a fixed, tenant-agnostic string. It
    // names no tenant id and is identical whether the tenant does not exist or
    // the caller is simply not authorized for it — so the client-facing message
    // can never reveal another tenant's existence/state.
    .with({ kind: "tenant-unknown" }, () => `tenant not found`)
    // Names only the caller's OWN tenant (FR-041): never another tenant's id.
    .with({ kind: "tenant-over-quota" }, (e) => `tenant '${e.tenant}' is over quota; retry after ${e.retryAfterSeconds}s`)
    .with({ kind: "worker-unavailable" }, (e) => `worker for tenant '${e.tenant}' is unavailable`)
    .with({ kind: "internal-invariant-violated" }, (e) => `internal invariant violated: ${e.message}`)
    .with({ kind: "fs-purge-failed" }, (e) => `filesystem purge failed: ${e.message}`)
    .exhaustive();

// ── Smart Constructors ─────────────────────────────────────────────────────

export const redisUnavailable = (operation: string): HostError => ({ kind: "redis-unavailable", operation });
export const spendLedgerUnavailable = (
  operation: "create" | "read" | "add",
  message: string,
): HostError => ({ kind: "spend-ledger-unavailable", backend: "file", operation, message });
/** Producer of `fs-purge-failed` — a local filesystem fault during grace-window mount reclamation (NOT a Redis outage). */
export const fsPurgeFailed = (message: string): HostError => ({ kind: "fs-purge-failed", message });
export const teamAlreadyExists = (team: string): HostError => ({ kind: "team-already-exists", team });
export const internalInvariantViolated = (message: string, context: Record<string, unknown>): HostError => ({ kind: "internal-invariant-violated", message, context });

/**
 * Producer of `tenant-config-invalid` (400). The single seam where a client-
 * supplied register/reconfigure body is rejected as a CALLER error (vs a host
 * config-load fault). Keeps the 4xx boundary translation greppable.
 */
export const tenantConfigInvalid = (message: string): HostError => ({ kind: "tenant-config-invalid", message });

// ── Multi-tenant supervisor smart constructors (AD-10) ───────────────────────

/**
 * The single producer of `tenant-unknown`. Takes NO arguments by design — the
 * error carries no tenant id and no discriminating field, so "no such tenant"
 * and "not authorized for it" are structurally indistinguishable to the caller
 * (FR-040, non-leakage). Using a constructor (not an inline literal) keeps the
 * boundary's fail-closed return a single, greppable seam.
 */
export const tenantUnknown = (): HostError => ({ kind: "tenant-unknown" });

/**
 * Producer of `tenant-over-quota` (SC-012). The tenant whose OWN ceiling was
 * hit and the backoff to advertise are both carried on the error — the
 * Retry-After header is derived from `retryAfterSeconds`, not hardcoded.
 */
export const tenantOverQuota = (tenant: TenantId, rawRetryAfterSeconds: number): HostError => ({
  kind: "tenant-over-quota",
  tenant,
  retryAfterSeconds: retryAfterSeconds(rawRetryAfterSeconds),
});

/** Producer of `worker-unavailable` (SC-012, AD-8) for THIS tenant only. */
export const workerUnavailable = (tenant: TenantId): HostError => ({ kind: "worker-unavailable", tenant });

/**
 * The Retry-After (seconds) a HostError advertises, if any. Centralizes the
 * "which errors are retriable, and after how long" decision so the HTTP layer
 * (error-handler middleware, supervisor) reads it from ONE authoritative place
 * instead of pattern-matching kinds itself. Returns `undefined` for errors
 * that carry no backoff signal.
 *
 * `tenant-over-quota` advertises its own per-tenant `retryAfterSeconds`. The
 * coarse concurrency limits and `worker-unavailable` keep a fixed 5s (the
 * established behaviour in the error-handler middleware), surfaced here so the
 * value lives in ONE place — both the live error-handler middleware AND
 * `classifyHostError` read it from here, so a 503 worker-unavailable advertises
 * the SAME Retry-After through every path (no divergent hardcoded sources).
 */
type RetryAfterPolicy = number | undefined | ((error: HostError) => number | undefined);

const RETRY_AFTER_POLICY = Object.freeze({
  "git-clone-failed": undefined,
  "git-pull-failed": undefined,
  "git-timeout": undefined,
  "git-spawn-failed": undefined,
  "import-failed": undefined,
  "validation-failed": undefined,
  "no-default-export": undefined,
  "dag-not-found": undefined,
  "dag-disabled": undefined,
  "global-concurrency-exceeded": 5,
  "dag-concurrency-exceeded": 5,
  timeout: undefined,
  "redis-unavailable": undefined,
  "spend-ledger-unavailable": undefined,
  "bun-install-failed": undefined,
  "config-invalid": undefined,
  "tenant-config-invalid": undefined,
  "input-validation-failed": undefined,
  "dag-validation-failed": undefined,
  "body-parse-failed": undefined,
  "discovery-failed": undefined,
  "async-result-expired": undefined,
  "run-not-found": undefined,
  "run-lease-lost": undefined,
  "run-not-suspended": undefined,
  "notification-failed": undefined,
  unauthorized: undefined,
  forbidden: undefined,
  "team-already-exists": undefined,
  "team-not-found": undefined,
  "tenant-unknown": undefined,
  "tenant-over-quota": (error: HostError) =>
    error.kind === "tenant-over-quota" ? error.retryAfterSeconds : undefined,
  "worker-unavailable": 5,
  "internal-invariant-violated": undefined,
  "fs-purge-failed": undefined,
} satisfies Record<HostErrorKind, RetryAfterPolicy>);

export const retryAfterSecondsFor = (error: HostError): number | undefined => {
  const policy = RETRY_AFTER_POLICY[error.kind];
  return typeof policy === "function" ? policy(error) : policy;
};
