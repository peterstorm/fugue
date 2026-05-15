// Observer contract — the typed domain-event interface.
//
// Lives in `types/` so the entire types layer is self-contained.
// Runtime implementations (NoopObserver, RecordingObserver, createObserver)
// live in `observer/observer.ts`.

import type {
  RunStartEvent,
  NodeStartEvent,
  NodeEndEvent,
  NodeSkippedEvent,
  NodeErrorEvent,
  SubSpanEvent,
  RunEndEvent,
  RouteDecidedEvent,
  NodePrunedEvent,
  WitnessCapturedEvent,
  WriteAttemptedEvent,
  FreshnessViolationEvent,
  HumanInterventionEvent,
} from "./events.js";

/**
 * Observer contract — one method per event type.
 *
 * This is intentionally a per-event interface (not a single `observe(event)`
 * method) so that adding a new event type to `ObserverEvent` forces every
 * `implements Observer` class to handle it at compile time. The 4-file update
 * cost on new event types is the exhaustiveness tax — it prevents silent
 * omissions in downstream consumers.
 *
 * The framework dispatches via `dispatchEvent(observer, event)` which routes
 * the discriminated union to the appropriate method using ts-pattern.
 */
export interface Observer {
  onRunStart(e: RunStartEvent): void;
  onNodeStart(e: NodeStartEvent): void;
  onNodeEnd(e: NodeEndEvent): void;
  onNodeSkipped(e: NodeSkippedEvent): void;
  onNodeError(e: NodeErrorEvent): void;
  onSubSpan(e: SubSpanEvent): void;
  onRunEnd(e: RunEndEvent): void;
  onRouteDecided(e: RouteDecidedEvent): void;
  onNodePruned(e: NodePrunedEvent): void;
  onWitnessCaptured(e: WitnessCapturedEvent): void;
  onWriteAttempted(e: WriteAttemptedEvent): void;
  onFreshnessViolation(e: FreshnessViolationEvent): void;
  onHumanIntervention(e: HumanInterventionEvent): void;
}
