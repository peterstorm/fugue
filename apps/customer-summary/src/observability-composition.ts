/**
 * Observability COMPOSITION — the testable core of the bootstrap wiring.
 *
 * Given the resolved backend selection plus a small set of injectable
 * factories (Azure exporter, MLflow exporter, Foundry sink), this module builds:
 *   1. the ordered, non-empty `SpanExporter` tuple handed to the WIDENED
 *      `initTracing` — `[mlflow?, foundry?]` in `traceBackends` order; and
 *   2. the domain-event `Observer` placed into `deps.observer`.
 *
 * Default (no Foundry) path: a SINGLE MLflow exporter + a `NoopObserver` —
 * byte-for-byte the pre-Foundry behaviour (observability spec SC-006 / FR-003 / FR-027). The
 * 1-element exporter tuple unwraps in `normalizeExporter`, so no Composite
 * wrapper is introduced.
 *
 * Foundry path: the MLflow and/or Azure Monitor exporters (observability spec FR-002 dual export,
 * order preserved), and an `AiFoundryObserver`-over-sink wrapped in a
 * `BufferedObserver` that SHARES the SAME persistence-policy instance used for
 * trace tail-sampling (observability spec FR-021 / SC-010 — a discarded trace produces no orphaned
 * domain events).
 *
 * Why a helper (functional core / imperative shell): the factories are
 * injected, so the whole composition is unit-testable with fakes and NO live
 * Azure / Redis / Anthropic. `bootstrap.ts` supplies the real factories.
 */
import {
  AiFoundryObserver,
  BufferedObserver,
  NoopObserver,
  computeRunSummary,
  mapRunSummaryToFoundry,
  forwardEmission,
  dispatchEvent,
  fwLogger,
  isCacheHit,
} from "@fuguejs/framework";
import type {
  Observer,
  PersistencePolicy,
  FoundryTelemetrySink,
  RunSummaryExtras,
  SpanExporter,
} from "@fuguejs/framework";
import type { ObserverEvent, RunEndEvent } from "@fuguejs/framework";
import type { ResolvedObservability, TraceBackend, TraceBackends } from "./observability.js";
import { isFoundryEnabled } from "./observability.js";

/**
 * The OTel `SpanExporter` contract, re-exported from the framework barrel (which
 * owns the `@opentelemetry/*` surface) so the app needs NO direct OTel
 * dependency and stays decoupled from any one exporter factory's signature.
 */
export type { SpanExporter };

/** A non-empty tuple of exporters, the exact shape `initTracing` accepts. */
type ExporterList = readonly [SpanExporter, ...SpanExporter[]];

/**
 * Factories the composition depends on. All injectable so tests can supply
 * fakes (no live Azure, no global Application Insights pipeline). In production
 * `bootstrap.ts` binds these to the real framework factories.
 */
export interface ObservabilityFactories {
  /** Build the MLflow OTLP exporter (always present — MLflow is selectable in both arms). */
  readonly createMlflowExporter: () => SpanExporter;
  /** Build the Azure AI Foundry (Application Insights) span exporter for the resolved auth. */
  readonly createFoundryExporter: () => SpanExporter;
  /** Build the Application Insights-backed domain-event sink for the resolved auth. */
  readonly createFoundrySink: () => FoundryTelemetrySink;
}

interface ComposedObservability {
  /** Ordered, non-empty exporter tuple for the widened `initTracing`. */
  readonly exporters: ExporterList;
  /** The domain-event observer for `deps.observer`. */
  readonly observer: Observer;
}

/**
 * Inner observer that emits the FULL observability spec FR-019 run summary (observability spec SC-008).
 *
 * `BufferedObserver` replays a run's buffered events one-by-one to its inner
 * observer and then the `run-end`. The framework's `AiFoundryObserver` maps each
 * event via `mapEventToFoundry`, which for `run-end` emits only the BARE summary
 * (duration + status — the fields the bare event guarantees). To satisfy observability spec SC-008
 * (every completed run produces a summary carrying nodeCount / retryCount /
 * cacheHitCount / totalCost) we bridge here:
 *
 *   - non-`run-end` events: forward to the wrapped `AiFoundryObserver`
 *     (route-decision, node-pruned, node-latency / cache-hit metrics) AND record
 *     them so the summary can be computed; and
 *   - `run-end`: compute `computeRunSummary(buffered, runEnd)` plus the
 *     cacheHitCount (count of `node-skipped reason=checkpoint` events, default 0)
 *     and emit the COMPLETE summary via `mapRunSummaryToFoundry`. We do NOT
 *     forward `run-end` to `AiFoundryObserver`, so the run-summary event is
 *     emitted exactly ONCE (the full one), never the bare one too.
 *
 * `totalCostUsd` is not knowable from observer events (it lives on OTel spans),
 * so it is omitted from the BufferedObserver path. Cost and token totals are
 * span-resident — they are carried on OTel spans (`ai.llm.cost_usd`,
 * `gen_ai.usage.*`), NOT on observer events — and are simply NOT re-emitted on
 * this domain-event channel here: `mapRunSummaryToFoundry` drops them when
 * undefined (which they always are on this observer-derived path).
 * `cacheHitCount` IS knowable here and is always supplied so the observability spec SC-008 guarantee
 * holds.
 *
 * This observer is fail-tolerant in the same spirit as `AiFoundryObserver`: it
 * is invoked inside `BufferedObserver`'s guarded replay loop, and it forwards
 * each emission independently through the sink (which the wrapped observer
 * already guards). A throw in summary mapping is contained per the buffered
 * replay's try/catch.
 */
