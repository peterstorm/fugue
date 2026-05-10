import type {
  ObserverEvent,
  RunStartEvent,
  NodeStartEvent,
  NodeEndEvent,
  NodeSkippedEvent,
  NodeErrorEvent,
  SubSpanEvent,
  RunEndEvent,
  RouteDecidedEvent,
  NodePrunedEvent,
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
      case "route-decided":
        observer.onRouteDecided?.(event);
        break;
      case "node-pruned":
        observer.onNodePruned?.(event);
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

/** Per-run buffer entry — events plus the wall-clock time it was opened. */
interface RunBuffer {
  events: ObserverEvent[];
  createdAt: number;
}

export interface BufferedObserverOpts {
  /** Drop a run buffer if `run-end` never arrived within this many ms. Default 1h. */
  readonly ttlMs?: number;
  /** Sweep interval for dropping stale buffers. Default 5min. */
  readonly sweepIntervalMs?: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_SWEEP_MS = 5 * 60 * 1000; // 5min

export class BufferedObserver implements Observer {
  private readonly buffers = new Map<string, RunBuffer>();
  readonly aggregates: AggregateCounters = { runCount: 0, totalCostUsd: 0 };
  /** Buffers dropped because `run-end` never arrived within TTL. Useful for monitoring. */
  evicted = 0;
  private readonly ttlMs: number;
  private readonly sweepHandle: ReturnType<typeof setInterval> | null;

  constructor(
    private readonly inner: Observer,
    private readonly policy: PersistencePolicy,
    opts?: BufferedObserverOpts,
  ) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    const sweepMs = opts?.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
    if (sweepMs > 0) {
      this.sweepHandle = setInterval(() => this.evictStale(), sweepMs);
      // Don't keep the event loop alive purely to sweep an idle observer.
      (this.sweepHandle as unknown as { unref?: () => void }).unref?.();
    } else {
      this.sweepHandle = null;
    }
  }

  /** Stop the background sweep. Call when discarding the observer. */
  close(): void {
    if (this.sweepHandle) clearInterval(this.sweepHandle);
  }

  /** Drop run buffers that exceeded `ttlMs` without a run-end. */
  private evictStale(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [runId, buf] of this.buffers) {
      if (buf.createdAt < cutoff) {
        this.buffers.delete(runId);
        this.evicted++;
        console.warn(
          `[BufferedObserver] Evicting orphaned run buffer ${runId} (age: ${Date.now() - buf.createdAt}ms, events: ${buf.events.length})`,
        );
      }
    }
  }

  private buffer(runId: string, event: ObserverEvent): void {
    let buf = this.buffers.get(runId);
    if (!buf) {
      buf = { events: [], createdAt: Date.now() };
      this.buffers.set(runId, buf);
    }
    buf.events.push(event);
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
  onRouteDecided(e: RouteDecidedEvent): void {
    this.buffer(e.runId, e);
  }
  onNodePruned(e: NodePrunedEvent): void {
    this.buffer(e.runId, e);
  }

  onRunEnd(e: RunEndEvent): void {
    const events = this.buffers.get(e.runId)?.events ?? [];
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
