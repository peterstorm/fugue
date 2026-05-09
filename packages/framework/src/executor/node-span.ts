import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { EvalJudgeResult } from "../nodes/eval-judge.js";
import {
  AI_NODE_ID,
  AI_NODE_KIND,
  AI_SPAN_TYPE,
  AI_GUARDRAIL_PASSED,
  EVENT_NODE_INPUT,
  EVENT_NODE_OUTPUT,
  NODE_KIND_TO_SPAN_TYPE,
  SPAN_TYPE_CHAIN,
} from "../tracing/semantic-conventions.js";

export interface DagRunMeta {
  guardrailFailed: boolean;
  guardrailWarnings: string[];
  evalJudgeFailed: boolean;
  evalJudgeResults: EvalJudgeResult[];
}

export const createDagRunMeta = (): DagRunMeta => ({
  guardrailFailed: false,
  guardrailWarnings: [],
  evalJudgeFailed: false,
  evalJudgeResults: [],
});

const tracer = trace.getTracer("ai-summary-framework");

/** Wrap node execution in an OTel span; propagate guardrail failure to meta + span. */
export const withNodeSpan = async (
  nodeId: string,
  kind: string,
  input: unknown,
  meta: DagRunMeta | undefined,
  fn: () => Promise<Result<any, FrameworkError>>,
): Promise<Result<any, FrameworkError>> => {
  const spanType = NODE_KIND_TO_SPAN_TYPE[kind] ?? SPAN_TYPE_CHAIN;

  return tracer.startActiveSpan(
    `node:${nodeId}`,
    {
      attributes: {
        [AI_SPAN_TYPE]: spanType,
        [AI_NODE_ID]: nodeId,
        [AI_NODE_KIND]: kind,
      },
    },
    async (span) => {
      const includeContent =
        process.env.LLM_TRACE_PROMPTS === "true" || process.env.LLM_TRACE_PROMPTS === "1";
      span.addEvent(
        EVENT_NODE_INPUT,
        includeContent ? { data: JSON.stringify(input) } : { data_redacted: "true" },
      );

      const result = await fn();
      if (result.ok) {
        span.addEvent(
          EVENT_NODE_OUTPUT,
          includeContent ? { data: JSON.stringify(result.value) } : { data_redacted: "true" },
        );
        if (
          kind === "guardrail" &&
          result.value &&
          typeof result.value === "object" &&
          "passed" in result.value &&
          !(result.value as { passed: boolean }).passed
        ) {
          const warnings = ((result.value as { warnings?: string[] }).warnings) ?? [];
          span.setStatus({ code: SpanStatusCode.ERROR, message: `Guardrail failed: ${warnings.join("; ")}` });
          span.setAttribute(AI_GUARDRAIL_PASSED, false);
          if (meta) {
            meta.guardrailFailed = true;
            meta.guardrailWarnings.push(...warnings);
          }
        }
      } else {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(result.error) });
      }
      span.end();
      return result;
    },
  );
};
