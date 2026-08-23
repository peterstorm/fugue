// foundry-event-mapping.ts — telemetry mapping core.
//
// Maps framework domain `ObserverEvent`s into vendor-neutral `FoundryEmission`
// records (events + pre-aggregated metrics). It performs no I/O or clock reads;
// deliberately dropped non-finite telemetry emits a diagnostic warning so a
// monitoring false negative cannot disappear silently. The imperative shell
// (`AiFoundryObserver`) forwards each emission to a `FoundryTelemetrySink`.
//
// Spec anchors: FR-018 (record run summaries, routing decisions, pruned
// branches), FR-019 (run-summary fields), FR-020 (pre-aggregated metrics
// dimensioned by DAG/node identity).
//
// --- Run-summary field sourcing -------------------------------------------
// `RunEndEvent` carries only `{ runId, dagId, duration, status }`. FR-019 also
// requires nodeCount, retryCount, cacheHitCount, and totalCost — none of which
// live on the bare event (see types/events.ts). The framework already
// aggregates these into `RunSummary` (observer/buffered.ts `computeRunSummary`,
// plus `totalCostUsd` bridged from OTel spans by `TailSamplingProcessor`).
//
// Therefore there are TWO entry points:
//   * `mapEventToFoundry(event)` — exhaustive over all 13 ObserverEvent
//     variants. For `run-end` it emits a summary carrying only the fields the
//     bare event guarantees (duration, status) plus the run-latency metric.
//     This is the seam the BufferedObserver replay path can use directly.
//   * `mapRunSummaryToFoundry(summary, runEnd)` — the FULL FR-019 emission.
//     The app-layer run-summary bridge computes a `RunSummary` and calls
//     this so the summary event carries duration, status, nodeCount,
//     retryCount, plus cacheHitCount/totalCost when available, and
//     pre-aggregated cost/run-latency metrics dimensioned by dagId.
//
// We do NOT invent fields on the bare event. Callers wanting the complete
// FR-019/SC-008 summary use `mapRunSummaryToFoundry`.

import { match } from "ts-pattern";
import type { NodeSkippedEvent, ObserverEvent, RunEndEvent } from "../types/events.js";
import type { RunSummary } from "./buffered.js";
import { fwLogger } from "../logger.js";
import { safeDiagnosticRender } from "../types/safe-error.js";

// Stable event/metric names. Centralised so the sink contract and tests share
// one source of truth.
export const FOUNDRY_EVENT_RUN_SUMMARY = "fugue.run.summary" as const;
export const FOUNDRY_EVENT_ROUTE_DECISION = "fugue.route.decision" as const;
export const FOUNDRY_EVENT_NODE_PRUNED = "fugue.node.pruned" as const;

export const FOUNDRY_METRIC_RUN_LATENCY = "fugue.run.latency_ms" as const;
export const FOUNDRY_METRIC_RUN_COST = "fugue.run.cost_usd" as const;
export const FOUNDRY_METRIC_RUN_TOKENS = "fugue.run.tokens" as const;
export const FOUNDRY_METRIC_NODE_LATENCY = "fugue.node.latency_ms" as const;
export const FOUNDRY_METRIC_NODE_CACHE_HIT = "fugue.node.cache_hit" as const;

/** The three stable Foundry event names. */
type FoundryEventName =
  | typeof FOUNDRY_EVENT_RUN_SUMMARY
  | typeof FOUNDRY_EVENT_ROUTE_DECISION
  | typeof FOUNDRY_EVENT_NODE_PRUNED;

/** The five stable Foundry metric names. */
type FoundryMetricName =
  | typeof FOUNDRY_METRIC_RUN_LATENCY
  | typeof FOUNDRY_METRIC_RUN_COST
  | typeof FOUNDRY_METRIC_RUN_TOKENS
  | typeof FOUNDRY_METRIC_NODE_LATENCY
  | typeof FOUNDRY_METRIC_NODE_CACHE_HIT;

