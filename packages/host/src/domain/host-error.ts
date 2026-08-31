/**
 * HostError — Discriminated union for all host-level errors.
 *
 * Each variant maps to a specific HTTP status code. Expected domain failures
 * use Result<T, HostError>; value-object smart constructors may throw when a
 * caller attempts to forge an invalid invariant (for example Retry-After).
 */

import { match, P } from "ts-pattern";
import type { z } from "zod";
import type { DagId, RunId } from "@fuguejs/framework";
import { tryDagId, tryRunId } from "@fuguejs/framework";
import { tenantId, type TenantId } from "./tenant-id.js";

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

const HOST_ERROR_KINDS = Object.freeze({
  "git-clone-failed": true,
  "git-pull-failed": true,
  "git-timeout": true,
  "git-spawn-failed": true,
  "import-failed": true,
  "validation-failed": true,
  "no-default-export": true,
  "dag-not-found": true,
  "dag-disabled": true,
  "global-concurrency-exceeded": true,
  "dag-concurrency-exceeded": true,
  timeout: true,
  "redis-unavailable": true,
  "spend-ledger-unavailable": true,
  "bun-install-failed": true,
  "config-invalid": true,
  "tenant-config-invalid": true,
  "input-validation-failed": true,
  "dag-validation-failed": true,
  "body-parse-failed": true,
  "discovery-failed": true,
  "async-result-expired": true,
  "run-not-found": true,
  "run-lease-lost": true,
  "run-not-suspended": true,
  "notification-failed": true,
  unauthorized: true,
  forbidden: true,
  "team-already-exists": true,
  "team-not-found": true,
  "tenant-unknown": true,
  "tenant-over-quota": true,
  "worker-unavailable": true,
  "internal-invariant-violated": true,
  "fs-purge-failed": true,
} satisfies Record<HostErrorKind, true>);

const hostErrorKindOf = (value: string): HostErrorKind | undefined =>
  Object.hasOwn(HOST_ERROR_KINDS, value) ? value as HostErrorKind : undefined;

const exhaustiveHostErrorKind = (_kind: never): undefined => undefined;

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
const hasExactOwnStringKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    actual.every((key) => allowed.has(key));
};

const isOptionalBoolean = (value: unknown): boolean =>
  value === undefined || typeof value === "boolean";
const isOptionalString = (value: unknown): boolean =>
  value === undefined || isString(value);
const isNumberOrBigInt = (value: unknown): value is number | bigint =>
  typeof value === "number" || typeof value === "bigint";
const isPrimitive = (value: unknown): boolean =>
  value === null || value === undefined ||
  typeof value === "string" || typeof value === "number" ||
  typeof value === "symbol" || typeof value === "bigint" ||
  typeof value === "boolean";

function isIssueArray(value: unknown): value is readonly ZodIssue[] {
  return Array.isArray(value) && value.every(isIssue);
}

const isIssueMatrix = (value: unknown): value is readonly (readonly ZodIssue[])[] =>
  Array.isArray(value) && value.every(isIssueArray);

type IssuePayloadParser = (value: Record<string, unknown>) => boolean;

const isInvalidFormatPayload = (value: Record<string, unknown>): boolean => {
  if (!isString(value.format)) return false;
  switch (value.format) {
    case "regex":
      return isString(value.pattern);
    case "starts_with":
      return isString(value.prefix);
    case "ends_with":
      return isString(value.suffix);
    case "includes":
      return isString(value.includes);
    default:
      return isOptionalString(value.pattern);
  }
};

/** Exhaustive parser table for Zod 4's closed `$ZodIssue` discriminants. */
const ISSUE_PAYLOAD_PARSERS = Object.freeze({
  invalid_type: (value) => isString(value.expected),
  too_big: (value) =>
    isString(value.origin) && isNumberOrBigInt(value.maximum) &&
    isOptionalBoolean(value.inclusive) && isOptionalBoolean(value.exact),
  too_small: (value) =>
    isString(value.origin) && isNumberOrBigInt(value.minimum) &&
    isOptionalBoolean(value.inclusive) && isOptionalBoolean(value.exact),
  invalid_format: isInvalidFormatPayload,
  not_multiple_of: (value) => typeof value.divisor === "number",
  unrecognized_keys: (value) => isStringArray(value.keys),
  invalid_union: (value) =>
    isIssueMatrix(value.errors) && isOptionalString(value.discriminator) &&
    (value.inclusive === undefined || value.inclusive === true ||
      (value.inclusive === false && value.errors.length === 0)),
  invalid_key: (value) =>
    (value.origin === "map" || value.origin === "record") &&
    isIssueArray(value.issues),
  invalid_element: (value) =>
    (value.origin === "map" || value.origin === "set") &&
    Object.hasOwn(value, "key") && isIssueArray(value.issues),
  invalid_value: (value) => Array.isArray(value.values) && value.values.every(isPrimitive),
  custom: (value) => value.params === undefined || isRecord(value.params),
} satisfies Record<ZodIssue["code"], IssuePayloadParser>);

