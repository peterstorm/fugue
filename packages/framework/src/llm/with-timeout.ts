// Shared timeout/signal management for LLM clients.
//
// Both Anthropic and OpenAI clients need to distinguish caller-initiated
// abort from timeout-induced abort. This module provides a single
// `createTimeoutSignal` that wires the abort-controller, timer, and
// caller-signal forwarding so each client doesn't repeat the pattern.

interface TimeoutHandle {
  /** The composite signal to pass to fetch / SDK calls. */
  readonly signal: AbortSignal;
  /** True when the timeout (not the caller) triggered the abort. */
  readonly timedOut: () => boolean;
  /** Clean up timer and signal listeners. Call in a `finally` block. */
  readonly cleanup: () => void;
}

/**
 * Creates a timeout-managed AbortSignal that distinguishes caller-initiated
 * abort from timeout-induced abort.
 *
 * Usage:
 * ```ts
 * const t = createTimeoutSignal(120_000, req.signal);
 * try {
 *   const res = await fetch(url, { signal: t.signal });
 * } catch (e) {
 *   return classifyLlmError(e, nodeId, {
 *     timedOut: t.timedOut(),
 *     callerAborted: req.signal?.aborted,
 *     timeoutMs: 120_000,
 *   });
 * } finally {
 *   t.cleanup();
 * }
 * ```
 */
export const createTimeoutSignal = (
  timeoutMs: number,
  callerSignal?: AbortSignal,
): TimeoutHandle => {
  const controller = new AbortController();
  let didTimeout = false;

  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
};
