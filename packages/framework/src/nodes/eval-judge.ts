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
import type { LlmClient, LlmResponse } from "../types/llm.js";
import { err, ok, type Result } from "../types/result.js";
import { nodeId, type NodeId } from "../types/ids.js";
import { JUDGE_SYSTEM_FRAME, resolveRubric, assembleJudgeUserMessage } from "./eval-judge-prompt.js";
import { enrichLlmSpan } from "../tracing/index.js";
import { dispatchEvent } from "../observer/dispatch.js";
import { safeErrorMessage } from "../types/safe-error.js";
import { logFrameworkWithoutThrowing } from "../logger.js";

// Re-export types from their canonical home in `types/`.
export type { EvalJudgeResult, EvalJudgeNodeDef, EvalJudgeNodeConfig, EvalJudgeRubric } from "../types/eval-judge.js";
export { judgePassed, judgeCrashed } from "../types/eval-judge.js";
import type {
  EvalJudgeResult,
  EvalJudgeNodeDef,
  EvalJudgeNodeConfig,
  EvalJudgeRubric,
} from "../types/eval-judge.js";


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

/** Parse the authoring value before a judge definition can enter a DAG. */
const parseEvalJudgeThreshold = (threshold: number | undefined): number => {
  const resolved = threshold ?? DEFAULT_THRESHOLD;
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new RangeError(`Eval-judge threshold must be a finite number in [0, 1]; got ${String(resolved)}`);
  }
  return resolved;
};

/** Default model for eval-judge (GPT-4o-mini). */
const DEFAULT_JUDGE_MODEL = "gpt-4o-mini";

/**
 * Judge diagnostics are secondary to the promised total result seam — but they
 * must not VANISH.
 *
 * A throwing `ctx.logger` is a caller-supplied hazard (a hostile or misconfigured
 * sink), and swallowing it outright would erase the only record that the judge
 * degraded. Fall back to the framework logger, which is a different sink and
 * itself total: the breadcrumb survives unless both sinks fail, and the caller
 * still receives the already-decided `EvalJudgeResult` either way.
 */
