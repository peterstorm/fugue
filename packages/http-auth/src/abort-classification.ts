/** Pure classification shared by token minting and authenticated requests. */
export type AbortClassification = "timeout" | "abort" | "other";

/**
 * Distinguish this package's timeout from caller/foreign cancellation.
 * Timeout wins when both facts are present so a signal-respecting fetch that
 * rejects with `AbortError` after our `abort(Error("timeout"))` remains
 * retriable exactly as before.
 */
export const classifyAbort = (
  signal: AbortSignal | undefined,
  error: unknown,
): AbortClassification => {
  const reason: unknown = signal?.reason;
  const isOurTimeout =
    (reason instanceof Error && reason.message === "timeout") ||
    (error instanceof Error && (error.message === "timeout" || error.name === "TimeoutError"));
  if (isOurTimeout) return "timeout";

  const isAbort =
    signal?.aborted === true ||
    (error instanceof Error && error.name === "AbortError");
  return isAbort ? "abort" : "other";
};
