// Shared eval-judge runner — used by both the legacy executor and the state-machine path.

import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { EvalJudgeNodeDef, EvalJudgeResult } from "../nodes/eval-judge.js";
import type { NodeContext } from "../types/node.js";
import {
  AI_SPAN_TYPE,
  EVENT_NODE_INPUT,
  EVENT_NODE_OUTPUT,
  SPAN_TYPE_TOOL,
} from "../tracing/semantic-conventions.js";

const tracer = trace.getTracer("ai-summary-framework");

/**
 * Run all configured eval-judges against the DAG output. Each judge runs in its
 * own OTel span; failures are logged but never crash the caller (fail-open).
 */
export const runEvalJudges = async (
  judges: readonly EvalJudgeNodeDef[],
  dagInput: unknown,
  dagOutput: unknown,
  nodeOutputs: Map<string, unknown>,
  ctx: NodeContext,
): Promise<EvalJudgeResult[]> => {
  return Promise.all(
    judges.map(async (judge) =>
      tracer.startActiveSpan(
        `eval-judge:${judge.id}`,
        { attributes: { [AI_SPAN_TYPE]: SPAN_TYPE_TOOL } },
        async (span) => {
          try {
            const judgeInput = { dagInput, dagOutput, nodeOutputs: Object.fromEntries(nodeOutputs) };
            const includeContent = process.env.LLM_TRACE_PROMPTS === "true" || process.env.LLM_TRACE_PROMPTS === "1";
            span.addEvent(EVENT_NODE_INPUT, includeContent
              ? { data: JSON.stringify({ ...judgeInput, criteria: judge.config.criteria }) }
              : { data_redacted: "true", criteria: JSON.stringify(judge.config.criteria) });

            const result = await judge.run(judgeInput, dagOutput, ctx);
            span.addEvent(EVENT_NODE_OUTPUT, { data: JSON.stringify(result) });
            if (!result.passed) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: `Score ${result.score} below threshold. ${result.reason}` });
            }
            span.end();
            return result;
          } catch (e) {
            const msg = `[eval-judge:${judge.id}] Unexpected error: ${e instanceof Error ? e.message : e}`;
            (ctx.logger?.warn ?? console.warn)(msg);
            span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
            span.end();
            return {
              passed: true,
              score: null as unknown as number,
              criteriaScores: {},
              failedCriteria: [] as string[],
              reason: `[skipped: ${msg}]`,
              skipped: true,
            };
          }
        },
      ),
    ),
  );
};
