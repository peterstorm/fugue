// OpenAI Responses API type definitions and structural guards.
//
// The OpenAI Responses API returns `output: ResponsesOutputItem[]`. The SDK's
// exported types do not (yet) cover every variant we consume — define local
// discriminated unions for the shapes we read, with structural guards. New
// item types coming back from the API surface as `unknown` and are skipped
// by the guards rather than being silently misinterpreted via `any`.

import type { ToolCall } from "./tool-dispatch.js";
import type { ToolDispatchResult } from "./tool-dispatch.js";
import { fwLogger } from "../logger.js";

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

interface FunctionCallBlock {
  readonly type: "function_call";
  readonly id?: string;
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
}

interface OutputTextPart {
  readonly type: "output_text";
  readonly text: string;
}

interface MessageContentPart {
  readonly type: string;
  readonly text?: string;
}

interface MessageBlock {
  readonly type: "message";
  readonly content: readonly MessageContentPart[];
}

interface ReasoningSummaryItem {
  readonly text?: string;
}

interface ReasoningBlock {
  readonly type: "reasoning";
  readonly summary: readonly ReasoningSummaryItem[];
}

export type ResponsesOutputItem =
  | FunctionCallBlock
  | MessageBlock
  | ReasoningBlock
  | { readonly type: string };

interface FunctionCallOutputItem {
  readonly type: "function_call_output";
  readonly call_id: string;
  readonly output: string;
}

/**
 * Discriminated conversation item union for the Responses API multi-turn loop.
 * Every `.push()` into the conversation array is type-checked against this
 * union; the single `as ConversationItem[]` cast at the `body.input` boundary
 * is the only widening point.
 */
export type ConversationItem =
  | { readonly role: "developer"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | ResponsesOutputItem
  | FunctionCallOutputItem;

interface ResponsesUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
}

/** The `error` object a `status: "failed"` Responses body carries. */
interface ResponsesApiError {
  readonly code?: string;
  readonly message?: string;
}

export interface ResponsesApiResponse {
  readonly id?: string;
  readonly model?: string;
  readonly status?: string;
  readonly output?: readonly ResponsesOutputItem[];
  readonly usage?: ResponsesUsage;
  /** Populated when `status === "failed"` — the API's stated failure reason. */
  readonly error?: ResponsesApiError | null;
  /** Populated when `status === "incomplete"` — e.g. `{ reason: "max_output_tokens" }`. */
  readonly incomplete_details?: { readonly reason?: string } | null;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object";

const isFunctionCallBlock = (b: unknown): b is FunctionCallBlock =>
  isObject(b) &&
  b.type === "function_call" &&
  typeof b.call_id === "string" &&
  typeof b.name === "string" &&
  typeof b.arguments === "string";

export const isMessageBlock = (b: unknown): b is MessageBlock =>
  isObject(b) && b.type === "message" && Array.isArray(b.content);

export const isOutputTextPart = (c: unknown): c is OutputTextPart =>
  isObject(c) && c.type === "output_text" && typeof c.text === "string";

const isReasoningBlock = (b: unknown): b is ReasoningBlock =>
  isObject(b) && b.type === "reasoning" && Array.isArray(b.summary);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const parseToolCalls = (output: readonly ResponsesOutputItem[]): ToolCall[] => {
  const calls: ToolCall[] = [];
  for (const block of output) {
    if (!isFunctionCallBlock(block)) continue;
    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(block.arguments || "{}");
    } catch (parseErr) {
      // Unparseable arguments are passed through as the RAW string: the tool's
      // Zod inputSchema then rejects it (expected object, received string) and
      // dispatchToolCall turns that into the is_error `invalid_input` result
      // the model can recover from by retrying with well-formed JSON. The
      // operator breadcrumb is the warn above; no intermediate marker is
      // needed (nothing downstream distinguishes parse failures from other
      // schema violations).
      fwLogger().warn(`[openai-client] Failed to parse tool-call arguments for '${block.name}': ${parseErr instanceof Error ? parseErr.message : parseErr}`);
      parsedInput = block.arguments;
    }
    calls.push({ id: block.call_id, name: block.name, input: parsedInput });
  }
  return calls;
};

export const buildToolResultItems = (
  results: readonly ToolDispatchResult[],
): Array<FunctionCallOutputItem> =>
  results.map((r) => ({
    type: "function_call_output" as const,
    call_id: r.id,
    output:
      typeof r.content === "string" ? r.content : JSON.stringify(r.content),
  }));

export const extractFinalText = (
  output: readonly ResponsesOutputItem[],
): string | undefined => {
  for (let i = output.length - 1; i >= 0; i--) {
    const block = output[i];
    if (!isMessageBlock(block)) continue;
    const textPart = block.content.find(isOutputTextPart);
    if (textPart) return textPart.text;
  }
  return undefined;
};

export const extractReasoning = (
  output: readonly ResponsesOutputItem[],
): string | undefined => {
  const block = output.find(isReasoningBlock);
  if (!block || block.summary.length === 0) return undefined;
  return block.summary.map((s) => s.text ?? "").join("\n");
};
