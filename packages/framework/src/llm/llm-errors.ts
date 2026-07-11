// Shared LLM client error policy.
//
// Both AnthropicLlmClient and OpenAILlmClient need identical logic for
// distinguishing abort, rate-limit, timeout, and generic crash errors
// (`classifyLlmError`). This module also owns the shared HTTP failure policy
// (`httpFailureToError` / `TRANSIENT_HTTP_STATUSES`), pre-flight temperature
// validation (`validateTemperature`), and error-body truncation
// (`truncateErrorBody`). Centralised here so the clients only carry
// provider-specific code.

import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import { err } from "../types/result.js";

/** True when `e` is an AbortError (caller cancellation or timeout). */
export const isAbort = (e: unknown): boolean =>
  e instanceof Error && e.name === "AbortError";

/** Safely truncate API error body to prevent data leakage through error propagation paths. */
export const truncateErrorBody = (body: string, maxLen = 200): string =>
  body.length > maxLen ? body.slice(0, maxLen) + "…[truncated]" : body;

/** 429 / 408 / 409 — transient by RFC and retried by both providers' own SDKs. */
const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 409, 429]);

/**
 * The ONE HTTP failure policy for non-OK responses on the raw-HTTP path
 * (today: the OpenAI client's `postResponses` arms; the Anthropic client
 * rides its SDK's thrown errors through `classifyLlmError`, whose duck-typed
 * status arm applies the same classification):
 * - 429, 408, 409 → `transient` (rate limit / request timeout / conflict —
 *   transient by RFC and retried by both providers' own SDKs);
 * - other 4xx → NON-retriable `node-crash` (a deterministic client error —
 *   retrying burns the budget without changing the outcome);
 * - everything else (5xx, and malformed-success bodies reported with their
 *   2xx status) → retriable `node-crash` (server-side, MAY be worth a retry).
 * Pure — `status`/`bodyText` in, typed error out; the message always carries
 * `HTTP <status>` plus the (truncated) body so the failure is debuggable
 * from the error alone, and EVERY arm carries the typed `httpStatus` (all
 * failures here are HTTP-origin by construction) so consumers can branch on
 * it without string-matching the message.
 */
export const httpFailureToError = (
  status: number,
  bodyText: string,
  nodeId: NodeId,
): Result<never, FrameworkError> => {
  const message = `HTTP ${status}: ${truncateErrorBody(bodyText)}`;
  if (TRANSIENT_HTTP_STATUSES.has(status)) {
    return err({ kind: "transient", nodeId, message, httpStatus: status });
  }
  if (status >= 400 && status < 500) {
    return err({ kind: "node-crash", retriability: "non-retriable", nodeId, message, httpStatus: status });
  }
  return err({ kind: "node-crash", retriability: "retriable", nodeId, message, httpStatus: status });
};

/**
 * Pre-flight validation of `LlmRequest.temperature`. The documented range is
 * [0, 1] — the providers' common denominator (Anthropic caps sampling at 1.0;
 * OpenAI accepts up to 2, but this seam pins the portable range so a request
 * never means different things per provider). A non-finite or out-of-range
 * value is a deterministic caller error: reject at the seam as a typed
 * `validation` failure (non-retriable by kind) instead of an opaque provider
 * HTTP 400 — mirrors the OpenAI thinking+temperature conflict pre-flight.
 * Returns `null` when the request is valid.
 */
export const validateTemperature = (
  temperature: number | undefined,
  nodeId: NodeId,
): Result<never, FrameworkError> | null =>
  temperature !== undefined &&
  (!Number.isFinite(temperature) || temperature < 0 || temperature > 1)
    ? err({
        kind: "validation",
        nodeId,
        message: `temperature must be a finite number in [0, 1], got ${temperature}`,
      })
    : null;

/**
 * Duck-typed 429 detection. The Anthropic SDK throws `RateLimitError` with
 * `.status === 429`; duck-typing avoids a class-hierarchy dependency.
 */
