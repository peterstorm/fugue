// retryAsync — generic async retry with linear backoff.
//
// Extracted from scheduler.ts to avoid hand-rolled retry loops.
// The scheduler, resolveDependents, and any future retry-needing code
// should use this instead of inlining attempt loops.

import { fwLogger } from "../logger.js";

interface RetryOpts {
  /** Maximum number of attempts (including the first). */
  readonly maxAttempts: number;
  /** Base delay in ms — multiplied by (attempt index) for linear backoff. */
  readonly baseDelayMs: number;
  /** Human-readable label for log messages. */
  readonly label: string;
}

/**
 * Retry an async operation with linear backoff. Returns the result on
 * success, or throws the last error after all attempts are exhausted.
 *
 * Delay between attempt `i` and `i+1` is `baseDelayMs * (i + 1)`.
 *
 * NOTE: this variant throws the raw last error on exhaustion.
 */
export const retryAsync = async <T>(
  fn: () => Promise<T>,
  opts: RetryOpts,
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      fwLogger().error(
        `[${opts.label}] attempt ${attempt + 1}/${opts.maxAttempts} failed:`,
        e,
      );
      if (attempt < opts.maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, opts.baseDelayMs * (attempt + 1)));
      }
    }
  }
  // Guarantee an Error instance propagates — callers can always access
  // `.message` and `.stack` without type narrowing.
  throw lastError instanceof Error
    ? lastError
    : new Error(`[${opts.label}] exhausted ${opts.maxAttempts} attempts: ${String(lastError)}`);
};
