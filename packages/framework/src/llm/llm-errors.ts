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
