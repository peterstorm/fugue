/**
 * Eval-judge node — framework-level LLM quality evaluation.
 *
 * Evaluates the DAG's final output using a cheap LLM call.
 * When the judge scores below threshold, the trace is marked ERROR
 * and persisted via the existing tail-sampling policy.
 *
 * The eval-judge node:
 * - Runs AFTER the output node (executor handles scheduling)
 * - Automatically receives { input: dagInput, output: outputNodeResult }
 * - Uses ctx.judgeLlm ?? ctx.llm for the LLM call
 * - Returns an EvalJudgeResult always (never throws across the node seam)
 * - Fails quality gating closed when the judge LLM is unavailable or invalid
 */
import { z } from "zod";
import type { NodeContext } from "../types/node.js";
import type { LlmClient } from "../types/llm.js";
import { nodeId } from "../types/ids.js";
import { JUDGE_SYSTEM_FRAME, resolveRubric, assembleJudgeUserMessage } from "./eval-judge-prompt.js";
import { enrichLlmSpan } from "../tracing/index.js";
import { dispatchEvent } from "../observer/dispatch.js";
import { safeErrorMessage } from "../types/safe-error.js";

// Re-export types from their canonical home in `types/`.
export type { EvalJudgeResult, EvalJudgeNodeDef, EvalJudgeNodeConfig, EvalJudgeRubric } from "../types/eval-judge.js";
export { judgePassed, judgeCrashed } from "../types/eval-judge.js";
import type { EvalJudgeResult, EvalJudgeNodeDef, EvalJudgeNodeConfig } from "../types/eval-judge.js";


/** Internal schema for LLM structured output parsing. */
export const EvalJudgeResponseSchema = z.object({
  score: z.number().min(0).max(1),
  criteria_scores: z.array(z.object({ name: z.string(), score: z.number().min(0).max(1) })),
  failed_criteria: z.array(z.string()),
  reason: z.string(),
});

export type EvalJudgeResponse = z.infer<typeof EvalJudgeResponseSchema>;


/** Default threshold if not specified. */
const DEFAULT_THRESHOLD = 0.8;

/** Default model for eval-judge (GPT-4o-mini). */
const DEFAULT_JUDGE_MODEL = "gpt-4o-mini";

/** Judge diagnostics are secondary to the promised total result seam. */
const warnWithoutThrowing = (ctx: NodeContext, message: string): void => {
  try {
    ctx.logger.warn(message);
  } catch {
    // The caller still receives the already-decided EvalJudgeResult.
  }
};

/** Emit an observer event when the judge cannot evaluate the output. */
const emitJudgeSkipped = (ctx: NodeContext, judgeId: string, reason: string): void => {
  try {
    dispatchEvent(ctx.observer, {
      type: "sub-span",
      runId: ctx.runId,
      dagId: ctx.dagId,
      nodeId: nodeId(judgeId),
      parentSpanId: judgeId,
      kind: "EVALUATOR",
      timestamp: ctx.eventTimestamp?.() ?? new Date(),
      duration: 0,
      attributes: {
        "eval_judge.skipped": true,
        "eval_judge.skip_reason": reason,
      },
    });
  } catch (error) {
    warnWithoutThrowing(
      ctx,
      `[eval-judge:${judgeId}] skipped-event emission failed: ${safeErrorMessage(error)}`,
    );
  }
};

/**
 * Construct an explicit `skipped-llm-failure` result. The DAG output remains
 * available, but `judgePassed` treats this as failed quality evidence.
 */
export const llmFailureResult = (reason: string): EvalJudgeResult => ({
  outcome: "skipped-llm-failure",
  score: null,
  criteriaScores: {},
  failedCriteria: [],
  reason: `[eval-judge skipped: ${reason}]`,
});

/**
 * Construct a fail-closed `crash` result for callers that choose to convert an
 * unexpected evaluator exception into an observable terminal judge outcome.
 */
export const crashResult = (reason: string): EvalJudgeResult => ({
  outcome: "crash",
  score: null,
  criteriaScores: {},
  failedCriteria: [],
  reason: `[eval-judge crashed: ${reason}]`,
  crashMessage: reason,
});

/**
 * Convert raw LLM response to EvalJudgeResult, applying threshold.
 */
