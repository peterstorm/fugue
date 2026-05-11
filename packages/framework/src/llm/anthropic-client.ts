import type Anthropic from "@anthropic-ai/sdk";
import { APIUserAbortError } from "@anthropic-ai/sdk";
import { z } from "zod";
import { ok, err } from "../types/result.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  LlmRuntime,
  SendWithToolsRequest,
} from "./client.js";
import type { NodeContext } from "../types/node.js";
import type { ToolDef } from "./tools.js";
import { ensureToolNames } from "./tools.js";
import {
  dispatchToolCallsWithSpans,
  type ToolCall,
  type ToolDispatchResult,
} from "./tool-dispatch.js";
import {
  withLlmSpan,
  setLlmUsageAttributes,
  setLlmRequestAttributes,
  setLlmResponseAttributes,
} from "./spans.js";

const ANTHROPIC_MAX_TOKENS = 16384;

type AnthropicMessage = Anthropic.MessageParam;
type AnthropicResponse = Anthropic.Message;

/** Append a JSON-Schema instruction to the system prompt so free-form text replies can be parsed. */
const appendSchemaInstruction = (system: string, schema: z.ZodType<any>): string => {
  const json = z.toJSONSchema(schema as any) as Record<string, unknown>;
  delete json.$schema;
  return `${system}\n\nWhen you have the final answer, respond with ONLY a JSON object matching this schema (no prose, no code fences):\n${JSON.stringify(json)}`;
};

const toolToAnthropicSpec = (tool: ToolDef<any, any>): Anthropic.Tool => {
  const json = z.toJSONSchema(tool.inputSchema as any) as Record<string, unknown>;
  delete json.$schema;
  return {
    name: tool.name,
    description: tool.description,
    input_schema: json as Anthropic.Tool["input_schema"],
  };
};

const toolChoiceToAnthropic = (
  choice: SendWithToolsRequest<any>["toolChoice"],
): Anthropic.ToolChoice | undefined => {
  switch (choice) {
    case "any":
      return { type: "any" };
    case "none":
      return { type: "none" };
    case "auto":
    case undefined:
      return { type: "auto" };
  }
};

const parseToolCalls = (response: AnthropicResponse): ToolCall[] =>
  response.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));

const buildToolResultMessage = (
  results: readonly ToolDispatchResult[],
): AnthropicMessage => ({
  role: "user",
  content: results.map((r) => ({
    type: "tool_result",
    tool_use_id: r.id,
    content: typeof r.content === "string" ? r.content : JSON.stringify(r.content),
    is_error: r.isError,
  })),
});

const lastTextBlock = (response: AnthropicResponse): string | undefined => {
  for (let i = response.content.length - 1; i >= 0; i--) {
    const block = response.content[i];
    if (block?.type === "text") return block.text;
  }
  return undefined;
};

const stripCodeFences = (text: string): string =>
  text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

const isAbort = (e: unknown): boolean =>
  e instanceof APIUserAbortError ||
  (e instanceof Error && e.name === "AbortError");

/**
 * Wave 6 §6.10 — detect HTTP 429 from the Anthropic SDK so callers can
 * distinguish "transient, retry me" from "permanent crash."
 *
 * The SDK throws `RateLimitError extends APIError<429, ...>` whose `status`
 * field is `429`. We duck-type on `.status === 429` so injected fakes from
 * tests don't need to subclass the SDK's class hierarchy.
 */
const isRateLimit = (e: unknown): boolean =>
  typeof (e as { status?: unknown })?.status === "number" &&
  (e as { status: number }).status === 429;

const resolveNodeId = (req: { readonly nodeId?: string }): string =>
  req.nodeId ?? "<llm>";

export class AnthropicLlmClient implements LlmClient {
  private readonly requestTimeoutMs: number;

  constructor(private readonly anthropic: Anthropic, opts?: { requestTimeoutMs?: number }) {
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 120_000;
  }

