import type Anthropic from "@anthropic-ai/sdk";
import { APIUserAbortError } from "@anthropic-ai/sdk";
import { z } from "zod";
import { ok, err } from "../types/result.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  SendWithToolsRequest,
  ToolDef,
} from "../types/llm.js";
import type { NodeContext } from "../types/node.js";
import { ensureToolNames } from "./tools.js";
import {
  dispatchToolCallsWithSpans,
  type ToolCall,
  type ToolDispatchResult,
} from "./tool-dispatch.js";
import { zodToJsonSchema } from "./zod-schema.js";
import {
  withLlmSpan,
  setLlmUsageAttributes,
  setLlmRequestAttributes,
  setLlmResponseAttributes,
} from "./spans.js";
import { classifyLlmError } from "./llm-errors.js";
import { createTimeoutSignal } from "./with-timeout.js";

const ANTHROPIC_MAX_TOKENS = 16384;

type AnthropicMessage = Anthropic.MessageParam;
type AnthropicResponse = Anthropic.Message;

/** Append a JSON-Schema instruction to the system prompt so free-form text replies can be parsed. */
const appendSchemaInstruction = (system: string, schema: z.ZodType<any>): string => {
  const json = zodToJsonSchema(schema);
  return `${system}\n\nWhen you have the final answer, respond with ONLY a JSON object matching this schema (no prose, no code fences):\n${JSON.stringify(json)}`;
};

const toolToAnthropicSpec = (tool: ToolDef<any, any>): Anthropic.Tool => {
  const json = zodToJsonSchema(tool.inputSchema);
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

/** Anthropic SDK abort predicate — `APIUserAbortError` name differs from standard `AbortError`. */
const isAnthropicAbort = (e: unknown): boolean =>
  e instanceof APIUserAbortError;

const resolveNodeId = (req: { readonly nodeId: NodeId }): NodeId =>
  req.nodeId;

export class AnthropicLlmClient implements LlmClient {
  private readonly requestTimeoutMs: number;

  constructor(private readonly anthropic: Anthropic, opts?: { requestTimeoutMs?: number }) {
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 120_000;
  }

  async sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>> {
    const t = createTimeoutSignal(this.requestTimeoutMs, req.signal);

    try {
      const jsonSchema = zodToJsonSchema(req.schema);
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

      const response = await withLlmSpan(
        req.tracer ?? null,
        { provider: "anthropic", model: req.model, operation: "chat" },
        async () => {
          const r = await this.anthropic.messages.create(params, { signal: t.signal });
          setLlmUsageAttributes(r.usage.input_tokens, r.usage.output_tokens);
          setLlmResponseAttributes({ model: r.model, id: r.id });
          return r;
        },
      );

      const thinkingBlock = response.content.find((b) => b.type === "thinking");
      const thinking = thinkingBlock?.type === "thinking" ? thinkingBlock.thinking : undefined;

      const toolUseBlock = response.content.find((b) => b.type === "tool_use");
      if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
        return err({
          kind: "node-crash",
          retriability: "retriable",
          nodeId: resolveNodeId(req),
          message: "Anthropic response did not contain a tool_use block",
        });
      }

      const parsed = req.schema.safeParse(toolUseBlock.input);
      if (!parsed.success) {
        return err({
          kind: "node-crash",
          retriability: "retriable",
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
      return classifyLlmError(error, resolveNodeId(req), {
        timedOut: t.timedOut(),
        callerAborted: req.signal?.aborted,
        timeoutMs: this.requestTimeoutMs,
        isAbortOverride: isAnthropicAbort,
      });
    } finally {
      t.cleanup();
    }
  }

  async sendWithTools<O>(
    req: SendWithToolsRequest<O>,
    ctx: NodeContext,
  ): Promise<Result<LlmResponse<O>, FrameworkError>> {
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
      if (req.signal?.aborted || ctx.signal?.aborted) {
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

      const turnCallerSignal = req.signal ?? ctx.signal;
      const t = createTimeoutSignal(this.requestTimeoutMs, turnCallerSignal);

      let response: AnthropicResponse;
      try {
        response = await withLlmSpan(
          ctx.tracer ?? null,
          { provider: "anthropic", model: req.model, operation: "chat" },
          async () => {
            setLlmRequestAttributes({ maxTokens: ANTHROPIC_MAX_TOKENS });
            const r = await this.anthropic.messages.create(params, { signal: t.signal });
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
        return classifyLlmError(e, resolveNodeId(req), {
          timedOut: t.timedOut(),
          callerAborted: turnCallerSignal?.aborted,
          timeoutMs: this.requestTimeoutMs,
          isAbortOverride: isAnthropicAbort,
        });
      } finally {
        t.cleanup();
      }

      totalTokensIn += response.usage.input_tokens;
      totalTokensOut += response.usage.output_tokens;

      const thinkingBlock = response.content.find((b) => b.type === "thinking");
      if (thinkingBlock?.type === "thinking") lastThinking = thinkingBlock.thinking;

      messages.push({ role: "assistant", content: response.content });

      const toolCalls = parseToolCalls(response);
      if (toolCalls.length === 0) {
        // Final turn — parse JSON answer.
        const text = lastTextBlock(response);
        if (text === undefined) {
          return err({
            kind: "node-crash",
            retriability: "retriable",
            nodeId: resolveNodeId(req),
            message: "Anthropic final turn had no text block to parse",
          });
        }
        lastRawText = text;
        let parsed: unknown;
        try {
          parsed = JSON.parse(stripCodeFences(text));
        } catch (parseErr) {
          const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          return err({
            kind: "node-crash",
            retriability: "retriable",
            nodeId: resolveNodeId(req),
            message: `Not valid JSON (${parseMsg}): ${text.slice(0, 200)}`,
          });
        }
        const validated = req.schema.safeParse(parsed);
        if (!validated.success) {
          return err({
            kind: "node-crash",
            retriability: "retriable",
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

      const results = await dispatchToolCallsWithSpans(toolCalls, req.tools, ctx, { model: req.model });
      messages.push(buildToolResultMessage(results));
    }

    // A model that did not converge within `maxIterations` turns will not
    // converge on retry without prompt changes — classify as permanent so the
    // DAG fast-fails instead of consuming the retry budget.
    return err({
      kind: "node-crash",
      nodeId: resolveNodeId(req),
      message: `Tool-call iteration limit (${maxIterations}) reached`,
      retriability: "non-retriable",
    });
  }
}