interface FoundryRunSummaryObserverOpts {
  /** Drop a run buffer if `run-end` never arrived within this many ms. Default 1h. */
  readonly ttlMs?: number;
  /** Sweep interval for dropping stale buffers. Default 5min. */
  readonly sweepIntervalMs?: number;
  /** Injectable clock; defaults to `Date.now`. Used by tests for deterministic eviction. */
  readonly now?: () => number;
}

/** Per-run buffer entry — events plus the wall-clock time it was opened. */
interface RunSummaryBuffer {
  events: ObserverEvent[];
  createdAt: number;
  /** Last wall-clock time this run produced an event; refreshed per event so
   * the orphan sweep evicts INACTIVE buffers only — an active long-running
   * run is never dropped mid-run, or its summary would be silently zeroed at
   * a late run-end (observability spec SC-008). */
  lastActivityAt: number;
}

const SUMMARY_TTL_MS = 60 * 60 * 1000; // 1h
const SUMMARY_SWEEP_MS = 5 * 60 * 1000; // 5min

export class FoundryRunSummaryObserver implements Observer {
  private readonly inner: AiFoundryObserver;
  // Inner buffer keyed by runId. Per-run entries are normally bounded by their
  // own terminal `run-end` (`emitRunSummary` → `this.buffered.delete`); the
  // TTL sweep mirrors the framework `BufferedObserver`'s orphan-eviction
  // discipline so a run that never emits `run-end` (crash, abandoned run)
  // cannot leak its buffer — the class is memory-safe STANDALONE, not only
  // under the production wrapper contract (round-21 atl-2).
  private readonly buffered = new Map<string, RunSummaryBuffer>();
  /** Buffers dropped because `run-end` never arrived within TTL. Useful for monitoring. */
  evicted = 0;
  /** Buffering events dropped because the clock was untrustworthy when the
   * run buffer would have been opened (a hostile clock must not orphan a
   * buffer that could never be evicted — BufferedObserver parity). */
  droppedEvents = 0;
  private readonly ttlMs: number;
  private readonly sweepHandle: ReturnType<typeof setInterval> | null;
  private readonly now: () => number;

