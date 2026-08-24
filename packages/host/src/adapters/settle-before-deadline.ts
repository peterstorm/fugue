type DeadlineResult<T> =
  | { readonly kind: "settled"; readonly value: T }
  | { readonly kind: "timed-out" };

/**
 * Bound an async shell operation even when it ignores cooperative cancellation.
 * The rejection handler remains attached after timeout, so late rejection is
 * observed rather than becoming an unhandled rejection.
 */
export const settleBeforeDeadline = <T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<DeadlineResult<T>> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onTimeout();
      } catch {
        // Hard settlement does not depend on cooperative cancellation signaling.
      }
      resolve({ kind: "timed-out" });
    }, timeoutMs);

    void operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve({ kind: "settled", value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
