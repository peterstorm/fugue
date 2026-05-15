// Eval-judge types — interface and result shape used by `DagDef.evalJudges`.
//
// Lives in `types/` so `types/dag.ts` can reference `EvalJudgeNodeDef`
// without an upward import into `nodes/`.

import type { NodeId } from "./ids.js";
import type { NodeContext } from "./node.js";

/** Output of the eval-judge node. */
export interface EvalJudgeResult {
  readonly passed: boolean;
  /**
   * Quality score in [0, 1], or `null` when the judge could not run
   * (`skipped: true`). Operators must distinguish "judge passed" from
   * "judge couldn't run" — `null` makes that explicit.
   */
  readonly score: number | null;
  readonly criteriaScores: Record<string, number>;
  readonly failedCriteria: readonly string[];
  readonly reason: string;
  /**
   * `true` when the judge could not produce a usable score (LLM call failure,
   * schema validation failure, or judge orchestrator exception). For LLM-side
   * failures `passed` stays `true` (fail-open: a broken model should not block
   * a run); for orchestrator-side exceptions `passed` is `false` so quality
   * gates filtering on `passed` see the failure. `crash` is set in the latter
   * case to expose the structured cause.
   */
  readonly skipped: boolean;
  /**
   * Set when the judge orchestrator caught an exception (a broken span call,
   * a span-attribute encoder bug, etc.). Distinct from `skipped` because it
   * carries the structured cause and forces `passed: false` so consumers
   * filtering on `passed` cannot silently miss a broken judge.
   */
  readonly crash?: { readonly kind: "judge-crash"; readonly message: string };
}

/** Configuration for creating an eval-judge node. */
export interface EvalJudgeNodeConfig {
  /** Unique node ID. */
  readonly id: string;
  /** Criteria to evaluate against. */
  readonly criteria: readonly string[];
  /** Score threshold — below this, the judge returns passed: false. Default 0.8. */
  readonly threshold?: number;
  /** Prompt template name loaded from ctx.prompts. */
  readonly rubricTemplateId?: string;
  /** Inline rubric text (alternative to rubricTemplateId). */
  readonly rubricInline?: string;
  /** Model to use for the judge call. If not set, uses whatever ctx.judgeLlm is configured with. */
  readonly model?: string;
}

/** Definition of an eval-judge node (stored on DagDef.evalJudges). */
export interface EvalJudgeNodeDef {
  readonly id: NodeId;
  readonly kind: "eval-judge";
  readonly config: EvalJudgeNodeConfig;
  /**
   * Run the eval-judge against the given DAG input and output.
   * Returns EvalJudgeResult (always ok — fail-open).
   */
  readonly run: (dagInput: unknown, dagOutput: unknown, ctx: NodeContext) => Promise<EvalJudgeResult>;
}
