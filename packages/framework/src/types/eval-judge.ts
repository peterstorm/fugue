// Eval-judge types — interface and result shape used by `DagDef.evalJudges`.
//
// Lives in `types/` so `types/dag.ts` can reference `EvalJudgeNodeDef`
// without an upward import into `nodes/`.

import type { NodeId } from "./ids.js";
import type { NodeContext } from "./node.js";

// ---------------------------------------------------------------------------
// EvalJudgeRubric — tagged union (parse, don't validate)
//
// A rubric is either loaded from the prompt registry by id, or supplied
// inline as raw text. When omitted, a default rubric is generated from the
// criteria list. The two sources are mutually exclusive at the type level.
// ---------------------------------------------------------------------------

export type EvalJudgeRubric =
  | { readonly source: "template"; readonly templateId: string }
  | { readonly source: "inline"; readonly text: string };

// ---------------------------------------------------------------------------
// EvalJudgeResult — discriminated union by `outcome`.
//
// Four outcomes:
//   - "passed":             judge ran, score >= threshold, no failed criteria
//   - "failed":             judge ran, score < threshold OR some criteria failed
//   - "skipped-llm-failure": LLM-side failure (call error, schema mismatch);
//                            fail-open — `judgePassed(r)` returns true
//   - "crash":              orchestrator-side exception (span setup, encoder
//                            bug, judge `run` threw past its own fail-open);
//                            fail-closed — `judgePassed(r)` returns false and
//                            `crashMessage` carries the structured cause.
//
// Helpers `judgePassed` / `judgeCrashed` below replace the prior three-flag
// shape (`passed` + `skipped` + `crash`) that allowed invalid combinations.
// ---------------------------------------------------------------------------

interface EvalJudgeResultBase {
  readonly criteriaScores: Record<string, number>;
  readonly failedCriteria: readonly string[];
  readonly reason: string;
}

export type EvalJudgeResult =
  | (EvalJudgeResultBase & { readonly outcome: "passed"; readonly score: number })
  | (EvalJudgeResultBase & { readonly outcome: "failed"; readonly score: number })
  | (EvalJudgeResultBase & { readonly outcome: "skipped-llm-failure"; readonly score: null })
  | (EvalJudgeResultBase & {
      readonly outcome: "crash";
      readonly score: null;
      readonly crashMessage: string;
    });

/**
 * True when the judge result satisfies gating logic. `"passed"` is the happy
 * path; `"skipped-llm-failure"` is fail-open (a broken model must not block a
 * run). `"failed"` and `"crash"` return false.
 */
export const judgePassed = (r: EvalJudgeResult): boolean =>
  r.outcome === "passed" || r.outcome === "skipped-llm-failure";

/** True when the judge orchestrator caught an exception. */
export const judgeCrashed = (r: EvalJudgeResult): boolean => r.outcome === "crash";

/** Configuration for creating an eval-judge node. */
export interface EvalJudgeNodeConfig {
  /** Unique node ID. */
  readonly id: string;
  /** Criteria to evaluate against. */
  readonly criteria: readonly string[];
  /** Score threshold — below this, the judge returns outcome: "failed". Default 0.8. */
  readonly threshold?: number;
  /**
   * Rubric source. Omit to fall back to an auto-generated default rubric
   * derived from `criteria`. When set, the source is either a template id
   * (looked up via `ctx.prompts`) or inline text.
   */
  readonly rubric?: EvalJudgeRubric;
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
   * Returns EvalJudgeResult — never throws across module boundaries.
   */
  readonly run: (dagInput: unknown, dagOutput: unknown, ctx: NodeContext) => Promise<EvalJudgeResult>;
}
