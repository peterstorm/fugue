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
import {
  dispatchToolCallsWithSpans,
  type ToolCall,
  type ToolDispatchResult,
} from "./tool-dispatch.js";
import { fwLogger } from "../logger.js";
import { withLlmSpan, setLlmUsageAttributes, setLlmResponseAttributes } from "./spans.js";
import { zodToJsonSchema, withAdditionalPropertiesFalse } from "./zod-schema.js";
import {
  classifyLlmError,
  httpFailureToError,
  truncateErrorBody,
  validateTemperature,
} from "./llm-errors.js";
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

const buildJsonSchema = (schema: z.ZodType<any>): Record<string, unknown> => {
  const json = zodToJsonSchema(schema);
  return withAdditionalPropertiesFalse(json);
};

/**
 * Classify a `response.status === "failed"` Responses body. The API populates
 * `error.code` / `error.message` on this arm; without an explicit check it
 * would sail past the `incomplete` short-circuit into the generic no-text /
 * malformed-success arm as a retriable node-crash, losing the provider's
 * stated reason and retrying a deterministic failure. Retriability is derived
 * from the code: `rate_limit_exceeded` → transient, `server_error` → retriable
 * node-crash, any other code (invalid_prompt, content policy, …) →
 * non-retriable. The turn's usage — threaded by callers only when the failed
 * body actually reports one ("absent means no attributable tokens", see
 * types/errors.ts) — rides along on EVERY arm so a failed turn's burned
 * tokens never escape budget accounting (FR-W0-001).
 */
function responseFailedError(
  response: ResponsesApiResponse,
  nodeId: NodeId,
  usage?: { readonly tokensIn: number; readonly tokensOut: number },
): Result<never, FrameworkError> {
  const code = response.error?.code;
  const detail = truncateErrorBody(response.error?.message ?? JSON.stringify(response));
  const message = `Responses API failed (response.status: failed${code ? `, error.code: ${code}` : ""}): ${detail}`;
  if (code === "rate_limit_exceeded") {
    return err({ kind: "transient", nodeId, message, ...(usage ? { usage } : {}) });
  }
  const retriability = code === "server_error" ? ("retriable" as const) : ("non-retriable" as const);
  return err({ kind: "node-crash", retriability, nodeId, message, ...(usage ? { usage } : {}) });
}

/**
 * Annotation for `response.status === "incomplete"` messages. Names the API's
 * stated reason (`incomplete_details.reason`) when present, so the two
 * truncation causes (`max_output_tokens` vs `content_filter`) are
 * distinguishable from the error message alone — mirrors how `error.code`
 * is surfaced on the failed arm.
 */
const incompleteDetail = (response: ResponsesApiResponse): string =>
  `response.status: incomplete${
    response.incomplete_details?.reason ? `, reason: ${response.incomplete_details.reason}` : ""
  }`;

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


/** Constructor options for {@link OpenAILlmClient}. */
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
  /**
   * When set, overrides the model field in every request body.
   * Used for Azure deployments where all requests route to a single model.
   */
  readonly modelOverride?: string;
}

/**
 * OpenAI LLM client using the Responses API (`POST {baseUrl}/responses`;
 * Azure: `{base}/openai/responses?api-version=…` — see `buildRequestConfig`).
 *
 * Validated against gpt-4o-mini and gpt-5-mini. Other OpenAI models work but
 * require a `PRICE_TABLE` entry in `llm/cost.ts` for cost attribution to fire.
 */
export class OpenAILlmClient implements LlmClient {
  private readonly requestTimeoutMs: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiVersion: string | undefined;
  private readonly modelOverride: string | undefined;

  constructor(opts: OpenAILlmClientOpts) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.apiVersion = opts.apiVersion;
    this.modelOverride = opts.modelOverride;
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
    // A 200 whose body is not JSON (proxy interstitial, HTML error page)
    // must not escape as a raw SyntaxError from `.json()` — fold it into the
    // same failure shape as a non-OK status, so the typed error carries
    // `HTTP 200` plus the (truncated) body snapshot.
    const text = await httpRes.text();
    try {
      return { ok: true, response: JSON.parse(text) as ResponsesApiResponse };
    } catch {
      return { ok: false, status: httpRes.status, bodyText: text };
    }
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

