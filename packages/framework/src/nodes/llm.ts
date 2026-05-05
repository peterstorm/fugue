import type { z } from "zod";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { LlmClient, LlmRequest } from "../llm/client.js";
import { type Result, ok, err } from "../types/result.js";
import { computeCostUsd } from "../llm/cost.js";
import { stableHash } from "../cache/hash.js";

// Lazy-load @mlflow/core for span enrichment
let _getCurrentActiveSpan: (() => any) | null = null;
const loadMlflow = async () => {
  if (_getCurrentActiveSpan) return;
  try {
    const mlflow = await import("@mlflow/core");
    _getCurrentActiveSpan = mlflow.getCurrentActiveSpan;
  } catch (e: any) {
    const code = e?.code;
    if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") {
      console.warn(`[llm] @mlflow/core import failed unexpectedly: ${e?.message}`);
    }
  }
};

export interface LlmNodeConfig<I, O> {
  readonly id: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly deps: readonly string[];
  readonly promptName: string;
  readonly model: string;
  readonly buildInput: (input: I) => Record<string, unknown>;
  readonly skipWhen?: (input: I) => boolean;
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
    await loadMlflow();

    // Skip check
    if (config.skipWhen?.(input)) {
      return ok(undefined as unknown as O);
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

    // Cache check — ctx.cache.get() returns the raw value or null
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

    // LLM call — uses LlmClient.sendStructured with correct shape
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
    };

    const attempt = async () => {
      const result = await llmClient.sendStructured(req);
      if (!result.ok) return result;

      // Validate output against schema (LLM may return non-conforming data)
      const parsed = config.outputSchema.safeParse(result.value.output);
      if (!parsed.success) {
        return err({
          kind: "validation" as const,
          nodeId: config.id,
          message: `LLM output validation failed: ${parsed.error.message}`,
        });
      }
      // Return full LlmResponse so we can extract tokens/thinking for span enrichment
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

    // Enrich active OTel span with LLM details (prompt, tokens, cost, thinking)
    if (_getCurrentActiveSpan) {
      const span = _getCurrentActiveSpan();
      if (span && typeof span.setAttribute === "function") {
        // Override executor's generic setInputs with LLM-specific prompt details
        span.setInputs({
          model: config.model,
          prompt_name: config.promptName,
          system_prompt: req.system,
          user_prompt: userMessage,
        });
        // Use MLflow's expected attribute for token usage (renders in UI)
        span.setAttribute("mlflow.chat.tokenUsage", {
          input_tokens: llmResponse.tokensIn,
          output_tokens: llmResponse.tokensOut,
          total_tokens: llmResponse.tokensIn + llmResponse.tokensOut,
        });
        // Custom attributes for filtering/cost tracking
        span.setAttribute("llm.model", config.model);
        span.setAttribute("llm.tokens_in", llmResponse.tokensIn);
        span.setAttribute("llm.tokens_out", llmResponse.tokensOut);
        span.setAttribute("cost_usd", computeCostUsd(config.model, llmResponse.tokensIn, llmResponse.tokensOut));
        if (llmResponse.thinking) {
          span.setAttribute("llm.thinking", llmResponse.thinking);
        }
      }
    }

    const output = llmResponse.output as O;

    // Cache result (best-effort — failure is non-fatal)
    if (ctx.cache?.set) {
      const DEFAULT_CACHE_TTL_SEC = 86400; // 24 hours, matching FR-052
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
