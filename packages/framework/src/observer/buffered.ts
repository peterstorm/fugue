import type { ObserverEvent, RunEndEvent } from "../types/events.js";
import type { Observer } from "./observer.js";
import type { PersistencePolicy } from "./policy.js";
import { fwLogger } from "../logger.js";
import { dispatchEvent } from "./dispatch.js";
import { match } from "ts-pattern";
export { dispatchEvent } from "./dispatch.js";

export type { RunSummary } from "./run-summary.js";
import type { RunSummary } from "./run-summary.js";

export interface AggregateCounters {
  runCount: number;
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
    match(e)
      .with({ type: "node-start" }, (ev) => {
        nodeIds.add(ev.nodeId);
        const count = (startCounts.get(ev.nodeId) ?? 0) + 1;
        startCounts.set(ev.nodeId, count);
      })
      .with({ type: "node-end" }, (ev) => { nodeIds.add(ev.nodeId); })
      .with({ type: "node-error" }, (ev) => { nodeIds.add(ev.nodeId); })
      .with({ type: "node-skipped" }, (ev) => { nodeIds.add(ev.nodeId); })
      .with({ type: "freshness-violation" }, () => { freshnessViolationCount++; })
      .with({ type: "human-intervention" }, () => { humanInterventionCount++; })
      .with({ type: "route-decided" }, () => { routeDecisionCount++; })
      .otherwise(() => { /* no-op for run-start, run-end, sub-span, node-pruned, witness-captured, write-attempted */ });
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

interface BufferedObserverOpts {
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

/**
 * Buffered observer that accumulates per-run events and flushes them according
 * to a persistence policy (tail-based sampling). Implements `Observer` for event
 * ingestion and `Disposable` for resource cleanup.
 *
 * Lifecycle: construct → observe(events) → close() / [Symbol.dispose]()
 *
 * Events are buffered by runId. On `run-end`, the persistence policy decides
 * whether to flush the run's events to the downstream exporter. Stale runs
 * (no events for `staleSweepMs`) are evicted to bound memory.
 */
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

  /**
   * Hostile-seam guard for the injected clock, parity with the file backend's
   * readClock discipline (ADR-0080): a throwing clock must never escape as an
   * uncaught timer exception, and a non-finite stamp must never silently
   * disable eviction (a NaN cutoff makes `createdAt < cutoff` permanently
   * false — orphaned run buffers would never be dropped and no diagnostic
   * would ever fire). Returns `null`, after a loud diagnostic, when the clock
   * cannot be trusted this cycle; every caller skips rather than comparing
   * against garbage.
   */
  private readClock(): number | null {
    let nowMs: number;
    try {
      nowMs = this.now();
    } catch (error) {
      fwLogger().error(
        `[BufferedObserver] clock threw — eviction disabled this cycle: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
    if (!Number.isFinite(nowMs)) {
      fwLogger().warn(
        `[BufferedObserver] clock returned a non-finite stamp (${String(nowMs)}) — eviction disabled this cycle`,
      );
      return null;
    }
    return nowMs;
  }

  /** Drop run buffers that exceeded `ttlMs` without a run-end. */
  evictStale(): void {
    const nowMs = this.readClock();
    if (nowMs === null) return;
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
      const createdAt = this.readClock();
      if (createdAt === null) {
        // A run buffer cannot be opened without a trustworthy stamp, and an
        // unstampable buffer could never be evicted — fail loud through the
        // established accounting (counted + dead-letter-or-log, never both,
        // never neither) rather than persisting a NaN/Infinity stamp that
        // orphans this run for the observer's lifetime.
        this.accountDispatchFailure(
          event,
          new Error("clock unavailable — cannot stamp run buffer; event dropped"),
          "buffer-open",
        );
        return;
      }
      buf = { events: [], createdAt };
      this.buffers.set(runId, buf);
    }
    buf.events.push(event);
  }

  /**
   * ONE accounting contract for a dispatch failure: count it in
   * `dispatchErrors` AND route it through the dead-letter seam, or log it —
   * never both, never neither. The replay loop and the run-end dispatch
   * share this so a future divergence between the two catch sites cannot
   * silently re-open the leak class those pins guard.
   */
  private accountDispatchFailure(event: ObserverEvent, error: unknown, label: string): void {
    this.dispatchErrors++;
    if (this.onReplayFailure) {
      this.onReplayFailure(event, error);
    } else {
      fwLogger().error(`[BufferedObserver] Replay failed for ${label}: ${error instanceof Error ? error.message : error}`);
    }
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

    // Policy evaluation is programmer-provided — let bugs surface visibly.
    // Fail-open: flush on policy error to avoid silent data loss.
    let shouldFlush: boolean;
    try {
      shouldFlush = this.policy.shouldFlush(summary);
    } catch (policyErr) {
      fwLogger().error(
        `[BufferedObserver] PersistencePolicy.shouldFlush threw — flushing to avoid data loss:`,
        policyErr instanceof Error ? policyErr.message : policyErr,
      );
      shouldFlush = true;
    }

    try {
      if (shouldFlush) {
        let replayFailures = 0;
        for (const buffered of events) {
          try {
            dispatchEvent(this.inner, buffered);
          } catch (err) {
            replayFailures++;
            this.accountDispatchFailure(buffered, err, `${buffered.type}`);
          }
        }
        if (replayFailures > 0) {
          fwLogger().error(
            `[BufferedObserver] ${replayFailures}/${events.length} events lost during replay for run ${e.runId}`,
          );
        }
        // Guard the final run-end dispatch the same way as the replay loop —
        // an unguarded throw here used to escape, skip buffer cleanup, and
        // leak the run-id's events for the lifetime of the observer. The
        // failure is accounted exactly like the replay loop's: counted in
        // `dispatchErrors` and routed through `onReplayFailure` (the dead-letter
        // seam), not logged-and-forgotten.
        try {
          dispatchEvent(this.inner, e);
        } catch (err) {
          this.accountDispatchFailure(e, err, "run-end");
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
