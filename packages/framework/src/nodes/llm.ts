import type { z } from "zod";
import type { NodeDef } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import type { LlmRequest } from "../types/llm.js";
import { type Result, ok, err } from "../types/result.js";
import { stableHash } from "../shared/hash.js";
import { nodeId } from "../types/ids.js";
import { runLlmCallPipeline } from "./llm-pipeline.js";

/**
 * Discriminated pairing for `skipWhen` + `skipDefault`. Supplying `skipWhen`
 * without `skipDefault` (or vice versa) is now a compile error rather than a
 * runtime `validation` error at first call.
 */
export type LlmSkipConfig<I, O> =
  | { readonly skipWhen?: undefined; readonly skipDefault?: undefined }
  | { readonly skipWhen: (input: I) => boolean; readonly skipDefault: O };

interface LlmNodeConfigBase<I, O> {
  readonly id: string;
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

export type LlmNodeConfig<I, O> =
  LlmNodeConfigBase<I, O> & LlmSkipConfig<I, O>;

/**
 * Interpolates {{placeholder}} variables in a prompt template.
 */
export const interpolatePrompt = (template: string, vars: Record<string, unknown>): string =>
  Object.entries(vars).reduce(
    (t, [k, v]) => t.replaceAll(`{{${k}}}`, String(v ?? "")),
    template,
  );

export const createLlmNode = <I, O>(
  config: LlmNodeConfig<I, O>,
): NodeDef<I, O, FrameworkError, readonly ["llm", "prompts"]> & { readonly id: NodeId } => {
  const id = nodeId(config.id);
  return {
  id,
  kind: "llm",
  inputSchema: config.inputSchema,
  outputSchema: config.outputSchema,
  requires: ["llm", "prompts"] as const,
  sideEffects: { kind: "external-call", resource: `llm:${config.model}` },
  confidence: { mode: "none" },
  run: async (input, ctx): Promise<Result<O, FrameworkError>> => {
    if (config.skipWhen?.(input)) {
      return ok(config.skipDefault as O);
    }

    // Load prompt template — ctx.prompts is guaranteed non-null by `requires`.
    const promptTemplate = ctx.prompts.get(config.promptName);
    if (!promptTemplate) {
      return err({ kind: "prompt-not-found", promptName: config.promptName, reason: "prompt not registered" });
    }

    const vars = config.buildInput(input);
    const userMessage = interpolatePrompt(promptTemplate, vars);
    const systemPrompt = config.system ?? "You are an AI assistant. Follow the instructions in the user message and return structured output.";
    const cacheKey = config.computeCacheKey?.(input) ?? `${config.id}:${stableHash(input)}`;

    return runLlmCallPipeline(
      {
        nodeId: id,
        model: config.model,
        outputSchema: config.outputSchema,
        prompts: { system: systemPrompt, user: userMessage },
        cacheKey,
        promptName: config.promptName,
        thinking: config.thinking,
      },
      () => {
        const req: LlmRequest<O> = {
          system: systemPrompt,
          user: userMessage,
          model: config.model,
          schema: config.outputSchema,
          nodeId: id,
          ...(config.thinking ? { thinking: config.thinking } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        };
        return ctx.llm.sendStructured(req);
      },
      ctx,
    );
  },
};
};
