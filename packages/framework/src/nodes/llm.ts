import type { z } from "zod";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { LlmClient, LlmRequest } from "../llm/client.js";
import { type Result, ok, err } from "../types/result.js";
import { stableHash } from "../cache/hash.js";
import { enrichLlmSpan } from "../tracing/index.js";

export interface LlmNodeConfig<I, O> {
  readonly id: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly deps: readonly string[];
  readonly promptName: string;
  readonly model: string;
  readonly buildInput: (input: I) => Record<string, unknown>;
  /** When true, skip the LLM call and return `skipDefault` instead. */
  readonly skipWhen?: (input: I) => boolean;
  /** Value to return when `skipWhen` is true. Required if `skipWhen` is provided. */
  readonly skipDefault?: O;
  readonly computeCacheKey?: (input: I) => string;
  /** Enable reasoning/thinking for models that support it (e.g., GPT-5.1, o-series) */
  readonly thinking?: { type: "enabled"; budgetTokens: number };
}

/**
 * Interpolates {{placeholder}} variables in a prompt template.
 */
const interpolatePrompt = (template: string, vars: Record<string, unknown>): string =>
  Object.entries(vars).reduce(
    (t, [k, v]) => t.replaceAll(`{{${k}}}`, String(v ?? "")),
    template,
  );

export const createLlmNode = <I, O>(
  config: LlmNodeConfig<I, O>,
): NodeDef<I, O, FrameworkError> => ({
  id: config.id,
  kind: "llm",
  inputSchema: config.inputSchema,
  outputSchema: config.outputSchema,
  deps: config.deps as string[],
  run: async (input: I, ctx: NodeContext): Promise<Result<O, FrameworkError>> => {
    // Skip check — return explicit default value instead of undefined
    if (config.skipWhen?.(input)) {
      if (!("skipDefault" in config)) {
        return err({ kind: "validation" as const, nodeId: config.id, message: "skipWhen triggered but no skipDefault provided" });
      }
      return ok(config.skipDefault as O);
    }

    // Load prompt template
    if (!ctx.prompts?.get) {
      return err({ kind: "prompt-not-found", promptName: config.promptName, reason: "prompts not available on context" });
    }
    const promptTemplate = ctx.prompts.get(config.promptName);
    if (!promptTemplate) {
      return err({ kind: "prompt-not-found", promptName: config.promptName, reason: "prompt not registered" });
    }

    // Build interpolation vars and construct user message
    const vars = config.buildInput(input);
    const userMessage = interpolatePrompt(promptTemplate, vars);

    // Cache check
    const cacheKey = config.computeCacheKey?.(input) ?? `${config.id}:${stableHash(input)}`;
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

    // LLM call
    if (!ctx.llm?.sendStructured) {
      return err({ kind: "node-crash" as const, nodeId: config.id, message: "llm not available on context" });
    }

    const llmClient = ctx.llm as LlmClient;
    const req: LlmRequest<O> = {
      system: `You are an AI assistant. Follow the instructions in the user message and return structured output.`,
      user: userMessage,
      model: config.model,
      schema: config.outputSchema,
      ...(config.thinking ? { thinking: config.thinking } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    };

    const attempt = async () => {
      const result = await llmClient.sendStructured(req);
      if (!result.ok) return result;

      const parsed = config.outputSchema.safeParse(result.value.output);
      if (!parsed.success) {
        return err({
          kind: "validation" as const,
          nodeId: config.id,
          message: `LLM output validation failed: ${parsed.error.message}`,
        });
      }
      return ok(result.value);
    };

    // First attempt
    let result = await attempt();

    // FR-021: retry once on validation failure
    if (!result.ok && result.error.kind === "validation") {
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

    // Enrich active span
    enrichLlmSpan({
      model: config.model,
      promptName: config.promptName,
      system: req.system,
      user: userMessage,
      tokensIn: llmResponse.tokensIn,
      tokensOut: llmResponse.tokensOut,
      thinking: llmResponse.thinking,
    });

    const output = llmResponse.output as O;

    // Cache result (best-effort)
    if (ctx.cache?.set) {
      const DEFAULT_CACHE_TTL_SEC = 86400;
      try {
        await ctx.cache.set(cacheKey, output, DEFAULT_CACHE_TTL_SEC);
      } catch (e) {
        const msg = `[${config.id}] Cache write failed: ${e instanceof Error ? e.message : e}`;
        (ctx.logger?.warn ?? console.warn)(msg);
      }
    }

    return ok(output);
  },
});
