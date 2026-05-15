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
import { fwLogger } from "../logger.js";
import { withLlmSpan, setLlmUsageAttributes, setLlmResponseAttributes } from "./spans.js";
import { zodToJsonSchema } from "./zod-schema.js";

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
  const json = zodToJsonSchema(schema);
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

// ---------------------------------------------------------------------------
// Responses API output shapes
//
// The OpenAI Responses API returns `output: ResponsesOutputItem[]`. The SDK's
// exported types do not (yet) cover every variant we consume — define local
// discriminated unions for the shapes we read, with structural guards. New
// item types coming back from the API surface as `unknown` and are skipped
// by the guards rather than being silently misinterpreted via `any`.
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

type ResponsesOutputItem =
  | FunctionCallBlock
  | MessageBlock
  | ReasoningBlock
  | { readonly type: string };

interface ResponsesUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
}

interface ResponsesApiResponse {
  readonly id?: string;
  readonly model?: string;
  readonly status?: string;
  readonly output?: readonly ResponsesOutputItem[];
  readonly usage?: ResponsesUsage;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object";

const isFunctionCallBlock = (b: unknown): b is FunctionCallBlock =>
  isObject(b) &&
  b.type === "function_call" &&
  typeof b.call_id === "string" &&
  typeof b.name === "string" &&
  typeof b.arguments === "string";

const isMessageBlock = (b: unknown): b is MessageBlock =>
  isObject(b) && b.type === "message" && Array.isArray(b.content);

const isOutputTextPart = (c: unknown): c is OutputTextPart =>
  isObject(c) && c.type === "output_text" && typeof c.text === "string";

const isReasoningBlock = (b: unknown): b is ReasoningBlock =>
  isObject(b) && b.type === "reasoning" && Array.isArray(b.summary);

const parseToolCalls = (output: readonly ResponsesOutputItem[]): ToolCall[] => {
  const calls: ToolCall[] = [];
  for (const block of output) {
    if (!isFunctionCallBlock(block)) continue;
    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(block.arguments || "{}");
    } catch (parseErr) {
      // Surface as unknown_input; dispatchToolCall will turn it into an is_error result.
      fwLogger().warn(`[openai-client] Failed to parse tool-call arguments for '${block.name}': ${parseErr instanceof Error ? parseErr.message : parseErr}`);
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

const extractFinalText = (
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

const extractReasoning = (
  output: readonly ResponsesOutputItem[],
): string | undefined => {
  const block = output.find(isReasoningBlock);
  if (!block || block.summary.length === 0) return undefined;
  return block.summary.map((s) => s.text ?? "").join("\n");
};

const isAbort = (e: unknown): boolean =>
  e instanceof Error && e.name === "AbortError";

/**
 * Detect a timeout-induced error thrown by `postResponses`. Uses standard
 * `Error.cause` (set to `"timeout"`) rather than a WeakSet — survives error
 * wrapping and polyfill environments that may create fresh Error objects.
 */
const isTimeoutError = (e: unknown): boolean =>
  e instanceof Error && (e as { cause?: unknown }).cause === "timeout";

/** Duck-typed 429 detection (see anthropic-client.ts for rationale). */
const isRateLimit = (e: unknown): boolean =>
  typeof (e as { status?: unknown })?.status === "number" &&
  (e as { status: number }).status === 429;

const resolveNodeId = (req: { readonly nodeId: NodeId }): NodeId =>
  req.nodeId;

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
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
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
    } catch (e) {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onCallerAbort);
      // Distinguish caller-cancellation (caller's `signal.aborted`) from a
      // request that timed out on our side. Both surface as AbortError at the
      // fetch boundary; without the tag the outer handler routes both to
      // `{ kind: "aborted" }` and a transient timeout looks like a user cancel.
      if (e instanceof Error && e.name === "AbortError" && timedOut && !signal?.aborted) {
        throw new Error(`request timed out after ${this.requestTimeoutMs}ms`, { cause: "timeout" });
      }
      throw e;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onCallerAbort);
    }

    if (!httpRes.ok) {
      const text = await httpRes.text();
      return { ok: false, status: httpRes.status, bodyText: text };
    }
    const response = (await httpRes.json()) as ResponsesApiResponse;
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
            nodeId: resolveNodeId(req),
            message: `${httpResult.status} ${httpResult.bodyText}`,
          });
        }
        return err({
          kind: "node-crash",
          retriability: "retriable",
          nodeId: resolveNodeId(req),
          message: `${httpResult.status} ${httpResult.bodyText}`,
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
          nodeId: resolveNodeId(req),
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
          nodeId: resolveNodeId(req),
          message: `Not valid JSON (${parseMsg}): ${rawText.slice(0, 200)}`,
        });
      }

      const parsed = req.schema.safeParse(raw);
      if (!parsed.success) {
        return err({
          kind: "node-crash",
          retriability: "retriable",
          nodeId: resolveNodeId(req),
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
      if (isTimeoutError(error)) {
        return err({
          kind: "transient",
          nodeId: resolveNodeId(req),
          message: `request timed out after ${this.requestTimeoutMs}ms`,
        });
      }
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
        retriability: "retriable",
        nodeId: resolveNodeId(req),
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
        nodeId: resolveNodeId(req),
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
      if (req.signal?.aborted || ctx.signal?.aborted) {
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
        if (isTimeoutError(error)) {
          return err({
            kind: "transient",
            nodeId: resolveNodeId(req),
            message: `request timed out after ${this.requestTimeoutMs}ms`,
          });
        }
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
          retriability: "retriable",
          nodeId: resolveNodeId(req),
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }

      if (!httpResult.ok) {
        if (httpResult.status === 429) {
          return err({
            kind: "transient",
            nodeId: resolveNodeId(req),
            message: `${httpResult.status} ${httpResult.bodyText}`,
          });
        }
        return err({
          kind: "node-crash",
          retriability: "retriable",
          nodeId: resolveNodeId(req),
          message: `${httpResult.status} ${httpResult.bodyText}`,
        });
      }

      const response = httpResult.response;
      const output: readonly ResponsesOutputItem[] = response.output ?? [];
      totalTokensIn += response.usage?.input_tokens ?? 0;
      totalTokensOut += response.usage?.output_tokens ?? 0;
      const reasoning = extractReasoning(output);
      if (reasoning) lastThinking = reasoning;

      // Echo all output items into the conversation so subsequent turns see
      // them. The cast to Record<string, unknown> is a boundary widening —
      // the conversation array carries items of varying shapes that the API
      // expects as opaque JSON-encoded objects.
      for (const item of output) conversation.push(item as Record<string, unknown>);

      const toolCalls = parseToolCalls(output);

      if (toolCalls.length === 0) {
        const text = extractFinalText(output);
        if (!text) {
          return err({
            kind: "node-crash",
            retriability: "retriable",
            nodeId: resolveNodeId(req),
            message: "OpenAI final turn had no text output",
          });
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
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
          rawText: text,
        });
      }

      const results = await dispatchToolCallsWithSpans(toolCalls, req.tools, ctx, { model: req.model });
      for (const item of buildToolResultItems(results)) conversation.push(item);
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
