import type {
  RunStartEvent,
  NodeStartEvent,
  NodeEndEvent,
  NodeSkippedEvent,
  NodeErrorEvent,
  SubSpanEvent,
  RunEndEvent,
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
}

export class NoopObserver implements Observer {
  onRunStart(_e: RunStartEvent): void {}
  onNodeStart(_e: NodeStartEvent): void {}
  onNodeEnd(_e: NodeEndEvent): void {}
  onNodeSkipped(_e: NodeSkippedEvent): void {}
  onNodeError(_e: NodeErrorEvent): void {}
  onSubSpan(_e: SubSpanEvent): void {}
  onRunEnd(_e: RunEndEvent): void {}
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
}
