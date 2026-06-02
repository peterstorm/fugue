// foundry-event-mapping.ts — PURE functional core.
//
// Maps framework domain `ObserverEvent`s into vendor-neutral `FoundryEmission`
// records (events + pre-aggregated metrics). NO I/O, NO clock reads, NO
// logging — deterministic over its input. The imperative shell
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
//     retryCount, cacheHitCount, and totalCost, plus pre-aggregated
//     cost/run-latency metrics dimensioned by dagId.
//
// We do NOT invent fields on the bare event. Callers wanting the complete
// FR-019/SC-008 summary use `mapRunSummaryToFoundry`.

import { match } from "ts-pattern";
import type { ObserverEvent, RunEndEvent } from "../types/events.js";
import type { RunSummary } from "./buffered.js";

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
export type FoundryEventName =
  | typeof FOUNDRY_EVENT_RUN_SUMMARY
  | typeof FOUNDRY_EVENT_ROUTE_DECISION
  | typeof FOUNDRY_EVENT_NODE_PRUNED;

/** The five stable Foundry metric names. */
export type FoundryMetricName =
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
  if (v === undefined) return undefined;
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
    }
  }
  return any ? out : undefined;
};

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
      const ev: FoundryEmission = measurements
        ? { kind: "event", name: FOUNDRY_EVENT_ROUTE_DECISION, properties: props, measurements }
        : { kind: "event", name: FOUNDRY_EVENT_ROUTE_DECISION, properties: props };
      return [ev];
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
      // A checkpoint skip is a cache hit (FR-020 cache-hit rate, by nodeId).
      // `already-completed` is a retry-pass artefact, not a cache hit.
      if (e.reason !== "checkpoint") return [];
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
    measurements
      ? {
          kind: "event",
          name: FOUNDRY_EVENT_RUN_SUMMARY,
          properties: { dagId: e.dagId, runId: e.runId, status: e.status },
          measurements,
        }
      : {
          kind: "event",
          name: FOUNDRY_EVENT_RUN_SUMMARY,
          properties: { dagId: e.dagId, runId: e.runId, status: e.status },
        },
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
 * 100% of completed runs produce a summary event carrying run duration, status,
 * node count, retry count, cache-hit count, and total cost (SC-008).
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

  const summaryEvent: FoundryEmission = measurements
    ? { kind: "event", name: FOUNDRY_EVENT_RUN_SUMMARY, properties, measurements }
    : { kind: "event", name: FOUNDRY_EVENT_RUN_SUMMARY, properties };

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
