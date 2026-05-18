import type { Observer } from "./observer.js";
import type { ObserverEvent } from "../types/events.js";
import { fwLogger } from "../logger.js";

/**
 * When `OBSERVER_STRICT=1` is set, dispatchEvent rethrows any observer failure
 * instead of catching. Useful in tests to surface programming bugs in observer
 * implementations that would otherwise be silently absorbed in production.
 */
const OBSERVER_STRICT =
  typeof process !== "undefined" && process.env?.OBSERVER_STRICT === "1";

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
        if (OBSERVER_STRICT) {
          const error = e instanceof Error ? e : new Error(String(e));
          error.message = `[OBSERVER_STRICT] Observer.observe() returned a rejected Promise for event '${event.type}'. ` +
            `Observer.observe MUST be synchronous. Original: ${error.message}`;
          queueMicrotask(() => { throw error; });
        }
      });
    }
  } catch (e) {
    fwLogger().error(
      `[observer] dispatchEvent failed for ${event.type}:`,
      e instanceof Error && e.stack ? e.stack : e,
    );
    if (OBSERVER_STRICT) throw e;
  }
}
