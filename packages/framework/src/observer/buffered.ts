import type { ObserverEvent, RunEndEvent } from "../types/events.js";
import type { Observer } from "./observer.js";
import type { PersistencePolicy } from "./policy.js";
import { fwLogger } from "../logger.js";

export interface RunSummary {
  readonly runId: string;
  readonly status: "ok" | "error";
  readonly totalDuration: number;
  readonly nodeCount: number;
  readonly retryCount: number;
  /**
   * Sum of LLM cost from OTel spans. Present only when computed by
   * `TailSamplingProcessor` (which reads `ai.llm.cost_usd` from span
   * attributes). `undefined` in the `BufferedObserver` path because
   * observer events don't carry cost data.
   */
  readonly totalCostUsd?: number;
  readonly freshnessViolationCount: number;
  readonly humanInterventionCount: number;
  readonly routeDecisionCount: number;
}

export interface AggregateCounters {
  runCount: number;
}

/**
 * When `OBSERVER_STRICT=1` is set in the environment, dispatchEvent rethrows
 * any observer failure instead of catching. Useful in tests and dev to surface
 * programming bugs in observer impls that would otherwise be silently absorbed.
 * Off in production by default.
 */
const OBSERVER_STRICT =
  typeof process !== "undefined" && process.env?.OBSERVER_STRICT === "1";

/**
 * Error-isolating dispatch wrapper. Calls `observer.observe(event)` and
 * catches any failure — production observers MUST be failure-tolerant (runs
 * continue). Under `OBSERVER_STRICT=1` the error is re-thrown after logging
 * so tests surface programming bugs in observer implementations.
 */
export function dispatchEvent(observer: Observer, event: ObserverEvent): void {
  try {
    const result: unknown = observer.observe(event);
    // Guard: if observe() returns a thenable despite void signature, catch its rejection
    // to prevent unhandled promise rejections from crashing the process.
    if (result !== null && result !== undefined && typeof (result as { catch?: unknown }).catch === "function") {
      (result as Promise<void>).catch((e) => {
        fwLogger().error(
          `[observer] async observe() rejected for ${event.type} — Observer.observe must be synchronous:`,
          e instanceof Error ? e.message : e,
        );
        if (OBSERVER_STRICT) {
          throw e instanceof Error ? e : new Error(String(e));
        }
      });
    }
  } catch (e) {
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
  let freshnessViolationCount = 0;
  let humanInterventionCount = 0;
  let routeDecisionCount = 0;

  const startCounts = new Map<string, number>();

  for (const e of events) {
    switch (e.type) {
      case "node-start": {
        nodeIds.add(e.nodeId);
        const count = (startCounts.get(e.nodeId) ?? 0) + 1;
        startCounts.set(e.nodeId, count);
        break;
      }
      case "node-end":
        nodeIds.add(e.nodeId);
        break;
      case "node-error":
      case "node-skipped":
        nodeIds.add(e.nodeId);
        break;
      case "freshness-violation":
        freshnessViolationCount++;
        break;
      case "human-intervention":
        humanInterventionCount++;
        break;
      case "route-decided":
        routeDecisionCount++;
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
    freshnessViolationCount,
    humanInterventionCount,
    routeDecisionCount,
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
  /**
   * Called when an event fails to replay to the inner observer. Receives the
   * failed event and the error. Use this to wire a dead-letter sink (write to
   * disk, push to a secondary queue) for events that would otherwise be lost.
   * When omitted, failures are logged at error level and the event is dropped.
   */
  readonly onReplayFailure?: (event: ObserverEvent, error: unknown) => void;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_SWEEP_MS = 5 * 60 * 1000; // 5min

export class BufferedObserver implements Observer, Disposable {
  private readonly buffers = new Map<string, RunBuffer>();
  readonly aggregates: AggregateCounters = { runCount: 0 };
  /** Buffers dropped because `run-end` never arrived within TTL. Useful for monitoring. */
  evicted = 0;
  /** Count of events lost to dispatch failures during replay. Useful for monitoring. */
  dispatchErrors = 0;
  private readonly ttlMs: number;
  private readonly sweepHandle: ReturnType<typeof setInterval> | null;
  private readonly now: () => number;

  private readonly onReplayFailure: ((event: ObserverEvent, error: unknown) => void) | null;

  constructor(
    private readonly inner: Observer,
    private readonly policy: PersistencePolicy,
    opts?: BufferedObserverOpts,
  ) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts?.now ?? Date.now;
    this.onReplayFailure = opts?.onReplayFailure ?? null;
    const sweepMs = opts?.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
    if (sweepMs > 0) {
      this.sweepHandle = setInterval(() => this.evictStale(), sweepMs);
      // Don't keep the event loop alive purely to sweep an idle observer.
      this.sweepHandle.unref();
    } else {
      this.sweepHandle = null;
    }
  }

  /** Stop the background sweep. Call when discarding the observer. */
  close(): void {
    if (this.sweepHandle) clearInterval(this.sweepHandle);
  }

  [Symbol.dispose](): void {
    this.close();
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

  observe(event: ObserverEvent): void {
    if (event.type === "run-end") {
      this.handleRunEnd(event);
    } else {
      this.buffer(event.runId, event);
    }
  }

  private handleRunEnd(e: RunEndEvent): void {
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

    try {
      if (this.policy.shouldFlush(summary)) {
        let replayFailures = 0;
        for (const buffered of events) {
          try {
            dispatchEvent(this.inner, buffered);
          } catch (err) {
            replayFailures++;
            this.dispatchErrors++;
            if (this.onReplayFailure) {
              this.onReplayFailure(buffered, err);
            } else {
              fwLogger().error(`[BufferedObserver] Replay failed for ${buffered.type}: ${err instanceof Error ? err.message : err}`);
            }
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
