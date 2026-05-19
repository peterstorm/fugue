import type { ObserverEvent } from "../types/events.js";

// Re-export the interface from its canonical home in `types/`.
export type { Observer } from "../types/observer.js";
import type { Observer } from "../types/observer.js";

// ---------------------------------------------------------------------------
// Design note: Observer vs OTel tracing (dual-channel architecture)
//
// The Observer carries **domain events** (run lifecycle, routing decisions,
// freshness witnesses, human interventions). OTel spans in `tracing/` carry
// **infrastructure telemetry** (LLM token costs, latency, span hierarchies).
//
// These are intentionally separate channels:
// - Observer events are consumed by application-level logic (BufferedObserver,
//   tail sampling, run summaries).
// - OTel spans are consumed by observability backends (Jaeger, MLflow OTLP).
//
// Cost data (token counts, USD) lives only on OTel spans. Domain routing
// decisions live only on Observer events. `RunSummary.totalCostUsd` is
// populated only when the TailSamplingProcessor bridges the two channels.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Exhaustive handler factory
// ---------------------------------------------------------------------------

/**
 * Exhaustive handler map — requires a handler for every `ObserverEvent` type.
 * Adding a new event variant to `ObserverEvent` without handling it here is
 * a compile error. Use `createObserver` for partial handling.
 */
type ExhaustiveEventHandlers = {
  readonly [K in ObserverEvent["type"]]: (
    event: Extract<ObserverEvent, { type: K }>,
  ) => void;
};

/**
 * Factory for creating an Observer that requires a handler for every event
 * type. Unlike `createObserver`, omitting a handler is a compile error.
 * Use this for production observers that should handle every event.
 *
 * ```ts
 * const obs = createExhaustiveObserver({
 *   "run-start": (e) => { ... },
 *   "node-start": (e) => { ... },
 *   // ... handler required for every ObserverEvent type (compiler-enforced)
 * });
 * ```
 */
export function createExhaustiveObserver(handlers: ExhaustiveEventHandlers): Observer {
  return {
    observe(event: ObserverEvent): void {
      const handler = handlers[event.type] as (e: ObserverEvent) => void;
      handler(event);
    },
  };
}