/**
 * A number proven finite (not NaN/±Infinity). Branded so the finiteness
 * invariant lives in the TYPE: the only way to obtain one is {@link asFinite},
 * which gates on `Number.isFinite`. A `metric` emission's `value` is therefore
 * structurally guaranteed ingestible by Application Insights — a NaN/Infinity
 * `value` is unrepresentable, not merely guarded for at each producer.
 */
export type FiniteNumber = number & { readonly __finite: unique symbol };

/** Smart constructor: the sole gateway to a {@link FiniteNumber}. */
const asFinite = (n: number): FiniteNumber | undefined =>
  Number.isFinite(n) ? (n as FiniteNumber) : undefined;

/**
 * Vendor-neutral telemetry emission. The observer translates each variant into
 * a `FoundryTelemetrySink` call (`trackEvent` / `trackMetric`).
 *
 * - `event`: a discrete domain event with string `properties` and optional
 *   numeric `measurements` (Application Insights customEvent semantics).
 * - `metric`: a single pre-aggregated numeric sample with optional `properties`
 *   used as dimensions (Application Insights customMetric semantics). `value` is
 *   a {@link FiniteNumber}, so NaN/Infinity is unrepresentable by construction.
 */
export type FoundryEmission =
  | {
      readonly kind: "event";
      readonly name: FoundryEventName;
      readonly properties: Record<string, string>;
      readonly measurements?: Record<string, FiniteNumber>;
    }
  | {
      readonly kind: "metric";
      readonly name: FoundryMetricName;
      readonly value: FiniteNumber;
      readonly properties?: Record<string, string>;
    };

/**
 * Build an event emission, attaching `measurements` only when at least one entry
 * survived the finiteness filter.
 *
 * ONE constructor for the shape three call sites spelled out as a ternary over
 * two nearly-identical object literals. The omission is deliberate and must stay
 * uniform: Application Insights rejects non-finite values, so `finiteMeasurements`
 * returns `undefined` when nothing is left, and the key must then be ABSENT
 * rather than present-and-empty. Mirrors the sibling `metricEmission`.
 */
const eventEmission = (
  name: FoundryEventName,
  properties: Record<string, string>,
  measurements: Record<string, FiniteNumber> | undefined,
): Extract<FoundryEmission, { kind: "event" }> =>
  measurements
    ? { kind: "event", name, properties, measurements }
    : { kind: "event", name, properties };

/**
 * Build a `metric` emission, or `undefined` if `value` is non-finite. The single
 * construction site for `metric` emissions: finiteness is enforced HERE (via
 * {@link asFinite}) rather than re-checked at every producer. Callers push the
 * result only when defined.
 */
const metricEmission = (
  name: FoundryMetricName,
  value: number,
  properties?: Record<string, string>,
): Extract<FoundryEmission, { kind: "metric" }> | undefined => {
  const v = asFinite(value);
  if (v === undefined) {
    // The drop is deliberate (Application Insights rejects non-finite values)
    // but must stay OBSERVABLE: a NaN/Infinity duration silently erasing the
    // node-latency metric would be a monitoring false negative with no path
    // to discovery (round-23 sfh-3).
    fwLogger().warn(
      `[foundry] dropping non-finite metric '${name}' (${safeDiagnosticRender(value)}) — Application Insights rejects non-finite values`,
    );
    return undefined;
  }
  return properties !== undefined
    ? { kind: "metric", name, value: v, properties }
    : { kind: "metric", name, value: v };
};

/**
 * Build a `measurements` object containing only finite entries, each branded a
 * {@link FiniteNumber} via the same {@link asFinite} smart constructor used for
 * `metric.value` — so the "Application Insights rejects NaN/Infinity" invariant
 * lives in the type on BOTH telemetry channels, not just metrics. Returns
 * `undefined` if nothing finite survives, so callers never attach an empty bag.
 */
const finiteMeasurements = (
  entries: Record<string, number>,
): Record<string, FiniteNumber> | undefined => {
  const out: Record<string, FiniteNumber> = {};
  let any = false;
  for (const [k, v] of Object.entries(entries)) {
    const finite = asFinite(v);
    if (finite !== undefined) {
      out[k] = finite;
      any = true;
    } else {
      // Same observability rule as `metricEmission`: dropped data must leave a
      // breadcrumb, never vanish silently (round-23 sfh-3).
      fwLogger().warn(
        `[foundry] dropping non-finite measurement '${k}' (${safeDiagnosticRender(v)}) — Application Insights rejects non-finite values`,
      );
    }
  }
  return any ? out : undefined;
};

