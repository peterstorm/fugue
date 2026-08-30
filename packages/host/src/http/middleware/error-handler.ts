/**
 * Error handler middleware — catches thrown errors and maps them to
 * structured JSON responses using the HostError/FrameworkError discriminated unions.
 *
 * Must be registered as the outermost middleware (app.onError) so it
 * catches errors from all routes.
 */

import { match, P } from "ts-pattern";
import type { Context } from "hono";
import type { HostError } from "../../domain/host-error.js";
import {
  formatHostError,
  httpStatusFor,
  isHostError,
  retryAfterSecondsFor,
} from "../../domain/host-error.js";
import { errorResponse } from "../response.js";

/**
 * Logger interface for the error handler — injected to avoid coupling to a specific logger.
 */
export interface ErrorHandlerLogger {
  readonly error: (msg: string, data?: Record<string, unknown>) => void;
}

/** Diagnostics are secondary: logger failure must never replace the response. */
const logErrorWithoutThrowing = (
  logger: ErrorHandlerLogger,
  message: string,
  data: Record<string, unknown>,
): void => {
  try {
    logger.error(message, data);
  } catch {
    // The already-selected HTTP response remains authoritative.
  }
};

/**
 * Extract details from a HostError for the response body.
 * Exhaustive — adding a new HostError kind without a case here is a compile error.
 */
const detailsFor = (error: HostError): unknown =>
  match(error)
    .with({ kind: "dag-not-found" }, (e) => ({ available: e.available }))
    .with({ kind: "input-validation-failed" }, (e) => ({ issues: e.issues }))
    .with({ kind: "validation-failed" }, (e) => ({ issues: e.issues }))
    .with({ kind: "global-concurrency-exceeded" }, () => ({ scope: "global" }))
    .with({ kind: "dag-concurrency-exceeded" }, (e) => ({ scope: "dag", dagId: e.dagId }))
    .with({ kind: "timeout" }, (e) => ({ timeoutMs: e.timeoutMs }))
    .with({ kind: "forbidden" }, (e) => ({ callerTeam: e.callerTeam, dagTeam: e.dagTeam }))
    .with({ kind: "dag-disabled" }, (e) => ({ reason: e.reason }))
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

/**
 * Extract dagId if present on the error.
 */
const dagIdFor = (error: HostError): string | undefined => {
  if ("dagId" in error && typeof error.dagId === "string") {
    return error.dagId;
  }
  return undefined;
};

/**
 * Extract runId if present on the error.
 */
const runIdFor = (error: HostError): string | undefined => {
  if ("runId" in error && typeof error.runId === "string") {
    return error.runId;
  }
  return undefined;
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
 * Render a HostError to a client response, applying the 4xx/5xx disclosure
 * discipline.
 *
 * SECURITY (information disclosure — OWASP A09/A05):
 *   - 5xx-class HostErrors (worker-unavailable 503, internal-invariant-violated
 *     500, git/import/config/etc 500) are SERVER faults. Their `formatHostError`
 *     text can interpolate raw internal state (e.g. `internal-invariant-violated`
 *     splices `e.message`, and the markTenant invariant carries a forged id in
 *     `context`). We therefore return a GENERIC client message and log the
 *     detailed `formatHostError` output + any `context` server-side — matching
 *     the discipline of the generic unhandled-error path, which never leaks
 *     internals and always logs.
 *   - 4xx-class HostErrors are deliberate, caller-facing outcomes whose messages
 *     are already curated to be safe (tenant-unknown is tenant-agnostic;
 *     tenant-over-quota names only the caller's OWN tenant; validation echoes the
 *     caller's own input). These keep their existing precise messages + details
 *     and are NOT logged (they are expected, caller-driven outcomes, not faults).
 */
const respondWithHostError = (
  logger: ErrorHandlerLogger,
  c: Context,
  hostErr: HostError,
): Response => {
  const status = httpStatusFor(hostErr);

  if (status >= 500) {
    // Log full detail server-side; return a generic message to the client.
    logErrorWithoutThrowing(logger, "Host error in request handler", {
      kind: hostErr.kind,
      detail: formatHostError(hostErr),
      ...("context" in hostErr ? { context: hostErr.context } : {}),
      dagId: dagIdFor(hostErr),
      runId: runIdFor(hostErr),
    });
    return errorResponse(c, status, hostErr.kind, "An unexpected error occurred", {
      // No `details` — the 5xx body must not echo internal state. Headers (e.g.
      // Retry-After for worker-unavailable 503) are still safe to advertise.
      dagId: dagIdFor(hostErr),
      runId: runIdFor(hostErr),
      headers: headersFor(hostErr),
    });
  }

  // 4xx — curated, safe, caller-facing messages + details.
  return errorResponse(c, status, hostErr.kind, formatHostError(hostErr), {
    details: detailsFor(hostErr),
    dagId: dagIdFor(hostErr),
    runId: runIdFor(hostErr),
    headers: headersFor(hostErr),
  });
};

/**
 * Create a Hono error handler with injected logger.
 * Registered via `app.onError(createErrorHandler(logger))`.
 */
export const createErrorHandler = (logger: ErrorHandlerLogger) => (thrown: Error | HostError, c: Context): Response => {
  // If it's a HostError (thrown directly or wrapped)
  if (isHostError(thrown)) {
    return respondWithHostError(logger, c, thrown);
  }

  // Check if the Error has a HostError as cause
  if (thrown instanceof Error && isHostError(thrown.cause)) {
    return respondWithHostError(logger, c, thrown.cause);
  }

  // Check for FrameworkError (has `kind` field from the framework)
  if (thrown instanceof Error && "frameworkErrorKind" in thrown) {
    const kind = (thrown as unknown as { frameworkErrorKind: string }).frameworkErrorKind;
    logErrorWithoutThrowing(logger, "Framework error in request handler", {
      kind,
      error: thrown.message,
      stack: thrown.stack,
    });
    // FrameworkErrors have controlled messages (e.g., "LLM unavailable") — safe to expose kind.
    // But message may contain internal details, so use a generic message.
    return errorResponse(c, 500, kind, `Framework error: ${kind}`);
  }

  // Generic unhandled error — MUST be logged for observability
  // SECURITY: Never expose internal error messages to clients.
  // Full details are logged server-side only.
  const internalMessage = thrown instanceof Error ? thrown.message : String(thrown);
  const cause = thrown instanceof Error && thrown.cause instanceof Error ? thrown.cause : undefined;
  logErrorWithoutThrowing(logger, "Unhandled error in request handler", {
    error: internalMessage,
    stack: thrown instanceof Error ? thrown.stack : undefined,
    causeMessage: cause?.message,
    causeStack: cause?.stack,
  });
  return errorResponse(c, 500, "internal-error", "An unexpected error occurred");
};
