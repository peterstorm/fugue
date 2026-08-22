import type { ObserverEvent, RunEndEvent } from "../types/events.js";
import type { Observer } from "./observer.js";
import type { PersistencePolicy } from "./policy.js";
import { fwLogger } from "../logger.js";
import { attemptDispatchEvent } from "./dispatch.js";
import { match } from "ts-pattern";
import { safeDiagnosticRender, safeErrorMessage } from "../types/safe-error.js";
export { dispatchEvent } from "./dispatch.js";

export type { RunSummary } from "./run-summary.js";
import type { RunSummary } from "./run-summary.js";

export interface AggregateCounters {
  readonly runCount: number;
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

/** Per-run buffer entry — events plus its latest activity timestamp. */
interface RunBuffer {
  events: ObserverEvent[];
  /** Last wall-clock time this run produced an event; refreshed per event so
   * the orphan sweep evicts INACTIVE buffers only — an active long-running
   * run must never be dropped mid-run (its run summary would be silently
   * zeroed at a late run-end). */
  lastActivityAt: number;
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

/** Observer diagnostics must never become a second observability failure. */
const bestEffortLog = (
  level: "error" | "warn",
  message: string,
): void => {
  try {
    fwLogger()[level](message);
  } catch {
    // Accounting and cleanup remain authoritative when the logger is broken.
  }
};

/**
 * Buffered observer that accumulates per-run events and flushes them according
 * to a persistence policy (tail-based sampling). Implements `Observer` for event
 * ingestion and `Disposable` for resource cleanup.
 *
 * Lifecycle: construct → observe(event) → close() / [Symbol.dispose]()
 *
 * Events are buffered by runId. On `run-end`, the persistence policy decides
 * whether to flush the run's events to the downstream exporter. Runs inactive
 * for `ttlMs` are evicted to bound memory; `sweepIntervalMs` controls how often
 * that eviction check runs.
 */
export class BufferedObserver implements Observer, Disposable {
  private readonly buffers = new Map<string, RunBuffer>();
  private runCount = 0;
  private evictedCount = 0;
  private dispatchErrorCount = 0;
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

  /** Immutable aggregate metric snapshot. */
  get aggregates(): AggregateCounters {
    return Object.freeze({ runCount: this.runCount });
  }

  /** Buffers dropped because `run-end` never arrived within TTL. */
  get evicted(): number {
    return this.evictedCount;
  }

  /** Count of events lost to dispatch failures during replay. */
  get dispatchErrors(): number {
    return this.dispatchErrorCount;
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
   * disable eviction (a NaN cutoff makes timestamp comparisons permanently
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
      bestEffortLog(
        "error",
        `[BufferedObserver] clock threw — eviction disabled this cycle: ${safeErrorMessage(error)}`,
      );
      return null;
    }
    if (!Number.isFinite(nowMs)) {
      bestEffortLog(
        "warn",
        `[BufferedObserver] clock returned a non-finite stamp (${safeDiagnosticRender(nowMs)}) — eviction disabled this cycle`,
      );
      return null;
    }
    return nowMs;
  }

  /** Drop run buffers whose LAST ACTIVITY exceeded `ttlMs` without a run-end.
   * Inactivity-based (not open-time-based): a run that kept emitting events
   * is alive and must not be evicted mid-run. Orphaned runs (no events since
   * open) still evict exactly as before. */
  evictStale(): void {
    const nowMs = this.readClock();
    if (nowMs === null) return;
    const cutoff = nowMs - this.ttlMs;
    for (const [runId, buf] of this.buffers) {
      if (buf.lastActivityAt < cutoff) {
        this.buffers.delete(runId);
        this.evictedCount++;
        bestEffortLog(
          "warn",
          `[BufferedObserver] Evicting orphaned run buffer ${runId} (last activity: ${nowMs - buf.lastActivityAt}ms ago, events: ${buf.events.length})`,
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
      buf = { events: [], lastActivityAt: createdAt };
      this.buffers.set(runId, buf);
    }
    // An open buffer absorbs the event even when the clock misbehaves
    // (hostile-clock parity): the activity refresh is best-effort — a null
    // stamp leaves lastActivityAt stale, but the sweep is disabled that
    // cycle anyway (readClock gate), so no active run is evicted on stale
    // data while the clock is broken.
    const activity = this.readClock();
    if (activity !== null) buf.lastActivityAt = activity;
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
    this.dispatchErrorCount++;
    if (!this.onReplayFailure) {
      bestEffortLog(
        "error",
        `[BufferedObserver] Replay failed for ${label}: ${safeErrorMessage(error)}`,
      );
      return;
    }

    try {
      this.onReplayFailure(event, error);
    } catch (deadLetterError) {
      bestEffortLog(
        "error",
        `[BufferedObserver] Replay failed for ${label}: ${safeErrorMessage(error)}; dead-letter callback also failed: ${safeErrorMessage(deadLetterError)}`,
      );
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
      bestEffortLog("warn", `[BufferedObserver] onRunEnd for unknown runId=${e.runId}`);
    }
    const events = buf?.events ?? [];
    const summary = computeRunSummary(events, e);

    this.runCount++;

    // Policy evaluation is programmer-provided — let bugs surface visibly.
    // Fail-open: flush on policy error to avoid silent data loss.
    let shouldFlush: boolean;
    try {
      shouldFlush = this.policy.shouldFlush(summary);
    } catch (policyErr) {
      bestEffortLog(
        "error",
        `[BufferedObserver] PersistencePolicy.shouldFlush threw — flushing to avoid data loss: ${safeErrorMessage(policyErr)}`,
      );
      shouldFlush = true;
    }

    try {
      if (shouldFlush) {
        let replayFailures = 0;
        for (const buffered of events) {
          const dispatch = attemptDispatchEvent(this.inner, buffered);
          if (dispatch.kind === "failed") {
            replayFailures++;
            this.accountDispatchFailure(buffered, dispatch.error, `${buffered.type}`);
          }
        }
        if (replayFailures > 0) {
          bestEffortLog(
            "error",
            `[BufferedObserver] ${replayFailures}/${events.length} events lost during replay for run ${e.runId}`,
          );
        }
        // Guard the final run-end dispatch the same way as the replay loop —
        // an unguarded throw here used to escape, skip buffer cleanup, and
        // leak the run-id's events for the lifetime of the observer. The
        // failure is accounted exactly like the replay loop's in production:
        // counted in `dispatchErrors` and routed through `onReplayFailure` (the
        // dead-letter seam), not logged-and-forgotten.
        const runEndDispatch = attemptDispatchEvent(this.inner, e);
        if (runEndDispatch.kind === "failed") {
          this.accountDispatchFailure(e, runEndDispatch.error, "run-end");
        }
      } else {
        bestEffortLog(
          "warn",
          `[BufferedObserver] Dropping ${events.length} events for run ${e.runId} (filtered by persistence policy)`,
        );
      }
    } finally {
      // Always clear the buffer — orphaning it on a flush-time throw is what
      // produced the leak in the first place.
      this.buffers.delete(e.runId);
    }
  }
}
