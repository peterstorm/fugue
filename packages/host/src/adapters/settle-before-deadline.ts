type DeadlineResult<T> =
  | { readonly kind: "settled"; readonly value: T }
  | { readonly kind: "timed-out" };

export interface DeadlineDiagnostics<T> {
  readonly onLateFulfillment?: (value: T) => void;
  readonly onLateRejection?: (error: unknown) => void;
  readonly onTimeoutCancellationFailure?: (error: unknown) => void;
}

/** Secondary diagnostics can never replace the deadline outcome they describe. */
const reportWithoutThrowing = <T>(
  report: ((value: T) => void) | undefined,
  value: T,
): void => {
  try {
    report?.(value);
  } catch {
    // The settled operation/timeout remains authoritative.
  }
};

/**
 * Bound an async shell operation even when it ignores cooperative cancellation.
 * The rejection handler remains attached after timeout. Late failures and
 * cancellation-signal failures are routed to explicit best-effort diagnostics;
 * neither can replace the already-authoritative timeout result.
 */
export const settleBeforeDeadline = <T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  onTimeout: () => void,
  diagnostics: DeadlineDiagnostics<T> = {},
): Promise<DeadlineResult<T>> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onTimeout();
      } catch (error) {
        reportWithoutThrowing(diagnostics.onTimeoutCancellationFailure, error);
      }
      resolve({ kind: "timed-out" });
    }, timeoutMs);

    void operation.then(
      (value) => {
        if (settled) {
          reportWithoutThrowing(diagnostics.onLateFulfillment, value);
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        resolve({ kind: "settled", value });
      },
      (error: unknown) => {
        if (settled) {
          reportWithoutThrowing(diagnostics.onLateRejection, error);
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
