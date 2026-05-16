import type { z } from "zod";
import type { NodeDef } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import type { LlmClient, SendWithToolsRequest, ToolDef } from "../types/llm.js";
import { type Result, ok, err } from "../types/result.js";
import { stableHash } from "../shared/hash.js";
import { __brandNodeId } from "../types/ids.js";
import { runLlmCallPipeline } from "./llm-pipeline.js";

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

interface LlmWithToolsNodeConfigBase<I, O> {
  readonly id: string;
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

export type LlmWithToolsNodeConfig<I, O> =
  LlmWithToolsNodeConfigBase<I, O> & LlmWithToolsSkipConfig<I, O>;

/**
 * Build a tool-call LLM node. The factory mirrors `createLlmNode` but routes
 * through `LlmClient.sendWithTools`, so the model can call registered tools
 * mid-completion before producing the final structured answer.
 */
export const createLlmWithToolsNode = <I, O>(
  config: LlmWithToolsNodeConfig<I, O>,
): NodeDef<I, O, FrameworkError, readonly ["llm"]> & { readonly id: NodeId } => {
  const id = __brandNodeId(config.id);
  return {
  id,
  kind: "llm",
  inputSchema: config.inputSchema,
  outputSchema: config.outputSchema,
  requires: ["llm"] as const,
  sideEffects: { kind: "external-call", resource: `llm:${config.model}` },
  confidence: { mode: "none" },
  run: async (input, ctx): Promise<Result<O, FrameworkError>> => {
    if (config.skipWhen?.(input)) {
      return ok(config.skipDefault as O);
    }

    const llmClient: LlmClient = ctx.llm;

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

    return runLlmCallPipeline(
      {
        nodeId: id,
        model: config.model,
        outputSchema: config.outputSchema,
        prompts: { system: systemPrompt, user: userMessage },
        cacheKey,
        disableValidationRetry: config.disableValidationRetry,
        promptName: config.promptName,
        thinking: config.thinking,
      },
      () => {
        const req: SendWithToolsRequest<O> = {
          system: systemPrompt,
          user: userMessage,
          model: config.model,
          tools: config.tools,
          schema: config.outputSchema,
          maxIterations: config.maxIterations,
          toolChoice: config.toolChoice,
          nodeId: id,
          ...(config.thinking ? { thinking: config.thinking } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        };
        return llmClient.sendWithTools!(req, ctx);
      },
      ctx,
    );
  },
};
};