type ZodIssueCode = keyof typeof ISSUE_PAYLOAD_PARSERS;
const isIssueCode = (value: unknown): value is ZodIssueCode =>
  isString(value) && Object.hasOwn(ISSUE_PAYLOAD_PARSERS, value);

function isIssue(value: unknown): value is ZodIssue {
  if (
    !isRecord(value) || !isIssueCode(value.code) || !isString(value.message) ||
    !Array.isArray(value.path) ||
    !value.path.every((part) =>
      typeof part === "string" || typeof part === "number" || typeof part === "symbol"
    )
  ) return false;
  return ISSUE_PAYLOAD_PARSERS[value.code](value);
}

const parseDagId = (value: unknown): DagId | undefined => {
  if (!isString(value)) return undefined;
  const parsed = tryDagId(value);
  return parsed.ok ? parsed.value : undefined;
};

const parseDagIds = (value: unknown): readonly DagId[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const parsed: DagId[] = [];
  for (const candidate of value) {
    const id = parseDagId(candidate);
    if (id === undefined) return undefined;
    parsed.push(id);
  }
  return Object.freeze(parsed);
};

const parseRunId = (value: unknown): RunId | undefined => {
  if (!isString(value)) return undefined;
  const parsed = tryRunId(value);
  return parsed.ok ? parsed.value : undefined;
};

const parseTenantId = (value: unknown): TenantId | undefined => {
  if (!isString(value)) return undefined;
  const parsed = tenantId(value);
  return parsed.ok ? parsed.value : undefined;
};

const frozenHostError = <E extends HostError>(error: E): E => Object.freeze(error);

/**
 * Total parser for errors crossing the throwing HTTP seam. It snapshots each
 * source field once, requires the variant's exact own string-key set, and
 * reconstructs a fresh deeply immutable HostError from canonical fields.
 * Branded values are rebuilt through their smart constructors, so erased brands
 * cannot be forged at this authority boundary.
 */
