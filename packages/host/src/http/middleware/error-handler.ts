/**
 * Error handler middleware — catches thrown errors and maps them to
 * structured JSON responses using the HostError/FrameworkError discriminated unions.
 *
 * Must be registered as the outermost middleware (app.onError) so it
 * catches errors from all routes.
 */

import { match, P } from "ts-pattern";
import type { Context } from "hono";
import { isFrameworkErrorKind, safeErrorMessage } from "@fuguejs/framework";
import type { FrameworkErrorKind } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import {
  discloseHostError,
  parseHostError,
  retryAfterSecondsFor,
} from "../../domain/host-error.js";
import { errorResponse } from "../response.js";
import { logWithoutThrowing } from "../../hitl/diagnostic-logging.js";

/**
 * Logger interface for the error handler — injected to avoid coupling to a specific logger.
 */
export interface ErrorHandlerLogger {
  readonly error: (msg: string, data?: Record<string, unknown>) => void;
}

export type ErrorHandlerFallback = (diagnostic: string) => unknown;

/**
 * Diagnostics are secondary: neither logger nor stderr may replace the response.
 * THE encoding of that rule is `logWithoutThrowing`; this only pins the level,
 * since every diagnostic this middleware emits is an error.
 */
const logErrorWithoutThrowing = (
  logger: ErrorHandlerLogger,
  message: string,
  data: Record<string, unknown>,
  writeFallback: ErrorHandlerFallback,
): void => logWithoutThrowing(logger, "error", message, data, writeFallback);

type JsonSafeTree =
  | null
  | boolean
  | number
  | string
  | readonly JsonSafeTree[]
  | { readonly [key: string]: JsonSafeTree };

/** Convert trusted snapshotted details into a deeply immutable JSON wire tree. */
const immutableJsonSafeTree = (value: unknown): JsonSafeTree => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return String(value);
  if (value === undefined) return null;
  if (Array.isArray(value)) return Object.freeze(value.map(immutableJsonSafeTree));
  if (typeof value === "object") {
    const copy = Object.create(null) as Record<string, JsonSafeTree>;
    for (const [key, property] of Object.entries(value)) {
      copy[key] = immutableJsonSafeTree(property);
    }
    return Object.freeze(copy);
  }
  return String(value);
};

/**
 * Extract details from a HostError for the response body.
 * Exhaustive — adding a new HostError kind without a case here is a compile error.
 */
const rawDetailsFor = (error: HostError): unknown =>
  match(error)
    .with({ kind: "dag-not-found" }, (e) => ({ available: e.available }))
    .with({ kind: "input-validation-failed" }, (e) => ({ issues: e.issues }))
    .with({ kind: "validation-failed" }, (e) => ({ issues: e.issues }))
    .with({ kind: "global-concurrency-exceeded" }, () => ({ scope: "global" }))
    .with({ kind: "dag-concurrency-exceeded" }, (e) => ({ scope: "dag", dagId: e.dagId }))
    .with({ kind: "timeout" }, (e) => ({ timeoutMs: e.timeoutMs }))
    .with({ kind: "forbidden" }, (e) => ({ callerTeam: e.callerTeam, dagTeam: e.dagTeam }))
    .with({ kind: "dag-disabled" }, (e) => ({ reason: e.reason }))
    .with({ kind: "circuit-open" }, (e) => ({ retryAfterSeconds: e.retryAfterSeconds }))
    .with(
      {
        kind: P.union(
          "body-parse-failed",
          "git-clone-failed",
          "git-pull-failed",
          "git-timeout",
          "git-spawn-failed",
          "import-failed",
          "no-default-export",
          "redis-unavailable",
          "spend-ledger-unavailable",
          "bun-install-failed",
          "config-invalid",
          "tenant-config-invalid",
          "dag-validation-failed",
          "discovery-failed",
          "async-result-expired",
          "run-not-found",
          "run-lease-lost",
        ),
      },
      () => undefined,
    )
    .with({ kind: "run-not-suspended" }, (e) => ({ status: e.status }))
    .with(
      { kind: P.union("notification-failed", "unauthorized", "team-already-exists", "team-not-found") },
      () => undefined,
    )
    // NON-LEAKING (FR-040): tenant-unknown exposes NO details — no tenant id,
    // no "available", nothing that could confirm another tenant's existence.
    .with({ kind: "tenant-unknown" }, () => undefined)
    // Names only the caller's OWN tenant (FR-041) — never another tenant's.
    .with({ kind: "tenant-over-quota" }, (e) => ({ scope: "tenant", tenant: e.tenant }))
    .with({ kind: "worker-unavailable" }, (e) => ({ scope: "tenant", tenant: e.tenant }))
    .with({ kind: "internal-invariant-violated" }, () => undefined)
    .with({ kind: "fs-purge-failed" }, () => undefined)
    .exhaustive();

const detailsFor = (error: HostError): JsonSafeTree | undefined => {
  const details = rawDetailsFor(error);
  return details === undefined ? undefined : immutableJsonSafeTree(details);
};

/**
 * The correlation ids this HostError variant carries, if any. Every caller
 * below wants the pair, so it is resolved once rather than field by field.
 */
