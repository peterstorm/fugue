import type { z } from "zod";
import type { NodeDef } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { LlmClient, LlmRequest } from "../llm/client.js";
import { type Result, ok, err } from "../types/result.js";
import { stableHash } from "../cache/hash.js";
import { enrichLlmSpan } from "../tracing/index.js";

/**
 * Discriminated pairing for `skipWhen` + `skipDefault`. Supplying `skipWhen`
 * without `skipDefault` (or vice versa) is now a compile error rather than a
 * runtime `validation` error at first call.
 */
export type LlmSkipConfig<I, O> =
  | { readonly skipWhen?: undefined; readonly skipDefault?: undefined }
  | { readonly skipWhen: (input: I) => boolean; readonly skipDefault: O };

interface LlmNodeConfigBase<I, O, Id extends string = string> {
  readonly id: Id;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly promptName: string;
  readonly model: string;
  readonly buildInput: (input: I) => Record<string, unknown>;
  readonly computeCacheKey?: (input: I) => string;
  /** Enable reasoning/thinking for models that support it (e.g., GPT-5.1, o-series) */
  readonly thinking?: { type: "enabled"; budgetTokens: number };
  /**
   * Override the system prompt. When omitted, a generic default ("You are an
   * AI assistant…") is used. Pass a domain-specific persona/frame here so the
   * user-template prompt can stay focused on the task input.
   */
  readonly system?: string;
}

export type LlmNodeConfig<I, O, Id extends string = string> =
  LlmNodeConfigBase<I, O, Id> & LlmSkipConfig<I, O>;

/**
 * Interpolates {{placeholder}} variables in a prompt template.
 */
const interpolatePrompt = (template: string, vars: Record<string, unknown>): string =>
  Object.entries(vars).reduce(
    (t, [k, v]) => t.replaceAll(`{{${k}}}`, String(v ?? "")),
    template,
  );

export const createLlmNode = <I, O, const Id extends string = string>(
  config: LlmNodeConfig<I, O, Id>,
): NodeDef<I, O, FrameworkError, readonly ["llm", "prompts"]> & { readonly id: Id } => ({
  id: config.id,
  kind: "llm",
  inputSchema: config.inputSchema,
  outputSchema: config.outputSchema,
  requires: ["llm", "prompts"] as const,
  run: async (input, ctx): Promise<Result<O, FrameworkError>> => {
    // Skip check — the discriminated `LlmSkipConfig` makes `skipDefault`
    // statically present whenever `skipWhen` is provided, so no runtime
    // validation hedge is needed.
    if (config.skipWhen?.(input)) {
      return ok(config.skipDefault as O);
    }

    // Load prompt template — ctx.prompts is guaranteed non-null by `requires`.
    const promptTemplate = ctx.prompts.get(config.promptName);
    if (!promptTemplate) {
      return err({ kind: "prompt-not-found", promptName: config.promptName, reason: "prompt not registered" });
    }

    // Build interpolation vars and construct user message
    const vars = config.buildInput(input);
    const userMessage = interpolatePrompt(promptTemplate, vars);

    // Cache check — cache stays opt-in (not in `requires`), so null-check
    // remains here. A wired cache that throws is treated as a miss.
    const cacheKey = config.computeCacheKey?.(input) ?? `${config.id}:${stableHash(input)}`;
    if (ctx.cache) {
      try {
        const lookup = await ctx.cache.get(cacheKey);
        if (lookup.hit) {
          return ok(lookup.value as O);
        }
      } catch (e) {
        ctx.logger.warn(`[${config.id}] Cache read failed: ${e instanceof Error ? e.message : e}`);
      }
    }

    // ctx.llm is guaranteed non-null by `requires`.
    const llmClient: LlmClient = ctx.llm;
    const req: LlmRequest<O> = {
      system: config.system ?? `You are an AI assistant. Follow the instructions in the user message and return structured output.`,
      user: userMessage,
      model: config.model,
      schema: config.outputSchema,
      nodeId: config.id,
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
          rootErrorKind: result.error.kind,
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
      includeContent: ctx.includeContent ?? false,
    });

    const output = llmResponse.output as O;

    // Cache result (best-effort) — failures must never break a successful run.
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
