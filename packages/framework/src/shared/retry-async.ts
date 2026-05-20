// retryAsync — generic async retry with linear backoff.
//
// Extracted from scheduler.ts to avoid hand-rolled retry loops.
// The scheduler, resolveDependents, and any future retry-needing code
// should use this instead of inlining attempt loops.

import { fwLogger } from "../logger.js";
import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";

export interface RetryOpts {
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
 * NOTE: This variant throws the raw last error on exhaustion. Callers that
 * need typed error propagation should use `retryAsyncResult` instead, which
 * returns `Result<T, FrameworkError>` and never throws.
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
  throw lastError;
};

/**
 * Retry with Result return. On exhaustion, returns `Err` with the last error
 * mapped to a `FrameworkError` via the caller-supplied `toFrameworkError`.
 * Never throws — prefer this over `retryAsync` when the caller needs typed
 * error propagation through the `Result` pipeline.
 *
 * Delay between attempt `i` and `i+1` is `baseDelayMs * (i + 1)`.
 */
export const retryAsyncResult = async <T>(
  fn: () => Promise<T>,
  opts: RetryOpts & { readonly toFrameworkError: (e: unknown) => FrameworkError },
): Promise<Result<T, FrameworkError>> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return ok(await fn());
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
  return err(opts.toFrameworkError(lastError));
};
