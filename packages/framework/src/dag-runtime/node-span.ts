import { SpanStatusCode } from "@opentelemetry/api";
import { fwTracer } from "../tracing/global-tracer.js";
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

/** Per-node guardrail outcome produced by `withNodeSpan`. */
export interface NodeSpanOutcome {
  readonly guardrailFailed: boolean;
  readonly guardrailWarnings: readonly string[];
}

export interface DagRunMeta {
  readonly guardrailFailed: boolean;
  readonly guardrailWarnings: readonly string[];
  readonly evalJudgeFailed: boolean;
  readonly evalJudgeResults: readonly EvalJudgeResult[];
}

const EMPTY_OUTCOME: NodeSpanOutcome = {
  guardrailFailed: false,
  guardrailWarnings: [],
};

export const createDagRunMeta = (): DagRunMeta => ({
  guardrailFailed: false,
  guardrailWarnings: [],
  evalJudgeFailed: false,
  evalJudgeResults: [],
});

/**
 * Fold a batch of per-node outcomes into a fresh, immutable `DagRunMeta`.
 * Concurrent siblings each return their own outcome; the wave caller folds
 * them after `Promise.all` so no two callbacks ever write the same field.
 */
export const foldOutcomes = (
  meta: DagRunMeta,
  outcomes: readonly NodeSpanOutcome[],
): DagRunMeta => {
  if (outcomes.length === 0) return meta;
  const newWarnings = outcomes.flatMap((o) => o.guardrailWarnings);
  const anyFailed = outcomes.some((o) => o.guardrailFailed);
  if (!anyFailed && newWarnings.length === 0) return meta;
  return {
    ...meta,
    guardrailFailed: meta.guardrailFailed || anyFailed,
    guardrailWarnings: [...meta.guardrailWarnings, ...newWarnings],
  };
};

/**
 * Wrap node execution in an OTel span. Returns the node `result` paired with a
 * `NodeSpanOutcome` describing any guardrail failure observed inside the span.
 * Outcomes are *returned*, not mutated onto a shared meta — the wave caller
 * folds them after `Promise.all`, eliminating concurrent writes to shared
 * accumulator state.
 */
export const withNodeSpan = async (
  nodeId: string,
  kind: string,
  input: unknown,
  includeContent: boolean,
  fn: () => Promise<Result<unknown, FrameworkError>>,
): Promise<{ result: Result<unknown, FrameworkError>; outcome: NodeSpanOutcome }> => {
  const spanType = NODE_KIND_TO_SPAN_TYPE[kind] ?? SPAN_TYPE_CHAIN;

  return fwTracer().startActiveSpan(
    `node:${nodeId}`,
    {
      attributes: {
        [AI_SPAN_TYPE]: spanType,
        [AI_NODE_ID]: nodeId,
        [AI_NODE_KIND]: kind,
      },
    },
    async (span) => {
      span.addEvent(
        EVENT_NODE_INPUT,
        includeContent ? { data: JSON.stringify(input) } : { data_redacted: "true" },
      );

      let outcome: NodeSpanOutcome = EMPTY_OUTCOME;
      let result: Result<unknown, FrameworkError>;
      // Guarantee `span.end()` runs on every path — including observer throws
      // re-raised by `dispatchEvent` under `OBSERVER_STRICT=1`. Without the
      // try/finally an unhandled rejection inside `fn()` would leak the span.
      try {
        result = await fn();
      } catch (e) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
        span.end();
        throw e;
      }
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
          outcome = { guardrailFailed: true, guardrailWarnings: warnings };
        }
      } else {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(result.error) });
      }
      span.end();
      return { result, outcome };
    },
  );
};
