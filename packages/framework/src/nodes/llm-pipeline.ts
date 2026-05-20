// llm-pipeline — shared LLM call pipeline (cache → call → validate+retry → enrich → cache-write).
//
// Deep module: callers learn one function; the pipeline hides cache error
// handling, validation retry (FR-021), span enrichment, and cache-write
// best-effort semantics behind a single invocation.
//
// The call strategy seam (`callFn`) is a function parameter — `sendStructured`
// and `sendWithTools` have different request shapes; the pipeline doesn't care
// which. It passes the resolved prompts and receives a Result<LlmResponse>.

import type { z } from "zod";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import type { LlmResponse } from "../types/llm.js";
import type { NodeContext } from "../types/node.js";
import { type Result, ok, err } from "../types/result.js";
import { enrichLlmSpan } from "../tracing/index.js";
import { formatFrameworkError } from "../types/errors.js";

const DEFAULT_CACHE_TTL_SEC = 86400;

export interface LlmPipelineConfig<O> {
  readonly nodeId: NodeId;
  readonly model: string;
  readonly outputSchema: z.ZodType<O>;
  readonly prompts: { readonly system: string; readonly user: string };
  readonly cacheKey: string;
  readonly disableValidationRetry?: boolean;
  readonly promptName?: string;
  readonly thinking?: { type: "enabled"; budgetTokens: number };
}

/**
 * The call-strategy seam. Invoked with no arguments beyond what the pipeline
 * already supplies (client access, prompts, ctx are closed over by the caller).
 * Returns a `Result<LlmResponse<O>, FrameworkError>`.
 */
export type LlmCallFn<O> = () => Promise<Result<LlmResponse<O>, FrameworkError>>;

/**
 * Shared pipeline: cache-read → call → validate+retry → enrich → cache-write.
 *
 * Both `createLlmNode` and `createLlmWithToolsNode` delegate here after
 * resolving prompts and constructing the call function. The pipeline owns:
 *
 * - Cache lookup (opt-in, best-effort on read failure)
 * - LLM call via the injected `callFn`
 * - Output schema validation + FR-021 single-shot retry
 * - GenAI semconv span enrichment
 * - Cache write (best-effort, failures never break a successful run)
 */
export const runLlmCallPipeline = async <O>(
  config: LlmPipelineConfig<O>,
  callFn: LlmCallFn<O>,
  ctx: NodeContext,
): Promise<Result<O, FrameworkError>> => {
  // 1. Cache read (opt-in — cache may be null)
  if (ctx.cache) {
    try {
      const lookup = await ctx.cache.get(config.cacheKey);
      if (lookup.hit) {
        const parsed = config.outputSchema.safeParse(lookup.value);
        if (parsed.success) return ok(parsed.data);
        ctx.logger.warn(
          `[${config.nodeId}] Cache hit failed schema validation, treating as miss`,
        );
      }
    } catch (e) {
      ctx.logger.warn(
        `[${config.nodeId}] Cache read failed (cacheKey=${config.cacheKey}): ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // 2. LLM call + output validation
  const attempt = async (): Promise<Result<LlmResponse<O>, FrameworkError>> => {
    const result = await callFn();
    if (!result.ok) return result;

    const parsed = config.outputSchema.safeParse(result.value.output);
    if (!parsed.success) {
      return err({
        kind: "validation" as const,
        nodeId: config.nodeId,
        message: `LLM output validation failed: ${parsed.error.message}`,
      });
    }
    return ok(result.value);
  };

  let result = await attempt();

  // 3. FR-021: retry once on validation failure
  if (!result.ok && result.error.kind === "validation" && !config.disableValidationRetry) {
    result = await attempt();
    if (!result.ok) {
      return err({
        kind: "retry-exhausted" as const,
        nodeId: config.nodeId,
        attempts: 2,
        lastError: formatFrameworkError(result.error),
        rootErrorKind:
          result.error.kind === "retry-exhausted"
            ? result.error.rootErrorKind
            : result.error.kind,
      });
    }
  }

  if (!result.ok) return result;

  const llmResponse = result.value;

  // 4. Span enrichment
  enrichLlmSpan({
    model: config.model,
    promptName: config.promptName,
    system: config.prompts.system,
    user: config.prompts.user,
    tokensIn: llmResponse.tokensIn,
    tokensOut: llmResponse.tokensOut,
    thinking: llmResponse.thinking,
    contentFilter: ctx.contentFilter,
  });

  const output = llmResponse.output as O;

  // 5. Cache write (best-effort — failures must never break a successful run)
  if (ctx.cache) {
    try {
      const setResult = await ctx.cache.set(config.cacheKey, output, DEFAULT_CACHE_TTL_SEC);
      if (!setResult.ok) {
        ctx.logger.warn(
          `[${config.nodeId}] Cache write failed: ${setResult.error.kind === "cache-error" ? setResult.error.message : String(setResult.error)}`,
        );
      }
    } catch (e) {
      ctx.logger.warn(
        `[${config.nodeId}] Cache write threw: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  return ok(output);
};
