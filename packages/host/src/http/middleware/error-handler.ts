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
 * Determine if an unknown value is a HostError by checking for the `kind` discriminant.
 */
const isHostError = (e: unknown): e is HostError =>
  e != null &&
  typeof e === "object" &&
  "kind" in e &&
  typeof (e as Record<string, unknown>).kind === "string";

/**
 * Extract details from a HostError for the response body.
 */
const detailsFor = (error: HostError): unknown =>
  match(error)
    .with({ kind: "dag-not-found" }, (e) => ({ available: e.available }))
    .with({ kind: "input-validation-failed" }, (e) => ({ issues: e.issues }))
    .with({ kind: "validation-failed" }, (e) => ({ issues: e.issues }))
    .with({ kind: "concurrency-exceeded" }, (e) => ({ scope: e.scope, dagId: e.dagId }))
    .with({ kind: "timeout" }, (e) => ({ timeoutMs: e.timeoutMs }))
    .otherwise(() => undefined);

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
  if (error.kind === "concurrency-exceeded") {
    return { "Retry-After": "5" };
  }
  return undefined;
};

/**
 * Hono error handler. Registered via `app.onError(errorHandler)`.
 */
export const errorHandler = (thrown: Error | HostError, c: Context): Response => {
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
    return errorResponse(c, 500, kind, thrown.message);
  }

  // Generic unhandled error
  const message = thrown instanceof Error ? thrown.message : "Internal server error";
  return errorResponse(c, 500, "internal-error", message);
};
