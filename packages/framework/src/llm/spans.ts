import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Tracer } from "../types/node.js";
import {
  ERROR_TYPE,
  GEN_AI_OPERATION_NAME,
  GEN_AI_REQUEST_MAX_TOKENS,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_REQUEST_TEMPERATURE,
  GEN_AI_REQUEST_TOP_P,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_ID,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_SYSTEM,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_CALL_RESULT,
  GEN_AI_TOOL_NAME,
  GEN_AI_TOOL_TYPE,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
} from "../tracing/semantic-conventions.js";

export interface LlmSpanMeta {
  readonly provider: string;
  readonly model: string;
  readonly operation: "chat" | "completion" | "embedding";
}

export interface ToolSpanMeta {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly toolType?: string;
  /** The model that requested this tool call (for attribution). */
  readonly model?: string;
}

const setLlmAttributes = (meta: LlmSpanMeta): void => {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttribute(GEN_AI_OPERATION_NAME, meta.operation);
  span.setAttribute(GEN_AI_SYSTEM, meta.provider);
  span.setAttribute(GEN_AI_REQUEST_MODEL, meta.model);
};

const setToolAttributes = (meta: ToolSpanMeta): void => {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttribute(GEN_AI_OPERATION_NAME, "execute_tool");
  span.setAttribute(GEN_AI_TOOL_NAME, meta.toolName);
  span.setAttribute(GEN_AI_TOOL_CALL_ID, meta.toolCallId);
  span.setAttribute(GEN_AI_TOOL_TYPE, meta.toolType ?? "function");
  if (meta.model) span.setAttribute(GEN_AI_REQUEST_MODEL, meta.model);
};

/**
 * Wrap an LLM call in a span emitting GenAI semantic-convention attributes.
 *
 * Span name follows `<operation> <model>` (e.g., `chat claude-3-5-sonnet`); the
 * span type is `CHAT_MODEL` so downstream consumers can distinguish
 * model-call spans from generic CHAIN spans.
 */
export async function withLlmSpan<T>(
  tracer: Tracer | null | undefined,
  meta: LlmSpanMeta,
  fn: () => Promise<T>,
): Promise<T> {
  if (!tracer) {
    setLlmAttributes(meta);
    return fn();
  }
  return tracer.withSpan(`${meta.operation} ${meta.model}`, "CHAT_MODEL", async () => {
    setLlmAttributes(meta);
    return fn();
  });
}

/**
 * Wrap a tool dispatch in a span emitting GenAI semantic-convention attributes.
 */
export async function withToolSpan<T>(
  tracer: Tracer | null | undefined,
  meta: ToolSpanMeta,
  fn: () => Promise<T>,
): Promise<T> {
  if (!tracer) {
    setToolAttributes(meta);
    return fn();
  }
  return tracer.withSpan(`execute_tool ${meta.toolName}`, "TOOL", async () => {
    setToolAttributes(meta);
    return fn();
  });
}

/** Set token-usage attributes on the currently-active LLM span. */
export const setLlmUsageAttributes = (tokensIn: number, tokensOut: number): void => {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, tokensIn);
  span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, tokensOut);
};

export interface LlmRequestParams {
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxTokens?: number;
}

/** Set OTel GenAI request-parameter attributes on the currently-active LLM span. */
export const setLlmRequestAttributes = (params: LlmRequestParams): void => {
  const span = trace.getActiveSpan();
  if (!span) return;
  if (params.temperature !== undefined)
    span.setAttribute(GEN_AI_REQUEST_TEMPERATURE, params.temperature);
  if (params.topP !== undefined) span.setAttribute(GEN_AI_REQUEST_TOP_P, params.topP);
  if (params.maxTokens !== undefined)
    span.setAttribute(GEN_AI_REQUEST_MAX_TOKENS, params.maxTokens);
};

export interface LlmResponseMeta {
  readonly model?: string;
  readonly id?: string;
  readonly finishReasons?: ReadonlyArray<string>;
}

/** Set OTel GenAI response attributes on the currently-active LLM span. */
export const setLlmResponseAttributes = (meta: LlmResponseMeta): void => {
  const span = trace.getActiveSpan();
  if (!span) return;
  if (meta.model) span.setAttribute(GEN_AI_RESPONSE_MODEL, meta.model);
  if (meta.id) span.setAttribute(GEN_AI_RESPONSE_ID, meta.id);
  if (meta.finishReasons && meta.finishReasons.length > 0) {
    span.setAttribute(GEN_AI_RESPONSE_FINISH_REASONS, [...meta.finishReasons]);
  }
};

const MAX_TOOL_IO_BYTES = 8192;

const stringifyOrTruncate = (value: unknown): string => {
  let s: string;
  try {
    s = JSON.stringify(value) ?? "";
  } catch {
    return JSON.stringify({ unserializable: true });
  }
  if (s.length > MAX_TOOL_IO_BYTES) {
    return JSON.stringify({ truncated: s.length });
  }
  return s;
};

/**
 * Set tool I/O attributes on the currently-active TOOL span.
 *
 * Attribute names follow OTel GenAI semconv: `gen_ai.tool.call.arguments` for
 * the tool input and `gen_ai.tool.call.result` for its output. Errors are
 * reported via the standard OTel `error.type` attribute and a span status of
 * ERROR, rather than the previous custom `gen_ai.tool.is_error` boolean.
 */
export const setToolIoAttributes = (
  input: unknown,
  output: unknown,
  isError: boolean,
): void => {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttribute(GEN_AI_TOOL_CALL_ARGUMENTS, stringifyOrTruncate(input));
  span.setAttribute(GEN_AI_TOOL_CALL_RESULT, stringifyOrTruncate(output));
  if (isError) {
    span.setAttribute(ERROR_TYPE, "tool_execution_error");
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
};
