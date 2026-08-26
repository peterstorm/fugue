import type { z } from "zod";
import type { NodeDef } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import type {
  ConversationCachePolicy,
  LlmClient,
  SendWithToolsRequest,
  ToolDef,
} from "../types/llm.js";
import { type Result, ok } from "../types/result.js";
import { resourceName } from "../types/freshness.js";
import { stableHash } from "../shared/hash.js";
import { nodeId } from "../types/ids.js";
import { computePromptHash } from "../prompts/hash.js";
import { runLlmCallPipeline } from "./llm-pipeline.js";

/**
 * Configuration for `createLlmWithToolsNode` — mirrors `LlmNodeConfig` but for
 * tool-call-capable LLM calls. The factory owns:
 *
 * - prompt resolution from the registry (or inline `system`/`buildUser`),
 * - cache lookup keyed on prompt + model + input + tool-name fingerprint,
 * - the FR-021b single-shot validation retry (re-prompt on schema failure),
 * - GenAI semconv span enrichment (delegated to `LlmClient.sendWithTools`).
 */
/**
 * Discriminated pairing for `skipWhen` + `skipDefault` — supplying one without
 * the other is a compile error, not a runtime failure at first call.
 */
type LlmWithToolsSkipConfig<I, O> =
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
  /** Provider-specific reasoning/thinking configuration for clients that support it. */
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
  /**
   * Provider-side prompt caching. Opt-in: omitted ≡ `{ kind: "none" }` ≡ no
   * `cache_control` on the wire, so adding this field is the only thing that
   * can change what a DAG costs.
   *
   * A tool loop re-sends its system prompt, tool specs and whole accumulated
   * history on every turn, so `{ kind: "conversation", ttl: "5m" }` is the
   * usual choice here — it pays for itself from the second turn. Use
   * `static-prefix` when the loop reliably answers in one turn but the prefix
   * is shared across many calls.
   */
  readonly cache?: ConversationCachePolicy;
}

export type LlmWithToolsNodeConfig<I, O> =
  LlmWithToolsNodeConfigBase<I, O> & LlmWithToolsSkipConfig<I, O>;

/**
 * Tool-using LLM node. The optional `promptName` is exposed on the returned
 * `NodeDef` so describe/manifest tooling can introspect prompt references
 * without a `as unknown` cast.
 */
export type LlmWithToolsNodeDef<I, O> =
  NodeDef<I, O, FrameworkError, readonly ["llm"]> & {
    readonly id: NodeId;
    readonly promptName?: string;
  };

/**
 * Build a tool-call LLM node. The factory mirrors `createLlmNode` but routes
 * through `LlmClient.sendWithTools`, so the model can call registered tools
 * mid-completion before producing the final structured answer.
 */
export const createLlmWithToolsNode = <I, O>(
  config: LlmWithToolsNodeConfig<I, O>,
): LlmWithToolsNodeDef<I, O> => {
  const id = nodeId(config.id);
  return {
  id,
  kind: "llm",
  inputSchema: config.inputSchema,
  outputSchema: config.outputSchema,
  requires: ["llm"] as const,
  sideEffects: { kind: "external-call", resource: resourceName(`llm:${config.model}`) },
  confidence: { mode: "none" },
  ...(config.promptName !== undefined && { promptName: config.promptName }),
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
    // System prompt is the prompt SOURCE here (user message comes from
    // buildUser, so it is input, not template). Appended to the cache key by
    // the pipeline so a system-prompt edit invalidates custom cache keys too.
    const promptFingerprint = computePromptHash(systemPrompt);

    return runLlmCallPipeline(
      {
        nodeId: id,
        model: config.model,
        outputSchema: config.outputSchema,
        prompts: { system: systemPrompt, user: userMessage },
        cacheKey,
        disableValidationRetry: config.disableValidationRetry,
        promptName: config.promptName,
        promptFingerprint,
        thinking: config.thinking,
        cache: config.cache,
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
          ...(config.cache ? { cache: config.cache } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        };
        return llmClient.sendWithTools(req, ctx);
      },
      ctx,
    );
  },
};
};