/**
 * Whether a `node-skipped` event counts as a cache hit (FR-020 cache-hit rate).
 *
 * A `checkpoint` skip restored a persisted result — a genuine cache hit. An
 * `already-completed` skip is a retry-pass artefact (the node succeeded earlier
 * in THIS run), not a cache hit. Exhaustive over the reason union via
 * `.exhaustive()` so a NEW skip reason becomes a compile error here rather than
 * silently falling into the not-a-cache-hit branch.
 *
 * This is the SINGLE definition of the rule. Both the per-event cache-hit metric
 * (below) and the app-layer run-summary `cacheHitCount` consume it, so the two
 * cannot drift when the set of cache-hit reasons changes.
 */
export const isCacheHit = (event: NodeSkippedEvent): boolean =>
  match(event.reason)
    .with("checkpoint", () => true)
    .with("already-completed", () => false)
    .exhaustive();

/**
 * Pure map: a single `ObserverEvent` → zero or more `FoundryEmission`s.
 *
 * Exhaustive over the discriminant via ts-pattern `.exhaustive()`. Adding a new
 * `ObserverEvent` variant without handling it here becomes a compile error.
 *
 * Cost/token/run-latency metrics are dimensioned by `dagId`; node-latency and
 * cache-hit metrics by `nodeId` (FR-020). All other event types map to `[]`.
 */
export function mapEventToFoundry(
  event: ObserverEvent,
): readonly FoundryEmission[] {
  return match(event)
    .with({ type: "run-end" }, (e) => runEndEmissions(e))
    .with({ type: "route-decided" }, (e) => {
      const props: Record<string, string> = {
        dagId: e.dagId,
        runId: e.runId,
        fromNodeId: e.fromNodeId,
        chosenTargets: e.chosenTargets.join(","),
        prunedTargets: e.prunedTargets.join(","),
        defaultTaken: String(e.defaultTaken),
      };
      const measurements = finiteMeasurements({
        chosenCount: e.chosenTargets.length,
        prunedCount: e.prunedTargets.length,
      });
      return [eventEmission(FOUNDRY_EVENT_ROUTE_DECISION, props, measurements)];
    })
    .with({ type: "node-pruned" }, (e) => [
      {
        kind: "event" as const,
        name: FOUNDRY_EVENT_NODE_PRUNED,
        properties: {
          dagId: e.dagId,
          runId: e.runId,
          nodeId: e.nodeId,
          reason: e.reason,
        },
      },
    ])
    .with({ type: "node-end" }, (e) => {
      const m = metricEmission(FOUNDRY_METRIC_NODE_LATENCY, e.duration, {
        dagId: e.dagId,
        nodeId: e.nodeId,
      });
      return m ? [m] : [];
    })
    .with({ type: "node-skipped" }, (e) => {
      // A checkpoint skip is a cache hit (FR-020 cache-hit rate, by nodeId);
      // `already-completed` is a retry-pass artefact, not a cache hit. The rule
      // is centralised in `isCacheHit` (exhaustive over the reason union).
      if (!isCacheHit(e)) return [];
      const m = metricEmission(FOUNDRY_METRIC_NODE_CACHE_HIT, 1, {
        dagId: e.dagId,
        nodeId: e.nodeId,
      });
      return m ? [m] : [];
    })
    .with({ type: "run-start" }, () => [])
    .with({ type: "node-start" }, () => [])
    // Node failures are DELIBERATELY not emitted as a Foundry domain event:
    // they already surface via OTel spans and the run-level `status: "error"`
    // summary, so a separate event would be redundant.
    .with({ type: "node-error" }, () => [])
    .with({ type: "sub-span" }, () => [])
    .with({ type: "witness-captured" }, () => [])
    .with({ type: "write-attempted" }, () => [])
    .with({ type: "freshness-violation" }, () => [])
    .with({ type: "human-intervention" }, () => [])
    .exhaustive();
}

