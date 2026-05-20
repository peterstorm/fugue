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
import { fwLogger } from "../logger.js";
import { withLlmSpan, setLlmUsageAttributes, setLlmResponseAttributes } from "./spans.js";
import { zodToJsonSchema } from "./zod-schema.js";
import { classifyLlmError } from "./llm-errors.js";
import { createTimeoutSignal } from "./with-timeout.js";
import { toolUseLoop } from "./tool-use-loop.js";
import type {
  FunctionCallBlock,
  MessageBlock,
  ReasoningBlock,
  ResponsesOutputItem,
  FunctionCallOutputItem,
  ConversationItem,
  ResponsesApiResponse,
} from "./openai-types.js";
import {
  isFunctionCallBlock,
  isMessageBlock,
  isOutputTextPart,
  isReasoningBlock,
  parseToolCalls,
  buildToolResultItems,
  extractFinalText,
  extractReasoning,
} from "./openai-types.js";

/**
 * Pure recursive transform: adds `additionalProperties: false` to all
 * object-type schemas. Required by Azure OpenAI structured output (strict
 * mode). Returns a new object — the input is never mutated.
 */
function withAdditionalPropertiesFalse(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema };
  if (result.type === "object" && result.properties) {
    result.additionalProperties = false;
    result.properties = Object.fromEntries(
      Object.entries(result.properties as Record<string, Record<string, unknown>>)
        .map(([k, v]) => [k, v && typeof v === "object" ? withAdditionalPropertiesFalse(v) : v]),
    );
  }
  if (result.items && typeof result.items === "object") {
    result.items = withAdditionalPropertiesFalse(result.items as Record<string, unknown>);
  }
  // Handle composition keywords (anyOf, oneOf, allOf) — Zod v4 renders
  // z.union, z.discriminatedUnion, z.optional as these.
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(result[key])) {
      result[key] = (result[key] as Record<string, unknown>[]).map(withAdditionalPropertiesFalse);
    }
  }
  // Handle $defs / definitions (shared schema references)
  for (const key of ["$defs", "definitions"] as const) {
    if (result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = Object.fromEntries(
        Object.entries(result[key] as Record<string, Record<string, unknown>>)
          .map(([k, v]) => [k, v && typeof v === "object" ? withAdditionalPropertiesFalse(v) : v]),
      );
    }
  }
  return result;
}

/** Safely truncate API error body to prevent data leakage through error propagation paths. */
const truncateErrorBody = (body: string, maxLen = 200): string =>
  body.length > maxLen ? body.slice(0, maxLen) + "…[truncated]" : body;

const buildJsonSchema = (schema: z.ZodType<any>): Record<string, unknown> => {
  const json = zodToJsonSchema(schema);
  return withAdditionalPropertiesFalse(json);
};

const toolToOpenAiSpec = (tool: ToolDef<any, any>): Record<string, unknown> => ({
  type: "function",
  name: tool.name,
  description: tool.description,
  parameters: buildJsonSchema(tool.inputSchema as z.ZodType<any>),
  strict: false,
});

import { match } from "ts-pattern";

const toolChoiceToOpenAi = (
  choice: SendWithToolsRequest<any>["toolChoice"],
): string =>
  match(choice)
    .with("any", () => "required")
    .with("none", () => "none")
    .with("auto", () => "auto")
    .with(undefined, () => "auto")
    .exhaustive();


/**
 * OpenAI LLM client using the Responses API (/openai/responses).
 *
 * Validated against gpt-4o-mini and gpt-5-mini. Other OpenAI models work but
 * require a `PRICE_TABLE` entry in `llm/cost.ts` for cost attribution to fire.
 */
export interface OpenAILlmClientOpts {
  /** API key sent on every request (Authorization header for OpenAI, `api-key` header for Azure). */
  readonly apiKey: string;
  /**
   * Base URL of the OpenAI-compatible endpoint, without a trailing `/responses`
   * segment. Examples:
   *   - OpenAI: `"https://api.openai.com/v1"`
   *   - Azure:  `"https://my-resource.openai.azure.com/openai/deployments/<deployment>"`
   * Azure deployments require `apiVersion`.
   */
  readonly baseUrl: string;
  /** Azure-only: when set, the request URL uses `api-version=` and `api-key` auth. */
  readonly apiVersion?: string;
  /** Per-request timeout in ms. Default 120s. */
  readonly requestTimeoutMs?: number;
}

export class OpenAILlmClient implements LlmClient {
  private readonly requestTimeoutMs: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiVersion: string | undefined;

