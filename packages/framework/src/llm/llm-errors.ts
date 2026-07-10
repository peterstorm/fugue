// Shared LLM client error classification.
//
// Both AnthropicLlmClient and OpenAILlmClient need identical logic for
// distinguishing abort, rate-limit, timeout, and generic crash errors.
// Centralised here so the clients only carry provider-specific code.

import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import { err } from "../types/result.js";

/** True when `e` is an AbortError (caller cancellation or timeout). */
export const isAbort = (e: unknown): boolean =>
  e instanceof Error && e.name === "AbortError";

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
  if (isRateLimit(e)) {
    return err({
      kind: "transient",
      nodeId,
      message: e instanceof Error ? e.message : String(e),
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
