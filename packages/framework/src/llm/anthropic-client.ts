import type Anthropic from "@anthropic-ai/sdk";
import { APIUserAbortError } from "@anthropic-ai/sdk";

/**
 * Structural interface for the Anthropic SDK client. Accepts any object with
 * a `messages.create` method matching the Anthropic SDK shape. This avoids
 * TypeScript's `#private` incompatibility when the SDK is resolved under
 * different module resolution modes (e.g., app vs framework workspace).
 */
export interface AnthropicSdkLike {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal | null },
    ): Promise<Anthropic.Message>;
  };
}
import { z } from "zod";
import { ok, err } from "../types/result.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  SendWithToolsRequest,
  ToolDef,
} from "../types/llm.js";
import type { NodeContext } from "../types/node.js";
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
import { classifyLlmError, validateTemperature } from "./llm-errors.js";
import { createTimeoutSignal } from "./with-timeout.js";
import { toolUseLoop } from "./tool-use-loop.js";

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

/** Anthropic SDK abort predicate — `APIUserAbortError` name differs from standard `AbortError`. */
const isAnthropicAbort = (e: unknown): boolean =>
  e instanceof APIUserAbortError;

export class AnthropicLlmClient implements LlmClient {
  private readonly requestTimeoutMs: number;

  constructor(private readonly anthropic: AnthropicSdkLike, opts?: { requestTimeoutMs?: number }) {
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 120_000;
  }

  async sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>> {
    // Pre-flight: an out-of-range/non-finite temperature is a deterministic
    // caller error — typed validation failure before anything reaches the wire.
    const temperatureError = validateTemperature(req.temperature, req.nodeId);
    if (temperatureError !== null) return temperatureError;

    // Pre-flight: schema construction is deterministic — non-retriable on
    // failure (mirrors OpenAI's sendStructured pre-flight).
    let jsonSchema: ReturnType<typeof zodToJsonSchema>;
    try {
      jsonSchema = zodToJsonSchema(req.schema);
    } catch (e) {
      return err({
        kind: "validation",
        nodeId: req.nodeId,
        message: `Schema construction failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    const t = createTimeoutSignal(this.requestTimeoutMs, req.signal);

    try {
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
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
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

      // `stop_reason === "max_tokens"` means the output was TRUNCATED at the
      // fixed ANTHROPIC_MAX_TOKENS cap — retrying the identical request hits
      // the identical cap, so it is a deterministic (non-retriable) failure.
      // Every other stop_reason on these arms is transient model behavior.
      const truncated = response.stop_reason === "max_tokens";
      const retriability = truncated ? ("non-retriable" as const) : ("retriable" as const);

      const toolUseBlock = response.content.find((b) => b.type === "tool_use");
      if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
        return err({
          kind: "node-crash",
          retriability,
          nodeId: req.nodeId,
          message: `Anthropic response did not contain a tool_use block (stop_reason: ${response.stop_reason ?? "unknown"})`,
        });
      }

      const parsed = req.schema.safeParse(toolUseBlock.input);
      if (!parsed.success) {
        return err({
          kind: "node-crash",
          retriability,
          nodeId: req.nodeId,
          message: `Schema validation failed (stop_reason: ${response.stop_reason ?? "unknown"}): ${parsed.error.message}`,
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
      return classifyLlmError(error, req.nodeId, {
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
    const maxIterations = req.maxIterations ?? 10;
    // Pre-flight: schema/tool-spec construction (zodToJsonSchema) is
    // deterministic — a throw here must stay inside the Result boundary as a
    // typed non-retriable validation error (mirrors sendStructured).
    let system: string;
    let toolSpecs: Anthropic.Tool[];
    try {
      system = appendSchemaInstruction(req.system, req.schema as z.ZodType<any>);
      toolSpecs = req.tools.map(toolToAnthropicSpec);
    } catch (e) {
      return err({
        kind: "validation",
        nodeId: req.nodeId,
        message: `Schema construction failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    const toolChoice = toolChoiceToAnthropic(req.toolChoice);
    const messages: AnthropicMessage[] = [{ role: "user", content: req.user }];

    const provider: import("./tool-use-loop.js").ToolLoopProvider = {
      call: async (_turn: number) => {
        const turnCallerSignal = req.signal ?? ctx.signal;
        const t = createTimeoutSignal(this.requestTimeoutMs, turnCallerSignal);

        let response: AnthropicResponse;
        try {
          response = await withLlmSpan(
            ctx.tracer ?? null,
            { provider: "anthropic", model: req.model, operation: "chat" },
            async () => {
              setLlmRequestAttributes({ maxTokens: ANTHROPIC_MAX_TOKENS });
              const r = await this.anthropic.messages.create(
                { model: req.model, max_tokens: ANTHROPIC_MAX_TOKENS, system, messages, tools: toolSpecs, tool_choice: toolChoice },
                { signal: t.signal },
              );
              setLlmUsageAttributes(r.usage.input_tokens, r.usage.output_tokens);
              setLlmResponseAttributes({ model: r.model, id: r.id, finishReasons: r.stop_reason ? [r.stop_reason] : undefined });
              return r;
            },
          );
        } catch (e) {
          return classifyLlmError(e, req.nodeId, {
            timedOut: t.timedOut(),
            callerAborted: turnCallerSignal?.aborted,
            timeoutMs: this.requestTimeoutMs,
            isAbortOverride: isAnthropicAbort,
          });
        } finally {
          t.cleanup();
        }

        const thinkingBlock = response.content.find((b) => b.type === "thinking");
        const thinking = thinkingBlock?.type === "thinking" ? thinkingBlock.thinking : undefined;

        messages.push({ role: "assistant", content: response.content });

        const toolCalls = parseToolCalls(response);
        const textContent = toolCalls.length === 0 ? lastTextBlock(response) : undefined;

        return ok({
          toolCalls,
          textContent,
          tokensIn: response.usage.input_tokens,
          tokensOut: response.usage.output_tokens,
          thinking,
        });
      },
      appendToolResults: (results) => {
        messages.push(buildToolResultMessage(results));
      },
    };

    return toolUseLoop(provider, {
      nodeId: req.nodeId,
      model: req.model,
      schema: req.schema,
      tools: req.tools,
      maxIterations,
      deadlineMs: req.deadlineMs,
      signal: req.signal,
    }, ctx);
  }
}