  constructor(opts: OpenAILlmClientOpts) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.apiVersion = opts.apiVersion;
  }

  private buildRequestConfig(): { url: string; headers: Record<string, string> } {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url: string;
    if (this.apiVersion) {
      const base = this.baseUrl.replace(/\/openai(\/deployments\/[^/]+)?$/, "");
      url = `${base}/openai/responses?api-version=${this.apiVersion}`;
      headers["api-key"] = this.apiKey;
    } else {
      url = `${this.baseUrl}/responses`;
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return { url, headers };
  }

  private async postResponses(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<
    | { ok: true; response: ResponsesApiResponse }
    | { ok: false; status: number; bodyText: string }
  > {
    const { url, headers } = this.buildRequestConfig();
    const t = createTimeoutSignal(this.requestTimeoutMs, signal);

    let httpRes: Response;
    try {
      httpRes = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: t.signal,
      });
    } catch (e) {
      // Distinguish caller-cancellation from timeout. Both surface as
      // AbortError at the fetch boundary; tag the timeout so the outer
      // handler can classify it as transient.
      //
      // Priority when both timeout and caller-signal fire simultaneously:
      // - t.timedOut() && !signal?.aborted → transient (retriable)
      // - signal?.aborted → aborted (caller cancelled)
      // Whichever AbortSignal fires first wins at fetch level; our
      // timedOut() flag disambiguates after the fact.
      if (e instanceof Error && e.name === "AbortError" && t.timedOut() && !signal?.aborted) {
        throw new Error(`request timed out after ${this.requestTimeoutMs}ms`, { cause: "timeout" });
      }
      throw e;
    } finally {
      t.cleanup();
    }

    if (!httpRes.ok) {
      const text = await httpRes.text();
      return { ok: false, status: httpRes.status, bodyText: text };
    }
    const response = (await httpRes.json()) as ResponsesApiResponse;
    return { ok: true, response };
  }

  async sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>> {
    // Pre-flight: schema construction is deterministic — non-retriable on failure
    let schema: Record<string, unknown>;
    try {
      schema = buildJsonSchema(req.schema as z.ZodType<any>);
    } catch (e) {
      return err({
        kind: "validation",
        nodeId: req.nodeId,
        message: `Schema construction failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    try {
      const body: Record<string, unknown> = {
        model: req.model,
        input: [
          { role: "developer", content: req.system },
          { role: "user", content: req.user },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "structured_output",
            strict: true,
            schema,
          },
        },
      };

      if (req.thinking?.type === "enabled") {
        body.reasoning = { effort: "high", summary: "auto" };
      }

      const httpResult = await withLlmSpan(
        req.tracer ?? null,
        { provider: "openai", model: req.model, operation: "chat" },
        async () => {
          const r = await this.postResponses(body, req.signal);
          if (r.ok) {
            const tIn = r.response.usage?.input_tokens ?? 0;
            const tOut = r.response.usage?.output_tokens ?? 0;
            setLlmUsageAttributes(tIn, tOut);
            setLlmResponseAttributes({
              model: r.response.model,
              id: r.response.id,
              finishReasons: r.response.status ? [r.response.status] : undefined,
            });
          }
          return r;
        },
      );
      if (!httpResult.ok) {
        if (httpResult.status === 429) {
          return err({
            kind: "transient",
            nodeId: req.nodeId,
            message: `HTTP ${httpResult.status}: ${truncateErrorBody(httpResult.bodyText)}`,
          });
        }
        // Non-429 4xx (401/403/422/...) is a deterministic client error —
        // retrying burns the budget without changing the outcome.
        if (httpResult.status >= 400 && httpResult.status < 500) {
          return err({
            kind: "node-crash",
            retriability: "non-retriable",
            nodeId: req.nodeId,
            message: `HTTP ${httpResult.status}: ${truncateErrorBody(httpResult.bodyText)}`,
          });
        }
        return err({
          kind: "node-crash",
          retriability: "retriable",
          nodeId: req.nodeId,
          message: `HTTP ${httpResult.status}: ${truncateErrorBody(httpResult.bodyText)}`,
        });
      }
      const response = httpResult.response;
      const output = response.output ?? [];

      const messageBlock = output.find(isMessageBlock);
      const textPart = messageBlock?.content.find(isOutputTextPart);
      const rawText = textPart?.text ?? "";

      if (!rawText) {
        return err({
          kind: "node-crash",
          retriability: "retriable",
          nodeId: req.nodeId,
          message: "Responses API returned no text output",
        });
      }

      const thinking = extractReasoning(response.output ?? []);

      let raw: unknown;
      try {
        raw = JSON.parse(rawText);
      } catch (parseErr) {
        const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        return err({
          kind: "node-crash",
          retriability: "retriable",
          nodeId: req.nodeId,
          message: `Not valid JSON (${parseMsg}): ${rawText.slice(0, 200)}`,
        });
      }

      const parsed = req.schema.safeParse(raw);
      if (!parsed.success) {
        return err({
          kind: "node-crash",
          retriability: "retriable",
          nodeId: req.nodeId,
          message: `Schema validation failed: ${parsed.error.message}`,
        });
      }

      const tokensIn = response.usage?.input_tokens ?? 0;
      const tokensOut = response.usage?.output_tokens ?? 0;

      return ok({
        output: parsed.data as O,
        tokensIn,
        tokensOut,
        thinking,
        rawText,
      });
    } catch (error) {
      return classifyLlmError(error, req.nodeId, {
        timeoutMs: this.requestTimeoutMs,
        callerAborted: req.signal?.aborted,
      });
    }
  }

  async sendWithTools<O>(
    req: SendWithToolsRequest<O>,
    ctx: NodeContext,
  ): Promise<Result<LlmResponse<O>, FrameworkError>> {
    const maxIterations = req.maxIterations ?? 10;
    const finalSchema = buildJsonSchema(req.schema as z.ZodType<any>);
    const toolSpecs = req.tools.map(toolToOpenAiSpec);
    const toolChoice = toolChoiceToOpenAi(req.toolChoice);

    const conversation: ConversationItem[] = [
      { role: "developer", content: req.system },
      { role: "user", content: req.user },
    ];

    const provider: import("./tool-use-loop.js").ToolLoopProvider = {
      call: async (_turn: number) => {
        const body: Record<string, unknown> = {
          model: req.model,
          input: conversation,
          tools: toolSpecs,
          tool_choice: toolChoice,
          text: {
            format: {
              type: "json_schema",
              name: "structured_output",
              strict: true,
              schema: finalSchema,
            },
          },
        };

        if (req.thinking?.type === "enabled") {
          body.reasoning = { effort: "high", summary: "auto" };
        }

        let httpResult: Awaited<ReturnType<typeof this.postResponses>>;
        try {
          httpResult = await withLlmSpan(
            ctx.tracer ?? null,
            { provider: "openai", model: req.model, operation: "chat" },
            async () => {
              const r = await this.postResponses(body, req.signal ?? ctx.signal);
              if (r.ok) {
                const tokensIn = r.response.usage?.input_tokens ?? 0;
                const tokensOut = r.response.usage?.output_tokens ?? 0;
                setLlmUsageAttributes(tokensIn, tokensOut);
                setLlmResponseAttributes({
                  model: r.response.model,
                  id: r.response.id,
                  finishReasons: r.response.status ? [r.response.status] : undefined,
                });
              }
              return r;
            },
          );
        } catch (error) {
          return classifyLlmError(error, req.nodeId, {
            timeoutMs: this.requestTimeoutMs,
            callerAborted: (req.signal ?? ctx.signal)?.aborted,
          });
        }

        if (!httpResult.ok) {
          if (httpResult.status === 429) {
            return err({
              kind: "transient",
              nodeId: req.nodeId,
              message: `HTTP ${httpResult.status}: ${truncateErrorBody(httpResult.bodyText)}`,
            });
          }
          // Non-429 4xx (401/403/422/...) is a deterministic client error —
          // retrying burns the budget without changing the outcome.
          if (httpResult.status >= 400 && httpResult.status < 500) {
            return err({
              kind: "node-crash",
              retriability: "non-retriable",
              nodeId: req.nodeId,
              message: `HTTP ${httpResult.status}: ${truncateErrorBody(httpResult.bodyText)}`,
            });
          }
          return err({
            kind: "node-crash",
            retriability: "retriable",
            nodeId: req.nodeId,
            message: `HTTP ${httpResult.status}: ${truncateErrorBody(httpResult.bodyText)}`,
          });
        }

        const response = httpResult.response;
        const output: readonly ResponsesOutputItem[] = response.output ?? [];
        const tokensIn = response.usage?.input_tokens ?? 0;
        const tokensOut = response.usage?.output_tokens ?? 0;
        const reasoning = extractReasoning(output);

        // Echo all output items into the conversation
        for (const item of output) conversation.push(item);

        const toolCalls = parseToolCalls(output);
        const textContent = toolCalls.length === 0 ? extractFinalText(output) : undefined;

        return ok({
          toolCalls,
          textContent,
          tokensIn,
          tokensOut,
          thinking: reasoning,
        });
      },
      appendToolResults: (results) => {
        for (const item of buildToolResultItems(results)) conversation.push(item);
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