export const isRateLimit = (e: unknown): boolean =>
  typeof (e as { status?: unknown })?.status === "number" &&
  (e as { status: number }).status === 429;

/**
 * Detect a timeout-induced error. Uses standard `Error.cause` (set to
 * `"timeout"` by `createTimeoutSignal` / `postResponses`).
 */
export const isTimeoutError = (e: unknown): boolean =>
  e instanceof Error && (e as { cause?: unknown }).cause === "timeout";

export interface ClassifyOpts {
  /** True when the request-level timeout fired. */
  readonly timedOut?: boolean;
  /** True when the caller's own signal was aborted (not our timeout). */
  readonly callerAborted?: boolean;
  /** Timeout duration for the error message. */
  readonly timeoutMs?: number;
  /**
   * Provider-specific abort predicate. When supplied, used in addition to
   * the generic `isAbort` check. Needed because Anthropic's SDK throws
   * `APIUserAbortError` (name: "APIUserAbortError", not "AbortError").
   */
  readonly isAbortOverride?: (e: unknown) => boolean;
}

/**
 * Classify an LLM client exception into the appropriate FrameworkError.
 * Handles: timeout-abort, caller-abort, rate-limit, and generic crash.
 */
export const classifyLlmError = (
  e: unknown,
  nodeId: NodeId,
  opts?: ClassifyOpts,
): Result<never, FrameworkError> => {
  const aborted = isAbort(e) || opts?.isAbortOverride?.(e);
  // Timeout-induced abort — retriable transient failure.
  if (aborted && opts?.timedOut && !opts?.callerAborted) {
    return err({
      kind: "transient",
      nodeId,
      message: `request timed out${opts.timeoutMs ? ` after ${opts.timeoutMs}ms` : ""}`,
    });
  }
  // Timeout detected via Error.cause (OpenAI path where postResponses throws).
  if (isTimeoutError(e)) {
    return err({
      kind: "transient",
      nodeId,
      message: e instanceof Error ? e.message : "request timed out",
    });
  }
  if (aborted) {
    return err({ kind: "aborted", reason: "signal" });
  }
  // Duck-typed HTTP status (SDK errors carry `.status`, e.g. Anthropic's
  // RateLimitError/AuthenticationError/BadRequestError): the shared
  // TRANSIENT_HTTP_STATUSES policy applies — 429 (rate limit), 408, and 409
  // classify as `transient`, any other 4xx as a deterministic non-retriable
  // client error, and everything else (5xx) as a retriable server-side crash —
  // every arm carrying the typed `httpStatus`. (The 429 case was formerly
  // a dedicated `isRateLimit` arm; it is fully subsumed here — same kind,
  // message, and httpStatus — so the redundant arm and its `429` literal are
  // gone. `isRateLimit` itself stays exported as a standalone predicate.)
  const status = (e as { status?: unknown })?.status;
  if (typeof status === "number") {
    if (TRANSIENT_HTTP_STATUSES.has(status)) {
      return err({
        kind: "transient",
        nodeId,
        message: e instanceof Error ? e.message : String(e),
        httpStatus: status,
      });
    }
    if (status >= 400 && status < 500) {
      return err({
        kind: "node-crash",
        retriability: "non-retriable",
        nodeId,
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
        httpStatus: status,
      });
    }
    // Any remaining duck-typed status (5xx, or an SDK oddity outside 4xx) is
    // still HTTP-origin: a retriable server-side crash that carries the typed
    // `httpStatus` (mirrors httpFailureToError's final arm) so consumers can
    // branch on it without string-matching the message.
    return err({
      kind: "node-crash",
      retriability: "retriable",
      nodeId,
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
      httpStatus: status,
    });
  }
  return err({
    kind: "node-crash",
    retriability: "retriable",
    nodeId,
    message: e instanceof Error ? e.message : String(e),
    stack: e instanceof Error ? e.stack : undefined,
  });
};
