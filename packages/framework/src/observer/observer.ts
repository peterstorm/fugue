import type { ObserverEvent } from "../types/events.js";

// Re-export the interface from its canonical home in `types/`.
export type { Observer } from "../types/observer.js";
import type { Observer } from "../types/observer.js";

// ---------------------------------------------------------------------------
// Concrete implementations
// ---------------------------------------------------------------------------

export class NoopObserver implements Observer {
  observe(_event: ObserverEvent): void {}
}

export class RecordingObserver implements Observer {
  readonly events: ObserverEvent[] = [];

  observe(event: ObserverEvent): void {
    this.events.push(event);
  }
}

// ---------------------------------------------------------------------------
// Per-event-type handler factory
// ---------------------------------------------------------------------------

/**
 * Handler map keyed by `ObserverEvent["type"]` discriminant.
 * Each handler receives the narrowed event type for that discriminant.
 */
type EventHandlers = {
  readonly [K in ObserverEvent["type"]]?: (
    event: Extract<ObserverEvent, { type: K }>,
  ) => void;
};

/**
 * Factory for creating an Observer from per-event-type handlers.
 * Unspecified event types are silently ignored (no-op).
 *
 * Preserves the ergonomics of the old `Partial<Observer>` API — consumers
 * that only care about a subset of events get a one-liner construction path.
 *
 * ```ts
 * const obs = createObserver({
 *   "run-end": (e) => console.log(`Run ${e.runId} finished: ${e.status}`),
 *   "node-error": (e) => metrics.increment('node.errors'),
 * });
 * ```
 */
export function createObserver(handlers: EventHandlers): Observer {
  return {
    observe(event: ObserverEvent): void {
      const handler = handlers[event.type] as
        | ((e: ObserverEvent) => void)
        | undefined;
      if (handler) handler(event);
    },
  };
}
