import type { Observer } from "./observer.js";
import type { ObserverEvent } from "../types/events.js";
import { fwLogger } from "../logger.js";

/**
 * When `OBSERVER_STRICT=1` is set, dispatchEvent rethrows any observer failure
 * instead of catching. Useful in tests to surface programming bugs in observer
 * implementations that would otherwise be silently absorbed in production.
 * Read per call (not frozen at module load) so a test can toggle it around a
 * single pin and restore it — production processes never mutate the variable
 * mid-run, so per-call reads observe the same value as a load-time const.
 */
const isStrictMode = (): boolean =>
  typeof process !== "undefined" && process.env?.OBSERVER_STRICT === "1";

/**
 * Most recent OBSERVER_STRICT failure, or `null`. An async observer rejection
 * cannot be surfaced by throwing from the synchronous `dispatchEvent`, so under
 * strict mode it is recorded here for tests to assert on synchronously.
 */
let lastStrictFailure: Error | null = null;

/** Test-only: the most recent OBSERVER_STRICT failure, or `null`. */
export function __lastStrictFailure(): Error | null {
  return lastStrictFailure;
}

/** Test-only: clear the recorded OBSERVER_STRICT failure. */
export function __clearStrictFailure(): void {
  lastStrictFailure = null;
}

/**
 * Error-isolating dispatch wrapper. Calls `observer.observe(event)` and
 * catches any failure — production observers MUST be failure-tolerant (runs
 * continue). Under `OBSERVER_STRICT=1` the error is re-thrown after logging
 * so tests surface programming bugs in observer implementations.
 */
export function dispatchEvent(observer: Observer, event: ObserverEvent): void {
  try {
    const result: unknown = observer.observe(event);
    // Guard: if observe() returns a thenable despite void signature, catch its rejection
    // to prevent unhandled promise rejections from crashing the process.
    if (result !== null && result !== undefined && typeof (result as { catch?: unknown }).catch === "function") {
      (result as Promise<void>).catch((e) => {
        fwLogger().error(
          `[observer] async observe() rejected for ${event.type} — Observer.observe must be synchronous:`,
          e instanceof Error ? e.message : e,
        );
        if (isStrictMode()) {
          const error = e instanceof Error ? e : new Error(String(e));
          error.message = `[OBSERVER_STRICT] Observer.observe() returned a rejected Promise for event '${event.type}'. ` +
            `Observer.observe MUST be synchronous. Original: ${error.message}`;
          // Cannot throw from the already-returned synchronous dispatchEvent;
          // record it so tests can assert via `__lastStrictFailure()`.
          lastStrictFailure = error;
        }
      });
    }
  } catch (e) {
    fwLogger().error(
      `[observer] dispatchEvent failed for ${event.type}:`,
      e instanceof Error && e.stack ? e.stack : e,
    );
    if (isStrictMode()) throw e;
  }
}
