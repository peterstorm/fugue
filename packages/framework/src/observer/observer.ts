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
  ObserverEvent,
} from "../types/events.js";

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

export class NoopObserver implements Observer {
  onRunStart(_e: RunStartEvent): void {}
  onNodeStart(_e: NodeStartEvent): void {}
  onNodeEnd(_e: NodeEndEvent): void {}
  onNodeSkipped(_e: NodeSkippedEvent): void {}
  onNodeError(_e: NodeErrorEvent): void {}
  onSubSpan(_e: SubSpanEvent): void {}
  onRunEnd(_e: RunEndEvent): void {}
  onRouteDecided(_e: RouteDecidedEvent): void {}
  onNodePruned(_e: NodePrunedEvent): void {}
  onWitnessCaptured(_e: WitnessCapturedEvent): void {}
  onWriteAttempted(_e: WriteAttemptedEvent): void {}
  onFreshnessViolation(_e: FreshnessViolationEvent): void {}
  onHumanIntervention(_e: HumanInterventionEvent): void {}
}

export class RecordingObserver implements Observer {
  readonly events: ObserverEvent[] = [];

  onRunStart(e: RunStartEvent): void {
    this.events.push(e);
  }
  onNodeStart(e: NodeStartEvent): void {
    this.events.push(e);
  }
  onNodeEnd(e: NodeEndEvent): void {
    this.events.push(e);
  }
  onNodeSkipped(e: NodeSkippedEvent): void {
    this.events.push(e);
  }
  onNodeError(e: NodeErrorEvent): void {
    this.events.push(e);
  }
  onSubSpan(e: SubSpanEvent): void {
    this.events.push(e);
  }
  onRunEnd(e: RunEndEvent): void {
    this.events.push(e);
  }
  onRouteDecided(e: RouteDecidedEvent): void {
    this.events.push(e);
  }
  onNodePruned(e: NodePrunedEvent): void {
    this.events.push(e);
  }
  onWitnessCaptured(e: WitnessCapturedEvent): void {
    this.events.push(e);
  }
  onWriteAttempted(e: WriteAttemptedEvent): void {
    this.events.push(e);
  }
  onFreshnessViolation(e: FreshnessViolationEvent): void {
    this.events.push(e);
  }
  onHumanIntervention(e: HumanInterventionEvent): void {
    this.events.push(e);
  }
}

const noop = (): void => {};

/**
 * Factory for creating an Observer from a partial set of handlers.
 * Unspecified event handlers default to no-ops. Keeps the `Observer` interface
 * exhaustive (adding a new event type is still a compile error in consumers
 * implementing the full interface) while giving consumers that only care about
 * a subset a one-liner construction path.
 *
 * ```ts
 * const obs = createObserver({
 *   onRunEnd(e) { console.log(`Run ${e.runId} finished: ${e.status}`); },
 *   onNodeError(e) { metrics.increment('node.errors'); },
 * });
 * ```
 */
export function createObserver(handlers: Partial<Observer>): Observer {
  return {
    onRunStart: handlers.onRunStart ?? noop,
    onNodeStart: handlers.onNodeStart ?? noop,
    onNodeEnd: handlers.onNodeEnd ?? noop,
    onNodeSkipped: handlers.onNodeSkipped ?? noop,
    onNodeError: handlers.onNodeError ?? noop,
    onSubSpan: handlers.onSubSpan ?? noop,
    onRunEnd: handlers.onRunEnd ?? noop,
    onRouteDecided: handlers.onRouteDecided ?? noop,
    onNodePruned: handlers.onNodePruned ?? noop,
    onWitnessCaptured: handlers.onWitnessCaptured ?? noop,
    onWriteAttempted: handlers.onWriteAttempted ?? noop,
    onFreshnessViolation: handlers.onFreshnessViolation ?? noop,
    onHumanIntervention: handlers.onHumanIntervention ?? noop,
  };
}