  async sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>> {
    try {
      const jsonSchema = z.toJSONSchema(req.schema as any) as Record<string, unknown>;
      delete jsonSchema.$schema;
      const toolDef = {
        name: "structured_output",
        description: "Return the structured output",
        input_schema: jsonSchema as Anthropic.Tool["input_schema"],
      };

      const params: Anthropic.MessageCreateParams = {
        model: req.model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        tools: [toolDef],
        tool_choice: { type: "tool", name: "structured_output" },
      };

      const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
      const signal = req.signal
        ? AbortSignal.any([timeoutSignal, req.signal])
        : timeoutSignal;
      const response = await this.anthropic.messages.create(params, { signal });

      // Extract thinking content if present
      const thinkingBlock = response.content.find((b) => b.type === "thinking");
      const thinking = thinkingBlock?.type === "thinking" ? thinkingBlock.thinking : undefined;

      // Extract tool use result
      const toolUseBlock = response.content.find((b) => b.type === "tool_use");
      if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
        return err({
          kind: "node-crash",
          nodeId: resolveNodeId(req),
          message: "Anthropic response did not contain a tool_use block",
        });
      }

      // Parse with zod
      const parsed = req.schema.safeParse(toolUseBlock.input);
      if (!parsed.success) {
        return err({
          kind: "node-crash",
          nodeId: resolveNodeId(req),
          message: `Schema validation failed: ${parsed.error.message}`,
        });
      }

      const rawText = JSON.stringify(toolUseBlock.input);

      return ok({
        output: parsed.data as O,
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
        thinking,
        rawText,
      });
    } catch (error) {
      if (isAbort(error)) {
        return err({ kind: "aborted", reason: "signal" });
      }
      if (isRateLimit(error)) {
        return err({
          kind: "transient",
          nodeId: resolveNodeId(req),
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return err({
        kind: "node-crash",
        nodeId: resolveNodeId(req),
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  async sendWithTools<O>(
    req: SendWithToolsRequest<O>,
    runtime: LlmRuntime,
  ): Promise<Result<LlmResponse<O>, FrameworkError>> {
    // Wave 4 §4.4 — `runtime`'s static type is the minimum (`LlmRuntime`)
    // because `llm/client.ts` can't import `NodeContext` (cycle: `types/node.ts`
    // imports `LlmClient`). At the tool-dispatch boundary, however, tools may
    // read any `NodeContext` field. The contract documented on `LlmClient`
    // requires callers wiring tools to pass a `NodeContext`. This cast is the
    // single sanctioned widening — it lives here so the rest of the file uses
    // the wider type honestly. See ADR-0012 and §4.4 of the Wave 4 plan.
    const ctx = runtime as NodeContext;
    try {
      ensureToolNames(req.tools);
    } catch (e) {
      return err({
        kind: "validation",
        nodeId: resolveNodeId(req),
        message: e instanceof Error ? e.message : String(e),
      });
    }

    const maxIterations = req.maxIterations ?? 10;
    const system = appendSchemaInstruction(req.system, req.schema as z.ZodType<any>);
    const toolSpecs = req.tools.map(toolToAnthropicSpec);
    const toolChoice = toolChoiceToAnthropic(req.toolChoice);
    const messages: AnthropicMessage[] = [{ role: "user", content: req.user }];

    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let lastThinking: string | undefined;
    let lastRawText = "";

    for (let turn = 0; turn < maxIterations; turn++) {
      if (req.signal?.aborted || runtime.signal?.aborted) {
        return err({ kind: "aborted", reason: "signal" });
      }

      const params: Anthropic.MessageCreateParams = {
        model: req.model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        system,
        messages,
        tools: toolSpecs,
        tool_choice: toolChoice,
      };

      const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
      const callerSignal = req.signal ?? runtime.signal;
      const signal = callerSignal
        ? AbortSignal.any([timeoutSignal, callerSignal])
        : timeoutSignal;

      let response: AnthropicResponse;
      try {
        response = await withLlmSpan(
          runtime.tracer ?? null,
          { provider: "anthropic", model: req.model, operation: "chat" },
          async () => {
            setLlmRequestAttributes({ maxTokens: ANTHROPIC_MAX_TOKENS });
            const r = await this.anthropic.messages.create(params, { signal });
            setLlmUsageAttributes(r.usage.input_tokens, r.usage.output_tokens);
            setLlmResponseAttributes({
              model: r.model,
              id: r.id,
              finishReasons: r.stop_reason ? [r.stop_reason] : undefined,
            });
            return r;
          },
        );
      } catch (e) {
        if (isAbort(e)) {
          return err({ kind: "aborted", reason: "signal" });
        }
        if (isRateLimit(e)) {
          return err({
            kind: "transient",
            nodeId: resolveNodeId(req),
            message: e instanceof Error ? e.message : String(e),
          });
        }
        return err({
          kind: "node-crash",
          nodeId: resolveNodeId(req),
          message: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined,
        });
      }

      totalTokensIn += response.usage.input_tokens;
      totalTokensOut += response.usage.output_tokens;

      const thinkingBlock = response.content.find((b) => b.type === "thinking");
      if (thinkingBlock?.type === "thinking") lastThinking = thinkingBlock.thinking;

      // Mirror the assistant turn back into the conversation.
      messages.push({ role: "assistant", content: response.content });

      const toolCalls = parseToolCalls(response);
      if (toolCalls.length === 0) {
        // Final turn — parse JSON answer.
        const text = lastTextBlock(response);
        if (text === undefined) {
          return err({
            kind: "node-crash",
            nodeId: resolveNodeId(req),
            message: "Anthropic final turn had no text block to parse",
          });
        }
        lastRawText = text;
        let parsed: unknown;
        try {
          parsed = JSON.parse(stripCodeFences(text));
        } catch {
          return err({
            kind: "node-crash",
            nodeId: resolveNodeId(req),
            message: `Final response was not valid JSON: ${text.slice(0, 200)}`,
          });
        }
        const validated = req.schema.safeParse(parsed);
        if (!validated.success) {
          return err({
            kind: "node-crash",
            nodeId: resolveNodeId(req),
            message: `Schema validation failed: ${validated.error.message}`,
          });
        }
        return ok({
          output: validated.data as O,
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          thinking: lastThinking,
          rawText: lastRawText,
        });
      }

      const results = await dispatchToolCallsWithSpans(toolCalls, req.tools, ctx);
      messages.push(buildToolResultMessage(results));
    }

    return err({
      kind: "transient",
      nodeId: resolveNodeId(req),
      message: `Tool-call iteration limit (${maxIterations}) reached`,
    });
  }
}