const correlationFor = (
  error: HostError,
): { readonly dagId?: string; readonly runId?: string } => {
  const stringField = (field: "dagId" | "runId"): string | undefined => {
    const value: unknown = Reflect.get(error, field);
    return typeof value === "string" ? value : undefined;
  };
  return { dagId: stringField("dagId"), runId: stringField("runId") };
};

/**
 * Headers to include based on error kind.
 */
const headersFor = (error: HostError): Record<string, string> | undefined => {
  // Single authoritative source for the backoff (host-error.ts): coarse
  // concurrency limits keep their 5s; tenant-over-quota advertises its own
  // per-tenant `retryAfterSeconds` (SC-012). Reading it from one place keeps
  // the 429 header in lockstep with the error's declared backoff.
  const retryAfter = retryAfterSecondsFor(error);
  return retryAfter === undefined ? undefined : { "Retry-After": String(retryAfter) };
};

/**
 * Render a HostError to a client response.
 *
 * The 4xx/5xx disclosure discipline itself lives in `discloseHostError`
 * (domain/host-error.ts) so every HTTP surface reads ONE authority; this
 * function only renders what that decision permits, and logs a server fault.
 */
const respondWithHostError = (
  logger: ErrorHandlerLogger,
  writeFallback: ErrorHandlerFallback,
  c: Context,
  hostErr: HostError,
): Response =>
  match(discloseHostError(hostErr))
    .with({ kind: "server-fault" }, (disclosure) => {
      // Log full detail server-side; return a generic message to the client.
      logErrorWithoutThrowing(logger, "Host error in request handler", {
        kind: hostErr.kind,
        detail: disclosure.detail,
        ...("context" in hostErr ? { context: hostErr.context } : {}),
        ...correlationFor(hostErr),
      }, writeFallback);
      return errorResponse(c, disclosure.status, hostErr.kind, disclosure.message, {
        // No `details` — the 5xx body must not echo internal state. Headers (e.g.
        // Retry-After for worker-unavailable 503) are still safe to advertise.
        ...correlationFor(hostErr),
        headers: headersFor(hostErr),
      });
    })
    // 4xx — curated, safe, caller-facing messages + details. NOT logged: they
    // are expected, caller-driven outcomes, not faults.
    .with({ kind: "client-safe" }, (disclosure) =>
      errorResponse(c, disclosure.status, hostErr.kind, disclosure.message, {
        details: detailsFor(hostErr),
        ...correlationFor(hostErr),
        headers: headersFor(hostErr),
      }),
    )
    .exhaustive();

/** Narrow an arbitrary throw to an Error without trusting prototype traps. */
const asError = (value: unknown): Error | undefined => {
  try {
    return value instanceof Error ? value : undefined;
  } catch {
    return undefined;
  }
};

const readErrorField = (error: Error, key: "cause" | "message" | "stack"): unknown => {
  try {
    return (error as unknown as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
};

/** Accept only an own data property from the framework's closed vocabulary. */
const readFrameworkErrorKind = (error: Error): FrameworkErrorKind | undefined => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "frameworkErrorKind");
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    return isFrameworkErrorKind(descriptor.value) ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Create a Hono error handler with injected logger.
 * Registered via `app.onError(createErrorHandler(logger))`.
 */
export const createErrorHandler = (
  logger: ErrorHandlerLogger,
  writeFallback: ErrorHandlerFallback = (diagnostic) => process.stderr.write(diagnostic),
) => (thrown: unknown, c: Context): Response => {
  const directHostError = parseHostError(thrown);
  if (directHostError !== undefined) {
    return respondWithHostError(logger, writeFallback, c, directHostError);
  }

  const thrownError = asError(thrown);
  const causeValue = thrownError === undefined ? undefined : readErrorField(thrownError, "cause");
  const causeHostError = parseHostError(causeValue);
  if (causeHostError !== undefined) {
    return respondWithHostError(logger, writeFallback, c, causeHostError);
  }

  const frameworkErrorKind = thrownError === undefined
    ? undefined
    : readFrameworkErrorKind(thrownError);
  if (thrownError !== undefined && frameworkErrorKind !== undefined) {
    logErrorWithoutThrowing(logger, "Framework error in request handler", {
      kind: frameworkErrorKind,
      error: readErrorField(thrownError, "message"),
      stack: readErrorField(thrownError, "stack"),
    }, writeFallback);
    return errorResponse(
      c,
      500,
      frameworkErrorKind,
      `Framework error: ${frameworkErrorKind}`,
    );
  }

  const causeError = asError(causeValue);
  logErrorWithoutThrowing(logger, "Unhandled error in request handler", {
    error: safeErrorMessage(thrown),
    stack: thrownError === undefined ? undefined : readErrorField(thrownError, "stack"),
    causeMessage: causeValue === undefined ? undefined : safeErrorMessage(causeValue),
    causeStack: causeError === undefined ? undefined : readErrorField(causeError, "stack"),
  }, writeFallback);
  return errorResponse(c, 500, "internal-error", "An unexpected error occurred");
};
