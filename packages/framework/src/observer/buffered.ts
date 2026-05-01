import type {
  ObserverEvent,
  RunStartEvent,
  NodeStartEvent,
  NodeEndEvent,
  NodeSkippedEvent,
  NodeErrorEvent,
  SubSpanEvent,
  RunEndEvent,
} from "../types/events.js";
import type { Observer } from "./observer.js";
import type { PersistencePolicy } from "./policy.js";

export interface RunSummary {
  readonly runId: string;
  readonly status: "ok" | "error";
  readonly totalDuration: number;
  readonly nodeCount: number;
  readonly retryCount: number;
  readonly cacheHitCount: number;
  readonly totalCostUsd: number;
}

export interface AggregateCounters {
  runCount: number;
  totalCostUsd: number;
}

export function dispatchEvent(observer: Observer, event: ObserverEvent): void {
  try {
    switch (event.type) {
      case "run-start":
        observer.onRunStart(event);
        break;
      case "node-start":
        observer.onNodeStart(event);
        break;
      case "node-end":
        observer.onNodeEnd(event);
        break;
      case "node-skipped":
        observer.onNodeSkipped(event);
        break;
      case "node-error":
        observer.onNodeError(event);
        break;
      case "sub-span":
        observer.onSubSpan(event);
        break;
      case "run-end":
        observer.onRunEnd(event);
        break;
      default: {
        const _exhaustive: never = event;
        break;
      }
    }
  } catch (e) {
    console.warn(`[observer] dispatchEvent failed for ${event.type}: ${e instanceof Error ? e.message : e}`);
  }
}

/** Pure: compute RunSummary from buffered events and the RunEndEvent. */
export function computeRunSummary(
  events: readonly ObserverEvent[],
  runEnd: RunEndEvent,
): RunSummary {
  const nodeIds = new Set<string>();
  let retryCount = 0;
  let cacheHitCount = 0;
  let totalCostUsd = 0;

  // Track node-start counts per nodeId to detect retries
  const startCounts = new Map<string, number>();

  for (const e of events) {
    switch (e.type) {
      case "node-start": {
        nodeIds.add(e.nodeId);
        const count = (startCounts.get(e.nodeId) ?? 0) + 1;
        startCounts.set(e.nodeId, count);
        break;
      }
      case "node-end": {
        nodeIds.add(e.nodeId);
        const attrs = (e as NodeEndEvent & { attributes?: Record<string, unknown> }).attributes;
        if (attrs) {
          if (attrs["cache_hit"] === true) cacheHitCount++;
          if (typeof attrs["cost_usd"] === "number") totalCostUsd += attrs["cost_usd"];
        }
        break;
      }
      case "node-error":
      case "node-skipped":
        nodeIds.add(e.nodeId);
        break;
    }
  }

  // Nodes that started more than once are retried nodes
  for (const count of startCounts.values()) {
    if (count > 1) retryCount++;
  }

  return {
    runId: runEnd.runId,
    status: runEnd.status,
    totalDuration: runEnd.duration,
    nodeCount: nodeIds.size,
    retryCount,
    cacheHitCount,
    totalCostUsd,
  };
}

export class BufferedObserver implements Observer {
  private readonly buffers = new Map<string, ObserverEvent[]>();
  readonly aggregates: AggregateCounters = { runCount: 0, totalCostUsd: 0 };

  constructor(
    private readonly inner: Observer,
    private readonly policy: PersistencePolicy,
  ) {}

  private buffer(runId: string, event: ObserverEvent): void {
    let buf = this.buffers.get(runId);
    if (!buf) {
      buf = [];
      this.buffers.set(runId, buf);
    }
    buf.push(event);
  }

  onRunStart(e: RunStartEvent): void {
    this.buffer(e.runId, e);
  }
  onNodeStart(e: NodeStartEvent): void {
    this.buffer(e.runId, e);
  }
  onNodeEnd(e: NodeEndEvent): void {
    this.buffer(e.runId, e);
  }
  onNodeSkipped(e: NodeSkippedEvent): void {
    this.buffer(e.runId, e);
  }
  onNodeError(e: NodeErrorEvent): void {
    this.buffer(e.runId, e);
  }
  onSubSpan(e: SubSpanEvent): void {
    this.buffer(e.runId, e);
  }

  onRunEnd(e: RunEndEvent): void {
    const events = this.buffers.get(e.runId) ?? [];
    const summary = computeRunSummary(events, e);

    // Aggregate counters always update
    this.aggregates.runCount++;
    this.aggregates.totalCostUsd += summary.totalCostUsd;

    if (this.policy.shouldFlush(summary)) {
      // Replay buffered events + the run-end event; continue on individual failures
      for (const buffered of events) {
        try {
          dispatchEvent(this.inner, buffered);
        } catch (err) {
          console.warn(`[BufferedObserver] Replay failed for ${buffered.type}: ${err instanceof Error ? err.message : err}`);
        }
      }
      dispatchEvent(this.inner, e);
    }

    this.buffers.delete(e.runId);
  }
}