const warnWithoutThrowing = (ctx: NodeContext, message: string): void => {
  try {
    ctx.logger.warn(message);
  } catch (loggerError) {
    logFrameworkWithoutThrowing(
      "warn",
      `[eval-judge] ctx.logger.warn threw; original warning: ${message}`,
      { loggerError: safeErrorMessage(loggerError) },
    );
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

// Criteria are matched case-insensitively; the configured set must therefore be
// unique after lower-casing.
const configuredCriteriaSet = (criteria: readonly string[]): Result<ReadonlySet<string>, string> => {
  const configuredNames = criteria.map((criterion) => criterion.toLowerCase());
  const configuredSet = new Set(configuredNames);
  return configuredSet.size === configuredNames.length
    ? ok(configuredSet)
    : err("Invalid judge response semantics: configured criteria are not unique");
};

const scoresByCriterion = (response: EvalJudgeResponse): Result<Map<string, number>, string> => {
  const scores = new Map<string, number>();
  for (const { name, score } of response.criteria_scores) {
    const normalizedName = name.toLowerCase();
    if (scores.has(normalizedName)) {
      return err(`Invalid judge response semantics: duplicate criterion '${name}'`);
    }
    scores.set(normalizedName, score);
  }
  return ok(scores);
};

// The response must score exactly the configured criteria: none missing, none extra.
const criteriaCoverageProblem = (
  criteria: readonly string[],
  configuredSet: ReadonlySet<string>,
  scores: ReadonlyMap<string, number>,
): string | null => {
  const missing = criteria.filter((criterion) => !scores.has(criterion.toLowerCase()));
  const unexpected = [...scores.keys()].filter((name) => !configuredSet.has(name));
  if (missing.length === 0 && unexpected.length === 0) return null;
  return `Invalid judge response semantics: criteria coverage mismatch (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`;
};

// `failed_criteria` must be a duplicate-free subset of the configured criteria.
const declaredFailureSet = (
  response: EvalJudgeResponse,
  configuredSet: ReadonlySet<string>,
): Result<ReadonlySet<string>, string> => {
  const declaredFailures = response.failed_criteria.map((criterion) => criterion.toLowerCase());
  const failureSet = new Set(declaredFailures);
  if (failureSet.size !== declaredFailures.length) {
    return err("Invalid judge response semantics: failed_criteria contains duplicates");
  }
  const unexpectedFailures = declaredFailures.filter((criterion) => !configuredSet.has(criterion));
  if (unexpectedFailures.length > 0) {
    return err(
      `Invalid judge response semantics: failed_criteria names unconfigured criteria: ${unexpectedFailures.join(", ")}`,
    );
  }
  return ok(failureSet);
};

/**
 * Convert raw LLM response to EvalJudgeResult, applying threshold.
 */
export const toEvalJudgeResult = (response: EvalJudgeResponse, threshold: number, criteria: readonly string[]): EvalJudgeResult => {
  const configured = configuredCriteriaSet(criteria);
  if (!configured.ok) return llmFailureResult(configured.error);
  const configuredSet = configured.value;

  const scored = scoresByCriterion(response);
  if (!scored.ok) return llmFailureResult(scored.error);
  const scores = scored.value;

  const coverageProblem = criteriaCoverageProblem(criteria, configuredSet, scores);
  if (coverageProblem !== null) return llmFailureResult(coverageProblem);

  const declared = declaredFailureSet(response, configuredSet);
  if (!declared.ok) return llmFailureResult(declared.error);
  const declaredSet = declared.value;

  const failedCriteria = criteria.filter((criterion) => scores.get(criterion.toLowerCase())! < threshold);
  const computedFailureSet = new Set(failedCriteria.map((criterion) => criterion.toLowerCase()));
  const failureDeclarationMatches =
    computedFailureSet.size === declaredSet.size &&
    [...computedFailureSet].every((criterion) => declaredSet.has(criterion));
  if (!failureDeclarationMatches) {
    return llmFailureResult("Invalid judge response semantics: failed_criteria contradicts criteria_scores");
  }

  const outcome = response.score >= threshold && failedCriteria.length === 0 ? "passed" : "failed";
  return {
    outcome,
    score: response.score,
    criteriaScores: Object.fromEntries(scores),
    failedCriteria,
    reason: response.reason,
  };
};

/** The normalized judge configuration a `run` closes over. */
interface JudgeSettings {
  readonly id: NodeId;
  readonly criteria: readonly string[];
  readonly threshold: number;
  readonly rubric: EvalJudgeRubric | undefined;
  readonly model: string | undefined;
}

// Enrich the active span with LLM details (guard against span errors).
const enrichJudgeSpan = (
  ctx: NodeContext,
  judgeId: string,
  model: string,
  userMessage: string,
  response: LlmResponse<unknown>,
): void => {
  try {
    enrichLlmSpan({
      model,
      system: JUDGE_SYSTEM_FRAME,
      user: userMessage,
      // `LlmResponse` extends `TokenUsage`, so the response IS the usage.
      usage: response,
      thinking: response.thinking,
      contentFilter: ctx.contentFilter,
    });
  } catch (spanErr) {
    warnWithoutThrowing(
      ctx,
      `[eval-judge:${judgeId}] enrichLlmSpan threw: ${safeErrorMessage(spanErr)}`,
    );
  }
};

// One judge evaluation against a resolved LLM client. May throw — the caller's
// catch turns an escaping exception into the `crash` outcome.
const evaluateWithJudge = async (
  llm: LlmClient,
  judge: JudgeSettings,
  dagInput: unknown,
  dagOutput: unknown,
  ctx: NodeContext,
): Promise<EvalJudgeResult> => {
  const { id, criteria, threshold, rubric } = judge;
  const resolvedRubric = resolveRubric(
    { criteria, threshold, rubric },
    ctx.prompts?.get ?? null,
  );
  const userMessage = assembleJudgeUserMessage(resolvedRubric, dagInput, dagOutput);
  const model = judge.model ?? DEFAULT_JUDGE_MODEL;
  const result = await llm.sendStructured({
    system: JUDGE_SYSTEM_FRAME,
    user: userMessage,
    model,
    schema: EvalJudgeResponseSchema,
    signal: ctx.signal,
    nodeId: id,
  });

  if (!result.ok) {
    const msg = `LLM call failed: ${safeErrorMessage(result.error)}`;
    warnWithoutThrowing(ctx, `[eval-judge:${id}] ${msg}`);
    emitJudgeSkipped(ctx, id, msg);
    return llmFailureResult(msg);
  }

  enrichJudgeSpan(ctx, id, model, userMessage, result.value);

  // Validate response shape (defense-in-depth: some LlmClient impls skip schema validation)
  const parsed = EvalJudgeResponseSchema.safeParse(result.value.output);
  if (!parsed.success) {
    const msg = `Invalid judge response: ${parsed.error.message}`;
    warnWithoutThrowing(ctx, `[eval-judge:${id}] ${msg}`);
    return llmFailureResult(msg);
  }

  return toEvalJudgeResult(parsed.data, threshold, criteria);
};

// The judge's total `run` seam: resolve the LLM client (judgeLlm > llm >
// explicit unavailable outcome), evaluate, and fold any escaping exception
// into the `crash` outcome.
const runJudge = async (
  judge: JudgeSettings,
  dagInput: unknown,
  dagOutput: unknown,
  ctx: NodeContext,
): Promise<EvalJudgeResult> => {
  const llm: LlmClient | null = ctx.judgeLlm ?? ctx.llm ?? null;
  if (!llm) {
    const msg = "No LLM client available (neither judgeLlm nor llm on context)";
    warnWithoutThrowing(ctx, `[eval-judge:${judge.id}] ${msg}`);
    return llmFailureResult(msg);
  }

  try {
    return await evaluateWithJudge(llm, judge, dagInput, dagOutput, ctx);
  } catch (e) {
    // A THROW here is not an LLM failure. The LLM's own failure mode is a
    // `!result.ok` Result, handled above; anything that escapes as an
    // exception came from orchestrator-side work — rubric resolution,
    // message assembly on a non-serializable DAG output, a schema/encoder
    // bug — or from an `LlmClient` breaking its Result contract. That is
    // exactly what the `crash` outcome documents ("judge `run` threw past
    // its outcome boundary"), and folding it into `skipped-llm-failure`
    // merged "the model was flaky" with "we have a bug" into one bucket,
    // making the `judgesCrashed` operational signal unreachable from inside
    // a judge's own `run`. Both outcomes still fail closed for gating.
    const msg = `Unexpected error: ${safeErrorMessage(e)}`;
    warnWithoutThrowing(ctx, `[eval-judge:${judge.id}] ${msg}`);
    emitJudgeSkipped(ctx, judge.id, msg);
    return crashResult(msg);
  }
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
  const configuredId = config.id;
  const configuredCriteria = config.criteria;
  const configuredThreshold = config.threshold;
  const configuredRubric = config.rubric;
  const configuredModel = config.model;
  const threshold = parseEvalJudgeThreshold(configuredThreshold);
  const brandedId = nodeId(configuredId);
  const criteria = Object.freeze([...configuredCriteria]);
  const rubric = configuredRubric === undefined ? undefined : Object.freeze({ ...configuredRubric });
  const normalizedConfig: EvalJudgeNodeConfig = Object.freeze({
    id: brandedId,
    criteria,
    threshold,
    ...(rubric === undefined ? {} : { rubric }),
    ...(configuredModel === undefined ? {} : { model: configuredModel }),
  });
  const judge: JudgeSettings = { id: brandedId, criteria, threshold, rubric, model: configuredModel };

  return {
    id: brandedId,
    kind: "eval-judge",
    config: normalizedConfig,
    run: (dagInput: unknown, dagOutput: unknown, ctx: NodeContext): Promise<EvalJudgeResult> =>
      runJudge(judge, dagInput, dagOutput, ctx),
  };
};
