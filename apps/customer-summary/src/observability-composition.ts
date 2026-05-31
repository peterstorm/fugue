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
 * byte-for-byte the pre-Foundry behaviour (SC-006 / FR-003 / FR-027). The
 * 1-element exporter tuple unwraps in `normalizeExporter`, so no Composite
 * wrapper is introduced.
 *
 * Foundry path: the MLflow and/or Azure Monitor exporters (FR-002 dual export,
 * order preserved), and an `AiFoundryObserver`-over-sink wrapped in a
 * `BufferedObserver` that SHARES the SAME persistence-policy instance used for
 * trace tail-sampling (FR-021 / SC-010 — a discarded trace produces no orphaned
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
  dispatchEvent,
  createAzureMonitorExporter,
  fwLogger,
} from "@fugue/framework";
import type {
  Observer,
  PersistencePolicy,
  FoundryTelemetrySink,
  RunSummaryExtras,
} from "@fugue/framework";
import type { ObserverEvent, RunEndEvent } from "@fugue/framework";
import type { ResolvedObservability } from "./observability.js";
import { isFoundryEnabled } from "./observability.js";

/**
 * `SpanExporter` derived from the framework's `createAzureMonitorExporter`
 * return type (which is annotated as the abstract OTel `SpanExporter`
 * interface, NOT a concrete class) so the app needs NO direct
 * `@opentelemetry/*` dependency. The framework owns the OTel surface; this keeps
 * the app's dependency graph minimal.
 */
export type SpanExporter = ReturnType<typeof createAzureMonitorExporter>;

/** A non-empty tuple of exporters, the exact shape `initTracing` accepts. */
export type ExporterList = readonly [SpanExporter, ...SpanExporter[]];

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

export interface ComposedObservability {
  /** Ordered, non-empty exporter tuple for the widened `initTracing`. */
  readonly exporters: ExporterList;
  /** The domain-event observer for `deps.observer`. */
  readonly observer: Observer;
}

/**
 * Inner observer that emits the FULL FR-019 run summary (SC-008).
 *
 * `BufferedObserver` replays a run's buffered events one-by-one to its inner
 * observer and then the `run-end`. The framework's `AiFoundryObserver` maps each
 * event via `mapEventToFoundry`, which for `run-end` emits only the BARE summary
 * (duration + status — the fields the bare event guarantees). To satisfy SC-008
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
 * so it is omitted from the BufferedObserver path — `mapRunSummaryToFoundry`
 * already drops it when `summary.totalCostUsd` is undefined, and the cost METRIC
 * is emitted on the span/trace side. Token totals are likewise span-resident and
 * are intentionally NOT supplied via `RunSummaryExtras` (same rationale as cost).
 * `cacheHitCount` IS knowable here and is always supplied so the SC-008 guarantee
 * holds.
 *
 * This observer is fail-tolerant in the same spirit as `AiFoundryObserver`: it
 * is invoked inside `BufferedObserver`'s guarded replay loop, and it forwards
 * each emission independently through the sink (which the wrapped observer
 * already guards). A throw in summary mapping is contained per the buffered
 * replay's try/catch.
 */
export class FoundryRunSummaryObserver implements Observer {
  private readonly inner: AiFoundryObserver;
  // Inner buffer that makes this observer usable STANDALONE (SC-008 drives it
  // directly, with no wrapping BufferedObserver). Per-run entries are bounded:
  // each is deleted on its own `run-end` (`emitRunSummary` → `this.buffered.delete`).
  // In production this runs UNDER a `BufferedObserver`, which guarantees a
  // terminal `run-end` per run — so entries cannot accumulate unbounded.
  private readonly buffered = new Map<string, ObserverEvent[]>();

  constructor(private readonly sink: FoundryTelemetrySink) {
    this.inner = new AiFoundryObserver(sink);
  }

  observe(event: ObserverEvent): void {
    if (event.type === "run-end") {
      this.emitRunSummary(event);
      return;
    }
    // Record for the eventual summary, then forward to the per-event mapper.
    const buf = this.buffered.get(event.runId) ?? [];
    buf.push(event);
    this.buffered.set(event.runId, buf);
    this.inner.observe(event);
  }

