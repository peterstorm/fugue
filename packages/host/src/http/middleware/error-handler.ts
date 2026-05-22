/**
 * Error handler middleware — catches thrown errors and maps them to
 * structured JSON responses using the HostError/FrameworkError discriminated unions.
 *
 * Must be registered as the outermost middleware (app.onError) so it
 * catches errors from all routes.
 */

import { match } from "ts-pattern";
import type { Context } from "hono";
import type { HostError } from "../../domain/host-error.js";
import { httpStatusFor, formatHostError } from "../../domain/host-error.js";
import { errorResponse } from "../response.js";

/**
 * Logger interface for the error handler — injected to avoid coupling to a specific logger.
 */
export interface ErrorHandlerLogger {
  readonly error: (msg: string, data?: Record<string, unknown>) => void;
}

/**
 * Determine if an unknown value is a HostError by checking for the `kind` discriminant.
 */
const isHostError = (e: unknown): e is HostError =>
  e != null &&
  typeof e === "object" &&
  "kind" in e &&
  typeof (e as Record<string, unknown>).kind === "string";

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
    .with({ kind: "body-parse-failed" }, () => undefined)
    .with({ kind: "git-clone-failed" }, () => undefined)
    .with({ kind: "git-pull-failed" }, () => undefined)
    .with({ kind: "git-timeout" }, () => undefined)
    .with({ kind: "git-spawn-failed" }, () => undefined)
    .with({ kind: "import-failed" }, () => undefined)
    .with({ kind: "no-default-export" }, () => undefined)
    .with({ kind: "redis-unavailable" }, () => undefined)
    .with({ kind: "bun-install-failed" }, () => undefined)
    .with({ kind: "config-invalid" }, () => undefined)
    .with({ kind: "dag-validation-failed" }, () => undefined)
    .with({ kind: "discovery-failed" }, () => undefined)
    .with({ kind: "async-result-expired" }, () => undefined)
    .with({ kind: "unauthorized" }, () => undefined)
    .with({ kind: "team-already-exists" }, () => undefined)
    .with({ kind: "team-not-found" }, () => undefined)
    .with({ kind: "internal-invariant-violated" }, () => undefined)
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
  if (error.kind === "global-concurrency-exceeded" || error.kind === "dag-concurrency-exceeded") {
    return { "Retry-After": "5" };
  }
  return undefined;
};

/**
 * Create a Hono error handler with injected logger.
 * Registered via `app.onError(createErrorHandler(logger))`.
 */
export const createErrorHandler = (logger: ErrorHandlerLogger) => (thrown: Error | HostError, c: Context): Response => {
  // If it's a HostError (thrown directly or wrapped)
  if (isHostError(thrown)) {
    const status = httpStatusFor(thrown);
    const message = formatHostError(thrown);
    return errorResponse(c, status, thrown.kind, message, {
      details: detailsFor(thrown),
      dagId: dagIdFor(thrown),
      runId: runIdFor(thrown),
      headers: headersFor(thrown),
    });
  }

  // Check if the Error has a HostError as cause
  if (thrown instanceof Error && isHostError(thrown.cause)) {
    const hostErr = thrown.cause;
    const status = httpStatusFor(hostErr);
    const message = formatHostError(hostErr);
    return errorResponse(c, status, hostErr.kind, message, {
      details: detailsFor(hostErr),
      dagId: dagIdFor(hostErr),
      runId: runIdFor(hostErr),
      headers: headersFor(hostErr),
    });
  }

  // Check for FrameworkError (has `kind` field from the framework)
  if (thrown instanceof Error && "frameworkErrorKind" in thrown) {
    const kind = (thrown as unknown as { frameworkErrorKind: string }).frameworkErrorKind;
    logger.error("Framework error in request handler", {
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
  logger.error("Unhandled error in request handler", {
    error: internalMessage,
    stack: thrown instanceof Error ? thrown.stack : undefined,
    causeMessage: cause?.message,
    causeStack: cause?.stack,
  });
  return errorResponse(c, 500, "internal-error", "An unexpected error occurred");
};

/**
 * Convenience error handler using console.error — intended for dev/test only.
 * Production code should use createErrorHandler(logger) with a structured logger.
 */
export const errorHandler = createErrorHandler({
  error: (msg, data) => console.error(JSON.stringify({ level: "error", msg, ...data, ts: new Date().toISOString() })),
});