  constructor(
    private readonly sink: FoundryTelemetrySink,
    opts?: FoundryRunSummaryObserverOpts,
  ) {
    this.inner = new AiFoundryObserver(sink);
    this.ttlMs = opts?.ttlMs ?? SUMMARY_TTL_MS;
    this.now = opts?.now ?? Date.now;
    const sweepMs = opts?.sweepIntervalMs ?? SUMMARY_SWEEP_MS;
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
   * Hostile-seam guard for the injected clock, parity with the framework
   * BufferedObserver's readClock discipline (ADR-0080): a throwing clock must
   * never escape as an uncaught timer exception, and a non-finite stamp must
   * never silently disable eviction. Returns `null`, after a loud diagnostic,
   * when the clock cannot be trusted this cycle.
   */
  private readClock(): number | null {
    let nowMs: number;
    try {
      nowMs = this.now();
    } catch (error) {
      fwLogger().error(
        `[FoundryRunSummaryObserver] clock threw — eviction disabled this cycle: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
    if (!Number.isFinite(nowMs)) {
      fwLogger().warn(
        `[FoundryRunSummaryObserver] clock returned a non-finite stamp (${String(nowMs)}) — eviction disabled this cycle`,
      );
      return null;
    }
    return nowMs;
  }

  /** Drop run buffers whose LAST ACTIVITY exceeded `ttlMs` without a run-end.
   * Eviction is inactivity-based (not open-time-based): a run that keeps
   * emitting events is alive by definition and must not be evicted mid-run,
   * or its summary would be silently zeroed at a late run-end (observability spec SC-008).
   * Public so tests can drive eviction deterministically (BufferedObserver
   * parity). */
  evictStale(): void {
    const nowMs = this.readClock();
    if (nowMs === null) return;
    const cutoff = nowMs - this.ttlMs;
    for (const [runId, buf] of this.buffered) {
      if (buf.lastActivityAt < cutoff) {
        this.buffered.delete(runId);
        this.evicted++;
        fwLogger().warn(
          `[FoundryRunSummaryObserver] evicted stale run buffer for runId '${String(runId)}' — no events within ${this.ttlMs}ms and run-end never arrived`,
        );
      }
    }
  }

  observe(event: ObserverEvent): void {
    if (event.type === "run-end") {
      this.emitRunSummary(event);
      return;
    }
    // The open-buffer branch absorbs the event even when the clock
    // misbehaves (BufferedObserver parity): the activity refresh is
    // best-effort — a null stamp leaves lastActivityAt stale, but the sweep
    // is disabled that cycle anyway (readClock gate), so no active run is
    // evicted on stale data while the clock is broken. Events are dropped
    // ONLY when a NEW buffer would have to be opened unstampable.
    const existing = this.buffered.get(event.runId);
    const activity = this.readClock();
    if (existing !== undefined) {
      existing.events.push(event);
      if (activity !== null) existing.lastActivityAt = activity;
      this.inner.observe(event);
      return;
    }
    if (activity === null) {
      this.droppedEvents++;
      fwLogger().warn(
        `[FoundryRunSummaryObserver] clock unavailable — run buffer not opened for runId '${String(event.runId)}'; event dropped (counted)`,
      );
      return this.inner.observe(event);
    }
    const opened: RunSummaryBuffer = {
      events: [event],
      createdAt: activity,
      lastActivityAt: activity,
    };
    this.buffered.set(event.runId, opened);
    this.inner.observe(event);
  }

  private emitRunSummary(runEnd: RunEndEvent): void {
    const entry = this.buffered.get(runEnd.runId);
    const events = entry?.events ?? [];
    this.buffered.delete(runEnd.runId);

    const summary = computeRunSummary(events, runEnd);
    // Cache-hit rule is the framework's single `isCacheHit` definition (exhaustive
    // over the skip-reason union) so this count and the per-event cache-hit metric
    // in `mapEventToFoundry` cannot drift. The `node-skipped` check narrows `e` so
    // `isCacheHit` receives the right variant.
    const cacheHitCount = events.filter(
      (e) => e.type === "node-skipped" && isCacheHit(e),
    ).length;
    const extras: RunSummaryExtras = { cacheHitCount };

    const emissions = mapRunSummaryToFoundry(summary, runEnd, extras);
    for (const emission of emissions) {
      try {
        forwardEmission(this.sink, emission);
      } catch (err) {
        // Fail-tolerant: a misbehaving sink must not break the run's tail. This
        // run-summary path calls `this.sink` DIRECTLY (it never routes through
        // AiFoundryObserver, which does its own logging), so the swallow MUST be
        // logged here or the failure would be invisible. Mirror the framework
        // observer's warn so a dropped run-summary emission is still observable.
        fwLogger().warn(
          `[FoundryRunSummaryObserver] sink.${emission.kind === "event" ? "trackEvent" : "trackMetric"} threw for '${emission.name}' (run summary) — swallowed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}

// Re-exported so callers that want to drive replay directly (and tests) share
// the same dispatch entry point the framework uses internally.
export { dispatchEvent };

/**
 * Pure-ish composition: resolved selection + injected factories →
 * `{ exporters, observer }`. No live I/O of its own — every effectful
 * construction is delegated to an injected factory.
 *
 * @param resolved      the backend-resolver output (`auth` presence discriminates).
 * @param policy        the SHARED persistence policy. The SAME instance is the
 *                      one `bootstrap.ts` passes to `initTracing`, so trace
 *                      tail-sampling and domain-event gating make ONE coherent
 *                      decision per run (observability spec FR-021 / SC-010).
 * @param factories     injectable exporter/sink builders (fakes in tests).
 */
export const composeObservability = (
  resolved: ResolvedObservability,
  policy: PersistencePolicy,
  factories: ObservabilityFactories,
): ComposedObservability => {
  // Build exporters in the resolved `traceBackends` ORDER (observability spec FR-002). The selection
  // is a NON-EMPTY tuple (config invariant, carried in `TraceBackends`), so the
  // head backend is proven present at the type level — destructuring yields a
  // non-optional head and the result is a non-empty `ExporterList` with no
  // empty-selection runtime guard needed.
  const toExporter = (backend: TraceBackend): SpanExporter =>
    backend === "mlflow" ? factories.createMlflowExporter() : factories.createFoundryExporter();
  const [headBackend, ...tailBackends] = resolved.traceBackends;
  const exporters: ExporterList = [toExporter(headBackend), ...tailBackends.map(toExporter)];

  if (!isFoundryEnabled(resolved)) {
    // Default / MLflow-only path — byte-for-byte the pre-Foundry behaviour:
    // a NoopObserver, and the single exporter unwraps in normalizeExporter.
    return { exporters, observer: new NoopObserver() };
  }

  // Foundry path: domain events go to the Application Insights sink via the
  // run-summary-bridging observer, wrapped in a BufferedObserver that SHARES
  // the trace policy instance (observability spec FR-021 / SC-010).
  const sink = factories.createFoundrySink();
  const foundryObserver = new FoundryRunSummaryObserver(sink);
  const observer = new BufferedObserver(foundryObserver, policy);

  return { exporters, observer };
};

/**
 * Minimal logging seam for {@link resolveFoundryLeg} — only `error` is used.
 */
interface FoundryLegLogger {
  error(msg: string, ...args: unknown[]): void;
}

/**
 * Outcome of attempting the Foundry construction leg in isolation — a
 * DISCRIMINATED UNION on `outcome` so the prebuilt instances and the effective
 * selection cannot drift apart:
 *
 * - `active` — Foundry construction succeeded; BOTH the prebuilt exporter and
 *   sink are present (never one without the other), and `effective` still
 *   includes foundry. The instances are handed to the composition's Foundry
 *   factories so they are constructed exactly once, here, under this guard.
 * - `inactive` — Foundry was never enabled, OR its construction FAILED and the
 *   leg degraded to an MLflow-only `effective` selection. Either way there are
 *   no prebuilt instances. A runtime Foundry construction fault therefore
 *   degrades ONLY the Foundry leg (observability spec FR-026 / SC-009) and never disables MLflow
 *   tracing (observability spec SC-006).
 *
 * `{ exporter present, sink null }` (and vice versa) is now unrepresentable.
 */
type ResolvedFoundryLeg =
  | {
      readonly outcome: "active";
      // An active leg means Foundry construction SUCCEEDED, which is only
      // attempted when the selection is `with-foundry`. Narrowed to that arm so
      // the "active ⇒ Foundry enabled" invariant lives in the type, not a
      // downstream `isFoundryEnabled` re-check.
      readonly effective: Extract<ResolvedObservability, { kind: "with-foundry" }>;
      readonly foundryExporter: SpanExporter;
      readonly foundrySink: FoundryTelemetrySink;
    }
  | {
      readonly outcome: "inactive";
      readonly effective: ResolvedObservability;
    };

/**
 * Attempt the Foundry exporter + sink construction in ISOLATION from MLflow.
 *
 * This is the fault-isolation boundary (observability spec FR-026 / SC-009): the effectful Foundry
 * construction runs here, OUTSIDE the lazy composition factories, so a failure
 * degrades only the Foundry leg. MLflow's exporter is built unconditionally by
 * the caller and is unaffected by this function's outcome.
 *
 * Pure-ish over its injected thunks + logger (no direct I/O of its own): tests
 * supply a throwing `buildExporter`/`buildSink` to assert the MLflow-only
 * degraded selection AND that the failure is logged, all with NO live Azure.
 *
 * @param resolved       the backend-resolver output.
 * @param buildExporter  effectful Azure Monitor exporter constructor (throws on fault).
 * @param buildSink      effectful Application Insights sink constructor (throws on fault).
 * @param log            error-logging seam (the failure MUST be observable).
 */
export const resolveFoundryLeg = (
  resolved: ResolvedObservability,
  buildExporter: () => SpanExporter,
  buildSink: () => FoundryTelemetrySink,
  log: FoundryLegLogger,
): ResolvedFoundryLeg => {
  if (!isFoundryEnabled(resolved)) {
    return { outcome: "inactive", effective: resolved };
  }

  try {
    const foundryExporter = buildExporter();
    const foundrySink = buildSink();
    return { outcome: "active", effective: resolved, foundryExporter, foundrySink };
  } catch (foundryErr) {
    // Foundry export disabled — MLflow tracing CONTINUES unaffected
    // (observability spec FR-026 / SC-009). Degrade the selection to MLflow-only so the
    // composition emits no Foundry exporter/observer for this run.
    log.error(
      "Azure AI Foundry export construction failed — disabling Foundry export; " +
        "MLflow tracing continues unaffected:",
      foundryErr,
    );
    // Preserve an already-selected MLflow leg after removing Foundry. If
    // Foundry was the SOLE backend, explicitly fall back to MLflow so tracing
    // still initializes. Rebuild as a NON-EMPTY tuple (matching the config-layer
    // `TraceBackends` invariant) and freeze it so the degraded selection stays
    // immutable.
    const [head, ...tail] = resolved.traceBackends.filter((b) => b !== "foundry");
    const degraded: TraceBackends = head !== undefined ? [head, ...tail] : ["mlflow"];
    return {
      outcome: "inactive",
      effective: { kind: "mlflow-only", traceBackends: Object.freeze(degraded) },
    };
  }
};