export const parseHostError = (value: unknown): HostError | undefined => {
  const snapshotted = snapshotUnknown(value);
  if (!snapshotted.ok || !isRecord(snapshotted.value)) return undefined;
  const snapshot = snapshotted.value;
  if (!isString(snapshot.kind)) return undefined;
  const kind = hostErrorKindOf(snapshot.kind);
  if (kind === undefined) return undefined;

  switch (kind) {
    case "git-clone-failed":
      return hasExactOwnStringKeys(snapshot, ["kind", "url", "message"]) &&
          isString(snapshot.url) && isString(snapshot.message)
        ? frozenHostError({ kind: "git-clone-failed", url: snapshot.url, message: snapshot.message })
        : undefined;
    case "git-pull-failed":
    case "bun-install-failed":
    case "config-invalid":
    case "tenant-config-invalid":
    case "fs-purge-failed":
      return hasExactOwnStringKeys(snapshot, ["kind", "message"]) && isString(snapshot.message)
        ? frozenHostError({ kind, message: snapshot.message })
        : undefined;
    case "git-timeout":
    case "redis-unavailable":
    case "notification-failed":
      return hasExactOwnStringKeys(snapshot, ["kind", "operation"]) && isString(snapshot.operation)
        ? frozenHostError({ kind, operation: snapshot.operation })
        : undefined;
    case "git-spawn-failed":
      return hasExactOwnStringKeys(snapshot, ["kind", "operation", "message"]) &&
          isString(snapshot.operation) && isString(snapshot.message)
        ? frozenHostError({
            kind: "git-spawn-failed",
            operation: snapshot.operation,
            message: snapshot.message,
          })
        : undefined;
    case "import-failed": {
      if (
        !hasExactOwnStringKeys(snapshot, ["kind", "path", "message"], ["stack"]) ||
        !isString(snapshot.path) || !isString(snapshot.message)
      ) return undefined;
      if (!Object.hasOwn(snapshot, "stack") || snapshot.stack === undefined) {
        return frozenHostError({ kind: "import-failed", path: snapshot.path, message: snapshot.message });
      }
      return isString(snapshot.stack)
        ? frozenHostError({
            kind: "import-failed",
            path: snapshot.path,
            message: snapshot.message,
            stack: snapshot.stack,
          })
        : undefined;
    }
    case "validation-failed":
      return hasExactOwnStringKeys(snapshot, ["kind", "path", "issues"]) &&
          isString(snapshot.path) && isIssueArray(snapshot.issues)
        ? frozenHostError({ kind: "validation-failed", path: snapshot.path, issues: snapshot.issues })
        : undefined;
    case "no-default-export":
      return hasExactOwnStringKeys(snapshot, ["kind", "path"]) && isString(snapshot.path)
        ? frozenHostError({ kind: "no-default-export", path: snapshot.path })
        : undefined;
    case "dag-not-found": {
      if (!hasExactOwnStringKeys(snapshot, ["kind", "dagId", "available"])) return undefined;
      const dagId = parseDagId(snapshot.dagId);
      const available = parseDagIds(snapshot.available);
      return dagId === undefined || available === undefined
        ? undefined
        : frozenHostError({ kind: "dag-not-found", dagId, available });
    }
    case "dag-disabled": {
      if (!hasExactOwnStringKeys(snapshot, ["kind", "dagId", "reason"])) return undefined;
      const dagId = parseDagId(snapshot.dagId);
      return dagId === undefined || !isString(snapshot.reason)
        ? undefined
        : frozenHostError({ kind: "dag-disabled", dagId, reason: snapshot.reason });
    }
    case "global-concurrency-exceeded":
    case "tenant-unknown":
      return hasExactOwnStringKeys(snapshot, ["kind"])
        ? frozenHostError({ kind })
        : undefined;
    case "dag-concurrency-exceeded": {
      if (!hasExactOwnStringKeys(snapshot, ["kind", "dagId"])) return undefined;
      const dagId = parseDagId(snapshot.dagId);
      return dagId === undefined
        ? undefined
        : frozenHostError({ kind: "dag-concurrency-exceeded", dagId });
    }
    case "timeout": {
      if (!hasExactOwnStringKeys(snapshot, ["kind", "dagId", "runId", "timeoutMs"])) {
        return undefined;
      }
      const dagId = parseDagId(snapshot.dagId);
      const runId = parseRunId(snapshot.runId);
      return dagId === undefined || runId === undefined ||
          typeof snapshot.timeoutMs !== "number" || !Number.isFinite(snapshot.timeoutMs)
        ? undefined
        : frozenHostError({ kind: "timeout", dagId, runId, timeoutMs: snapshot.timeoutMs });
    }
    case "spend-ledger-unavailable":
      return hasExactOwnStringKeys(snapshot, ["kind", "backend", "operation", "message"]) &&
          snapshot.backend === "file" &&
          (snapshot.operation === "create" || snapshot.operation === "read" || snapshot.operation === "add") &&
          isString(snapshot.message)
        ? frozenHostError({
            kind: "spend-ledger-unavailable",
            backend: "file",
            operation: snapshot.operation,
            message: snapshot.message,
          })
        : undefined;
    case "input-validation-failed": {
      if (!hasExactOwnStringKeys(snapshot, ["kind", "dagId", "issues"])) return undefined;
      const dagId = parseDagId(snapshot.dagId);
      return dagId === undefined || !isIssueArray(snapshot.issues)
        ? undefined
        : frozenHostError({ kind: "input-validation-failed", dagId, issues: snapshot.issues });
    }
    case "dag-validation-failed": {
      if (!hasExactOwnStringKeys(snapshot, ["kind", "dagId", "reason", "message"])) {
        return undefined;
      }
      const dagId = parseDagId(snapshot.dagId);
      return dagId === undefined || !isString(snapshot.reason) || !isString(snapshot.message)
        ? undefined
        : frozenHostError({
            kind: "dag-validation-failed",
            dagId,
            reason: snapshot.reason,
            message: snapshot.message,
          });
    }
    case "body-parse-failed": {
      if (!hasExactOwnStringKeys(snapshot, ["kind", "dagId", "message"])) return undefined;
      const dagId = parseDagId(snapshot.dagId);
      return dagId === undefined || !isString(snapshot.message)
        ? undefined
        : frozenHostError({ kind: "body-parse-failed", dagId, message: snapshot.message });
    }
    case "discovery-failed":
      return hasExactOwnStringKeys(snapshot, ["kind", "dagsRoot", "message"]) &&
          isString(snapshot.dagsRoot) && isString(snapshot.message)
        ? frozenHostError({
            kind: "discovery-failed",
            dagsRoot: snapshot.dagsRoot,
            message: snapshot.message,
          })
        : undefined;
    case "async-result-expired":
    case "run-not-found":
    case "run-lease-lost": {
      if (!hasExactOwnStringKeys(snapshot, ["kind", "runId"])) return undefined;
      const runId = parseRunId(snapshot.runId);
      return runId === undefined
        ? undefined
        : frozenHostError({ kind, runId });
    }
    case "run-not-suspended": {
      if (!hasExactOwnStringKeys(snapshot, ["kind", "runId", "status"])) return undefined;
      const runId = parseRunId(snapshot.runId);
      return runId === undefined || !isString(snapshot.status)
        ? undefined
        : frozenHostError({ kind: "run-not-suspended", runId, status: snapshot.status });
    }
    case "unauthorized":
      return hasExactOwnStringKeys(snapshot, ["kind", "reason"]) && isString(snapshot.reason)
        ? frozenHostError({ kind: "unauthorized", reason: snapshot.reason })
        : undefined;
    case "forbidden": {
      if (!hasExactOwnStringKeys(snapshot, ["kind", "dagId", "callerTeam", "dagTeam"])) {
        return undefined;
      }
      const dagId = parseDagId(snapshot.dagId);
      return dagId === undefined || !isString(snapshot.callerTeam) || !isString(snapshot.dagTeam)
        ? undefined
        : frozenHostError({
            kind: "forbidden",
            dagId,
            callerTeam: snapshot.callerTeam,
            dagTeam: snapshot.dagTeam,
          });
    }
    case "team-already-exists":
    case "team-not-found":
      return hasExactOwnStringKeys(snapshot, ["kind", "team"]) && isString(snapshot.team)
        ? frozenHostError({ kind, team: snapshot.team })
        : undefined;
    case "tenant-over-quota": {
      if (!hasExactOwnStringKeys(snapshot, ["kind", "tenant", "retryAfterSeconds"])) {
        return undefined;
      }
      const tenant = parseTenantId(snapshot.tenant);
      return tenant === undefined || typeof snapshot.retryAfterSeconds !== "number" ||
          !Number.isSafeInteger(snapshot.retryAfterSeconds) || snapshot.retryAfterSeconds < 0
        ? undefined
        : frozenHostError({
            kind: "tenant-over-quota",
            tenant,
            retryAfterSeconds: retryAfterSeconds(snapshot.retryAfterSeconds),
          });
    }
    case "worker-unavailable": {
      if (!hasExactOwnStringKeys(snapshot, ["kind", "tenant"])) return undefined;
      const tenant = parseTenantId(snapshot.tenant);
      return tenant === undefined
        ? undefined
        : frozenHostError({ kind: "worker-unavailable", tenant });
    }
    case "internal-invariant-violated":
      return hasExactOwnStringKeys(snapshot, ["kind", "message", "context"]) &&
          isString(snapshot.message) && isRecord(snapshot.context)
        ? frozenHostError({
            kind: "internal-invariant-violated",
            message: snapshot.message,
            context: snapshot.context,
          })
        : undefined;
    default:
      return exhaustiveHostErrorKind(kind);
  }
};

