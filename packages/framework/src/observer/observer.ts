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
  ObserverEvent,
} from "../types/events.js";

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
}