  private emitRunSummary(runEnd: RunEndEvent): void {
    const events = this.buffered.get(runEnd.runId) ?? [];
    this.buffered.delete(runEnd.runId);

    const summary = computeRunSummary(events, runEnd);
    const cacheHitCount = events.filter(
      (e) => e.type === "node-skipped" && e.reason === "checkpoint",
    ).length;
    const extras: RunSummaryExtras = { cacheHitCount };

    const emissions = mapRunSummaryToFoundry(summary, runEnd, extras);
    for (const emission of emissions) {
      try {
        if (emission.kind === "event") {
          this.sink.trackEvent({
            name: emission.name,
            properties: emission.properties,
            ...(emission.measurements ? { measurements: emission.measurements } : {}),
          });
        } else {
          this.sink.trackMetric({
            name: emission.name,
            value: emission.value,
            ...(emission.properties ? { properties: emission.properties } : {}),
          });
        }
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
 *                      decision per run (FR-021 / SC-010).
 * @param factories     injectable exporter/sink builders (fakes in tests).
 */
export const composeObservability = (
  resolved: ResolvedObservability,
  policy: PersistencePolicy,
  factories: ObservabilityFactories,
): ComposedObservability => {
  // Build exporters in the resolved `traceBackends` ORDER (FR-002).
  const exporterList: SpanExporter[] = [];
  for (const backend of resolved.traceBackends) {
    if (backend === "mlflow") {
      exporterList.push(factories.createMlflowExporter());
    } else {
      exporterList.push(factories.createFoundryExporter());
    }
  }
  // `traceBackends` is always non-empty (config rejects empty selection), so the
  // first element exists. Build the non-empty tuple explicitly rather than a
  // blind array→tuple cast (the head is proven present; the tail is the rest).
  const [head, ...tail] = exporterList;
  if (head === undefined) {
    // Unreachable: config validation rejects an empty selection. Fail loud.
    throw new Error(
      "composeObservability: resolved traceBackends produced no exporters (empty selection)",
    );
  }
  const exporters: ExporterList = [head, ...tail];

  if (!isFoundryEnabled(resolved)) {
    // Default / MLflow-only path — byte-for-byte the pre-Foundry behaviour:
    // a NoopObserver, and the single exporter unwraps in normalizeExporter.
    return { exporters, observer: new NoopObserver() };
  }

  // Foundry path: domain events go to the Application Insights sink via the
  // run-summary-bridging observer, wrapped in a BufferedObserver that SHARES
  // the trace policy instance (FR-021 / SC-010).
  const sink = factories.createFoundrySink();
  const foundryObserver = new FoundryRunSummaryObserver(sink);
  const observer = new BufferedObserver(foundryObserver, policy);

  return { exporters, observer };
};

/**
 * Minimal logging seam for {@link resolveFoundryLeg} — only `error` is used.
 */
export interface FoundryLegLogger {
  error(msg: string, ...args: unknown[]): void;
}

/**
 * Outcome of attempting the Foundry construction leg in isolation.
 *
 * `effective` is the selection {@link composeObservability} should consume:
 * unchanged when the Foundry leg succeeded (or was never enabled), and degraded
 * to an MLflow-only selection (no `auth` → {@link isFoundryEnabled} derives
 * `false`) when Foundry construction FAILED — so a runtime Foundry construction
 * fault degrades ONLY the Foundry leg
 * (FR-026 / SC-009) and never disables MLflow tracing (SC-006). The prebuilt
 * instances (present only on success) are handed to the composition's Foundry
 * factories so they are constructed exactly once, here, under this guard.
 */
export interface ResolvedFoundryLeg {
  readonly effective: ResolvedObservability;
  readonly foundryExporter: SpanExporter | null;
  readonly foundrySink: FoundryTelemetrySink | null;
}

/**
 * Attempt the Foundry exporter + sink construction in ISOLATION from MLflow.
 *
 * This is the fault-isolation boundary (FR-026 / SC-009): the effectful Foundry
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
    return { effective: resolved, foundryExporter: null, foundrySink: null };
  }

  try {
    const foundryExporter = buildExporter();
    const foundrySink = buildSink();
    return { effective: resolved, foundryExporter, foundrySink };
  } catch (foundryErr) {
    // Foundry export disabled — MLflow tracing CONTINUES unaffected
    // (FR-026 / SC-009). Degrade the selection to MLflow-only so the
    // composition emits no Foundry exporter/observer for this run.
    log.error(
      "Azure AI Foundry export construction failed — disabling Foundry export; " +
        "MLflow tracing continues unaffected:",
      foundryErr,
    );
    const mlflowOnly = resolved.traceBackends.filter((b) => b !== "foundry");
    // MLflow is guaranteed selectable alongside Foundry in well-formed config;
    // if Foundry was the SOLE backend, fall back to MLflow so tracing still
    // initializes.
    return {
      effective: {
        traceBackends: mlflowOnly.length > 0 ? mlflowOnly : ["mlflow"],
      },
      foundryExporter: null,
      foundrySink: null,
    };
  }
};