/**
 * Maps each HostError kind to its corresponding HTTP status code.
 */
export const httpStatusFor = (error: HostError): number =>
  match(error)
    // tenant-unknown → 404 (FR-040, US3). 404 is chosen over 401 deliberately:
    // a not-found response does NOT confirm the tenant exists, so a caller can
    // never distinguish "no such tenant" from "not authorized for it" and so
    // cannot probe other tenants' existence/state. (Spec allows 404 OR 401; the
    // non-leakage requirement makes 404 the safer of the two.)
    .with(
      { kind: P.union("dag-not-found", "run-not-found", "team-not-found", "tenant-unknown") },
      () => 404,
    )
    .with(
      {
        kind: P.union(
          "input-validation-failed",
          "validation-failed",
          "dag-validation-failed",
          "body-parse-failed",
          "tenant-config-invalid",
        ),
      },
      () => 400,
    )
    // tenant-over-quota → 429 (SC-012). Retry-After comes from the error's own
    // `retryAfterSeconds` (see `retryAfterSecondsFor` below).
    .with(
      { kind: P.union("global-concurrency-exceeded", "dag-concurrency-exceeded", "tenant-over-quota") },
      () => 429,
    )
    .with({ kind: "timeout" }, () => 408)
    // worker-unavailable → 503 (SC-012, AD-8). Contained to this tenant.
    .with(
      { kind: P.union("dag-disabled", "redis-unavailable", "run-lease-lost", "worker-unavailable") },
      () => 503,
    )
    .with(
      {
        kind: P.union(
          "spend-ledger-unavailable",
          "git-clone-failed",
          "git-pull-failed",
          "git-timeout",
          "git-spawn-failed",
          "import-failed",
          "no-default-export",
          "bun-install-failed",
          "config-invalid",
          "discovery-failed",
          "internal-invariant-violated",
          "fs-purge-failed",
        ),
      },
      () => 500,
    )
    .with({ kind: "async-result-expired" }, () => 410)
    .with({ kind: P.union("run-not-suspended", "team-already-exists") }, () => 409)
    .with({ kind: "notification-failed" }, () => 502)
    .with({ kind: "unauthorized" }, () => 401)
    .with({ kind: "forbidden" }, () => 403)
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

