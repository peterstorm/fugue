import type { z } from "zod";
import type { NodeDef } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import type { LlmRequest, SingleShotCachePolicy } from "../types/llm.js";
import { type Result, ok, err } from "../types/result.js";
import { resourceName } from "../types/freshness.js";
import { stableHash } from "../shared/hash.js";
import { nodeId } from "../types/ids.js";
import { computePromptHash } from "../prompts/hash.js";
import { runLlmCallPipeline } from "./llm-pipeline.js";

/**
 * Discriminated pairing for `skipWhen` + `skipDefault`. Supplying `skipWhen`
 * without `skipDefault` (or vice versa) is now a compile error rather than a
 * runtime `validation` error at first call.
 */
type LlmSkipConfig<I, O> =
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
  /**
   * Provider-side prompt caching. Opt-in: omitted ≡ `{ kind: "none" }` ≡ no
   * `cache_control` on the wire, so adding this field is the only thing that
   * can change what a DAG costs.
   *
   * `{ kind: "static-prefix", ttl: "5m" }` caches the system prompt and tool
   * spec shared by every call to this node; the per-input user message renders
   * after the breakpoint and stays uncached. Worth it when the node runs
   * repeatedly within the TTL and the shared prefix clears the model's minimum
   * cacheable size — a single call over a large unique prefix pays the write
   * premium and never reads it back.
   */
  readonly cache?: SingleShotCachePolicy;
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

/**
 * LLM node with its prompt name exposed as a typed field on the returned
 * `NodeDef`. The extra `promptName` field lets describe/manifest tooling
 * introspect prompt references without a `as unknown` cast.
 */
export type LlmNodeDef<I, O> =
  NodeDef<I, O, FrameworkError, readonly ["llm", "prompts"]> & {
    readonly id: NodeId;
    readonly promptName: string;
  };

export const createLlmNode = <I, O>(
  config: LlmNodeConfig<I, O>,
): LlmNodeDef<I, O> => {
  const id = nodeId(config.id);
  return {
  id,
  kind: "llm",
  inputSchema: config.inputSchema,
  outputSchema: config.outputSchema,
  requires: ["llm", "prompts"] as const,
  sideEffects: { kind: "external-call", resource: resourceName(`llm:${config.model}`) },
  confidence: { mode: "none" },
  promptName: config.promptName,
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
    // Fingerprint the prompt SOURCES (system + un-interpolated template), not
    // the final message — custom cache keys keep their semantics, but a prompt
    // edit always invalidates (the pipeline appends this to the cache key).
    const promptFingerprint = computePromptHash(`${systemPrompt}\u0000${promptTemplate}`);

    return runLlmCallPipeline(
      {
        nodeId: id,
        model: config.model,
        outputSchema: config.outputSchema,
        prompts: { system: systemPrompt, user: userMessage },
        cacheKey,
        promptName: config.promptName,
        promptFingerprint,
        thinking: config.thinking,
        cache: config.cache,
      },
      () => {
        const req: LlmRequest<O> = {
          system: systemPrompt,
          user: userMessage,
          model: config.model,
          schema: config.outputSchema,
          nodeId: id,
          ...(config.thinking ? { thinking: config.thinking } : {}),
          ...(config.cache ? { cache: config.cache } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        };
        return ctx.llm.sendStructured(req);
      },
      ctx,
    );
  },
};
};
