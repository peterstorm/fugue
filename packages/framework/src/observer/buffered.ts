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
import { fwLogger } from "../logger.js";

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

/**
 * When `OBSERVER_STRICT=1` is set in the environment, dispatchEvent rethrows
 * any observer failure instead of catching. Useful in tests and dev to surface
 * programming bugs in observer impls that would otherwise be silently absorbed.
 * Off in production by default.
 */
const OBSERVER_STRICT =
  typeof process !== "undefined" && process.env?.OBSERVER_STRICT === "1";

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
    // Log at error level with full stack — production observers MUST be
    // failure-tolerant (runs continue), but silent failure is worse than a
    // crash when debugging an observer-impl bug.
    fwLogger().error(
      `[observer] dispatchEvent failed for ${event.type}:`,
      e instanceof Error && e.stack ? e.stack : e,
    );
    if (OBSERVER_STRICT) throw e;
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
  /** Injectable clock; defaults to `Date.now`. Used by tests for deterministic eviction. */
  readonly now?: () => number;
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
  private readonly now: () => number;

  constructor(
    private readonly inner: Observer,
    private readonly policy: PersistencePolicy,
    opts?: BufferedObserverOpts,
  ) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts?.now ?? Date.now;
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
  evictStale(): void {
    const nowMs = this.now();
    const cutoff = nowMs - this.ttlMs;
    for (const [runId, buf] of this.buffers) {
      if (buf.createdAt < cutoff) {
        this.buffers.delete(runId);
        this.evicted++;
        fwLogger().warn(
          `[BufferedObserver] Evicting orphaned run buffer ${runId} (age: ${nowMs - buf.createdAt}ms, events: ${buf.events.length})`,
        );
      }
    }
  }

  private buffer(runId: string, event: ObserverEvent): void {
    let buf = this.buffers.get(runId);
    if (!buf) {
      buf = { events: [], createdAt: this.now() };
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

    this.aggregates.runCount++;
    this.aggregates.totalCostUsd += summary.totalCostUsd;

    try {
      if (this.policy.shouldFlush(summary)) {
        for (const buffered of events) {
          try {
            dispatchEvent(this.inner, buffered);
          } catch (err) {
            fwLogger().warn(`[BufferedObserver] Replay failed for ${buffered.type}: ${err instanceof Error ? err.message : err}`);
          }
        }
        // Guard the final run-end dispatch the same way as the replay loop —
        // an unguarded throw here used to escape, skip buffer cleanup, and
        // leak the run-id's events for the lifetime of the observer.
        try {
          dispatchEvent(this.inner, e);
        } catch (err) {
          fwLogger().warn(`[BufferedObserver] Replay failed for run-end: ${err instanceof Error ? err.message : err}`);
        }
      }
    } finally {
      // Always clear the buffer — orphaning it on a flush-time throw is what
      // produced the leak in the first place.
      this.buffers.delete(e.runId);
    }
  }
}
