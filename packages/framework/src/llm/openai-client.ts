import OpenAI from "openai";
import { z } from "zod";
import { ok, err } from "../types/result.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
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
import { withLlmSpan, setLlmUsageAttributes } from "./spans.js";

/**
 * Recursively adds `additionalProperties: false` to all object-type schemas.
 * Required by Azure OpenAI structured output (strict mode).
 * Zod v4's toJSONSchema already adds it at the top level but not always nested.
 */
function addAdditionalPropertiesFalse(schema: Record<string, unknown>): void {
  if (schema.type === "object" && schema.properties) {
    schema.additionalProperties = false;
    for (const prop of Object.values(schema.properties as Record<string, Record<string, unknown>>)) {
      if (prop && typeof prop === "object") {
        addAdditionalPropertiesFalse(prop);
      }
    }
  }
  if (schema.items && typeof schema.items === "object") {
    addAdditionalPropertiesFalse(schema.items as Record<string, unknown>);
  }
}

const buildJsonSchema = (schema: z.ZodType<any>): Record<string, unknown> => {
  const json = z.toJSONSchema(schema as any) as Record<string, unknown>;
  delete json.$schema;
  addAdditionalPropertiesFalse(json);
  return json;
};

const toolToOpenAiSpec = (tool: ToolDef<any, any>): Record<string, unknown> => ({
  type: "function",
  name: tool.name,
  description: tool.description,
  parameters: buildJsonSchema(tool.inputSchema as z.ZodType<any>),
  strict: false,
});

const toolChoiceToOpenAi = (
  choice: SendWithToolsRequest<any>["toolChoice"],
): string => {
  switch (choice) {
    case "any":
      return "required";
    case "none":
      return "none";
    case "auto":
    case undefined:
      return "auto";
  }
};

interface FunctionCallBlock {
  readonly type: "function_call";
  readonly id?: string;
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
}

const isFunctionCallBlock = (b: any): b is FunctionCallBlock =>
  b && typeof b === "object" && b.type === "function_call";

const parseToolCalls = (output: readonly any[]): ToolCall[] => {
  const calls: ToolCall[] = [];
  for (const block of output) {
    if (!isFunctionCallBlock(block)) continue;
    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(block.arguments || "{}");
    } catch {
      // Surface as unknown_input; dispatchToolCall will turn it into an is_error result.
      parsedInput = { __parse_error__: block.arguments };
    }
    calls.push({ id: block.call_id, name: block.name, input: parsedInput });
  }
  return calls;
};

const buildToolResultItems = (
  results: readonly ToolDispatchResult[],
): Array<Record<string, unknown>> =>
  results.map((r) => ({
    type: "function_call_output",
    call_id: r.id,
    output:
      typeof r.content === "string" ? r.content : JSON.stringify(r.content),
  }));

const extractFinalText = (output: readonly any[]): string | undefined => {
  for (let i = output.length - 1; i >= 0; i--) {
    const block = output[i];
    if (block?.type !== "message") continue;
    const textPart = block.content?.find((c: any) => c.type === "output_text");
    if (textPart?.text) return textPart.text;
  }
  return undefined;
};

const extractReasoning = (output: readonly any[]): string | undefined => {
  const block = output.find((b: any) => b?.type === "reasoning");
  if (!block?.summary?.length) return undefined;
  return block.summary.map((s: any) => s.text ?? s).join("\n");
};

/**
 * OpenAI LLM client using the Responses API (/openai/responses).
 * Works with all models (gpt-4o-mini, gpt-5-mini, gpt-5.2-codex) and
 * provides native reasoning support on capable models.
 */
export class OpenAILlmClient implements LlmClient {
  private readonly requestTimeoutMs: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiVersion: string | undefined;

  constructor(private readonly openai: OpenAI, opts?: { requestTimeoutMs?: number }) {
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 120_000;
    this.baseUrl = (openai as any).baseURL ?? (openai as any)._options?.baseURL ?? "";
    this.apiKey = (openai as any).apiKey ?? (openai as any)._options?.apiKey ?? "";
    this.apiVersion = (openai as any)._options?.defaultQuery?.["api-version"] ?? undefined;
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
  ): Promise<{ ok: true; response: any } | { ok: false; status: number; bodyText: string }> {
    const { url, headers } = this.buildRequestConfig();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const onCallerAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    let httpRes: Response;
    try {
      httpRes = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onCallerAbort);
    }