export const redisUnavailable = (operation: string): HostError =>
  frozenHostError({ kind: "redis-unavailable", operation });
export const spendLedgerUnavailable = (
  operation: "create" | "read" | "add",
  message: string,
): HostError => frozenHostError({
  kind: "spend-ledger-unavailable",
  backend: "file",
  operation,
  message,
});
/** Producer of `fs-purge-failed` — a local filesystem fault during grace-window mount reclamation (NOT a Redis outage). */
export const fsPurgeFailed = (message: string): HostError =>
  frozenHostError({ kind: "fs-purge-failed", message });
export const teamAlreadyExists = (team: string): HostError =>
  frozenHostError({ kind: "team-already-exists", team });
const UNSNAPSHOTABLE_INVARIANT_CONTEXT: Readonly<Record<string, unknown>> =
  Object.freeze({ contextSnapshot: "unavailable" });

const snapshotInvariantContext = (
  context: Record<string, unknown>,
): Record<string, unknown> => {
  const snapshot = snapshotUnknown(context);
  return snapshot.ok && isRecord(snapshot.value)
    ? snapshot.value
    : UNSNAPSHOTABLE_INVARIANT_CONTEXT;
};

export const internalInvariantViolated = (
  message: string,
  context: Record<string, unknown>,
): HostError => frozenHostError({
  kind: "internal-invariant-violated",
  message,
  context: snapshotInvariantContext(context),
});

/**
 * Producer of `tenant-config-invalid` (400). The single seam where a client-
 * supplied register/reconfigure body is rejected as a CALLER error (vs a host
 * config-load fault). Keeps the 4xx boundary translation greppable.
 */
export const tenantConfigInvalid = (message: string): HostError =>
  frozenHostError({ kind: "tenant-config-invalid", message });

// ── Multi-tenant supervisor smart constructors (AD-10) ───────────────────────

/**
 * The single producer of `tenant-unknown`. Takes NO arguments by design — the
 * error carries no tenant id and no discriminating field, so "no such tenant"
 * and "not authorized for it" are structurally indistinguishable to the caller
 * (FR-040, non-leakage). Using a constructor (not an inline literal) keeps the
 * boundary's fail-closed return a single, greppable seam.
 */
export const tenantUnknown = (): HostError => frozenHostError({ kind: "tenant-unknown" });

/**
 * Producer of `tenant-over-quota` (SC-012). The tenant whose OWN ceiling was
 * hit and the backoff to advertise are both carried on the error — the
 * Retry-After header is derived from `retryAfterSeconds`, not hardcoded.
 */
export const tenantOverQuota = (
  tenant: TenantId,
  rawRetryAfterSeconds: number,
): HostError => frozenHostError({
  kind: "tenant-over-quota",
  tenant,
  retryAfterSeconds: retryAfterSeconds(rawRetryAfterSeconds),
});

/** Producer of `worker-unavailable` (SC-012, AD-8) for THIS tenant only. */
export const workerUnavailable = (tenant: TenantId): HostError =>
  frozenHostError({ kind: "worker-unavailable", tenant });

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
