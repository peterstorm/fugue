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
//     The app-layer run-summary bridge (T5) computes a `RunSummary` and calls
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
 * Vendor-neutral telemetry emission. The observer translates each variant into
 * a `FoundryTelemetrySink` call (`trackEvent` / `trackMetric`).
 *
 * - `event`: a discrete domain event with string `properties` and optional
 *   numeric `measurements` (Application Insights customEvent semantics).
 * - `metric`: a single pre-aggregated numeric sample with optional `properties`
 *   used as dimensions (Application Insights customMetric semantics).
 */
export type FoundryEmission =
  | {
      readonly kind: "event";
      readonly name: FoundryEventName;
      readonly properties: Record<string, string>;
      readonly measurements?: Record<string, number>;
    }
  | {
      readonly kind: "metric";
      readonly name: FoundryMetricName;
      readonly value: number;
      readonly properties?: Record<string, string>;
    };

/** Keep only finite numbers — Application Insights rejects NaN/Infinity. */
const isFinite_ = (n: number): boolean => Number.isFinite(n);

/**
 * Build a `measurements` object containing only finite entries. Returns
 * `undefined` if nothing finite survives, so callers never attach an empty bag.
 */
const finiteMeasurements = (
  entries: Record<string, number>,
): Record<string, number> | undefined => {
  const out: Record<string, number> = {};
  let any = false;
  for (const [k, v] of Object.entries(entries)) {
    if (isFinite_(v)) {
      out[k] = v;
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
      const out: FoundryEmission[] = [];
      if (isFinite_(e.duration)) {
        out.push({
          kind: "metric",
          name: FOUNDRY_METRIC_NODE_LATENCY,
          value: e.duration,
          properties: { dagId: e.dagId, nodeId: e.nodeId },
        });
      }
      return out;
    })
    .with({ type: "node-skipped" }, (e) =>
      // A checkpoint skip is a cache hit (FR-020 cache-hit rate, by nodeId).
      // `already-completed` is a retry-pass artefact, not a cache hit.
      e.reason === "checkpoint"
        ? [
            {
              kind: "metric" as const,
              name: FOUNDRY_METRIC_NODE_CACHE_HIT,
              value: 1,
              properties: { dagId: e.dagId, nodeId: e.nodeId },
            },
          ]
        : [],
    )
    .with({ type: "run-start" }, () => [])
    .with({ type: "node-start" }, () => [])
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
  if (isFinite_(e.duration)) {
    out.push({
      kind: "metric",
      name: FOUNDRY_METRIC_RUN_LATENCY,
      value: e.duration,
      properties: { dagId: e.dagId },
    });
  }
  return out;
}

/**
 * Optional aggregate inputs the app-layer bridge (T5) can supply alongside a
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
 * This is the entry point the app-layer run-summary bridge (T5) uses so that
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

  // Pre-aggregated metrics dimensioned by dagId (FR-020).
  const dagDim = { dagId: runEnd.dagId };
  if (isFinite_(summary.totalDuration)) {
    out.push({
      kind: "metric",
      name: FOUNDRY_METRIC_RUN_LATENCY,
      value: summary.totalDuration,
      properties: dagDim,
    });
  }
  if (summary.totalCostUsd !== undefined && isFinite_(summary.totalCostUsd)) {
    out.push({
      kind: "metric",
      name: FOUNDRY_METRIC_RUN_COST,
      value: summary.totalCostUsd,
      properties: dagDim,
    });
  }
  if (extras.totalTokens !== undefined && isFinite_(extras.totalTokens)) {
    out.push({
      kind: "metric",
      name: FOUNDRY_METRIC_RUN_TOKENS,
      value: extras.totalTokens,
      properties: dagDim,
    });
  }

  return out;
}
