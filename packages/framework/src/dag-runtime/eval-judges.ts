// Eval-judge runner called by runDagStateful after a successful DAG run.
// Each judge runs in its own OTel span. Judge-internal failures (LLM call,
// schema mismatch) fail open with `passed: true, skipped: true` so a broken
// model can't block a run. Orchestrator-level exceptions surface as
// `passed: false, skipped: true, crash: { ... }` so quality gates filtering
// on `passed` see a broken judge rather than silently treating it as passing.

import { SpanStatusCode } from "@opentelemetry/api";
import type { EvalJudgeNodeDef, EvalJudgeResult } from "../nodes/eval-judge.js";
import type { NodeContext } from "../types/node.js";
import { fwLogger } from "../logger.js";
import { fwTracer } from "../tracing/global-tracer.js";
import {
  AI_SPAN_TYPE,
  EVENT_NODE_INPUT,
  EVENT_NODE_OUTPUT,
  SPAN_TYPE_TOOL,
} from "../tracing/semantic-conventions.js";

export const runEvalJudges = async (
  judges: readonly EvalJudgeNodeDef[],
  dagInput: unknown,
  dagOutput: unknown,
  nodeOutputs: Map<string, unknown>,
  ctx: NodeContext,
): Promise<EvalJudgeResult[]> => {
  return Promise.all(
    judges.map(async (judge) =>
      fwTracer().startActiveSpan(
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
            (ctx.logger?.warn ?? fwLogger().warn)(prefix);
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
