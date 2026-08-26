/**
 * FR-PC-009 — a declared cache policy that did nothing must say so.
 *
 * The provider caches nothing and raises nothing when the cacheable prefix sits
 * below the model's minimum size (512-4096 tokens, model-dependent) or when a
 * volatile byte breaks the prefix match. Without this warning "caching is
 * enabled" and "caching is working" are indistinguishable from the outside,
 * which is precisely the silent-success failure this codebase legislates
 * against elsewhere.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { runLlmCallPipeline } from "../nodes/llm-pipeline.js";
import type { LlmPipelineConfig } from "../nodes/llm-pipeline.js";
import type { LlmResponse } from "../types/llm.js";
import type { TokenUsage } from "../types/token-usage.js";
import { tokensOnly } from "../types/token-usage.js";
import { ok } from "../types/result.js";
import { testNodeContext } from "./_context-factories.js";
import { N } from "./_id-helpers.js";

const schema = z.object({ answer: z.string() });
type Output = z.infer<typeof schema>;

const baseConfig: LlmPipelineConfig<Output> = {
  nodeId: N("test-llm"),
  model: "gpt-4o",
  outputSchema: schema,
  prompts: { system: "sys", user: "usr" },
  cacheKey: "test-key",
};

/** Collects everything the pipeline logged at `warn`. */
const capturingContext = () => {
  const warnings: string[] = [];
  const ctx = testNodeContext();
  return {
    warnings,
    ctx: { ...ctx, logger: { ...ctx.logger, warn: (m: string) => { warnings.push(m); } } },
  };
};

const respondWith = (usage: TokenUsage) => async () =>
  ok<LlmResponse<Output>>({ output: { answer: "hi" }, rawText: '{"answer":"hi"}', ...usage });

const cachedUsage = (): TokenUsage => ({
  tokensIn: 1000,
  tokensOut: 20,
  cacheWriteTokens: 0,
  cacheReadTokens: 900,
});

describe("inert prompt-cache policy", () => {
  it("warns when a declared policy reports neither a write nor a read", async () => {
    const { ctx, warnings } = capturingContext();
    await runLlmCallPipeline(
      { ...baseConfig, cache: { kind: "static-prefix", ttl: "5m" } },
      respondWith(tokensOnly(1000, 20)),
      ctx,
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("static-prefix");
    expect(warnings[0]).toContain("no cache write and no cache read");
  });

  it("names the policy that was declared, so the log points at the config to change", async () => {
    const { ctx, warnings } = capturingContext();
    await runLlmCallPipeline(
      { ...baseConfig, cache: { kind: "conversation", ttl: "1h" } },
      respondWith(tokensOnly(1000, 20)),
      ctx,
    );
    expect(warnings[0]).toContain("conversation");
  });

  it("stays silent when the policy actually cached something", async () => {
    const { ctx, warnings } = capturingContext();
    await runLlmCallPipeline(
      { ...baseConfig, cache: { kind: "static-prefix", ttl: "5m" } },
      respondWith(cachedUsage()),
      ctx,
    );
    expect(warnings).toEqual([]);
  });

  it("stays silent when no policy was declared — nothing was promised", async () => {
    const { ctx, warnings } = capturingContext();
    await runLlmCallPipeline(baseConfig, respondWith(tokensOnly(1000, 20)), ctx);
    expect(warnings).toEqual([]);
  });

  it("stays silent for an explicit `none`", async () => {
    const { ctx, warnings } = capturingContext();
    await runLlmCallPipeline(
      { ...baseConfig, cache: { kind: "none" } },
      respondWith(tokensOnly(1000, 20)),
      ctx,
    );
    expect(warnings).toEqual([]);
  });
});
