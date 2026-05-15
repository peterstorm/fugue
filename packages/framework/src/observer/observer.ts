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

// Re-export the interface from its canonical home in `types/`.
export type { Observer } from "../types/observer.js";
import type { Observer } from "../types/observer.js";

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
