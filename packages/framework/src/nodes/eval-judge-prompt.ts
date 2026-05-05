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

/**
 * Generate a default rubric from a list of criteria names.
 * Used when no rubricTemplateId or rubricInline is provided.
 */
export const generateDefaultRubric = (criteria: readonly string[], threshold: number): string => {
  const lines = criteria.map(
    (c) => `- ${c}: Scores 1.0 if fully met, 0.0 if entirely absent. Fails below ${threshold}.`,
  );
  return `Evaluate against these criteria (threshold: ${threshold}):\n${lines.join("\n")}`;
};

/**
 * Resolve the rubric from config + context.
 *
 * Priority:
 * 1. rubricTemplateId → loaded from ctx.prompts
 * 2. rubricInline → used directly
 * 3. Auto-generate from criteria names
 */
export const resolveRubric = (
  opts: {
    readonly criteria: readonly string[];
    readonly threshold: number;
    readonly rubricTemplateId?: string;
    readonly rubricInline?: string;
  },
  promptsGet: ((name: string) => string | null) | null,
): string => {
  if (opts.rubricTemplateId && promptsGet) {
    const template = promptsGet(opts.rubricTemplateId);
    if (template) return template;
  }
  if (opts.rubricInline) return opts.rubricInline;
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
