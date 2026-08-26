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
import { match } from "ts-pattern";
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
import type { TokenUsage } from "../types/token-usage.js";
import type { ToolCall, ToolDispatchResult } from "./tool-dispatch.js";
import { planPromptCache, type PromptCachePlan } from "./prompt-cache.js";
import { zodToJsonSchema } from "./zod-schema.js";
import {
  withLlmSpan,
  setLlmUsageAttributes,
  setLlmRequestAttributes,
  setLlmResponseAttributes,
} from "./spans.js";
import { classifyLlmError, truncateErrorBody, validateTemperature } from "./llm-errors.js";
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
): Anthropic.ToolChoice | undefined =>
  match(choice)
    .with("any", () => ({ type: "any" }) as const)
    .with("none", () => ({ type: "none" }) as const)
    .with("auto", undefined, () => ({ type: "auto" }) as const)
    .exhaustive();

/**
 * The `cache_control` value a plan's breakpoints carry, or `undefined` when the
 * plan emits none. A 5-minute entry is the provider's default and omits `ttl`;
 * a 1-hour entry names it explicitly.
 */
const cacheControlOf = (plan: PromptCachePlan): Anthropic.CacheControlEphemeral | undefined =>
  match(plan.ttl)
    .with(null, () => undefined)
    // 5 minutes is the provider default, expressed by OMITTING `ttl` — sending
    // it explicitly would be a different request body for no benefit.
    .with("5m", () => ({ type: "ephemeral" }) as const)
    .with("1h", () => ({ type: "ephemeral", ttl: "1h" }) as const)
    .exhaustive();

/**
 * Render the system prompt, carrying the prefix breakpoint when the plan asks
 * for one.
 *
 * Without caching the system prompt stays a bare string — byte-identical to the
 * pre-caching request (FR-PC-004). With caching it becomes a single text block
 * so `cache_control` has somewhere to live; because the provider renders
 * `tools → system → messages`, that one breakpoint caches the tool specs too
 * (FR-PC-002).
 */
const systemParamFor = (
  system: string,
  plan: PromptCachePlan,
): Anthropic.MessageCreateParams["system"] => {
  const cacheControl = plan.systemBreakpoint ? cacheControlOf(plan) : undefined;
  return cacheControl === undefined
    ? system
    : [{ type: "text", text: system, cache_control: cacheControl }];
};

/**
 * Normalise an Anthropic `usage` block into the framework's `TokenUsage`.
 *
 * Anthropic reports `input_tokens` as the UNCACHED REMAINDER — cached prompt
 * tokens are excluded from it and reported separately. Summing all three is
 * what keeps `tokensIn` the complete prompt count across providers (FR-PC-005),
 * and is why enabling a cache policy cannot silently shrink a run's metered
 * token total.
 */
const anthropicUsage = (usage: AnthropicResponse["usage"]): TokenUsage => {
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  return {
    tokensIn: usage.input_tokens + cacheWriteTokens + cacheReadTokens,
    tokensOut: usage.output_tokens,
    cacheWriteTokens,
    cacheReadTokens,
  };
};

/**
 * Render the message history with a rolling breakpoint on its final content
 * block, for a `conversation` plan.
 *
 * The annotation is a RENDERING concern, applied to a copy on the way to the
 * wire — the accumulated history itself never carries `cache_control`. That is
 * what makes the breakpoint rolling without a "strip the previous one" step,
 * and keeps the emitted count at exactly one no matter how long the loop runs
 * (FR-PC-003, INV-PC-5). Without a plan this is the identity function, so the
 * request stays byte-identical to the pre-caching one.
 */