    if (!httpRes.ok) {
      const text = await httpRes.text();
      return { ok: false, status: httpRes.status, bodyText: text };
    }
    const response = await httpRes.json();
    return { ok: true, response };
  }

  async sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>> {
    try {
      const schema = buildJsonSchema(req.schema as z.ZodType<any>);

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

      const httpResult = await this.postResponses(body, req.signal);
      if (!httpResult.ok) {
        return err({
          kind: "node-crash",
          nodeId: req.model,
          message: `${httpResult.status} ${httpResult.bodyText}`,
        });
      }
      const response = httpResult.response;

      const messageBlock = response.output?.find((b: any) => b.type === "message");
      const textContent = messageBlock?.content?.find((c: any) => c.type === "output_text");
      const rawText = textContent?.text ?? "";

      if (!rawText) {
        return err({
          kind: "node-crash",
          nodeId: req.model,
          message: "Responses API returned no text output",
        });
      }

      const thinking = extractReasoning(response.output ?? []);

      let raw: unknown;
      try {
        raw = JSON.parse(rawText);
      } catch {
        return err({
          kind: "node-crash",
          nodeId: req.model,
          message: `Response was not valid JSON: ${rawText.slice(0, 200)}`,
        });
      }

      const parsed = req.schema.safeParse(raw);
      if (!parsed.success) {
        return err({
          kind: "node-crash",
          nodeId: req.model,
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
      return err({
        kind: "node-crash",
        nodeId: req.model,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
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
        nodeId: req.model,
        message: e instanceof Error ? e.message : String(e),
      });
    }

    const maxIterations = req.maxIterations ?? 10;
    const finalSchema = buildJsonSchema(req.schema as z.ZodType<any>);
    const toolSpecs = req.tools.map(toolToOpenAiSpec);
    const toolChoice = toolChoiceToOpenAi(req.toolChoice);

    const conversation: Array<Record<string, unknown>> = [
      { role: "developer", content: req.system },
      { role: "user", content: req.user },
    ];

    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let lastThinking: string | undefined;

    for (let turn = 0; turn < maxIterations; turn++) {
      if (req.signal?.aborted) {
        return err({ kind: "aborted", reason: "signal" });
      }

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

      const httpResult = await withLlmSpan(
        ctx.tracer ?? null,
        { provider: "openai", model: req.model, operation: "chat" },
        async () => {
          const r = await this.postResponses(body, req.signal);
          if (r.ok) {
            const tokensIn = r.response.usage?.input_tokens ?? 0;
            const tokensOut = r.response.usage?.output_tokens ?? 0;
            setLlmUsageAttributes(tokensIn, tokensOut);
          }
          return r;
        },
      );

      if (!httpResult.ok) {
        return err({
          kind: "node-crash",
          nodeId: req.model,
          message: `${httpResult.status} ${httpResult.bodyText}`,
        });
      }

      const response = httpResult.response;
      const output: any[] = response.output ?? [];
      totalTokensIn += response.usage?.input_tokens ?? 0;
      totalTokensOut += response.usage?.output_tokens ?? 0;
      const reasoning = extractReasoning(output);
      if (reasoning) lastThinking = reasoning;

      // Echo all output items into the conversation so subsequent turns see them.
      for (const item of output) conversation.push(item);

      const toolCalls = parseToolCalls(output);

      if (toolCalls.length === 0) {
        const text = extractFinalText(output);
        if (!text) {
          return err({
            kind: "node-crash",
            nodeId: req.model,
            message: "OpenAI final turn had no text output",
          });
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return err({
            kind: "node-crash",
            nodeId: req.model,
            message: `Final response was not valid JSON: ${text.slice(0, 200)}`,
          });
        }
        const validated = req.schema.safeParse(parsed);
        if (!validated.success) {
          return err({
            kind: "node-crash",
            nodeId: req.model,
            message: `Schema validation failed: ${validated.error.message}`,
          });
        }
        return ok({
          output: validated.data as O,
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          thinking: lastThinking,
          rawText: text,
        });
      }

      const results = await dispatchToolCallsWithSpans(toolCalls, req.tools, ctx);
      for (const item of buildToolResultItems(results)) conversation.push(item);
    }

    return err({
      kind: "transient",
      message: `Tool-call iteration limit (${maxIterations}) reached`,
    });
  }
}
