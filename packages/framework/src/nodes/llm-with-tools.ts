import type { z } from "zod";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { LlmClient, SendWithToolsRequest } from "../llm/client.js";
import type { ToolDef } from "../llm/tools.js";
import { type Result, ok, err } from "../types/result.js";
import { stableHash } from "../cache/hash.js";
import { enrichLlmSpan } from "../tracing/index.js";

/**
 * Configuration for `createLlmWithToolsNode` — mirrors `LlmNodeConfig` but for
 * tool-call-capable LLM calls. The factory owns:
 *
 * - prompt resolution from the registry (or inline `system`/`buildUser`),
 * - cache lookup keyed on prompt + model + input + tool-name fingerprint,
 * - the FR-021 single-shot validation retry,
 * - GenAI semconv span enrichment (delegated to `LlmClient.sendWithTools`).
 */
export interface LlmWithToolsNodeConfig<I, O, Id extends string = string> {
  readonly id: Id;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly model: string;
  readonly tools: readonly ToolDef<unknown, unknown>[];
  /** Tool-choice hint forwarded to the LLM client. */
  readonly toolChoice?: SendWithToolsRequest<O>["toolChoice"];
  /** Cap on tool-use turns. Default 10. */
  readonly maxIterations?: number;
  /** Anthropic-only extended thinking; ignored by other providers. */
  readonly thinking?: { type: "enabled"; budgetTokens: number };
  /**
   * Inline system prompt. Used when `promptName` is omitted, or as a fallback
   * if the prompt registry doesn't carry a system entry.
   */
  readonly system?: string;
  /**
   * Optional registry-backed prompt name. When supplied, the factory loads the
   * `<promptName>` (user template) and `<promptName>-system` (system frame) at
   * call time via `ctx.prompts`. Falls back to `system`/`buildUser` when the
   * registry doesn't have an entry.
   */
  readonly promptName?: string;
  /** Build the user message from the validated input. */
  readonly buildUser: (input: I) => string;
  /** When true, skip the LLM call and return `skipDefault` instead. */
  readonly skipWhen?: (input: I) => boolean;
  readonly skipDefault?: O;
  /** Override the cache key. Default: `<id>:<stableHash(input)>`. */
  readonly computeCacheKey?: (input: I) => string;
  /** Disable the FR-021 validation retry. Default `false` (one retry). */
  readonly disableValidationRetry?: boolean;
}

/**
 * Build a tool-call LLM node. The factory mirrors `createLlmNode` but routes
 * through `LlmClient.sendWithTools`, so the model can call registered tools
 * mid-completion before producing the final structured answer.
 */
export const createLlmWithToolsNode = <I, O, const Id extends string = string>(
  config: LlmWithToolsNodeConfig<I, O, Id>,
): NodeDef<I, O, FrameworkError> & { readonly id: Id } => ({
  id: config.id,
  kind: "llm",
  inputSchema: config.inputSchema,
  outputSchema: config.outputSchema,
  run: async (input: I, ctx: NodeContext): Promise<Result<O, FrameworkError>> => {
    if (config.skipWhen?.(input)) {
      if (!("skipDefault" in config)) {
        return err({
          kind: "validation" as const,
          nodeId: config.id,
          message: "skipWhen triggered but no skipDefault provided",
        });
      }
      return ok(config.skipDefault as O);
    }

    if (!ctx.llm?.sendWithTools) {
      return err({
        kind: "node-crash" as const,
        nodeId: config.id,
        message: "llm.sendWithTools not available on context",
      });
    }

    // Resolve system + user prompts. Registry takes precedence; fall back to
    // inline configuration when entries are missing.
    let systemPrompt = config.system ?? "";
    if (config.promptName && ctx.prompts?.get) {
      const registrySystem = ctx.prompts.get(`${config.promptName}-system`);
      if (registrySystem) systemPrompt = registrySystem;
    }
    if (!systemPrompt) {
      systemPrompt =
        "You are an AI assistant. Use the registered tools as needed and return structured output.";
    }

    const userMessage = config.buildUser(input);

    // Cache check — keyed on prompt + model + input + tool-names so any of
    // those changing invalidates the entry.
    const toolNamesHash = stableHash(config.tools.map((t) => t.name).slice().sort());
    const cacheKey =
      config.computeCacheKey?.(input) ??
      `${config.id}:${stableHash({
        system: systemPrompt,
        user: userMessage,
        model: config.model,
        toolNamesHash,
        input,
      })}`;
    if (ctx.cache?.get) {
      try {
        const cached = await ctx.cache.get(cacheKey);
        if (cached !== undefined && cached !== null) {
          return ok(cached as O);
        }
      } catch (e) {
        const msg = `[${config.id}] Cache read failed: ${e instanceof Error ? e.message : e}`;
        (ctx.logger?.warn ?? console.warn)(msg);
      }
    }

    const llmClient = ctx.llm as LlmClient;
    const req: SendWithToolsRequest<O> = {
      system: systemPrompt,
      user: userMessage,
      model: config.model,
      tools: config.tools,
      schema: config.outputSchema,
      maxIterations: config.maxIterations,
      toolChoice: config.toolChoice,
      nodeId: config.id,
      ...(config.thinking ? { thinking: config.thinking } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    };

    const attempt = async () => {
      const result = await llmClient.sendWithTools(req, {
        tracer: ctx.tracer ?? null,
        signal: ctx.signal,
      });
      if (!result.ok) return result;
      const parsed = config.outputSchema.safeParse(result.value.output);
      if (!parsed.success) {
        return err({
          kind: "validation" as const,
          nodeId: config.id,
          message: `LLM tool-call output validation failed: ${parsed.error.message}`,
        });
      }
      return ok(result.value);
    };

    let result = await attempt();

    if (
      !result.ok &&
      result.error.kind === "validation" &&
      !config.disableValidationRetry
    ) {
      result = await attempt();
      if (!result.ok) {
        return err({
          kind: "retry-exhausted" as const,
          nodeId: config.id,
          attempts: 2,
          lastError: "message" in result.error ? result.error.message : String(result.error),
        });
      }
    }

    if (!result.ok) return result;
    const llmResponse = result.value;

    enrichLlmSpan({
      model: config.model,
      promptName: config.promptName,
      system: systemPrompt,
      user: userMessage,
      tokensIn: llmResponse.tokensIn,
      tokensOut: llmResponse.tokensOut,
      thinking: llmResponse.thinking,
      includeContent: ctx.includeContent ?? false,
    });

    const output = llmResponse.output as O;

    if (ctx.cache?.set) {
      const DEFAULT_CACHE_TTL_SEC = 86400;
      try {
        const setResult = await ctx.cache.set(cacheKey, output, DEFAULT_CACHE_TTL_SEC);
        if (!setResult.ok) {
          const msg = `[${config.id}] Cache write failed: ${setResult.error.kind === "cache-error" ? setResult.error.message : String(setResult.error)}`;
          (ctx.logger?.warn ?? console.warn)(msg);
        }
      } catch (e) {
        const msg = `[${config.id}] Cache write threw: ${e instanceof Error ? e.message : e}`;
        (ctx.logger?.warn ?? console.warn)(msg);
      }
    }

    return ok(output);
  },
});
