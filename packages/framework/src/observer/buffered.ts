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
  WitnessCapturedEvent,
  WriteAttemptedEvent,
  FreshnessViolationEvent,
  HumanInterventionEvent,
} from "../types/events.js";
import { match } from "ts-pattern";
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
    match(event)
      .with({ type: "run-start" }, (e) => observer.onRunStart(e))
      .with({ type: "node-start" }, (e) => observer.onNodeStart(e))
      .with({ type: "node-end" }, (e) => observer.onNodeEnd(e))
      .with({ type: "node-skipped" }, (e) => observer.onNodeSkipped(e))
      .with({ type: "node-error" }, (e) => observer.onNodeError(e))
      .with({ type: "sub-span" }, (e) => observer.onSubSpan(e))
      .with({ type: "run-end" }, (e) => observer.onRunEnd(e))
      .with({ type: "route-decided" }, (e) => observer.onRouteDecided(e))
      .with({ type: "node-pruned" }, (e) => observer.onNodePruned(e))
      .with({ type: "witness-captured" }, (e) => observer.onWitnessCaptured(e))
      .with({ type: "write-attempted" }, (e) => observer.onWriteAttempted(e))
      .with({ type: "freshness-violation" }, (e) => observer.onFreshnessViolation(e))
      .with({ type: "human-intervention" }, (e) => observer.onHumanIntervention(e))
      .exhaustive();
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
    if (count > 1) retryCount += count - 1;
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

  onWitnessCaptured(e: WitnessCapturedEvent): void {
    this.buffer(e.runId, e);
  }
  onWriteAttempted(e: WriteAttemptedEvent): void {
    this.buffer(e.runId, e);
  }
  onFreshnessViolation(e: FreshnessViolationEvent): void {
    this.buffer(e.runId, e);
  }
  onHumanIntervention(e: HumanInterventionEvent): void {
    this.buffer(e.runId, e);
  }

  onRunEnd(e: RunEndEvent): void {
    const buf = this.buffers.get(e.runId);
    if (!buf) {
      // An unmatched run-end means the inner observer is about to see a
      // run-end with no preceding run-start. Surface this rather than
      // silently emitting an orphan event — it usually indicates a buggy
      // caller or a double-finalize race.
      fwLogger().warn(`[BufferedObserver] onRunEnd for unknown runId=${e.runId}`);
    }
    const events = buf?.events ?? [];
    const summary = computeRunSummary(events, e);

    this.aggregates.runCount++;
    this.aggregates.totalCostUsd += summary.totalCostUsd;

    try {
      if (this.policy.shouldFlush(summary)) {
        let replayFailures = 0;
        for (const buffered of events) {
          try {
            dispatchEvent(this.inner, buffered);
          } catch (err) {
            replayFailures++;
            fwLogger().error(`[BufferedObserver] Replay failed for ${buffered.type}: ${err instanceof Error ? err.message : err}`);
          }
        }
        if (replayFailures > 0) {
          fwLogger().error(
            `[BufferedObserver] ${replayFailures}/${events.length} events lost during replay for run ${e.runId}`,
          );
        }
        // Guard the final run-end dispatch the same way as the replay loop —
        // an unguarded throw here used to escape, skip buffer cleanup, and
        // leak the run-id's events for the lifetime of the observer.
        try {
          dispatchEvent(this.inner, e);
        } catch (err) {
          fwLogger().error(`[BufferedObserver] Replay failed for run-end: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        fwLogger().warn(`[BufferedObserver] Dropping ${events.length} events for run ${e.runId} (filtered by persistence policy)`);
      }
    } finally {
      // Always clear the buffer — orphaning it on a flush-time throw is what
      // produced the leak in the first place.
      this.buffers.delete(e.runId);
    }
  }
}
