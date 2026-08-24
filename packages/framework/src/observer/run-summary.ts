/**
 * The per-run rollup shared by the buffering observer and the persistence
 * policy that decides whether to keep it.
 *
 * It sits in a leaf because both modules need it and each was importing the
 * other: `policy.ts` needed the summary it judges, `buffered.ts` needed the
 * policy that judges it. Neither could be read without the other.
 */
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
