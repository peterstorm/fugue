// Eval-judge runner — called by runDagStateful after the DAG resolves
// successfully. Each judge runs in its own OTel span. Judge-internal failures
// (LLM call failure, schema validation) fail open with `passed: true,
// skipped: true` (the judge couldn't grade — don't block the run on a broken
// model). Orchestrator-level exceptions surface as `passed: false,
// skipped: true, crash: { ... }` so quality gates filtering on `passed` see
// the failure rather than silently treating a broken judge as passing.

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
            const includeContent = ctx.includeContent ?? false;
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
            // Orchestrator-side exception (span setup, tracer/attribute bug,
            // or a judge whose `run` threw past its own internal fail-open).
            // Returning `passed: true` here would silently disable quality
            // gates filtering on `passed` — operators would see a broken
            // judge as passing every run. Return `passed: false` with a
            // structured `crash` payload so the failure is visible to both
            // run-end aggregation (`evalJudgeFailed`) and any downstream
            // gating logic.
            const msg = e instanceof Error ? e.message : String(e);
            const prefix = `[eval-judge:${judge.id}] Unexpected error: ${msg}`;
            (ctx.logger?.warn ?? console.warn)(prefix);
            span.setStatus({ code: SpanStatusCode.ERROR, message: prefix });
            span.end();
            return {
              passed: false,
              score: null,
              criteriaScores: {},
              failedCriteria: [] as string[],
              reason: `[crashed: ${msg}]`,
              skipped: true,
              crash: { kind: "judge-crash" as const, message: msg },
            };
          }
        },
      ),
    ),
  );
};