export const toEvalJudgeResult = (response: EvalJudgeResponse, threshold: number, criteria: readonly string[]): EvalJudgeResult => {
  const scoresMap: Record<string, number> = {};
  for (const { name, score } of response.criteria_scores) {
    scoresMap[name.toLowerCase()] = score;
  }

  const failedCriteria = criteria.filter((c) => {
    const score = scoresMap[c.toLowerCase()];
    return score !== undefined && score < threshold;
  });

  const passed = response.score >= threshold && failedCriteria.length === 0;

  return passed
    ? {
        outcome: "passed",
        score: response.score,
        criteriaScores: scoresMap,
        failedCriteria,
        reason: response.reason,
      }
    : {
        outcome: "failed",
        score: response.score,
        criteriaScores: scoresMap,
        failedCriteria,
        reason: response.reason,
      };
};

/**
 * Create an eval-judge node.
 *
 * Usage:
 * ```typescript
 * createEvalJudgeNode({
 *   id: "quality-check",
 *   criteria: ["factuality", "relevance", "completeness"],
 *   threshold: 0.8,
 *   rubric: { source: "template", templateId: "summary-rubric" },
 * })
 * ```
 */
export const createEvalJudgeNode = (config: EvalJudgeNodeConfig): EvalJudgeNodeDef => {
  const threshold = config.threshold ?? DEFAULT_THRESHOLD;
  const brandedId = nodeId(config.id);

  return {
    id: brandedId,
    kind: "eval-judge",
    config: { ...config, id: brandedId },
    run: async (dagInput: unknown, dagOutput: unknown, ctx: NodeContext): Promise<EvalJudgeResult> => {
      // Resolve LLM client (judgeLlm > llm > explicit unavailable outcome)
      const llm: LlmClient | null = ctx.judgeLlm ?? ctx.llm ?? null;
      if (!llm) {
        const msg = "No LLM client available (neither judgeLlm nor llm on context)";
        warnWithoutThrowing(ctx, `[eval-judge:${config.id}] ${msg}`);
        return llmFailureResult(msg);
      }

      try {
        const rubric = resolveRubric(
          { criteria: config.criteria, threshold, rubric: config.rubric },
          ctx.prompts?.get ?? null,
        );
        const userMessage = assembleJudgeUserMessage(rubric, dagInput, dagOutput);
        const model = config.model ?? DEFAULT_JUDGE_MODEL;
        const result = await llm.sendStructured({
          system: JUDGE_SYSTEM_FRAME,
          user: userMessage,
          model,
          schema: EvalJudgeResponseSchema,
          signal: ctx.signal,
          nodeId: brandedId,
        });

        if (!result.ok) {
          const msg = `LLM call failed: ${safeErrorMessage(result.error)}`;
          warnWithoutThrowing(ctx, `[eval-judge:${config.id}] ${msg}`);
          emitJudgeSkipped(ctx, config.id, msg);
          return llmFailureResult(msg);
        }

        // Enrich active span with LLM details (guard against span errors)
        try {
          enrichLlmSpan({
            model,
            system: JUDGE_SYSTEM_FRAME,
            user: userMessage,
            tokensIn: result.value.tokensIn,
            tokensOut: result.value.tokensOut,
            thinking: result.value.thinking,
            contentFilter: ctx.contentFilter,
          });
        } catch (spanErr) {
          warnWithoutThrowing(
            ctx,
            `[eval-judge:${config.id}] enrichLlmSpan threw: ${safeErrorMessage(spanErr)}`,
          );
        }

        // Validate response shape (defense-in-depth: some LlmClient impls skip schema validation)
        const parsed = EvalJudgeResponseSchema.safeParse(result.value.output);
        if (!parsed.success) {
          const msg = `Invalid judge response: ${parsed.error.message}`;
          warnWithoutThrowing(ctx, `[eval-judge:${config.id}] ${msg}`);
          return llmFailureResult(msg);
        }

        return toEvalJudgeResult(parsed.data, threshold, config.criteria);
      } catch (e) {
        const msg = `Unexpected error: ${safeErrorMessage(e)}`;
        warnWithoutThrowing(ctx, `[eval-judge:${config.id}] ${msg}`);
        emitJudgeSkipped(ctx, config.id, msg);
        return llmFailureResult(msg);
      }
    },
  };
};
