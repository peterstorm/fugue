/**
 * Shared fixtures for the prompt-caching tests.
 *
 * The Anthropic SDK's response types carry a dozen fields the client never
 * reads, so building one inline per test drowns the assertion. These builders
 * keep each test file down to the thing it is actually pinning.
 */

import type Anthropic from "@anthropic-ai/sdk";

export type CreateFn = (
  params: Anthropic.MessageCreateParams,
  opts?: { signal?: AbortSignal },
) => Promise<Anthropic.Message>;

/**
 * An Anthropic `usage` block. `cacheWrite`/`cacheRead` default to `null` —
 * which is what the provider sends for an uncached call, and the case the
 * normaliser must read as zero rather than as `NaN`.
 */
export const anthropicUsageBlock = (
  input: number,
  output: number,
  cacheWrite: number | null = null,
  cacheRead: number | null = null,
): Anthropic.Message["usage"] =>
  ({
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    server_tool_use: null,
    service_tier: null,
  }) as unknown as Anthropic.Message["usage"];

const message = (
  overrides: Record<string, unknown>,
  usage: Anthropic.Message["usage"],
): Anthropic.Message =>
  ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-test",
    stop_sequence: null,
    usage,
    container: null,
    context_management: null,
    ...overrides,
  }) as unknown as Anthropic.Message;

/** A terminal turn returning the `structured_output` tool call `sendStructured` expects. */
export const structuredOutputResponse = (
  usage: Anthropic.Message["usage"],
  input: Record<string, unknown> = { answer: "hi" },
): Anthropic.Message =>
  message(
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tool_1", name: "structured_output", input }],
    },
    usage,
  );

/** A turn in which the model calls a caller-supplied tool. */
export const toolUseResponse = (
  usage: Anthropic.Message["usage"],
  toolName = "lookup",
): Anthropic.Message =>
  message(
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "call_1", name: toolName, input: { id: "x" } }],
    },
    usage,
  );

/** A terminal text turn, which the tool loop parses as the final answer. */
export const textResponse = (
  text: string,
  usage: Anthropic.Message["usage"],
): Anthropic.Message =>
  message(
    { stop_reason: "end_turn", content: [{ type: "text", text, citations: null }] },
    usage,
  );

/**
 * Every `cache_control` present anywhere in a request.
 *
 * Deliberately searches the WHOLE request rather than the places breakpoints
 * are expected: a test that only looked where it expected one could not catch a
 * breakpoint appearing somewhere it should not.
 */
export const breakpointsIn = (params: Anthropic.MessageCreateParams): unknown[] => {
  const found: unknown[] = [];
  const systemParam: unknown = params.system;
  if (Array.isArray(systemParam)) {
    for (const block of systemParam) {
      const cc = (block as { cache_control?: unknown }).cache_control;
      if (cc) found.push(cc);
    }
  }
  for (const message of params.messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      const cc = (block as { cache_control?: unknown }).cache_control;
      if (cc) found.push(cc);
    }
  }
  return found;
};