/**
 * Run-end emission from the bare event. Carries only the fields `RunEndEvent`
 * guarantees (duration, status) plus the run-latency metric dimensioned by
 * dagId. For the complete FR-019 summary (nodeCount/retryCount/cacheHitCount/
 * totalCost) use `mapRunSummaryToFoundry`.
 */
function runEndEmissions(e: RunEndEvent): readonly FoundryEmission[] {
  const out: FoundryEmission[] = [];
  const measurements = finiteMeasurements({ durationMs: e.duration });
  out.push(
    eventEmission(
      FOUNDRY_EVENT_RUN_SUMMARY,
      { dagId: e.dagId, runId: e.runId, status: e.status },
      measurements,
    ),
  );
  const latency = metricEmission(FOUNDRY_METRIC_RUN_LATENCY, e.duration, { dagId: e.dagId });
  if (latency) out.push(latency);
  return out;
}

/**
 * Optional aggregate inputs the app-layer bridge can supply alongside a
 * `RunSummary`. Neither `cacheHitCount` nor `totalTokens` has a home on the
 * framework's `RunSummary` type today (see observer/buffered.ts), so they are
 * accepted here rather than invented as fields on the shared summary type. The
 * bridge computes them (cache hits from `node-skipped` checkpoint events; token
 * totals from OTel spans) and passes them through.
 */
export interface RunSummaryExtras {
  /** Number of cache hits (checkpoint skips) for the run, if known. FR-019. */
  readonly cacheHitCount?: number;
  /** Total LLM token consumption for the run, if known. FR-020. */
  readonly totalTokens?: number;
}

/**
 * Pure map: a fully-aggregated `RunSummary` (+ the originating `RunEndEvent`
 * for dagId/identity) → the complete FR-019 run-summary event plus
 * pre-aggregated cost/token/run-latency metrics dimensioned by dagId (FR-020).
 *
 * This is the entry point the app-layer run-summary bridge uses so that
 * completed runs produce a summary event carrying run duration, status, node
 * count, and retry count. Cache-hit count and total cost are included when the
 * bridge/summary can supply them (SC-008).
 */
export function mapRunSummaryToFoundry(
  summary: RunSummary,
  runEnd: RunEndEvent,
  extras: RunSummaryExtras = {},
): readonly FoundryEmission[] {
  const measurements = finiteMeasurements({
    durationMs: summary.totalDuration,
    nodeCount: summary.nodeCount,
    retryCount: summary.retryCount,
    ...(extras.cacheHitCount !== undefined ? { cacheHitCount: extras.cacheHitCount } : {}),
    ...(summary.totalCostUsd !== undefined ? { totalCost: summary.totalCostUsd } : {}),
  });

  const properties: Record<string, string> = {
    dagId: runEnd.dagId,
    runId: summary.runId,
    status: summary.status,
  };

  const summaryEvent = eventEmission(FOUNDRY_EVENT_RUN_SUMMARY, properties, measurements);

  const out: FoundryEmission[] = [summaryEvent];

  // Pre-aggregated metrics dimensioned by dagId (FR-020). `metricEmission`
  // gates finiteness; the `!== undefined` guards gate PRESENCE (an absent
  // cost/token total emits no metric, distinct from a present-but-non-finite one).
  const dagDim = { dagId: runEnd.dagId };
  const latency = metricEmission(FOUNDRY_METRIC_RUN_LATENCY, summary.totalDuration, dagDim);
  if (latency) out.push(latency);
  if (summary.totalCostUsd !== undefined) {
    const cost = metricEmission(FOUNDRY_METRIC_RUN_COST, summary.totalCostUsd, dagDim);
    if (cost) out.push(cost);
  }
  if (extras.totalTokens !== undefined) {
    const tokens = metricEmission(FOUNDRY_METRIC_RUN_TOKENS, extras.totalTokens, dagDim);
    if (tokens) out.push(tokens);
  }

  return out;
}