    // Pre-flight: an out-of-range/non-finite temperature is a deterministic
    // caller error — typed validation failure before anything reaches the wire.
    const temperatureError = validateTemperature(req.temperature, req.nodeId);
    if (temperatureError !== null) return temperatureError;

    // Pre-flight: reasoning models reject `temperature` alongside `reasoning`
    // with an opaque HTTP 400. That combination is a deterministic caller
    // error — surface it as a typed validation failure at the seam rather
    // than letting the wire round-trip crash the node (and never silently
    // drop the caller's temperature).
    if (req.thinking?.type === "enabled" && req.temperature !== undefined) {
      return err({
        kind: "validation",
        nodeId: req.nodeId,
        message:
          "temperature cannot be combined with thinking (OpenAI reasoning models reject the pair) — unset one of them",
      });
    }

    try {
      const body: Record<string, unknown> = {
        model: this.modelOverride ?? req.model,
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

      if (req.temperature !== undefined) {
        body.temperature = req.temperature;
      }

      const httpResult = await withLlmSpan(
        req.tracer ?? null,
        { provider: "openai", model: this.modelOverride ?? req.model, operation: "chat" },
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
        // The shared 429/4xx/5xx policy — see `httpFailureToError`.
        return httpFailureToError(httpResult.status, httpResult.bodyText, req.nodeId);
      }
      const response = httpResult.response;
      const output = response.output ?? [];

      // `response.status === "failed"` carries the API's own error.code /
      // error.message — classify it explicitly (retriability derived from the
      // code) rather than letting it fall through to the generic no-text arm
      // as a blindly-retriable crash that discards the stated reason.
      if (response.status === "failed") {
        // Usage is threaded only when the failed body actually reports it —
        // "absent means no attributable tokens" (types/errors.ts); stamping
        // a fabricated `{0, 0}` would make that state representable two ways.
        return responseFailedError(
          response,
          req.nodeId,
          response.usage
            ? {
                tokensIn: response.usage.input_tokens ?? 0,
                tokensOut: response.usage.output_tokens ?? 0,
              }
            : undefined,
        );
      }

      // `response.status === "incomplete"` means the output was TRUNCATED or
      // filtered (see `incomplete_details.reason`: `max_output_tokens` vs
      // `content_filter`) — deterministic either way, so a retry of the
      // identical request reproduces the identical incomplete result. Hence a
      // non-retriable failure on every arm below (mirrors the Anthropic
      // stop_reason max_tokens treatment).
      const truncated = response.status === "incomplete";
      const retriability = truncated ? ("non-retriable" as const) : ("retriable" as const);

      const messageBlock = output.find(isMessageBlock);
      const textPart = messageBlock?.content.find(isOutputTextPart);
      const rawText = textPart?.text ?? "";

      if (!rawText) {
        // A 200 whose body carries no message/output_text is a malformed
        // success — snapshot what the API actually sent (status + truncated
        // body) so the failure is debuggable from this error alone.
        return err({
          kind: "node-crash",
          retriability,
          nodeId: req.nodeId,
          message: `Responses API returned no text output (response.status: ${response.status ?? "unknown"}): ${truncateErrorBody(JSON.stringify(response))}`,
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
          retriability,
          nodeId: req.nodeId,
          message: `Not valid JSON (${parseMsg})${truncated ? ` (${incompleteDetail(response)})` : ""}: ${rawText.slice(0, 200)}`,
        });
      }

      const parsed = req.schema.safeParse(raw);
      if (!parsed.success) {
        return err({
          kind: "node-crash",
          retriability,
          nodeId: req.nodeId,
          message: `Schema validation failed${truncated ? ` (${incompleteDetail(response)})` : ""}: ${parsed.error.message}`,
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
    // Pre-flight: schema/tool-spec construction (zodToJsonSchema) is
    // deterministic — a throw here must stay inside the Result boundary as a
    // typed non-retriable validation error (mirrors sendStructured).
    let finalSchema: Record<string, unknown>;
    let toolSpecs: Record<string, unknown>[];
    try {
      finalSchema = buildJsonSchema(req.schema as z.ZodType<any>);
      toolSpecs = req.tools.map(toolToOpenAiSpec);
    } catch (e) {
      return err({
        kind: "validation",
        nodeId: req.nodeId,
        message: `Schema construction failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    const toolChoice = toolChoiceToOpenAi(req.toolChoice);

    const conversation: ConversationItem[] = [
      { role: "developer", content: req.system },
      { role: "user", content: req.user },
    ];

    const provider: import("./tool-use-loop.js").ToolLoopProvider = {
      call: async (_turn: number) => {
        const body: Record<string, unknown> = {
          model: this.modelOverride ?? req.model,
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
            { provider: "openai", model: this.modelOverride ?? req.model, operation: "chat" },
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
          // The shared 429/4xx/5xx policy — see `httpFailureToError`.
          return httpFailureToError(httpResult.status, httpResult.bodyText, req.nodeId);
        }

        const response = httpResult.response;
        const output: readonly ResponsesOutputItem[] = response.output ?? [];
        const tokensIn = response.usage?.input_tokens ?? 0;
        const tokensOut = response.usage?.output_tokens ?? 0;

        // `response.status === "failed"` carries the API's own error.code /
        // error.message — classify it explicitly (retriability from the code)
        // instead of letting the empty output fall through to the loop's
        // context-free "no text content to parse" retriable arm.
        if (response.status === "failed") {
          // Usage only when the failed body reports it — see the
          // sendStructured arm for the "absent means no attributable
          // tokens" contract.
          return responseFailedError(
            response,
            req.nodeId,
            response.usage ? { tokensIn, tokensOut } : undefined,
          );
        }

        // `response.status === "incomplete"` means this turn's output was
        // TRUNCATED or filtered (see `incomplete_details.reason`:
        // `max_output_tokens` vs `content_filter`) — the tool calls / final
        // answer are unreliable and, deterministic either way, retrying the
        // identical request reproduces the identical incomplete result. Hence
        // a non-retriable failure (mirrors the Anthropic stop_reason max_tokens
        // treatment). The turn's own usage rides along so the loop still
        // attributes the burned tokens.
        if (response.status === "incomplete") {
          return err({
            kind: "node-crash",
            retriability: "non-retriable",
            nodeId: req.nodeId,
            message: `Responses API returned an incomplete (truncated) response (${incompleteDetail(response)}): ${truncateErrorBody(JSON.stringify(response))}`,
            usage: { tokensIn, tokensOut },
          });
        }

        const reasoning = extractReasoning(output);

        // Echo all output items into the conversation
        for (const item of output) conversation.push(item);

        const toolCalls = parseToolCalls(output);
        const textContent = toolCalls.length === 0 ? extractFinalText(output) : undefined;

        // A terminal turn with neither tool calls nor text is a malformed
        // success. The failed/incomplete statuses short-circuit above; every
        // RESIDUAL status (cancelled, queued, …) would otherwise hand
        // `textContent: undefined` to the loop's context-free "no text
        // content to parse" arm, losing the status. Mirror sendStructured's
        // no-text arm: name the status and snapshot the (truncated) body so
        // the unknown terminal state is diagnosable from the error alone.
        // Classification is unchanged — retriable, like the arm it replaces.
        if (toolCalls.length === 0 && textContent === undefined) {
          return err({
            kind: "node-crash",
            retriability: "retriable",
            nodeId: req.nodeId,
            message: `Responses API returned no tool calls and no text output (response.status: ${response.status ?? "unknown"}): ${truncateErrorBody(JSON.stringify(response))}`,
            ...(response.usage ? { usage: { tokensIn, tokensOut } } : {}),
          });
        }

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
      model: this.modelOverride ?? req.model,
      schema: req.schema,
      tools: req.tools,
      maxIterations,
      deadlineMs: req.deadlineMs,
      signal: req.signal,
    }, ctx);
  }
}
