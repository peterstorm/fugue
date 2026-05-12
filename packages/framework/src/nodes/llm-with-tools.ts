import type { z } from "zod";
import type { NodeDef } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { LlmClient, SendWithToolsRequest, ToolDef } from "../types/llm.js";
import { type Result, ok, err } from "../types/result.js";
import { stableHash } from "../cache/hash.js";
import { enrichLlmSpan } from "../tracing/index.js";
import { __brandNodeId } from "../types/ids.js";
import type { NodeId } from "../types/ids.js";

/**
 * Configuration for `createLlmWithToolsNode` — mirrors `LlmNodeConfig` but for
 * tool-call-capable LLM calls. The factory owns:
 *
 * - prompt resolution from the registry (or inline `system`/`buildUser`),
 * - cache lookup keyed on prompt + model + input + tool-name fingerprint,
 * - the FR-021 single-shot validation retry,
 * - GenAI semconv span enrichment (delegated to `LlmClient.sendWithTools`).
 */
/**
 * Discriminated pairing for `skipWhen` + `skipDefault` — supplying one without
 * the other is a compile error, not a runtime failure at first call.
 */
export type LlmWithToolsSkipConfig<I, O> =
  | { readonly skipWhen?: undefined; readonly skipDefault?: undefined }
  | { readonly skipWhen: (input: I) => boolean; readonly skipDefault: O };

interface LlmWithToolsNodeConfigBase<I, O, Id extends string = string> {
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
  /** Override the cache key. Default: `<id>:<stableHash(input)>`. */
  readonly computeCacheKey?: (input: I) => string;
  /** Disable the FR-021 validation retry. Default `false` (one retry). */
  readonly disableValidationRetry?: boolean;
}

export type LlmWithToolsNodeConfig<I, O, Id extends string = string> =
  LlmWithToolsNodeConfigBase<I, O, Id> & LlmWithToolsSkipConfig<I, O>;

/**
 * Build a tool-call LLM node. The factory mirrors `createLlmNode` but routes
 * through `LlmClient.sendWithTools`, so the model can call registered tools
 * mid-completion before producing the final structured answer.
 */
export const createLlmWithToolsNode = <I, O, const Id extends string = string>(
  config: LlmWithToolsNodeConfig<I, O, Id>,
): NodeDef<I, O, FrameworkError, readonly ["llm"]> & { readonly id: Id & NodeId } => ({
  id: __brandNodeId(config.id) as Id & NodeId,
  kind: "llm",
  inputSchema: config.inputSchema,
  outputSchema: config.outputSchema,
  requires: ["llm"] as const,
  run: async (input, ctx): Promise<Result<O, FrameworkError>> => {
    // Skip check — discriminated `LlmWithToolsSkipConfig` guarantees
    // `skipDefault` is present whenever `skipWhen` is set.
    if (config.skipWhen?.(input)) {
      return ok(config.skipDefault as O);
    }

    // ctx.llm guaranteed non-null by `requires`. `sendWithTools` is still a
    // method-shape concern (some clients implement send-only) — leave that
    // runtime check on the LlmClient surface.
    const llmClient: LlmClient = ctx.llm;
    if (!llmClient.sendWithTools) {
      return err({
        kind: "node-crash" as const,
        nodeId: config.id,
        retriability: "non-retriable" as const,
        message: "llm.sendWithTools not available on context",
      });
    }

    // Resolve system + user prompts. Registry (when present) takes
    // precedence; fall back to inline configuration when the registry entry
    // is missing. `prompts` is opt-in (not in `requires`), so null-check it.
    let systemPrompt = config.system ?? "";
    if (config.promptName && ctx.prompts) {
      const registrySystem = ctx.prompts.get(`${config.promptName}-system`);
      if (registrySystem) systemPrompt = registrySystem;
    }
    if (!systemPrompt) {
      systemPrompt =
        "You are an AI assistant. Use the registered tools as needed and return structured output.";
    }

    const userMessage = config.buildUser(input);

    // Cache check — keyed on prompt + model + input + tool-names so any of
    // those changing invalidates the entry. Cache is opt-in.
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
    if (ctx.cache) {
      try {
        const lookup = await ctx.cache.get(cacheKey);
        if (lookup.hit) {
          return ok(lookup.value as O);
        }
      } catch (e) {
        ctx.logger.warn(`[${config.id}] Cache read failed (cacheKey=${cacheKey}): ${e instanceof Error ? e.message : e}`);
      }
    }

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
      const result = await llmClient.sendWithTools!(req, ctx);
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
          rootErrorKind: result.error.kind,
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

    if (ctx.cache) {
      const DEFAULT_CACHE_TTL_SEC = 86400;
      try {
        const setResult = await ctx.cache.set(cacheKey, output, DEFAULT_CACHE_TTL_SEC);
        if (!setResult.ok) {
          ctx.logger.warn(
            `[${config.id}] Cache write failed: ${setResult.error.kind === "cache-error" ? setResult.error.message : String(setResult.error)}`,
          );
        }
      } catch (e) {
        ctx.logger.warn(`[${config.id}] Cache write threw: ${e instanceof Error ? e.message : e}`);
      }
    }

    return ok(output);
  },
});