const withTurnBreakpoint = (
  messages: readonly AnthropicMessage[],
  cacheControl: Anthropic.CacheControlEphemeral | undefined,
): readonly AnthropicMessage[] => {
  if (cacheControl === undefined) return messages;
  const lastMessage = messages[messages.length - 1];
  if (lastMessage === undefined) return messages;

  // A bare-string content is the first user turn; promote it to a single text
  // block so the breakpoint has somewhere to attach.
  const blocks: Anthropic.ContentBlockParam[] =
    typeof lastMessage.content === "string"
      ? [{ type: "text", text: lastMessage.content }]
      : [...lastMessage.content];

  const lastBlock = blocks[blocks.length - 1];
  // Two blocks cannot carry a breakpoint: an absent one (empty content array),
  // and a thinking block — the provider rejects `cache_control` on thinking and
  // redacted_thinking, which is why the SDK's union excludes it there. Skipping
  // the turn annotation is the honest outcome in both cases: the system-prefix
  // breakpoint still stands, and a chain that never forms surfaces as an inert
  // policy (FR-PC-009) rather than as a 400 or as silence.
  if (
    lastBlock === undefined ||
    lastBlock.type === "thinking" ||
    lastBlock.type === "redacted_thinking"
  ) {
    return messages;
  }

  blocks[blocks.length - 1] = { ...lastBlock, cache_control: cacheControl };
  return [...messages.slice(0, -1), { ...lastMessage, content: blocks }];
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

      // The per-call user message renders after the system block, so a prefix
      // breakpoint never traps volatile content behind it (rule 3 in
      // `prompt-cache.ts`) — this holds by construction, not by convention.
      const plan = planPromptCache(req.cache);

      const params: Anthropic.MessageCreateParams = {
        model: req.model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        system: systemParamFor(req.system, plan),
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
          setLlmUsageAttributes(anthropicUsage(r.usage));
          setLlmResponseAttributes({ model: r.model, id: r.id });
          return r;
        },
      );

      const thinkingBlock = response.content.find((b) => b.type === "thinking");
      const thinking = thinkingBlock?.type === "thinking" ? thinkingBlock.thinking : undefined;

      // `stop_reason === "max_tokens"` means the output was TRUNCATED at the
      // fixed ANTHROPIC_MAX_TOKENS cap — retrying the identical request hits
      // the identical cap, so it is a deterministic (non-retriable) failure.
      // `stop_reason === "refusal"` is likewise deterministic — the model
      // declined and would decline the identical request again. Every other
      // stop_reason on these arms is retriable (non-deterministic) model
      // behavior.
      const truncated = response.stop_reason === "max_tokens";
      const nonRetriable = truncated || response.stop_reason === "refusal";
      const retriability = nonRetriable ? ("non-retriable" as const) : ("retriable" as const);

      // The turn's usage rides along on both terminal error arms below so a
      // malformed success / schema failure still attributes the burned tokens
      // (FR-W0-001, extended to cached tokens by FR-PC-006) — mirrors the
      // sendWithTools arms.
      const usage = anthropicUsage(response.usage);

      const toolUseBlock = response.content.find((b) => b.type === "tool_use");
      if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
        return err({
          kind: "node-crash",
          retriability,
          nodeId: req.nodeId,
          message: `Anthropic response did not contain a tool_use block (stop_reason: ${response.stop_reason ?? "unknown"}): ${truncateErrorBody(JSON.stringify(response.content))}`,
          usage,
        });
      }

      const parsed = req.schema.safeParse(toolUseBlock.input);
      if (!parsed.success) {
        return err({
          kind: "node-crash",
          retriability,
          nodeId: req.nodeId,
          message: `Schema validation failed (stop_reason: ${response.stop_reason ?? "unknown"}): ${parsed.error.message}`,
          usage,
        });
      }

      const rawText = JSON.stringify(toolUseBlock.input);

      return ok({
        output: parsed.data as O,
        ...usage,
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
    const plan = planPromptCache(req.cache);
    const systemParam = systemParamFor(system, plan);
    const turnCacheControl = plan.turnBreakpoint ? cacheControlOf(plan) : undefined;

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
                {
                  model: req.model,
                  max_tokens: ANTHROPIC_MAX_TOKENS,
                  system: systemParam,
                  messages: [...withTurnBreakpoint(messages, turnCacheControl)],
                  tools: toolSpecs,
                  tool_choice: toolChoice,
                },
                { signal: t.signal },
              );
              setLlmUsageAttributes(anthropicUsage(r.usage));
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

        // `stop_reason === "max_tokens"` means this turn's output was
        // TRUNCATED at the fixed ANTHROPIC_MAX_TOKENS cap — the tool calls /
        // final answer are unreliable and retrying the identical request hits
        // the identical cap, so it is a deterministic (non-retriable) failure
        // (mirrors sendStructured). The turn's own usage rides along so the
        // loop still attributes the burned tokens (FR-W0-001).
        if (response.stop_reason === "max_tokens") {
          return err({
            kind: "node-crash",
            retriability: "non-retriable",
            nodeId: req.nodeId,
            message: `Anthropic response truncated at the ${ANTHROPIC_MAX_TOKENS}-token cap (stop_reason: max_tokens)`,
            usage: anthropicUsage(response.usage),
          });
        }

        // `stop_reason === "refusal"` — the model declined to generate (e.g.
        // safety). There is no tool_use or text block, so without this arm the
        // turn falls through to the loop's context-free "no text content to
        // parse" retriable arm, losing the stop_reason and blindly retrying a
        // deterministic refusal. Non-retriable; the turn's usage rides along.
        if (response.stop_reason === "refusal") {
          return err({
            kind: "node-crash",
            retriability: "non-retriable",
            nodeId: req.nodeId,
            message: `Anthropic declined to generate a response (stop_reason: refusal)`,
            usage: anthropicUsage(response.usage),
          });
        }

        const thinkingBlock = response.content.find((b) => b.type === "thinking");
        const thinking = thinkingBlock?.type === "thinking" ? thinkingBlock.thinking : undefined;

        messages.push({ role: "assistant", content: response.content });

        const toolCalls = parseToolCalls(response);
        const textContent = toolCalls.length === 0 ? lastTextBlock(response) : undefined;

        // A terminal turn with neither tool_use nor text is a malformed
        // success. max_tokens / refusal short-circuit above; every RESIDUAL
        // stop_reason (pause_turn, …) would otherwise hand `textContent:
        // undefined` to the loop's context-free "no text content to parse"
        // arm, losing the stop_reason. Name it and snapshot the (truncated)
        // content so the unknown terminal state is diagnosable from the
        // error alone (mirrors the OpenAI client's residual-status arm).
        // Classification is unchanged — retriable, like the arm it replaces.
        if (toolCalls.length === 0 && textContent === undefined) {
          return err({
            kind: "node-crash",
            retriability: "retriable",
            nodeId: req.nodeId,
            message: `Anthropic response contained no tool_use and no text block (stop_reason: ${response.stop_reason ?? "unknown"}): ${truncateErrorBody(JSON.stringify(response.content))}`,
            usage: anthropicUsage(response.usage),
          });
        }

        return ok({
          toolCalls,
          textContent,
          ...anthropicUsage(response.usage),
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
