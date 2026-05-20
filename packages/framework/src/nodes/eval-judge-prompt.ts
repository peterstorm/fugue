/**
 * Prompt assembly for eval-judge nodes.
 *
 * Three-layer structure:
 * 1. System frame (framework-owned) — output format, scoring instructions
 * 2. Rubric (user-owned) — criteria definitions, from prompts or inline
 * 3. Instance (runtime) — actual input/output being evaluated
 */

/** The fixed system frame that instructs the judge on output format. */
export const JUDGE_SYSTEM_FRAME = `You are a quality evaluation judge. You will receive an input that was given to a system, and the output it produced. Evaluate the output against the provided rubric criteria.

You MUST respond with valid JSON matching this exact schema:
{
  "score": <float 0.0 to 1.0, average of all criteria scores>,
  "criteria_scores": [{ "name": "<criterion_name>", "score": <float 0.0 to 1.0> }, ...],
  "failed_criteria": ["<criterion_name>", ...],
  "reason": "<1-2 sentence explanation of the overall evaluation>"
}

Scoring rules:
- Score each criterion independently from 0.0 (completely fails) to 1.0 (perfectly meets criterion)
- The overall "score" is the average of all criteria scores
- A criterion is "failed" if its score is below the threshold (provided in the rubric)
- Be strict and objective. Do not give high scores for vague or partial compliance.`;

import type { EvalJudgeRubric } from "../types/eval-judge.js";

/**
 * Generate a default rubric from a list of criteria names. Used when the
 * judge config supplies no `rubric` field.
 */
export const generateDefaultRubric = (criteria: readonly string[], threshold: number): string => {
  const lines = criteria.map(
    (c) => `- ${c}: Scores 1.0 if fully met, 0.0 if entirely absent. Fails below ${threshold}.`,
  );
  return `Evaluate against these criteria (threshold: ${threshold}):\n${lines.join("\n")}`;
};

/**
 * Resolve the rubric from config + context. The tagged `rubric` discriminant
 * makes template vs inline a parse-don't-validate choice. When omitted, the
 * default rubric is generated from `criteria`.
 *
 * Template lookups fall back to the default if `ctx.prompts` is absent or the
 * id is unknown — the fallback is logged elsewhere; here we just decide which
 * string to use.
 */
export const resolveRubric = (
  opts: {
    readonly criteria: readonly string[];
    readonly threshold: number;
    readonly rubric?: EvalJudgeRubric;
  },
  promptsGet: ((name: string) => string | null) | null,
): string => {
  const r = opts.rubric;
  if (r?.source === "template" && promptsGet) {
    const template = promptsGet(r.templateId);
    if (template) return template;
  }
  if (r?.source === "inline") return r.text;
  return generateDefaultRubric(opts.criteria, opts.threshold);
};

/**
 * Assemble the full user message for the judge LLM call.
 */
export const assembleJudgeUserMessage = (rubric: string, input: unknown, output: unknown): string => {
  const inputStr = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  const outputStr = typeof output === "string" ? output : JSON.stringify(output, null, 2);

  return `## Rubric

${rubric}

## Input (provided to the system)

${inputStr}

## Output (produced by the system)

${outputStr}`;
};
