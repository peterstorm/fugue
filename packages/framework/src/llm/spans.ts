import { trace } from "@opentelemetry/api";
import type { Tracer } from "../types/node.js";

export interface LlmSpanMeta {
  readonly provider: string;
  readonly model: string;
  readonly operation: "chat" | "completion" | "embedding";
}

export interface ToolSpanMeta {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly toolType?: string;
}

const setLlmAttributes = (meta: LlmSpanMeta): void => {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttribute("gen_ai.operation.name", meta.operation);
  span.setAttribute("gen_ai.system", meta.provider);
  span.setAttribute("gen_ai.request.model", meta.model);
};

const setToolAttributes = (meta: ToolSpanMeta): void => {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttribute("gen_ai.operation.name", "execute_tool");
  span.setAttribute("gen_ai.tool.name", meta.toolName);
  span.setAttribute("gen_ai.tool.call.id", meta.toolCallId);
  span.setAttribute("gen_ai.tool.type", meta.toolType ?? "function");
};

/**
 * Wrap an LLM call in a span emitting GenAI semantic-convention attributes.
 *
 * Span name follows `<operation> <model>` (e.g., `chat claude-3-5-sonnet`); the
 * underlying span type is `CHAT_MODEL` for downstream MLflow rendering.
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
  span.setAttribute("gen_ai.usage.input_tokens", tokensIn);
  span.setAttribute("gen_ai.usage.output_tokens", tokensOut);
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

/** Set tool I/O attributes on the currently-active TOOL span. */
export const setToolIoAttributes = (
  input: unknown,
  output: unknown,
  isError: boolean,
): void => {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttribute("gen_ai.tool.input", stringifyOrTruncate(input));
  span.setAttribute("gen_ai.tool.output", stringifyOrTruncate(output));
  span.setAttribute("gen_ai.tool.is_error", isError);
};
