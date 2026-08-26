/**
 * Provider-facing prompt-caching behaviour: what each client SENDS for a given
 * policy, and how each client NORMALISES the usage it gets back.
 *
 * The normalisation cases are the load-bearing ones. The two providers report
 * cached tokens in opposite ways — Anthropic excludes them from `input_tokens`,
 * OpenAI includes them — so a single shared assumption would be wrong for one
 * of them, and wrong in a direction (under- or over-counting every cached
 * prompt token) that no other test would catch.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicLlmClient } from "../llm/anthropic-client.js";
import { OpenAILlmClient } from "../llm/openai-client.js";
import { unwrap } from "../types/result.js";
import { uncachedInputTokens } from "../types/token-usage.js";
import { N } from "./_id-helpers.js";
import {
  anthropicUsageBlock,
  breakpointsIn,
  openAiResponseBody,
  structuredOutputResponse,
  withStubbedFetch,
  type CreateFn,
} from "./_prompt-cache-helpers.js";
import { makeNodeContext } from "../shared/index.js";
import { usageOfError } from "../types/errors.js";
import type { ConversationCachePolicy, SingleShotCachePolicy } from "../types/llm.js";
import type { DagId, RunId } from "../types/ids.js";

/** Tool loops need a NodeContext; nothing in these tests reaches its llm field. */
const OPENAI_RUNTIME = makeNodeContext({
  runId: "openai-cache-run" as RunId,
  dagId: "openai-cache-dag" as DagId,
  llm: {
    sendStructured: async () => {
      throw new Error("unused");
    },
    sendWithTools: async () => {
      throw new Error("unused");
    },
  } as never,
});

const schema = z.object({ answer: z.string() });

/** Captures the params of the last `messages.create` call. */
const capturingAnthropic = (usage = anthropicUsageBlock(100, 50)) => {
  const seen: Anthropic.MessageCreateParams[] = [];
  const create: CreateFn = async (params) => {
    seen.push(params);
    return structuredOutputResponse(usage);
  };
  const client = new AnthropicLlmClient({ messages: { create } } as never);
  return { client, seen };
};

describe("Anthropic request shape — FR-PC-004: no policy is byte-identical to before", () => {
  it("keeps `system` a bare string and emits no cache_control when the policy is omitted", async () => {
    const { client, seen } = capturingAnthropic();
    await client.sendStructured({
      system: "SYS",
      user: "hello",
      model: "claude-test",
      schema,
      nodeId: N("n1"),
    });
    expect(typeof seen[0]!.system).toBe("string");
    expect(seen[0]!.system).toBe("SYS");
    expect(breakpointsIn(seen[0]!)).toEqual([]);
  });

  it("is identical for an explicit `none`", async () => {
    const omitted = capturingAnthropic();
    await omitted.client.sendStructured({
      system: "SYS",
      user: "hello",
      model: "claude-test",
      schema,
      nodeId: N("n1"),
    });
    const explicit = capturingAnthropic();
    await explicit.client.sendStructured({
      system: "SYS",
      user: "hello",
      model: "claude-test",
      schema,
      nodeId: N("n1"),
      cache: { kind: "none" },
    });
    expect(explicit.seen[0]).toEqual(omitted.seen[0]!);
  });
});

describe("Anthropic request shape — FR-PC-002: static-prefix", () => {
  it("promotes system to one text block carrying a 5m breakpoint", async () => {
    const { client, seen } = capturingAnthropic();
    await client.sendStructured({
      system: "SYS",
      user: "hello",
      model: "claude-test",
      schema,
      nodeId: N("n1"),
      cache: { kind: "static-prefix", ttl: "5m" },
    });
    expect(seen[0]!.system).toEqual([
      { type: "text", text: "SYS", cache_control: { type: "ephemeral" } },
    ]);
    // The 5-minute lifetime is the provider default and is expressed by OMITTING
    // `ttl` — sending it explicitly is a different request for no benefit.
    expect(breakpointsIn(seen[0]!)).toEqual([{ type: "ephemeral" }]);
  });

  it("names the 1h TTL explicitly", async () => {
    const { client, seen } = capturingAnthropic();
    await client.sendStructured({
      system: "SYS",
      user: "hello",
      model: "claude-test",
      schema,
      nodeId: N("n1"),
      cache: { kind: "static-prefix", ttl: "1h" },
    });
    expect(breakpointsIn(seen[0]!)).toEqual([{ type: "ephemeral", ttl: "1h" }]);
  });

  it("leaves the per-call user message after the breakpoint, uncached", async () => {
    const { client, seen } = capturingAnthropic();
    await client.sendStructured({
      system: "SYS",
      user: "VOLATILE",
      model: "claude-test",
      schema,
      nodeId: N("n1"),
      cache: { kind: "static-prefix", ttl: "5m" },
    });
    expect(seen[0]!.messages).toEqual([{ role: "user", content: "VOLATILE" }]);
  });
});

describe("Anthropic usage normalisation — FR-PC-005", () => {
  it("SUMS the cache split into tokensIn, because Anthropic excludes it from input_tokens", async () => {
    const { client } = capturingAnthropic(anthropicUsageBlock(10, 7, 900, 0));
    const res = unwrap(
      await client.sendStructured({
        system: "SYS",
        user: "hello",
        model: "claude-test",
        schema,
        nodeId: N("n1"),
        cache: { kind: "static-prefix", ttl: "5m" },
      }),
    );
    expect(res.tokensIn).toBe(910);
    expect(res.cacheWriteTokens).toBe(900);
    expect(res.cacheReadTokens).toBe(0);
    expect(uncachedInputTokens(res)).toBe(10);
  });

  it("reports a cache READ the same way", async () => {
    const { client } = capturingAnthropic(anthropicUsageBlock(10, 7, 0, 900));
    const res = unwrap(
      await client.sendStructured({
        system: "SYS",
        user: "hello",
        model: "claude-test",
        schema,
        nodeId: N("n1"),
        cache: { kind: "static-prefix", ttl: "5m" },
      }),
    );
    expect(res.tokensIn).toBe(910);
    expect(res.cacheReadTokens).toBe(900);
    expect(uncachedInputTokens(res)).toBe(10);
  });

  it("reads absent cache fields as zero, leaving an uncached call's total untouched", async () => {
    const { client } = capturingAnthropic(anthropicUsageBlock(100, 50));
    const res = unwrap(
      await client.sendStructured({
        system: "SYS",
        user: "hello",
        model: "claude-test",
        schema,
        nodeId: N("n1"),
      }),
    );
    expect(res).toMatchObject({
      tokensIn: 100,
      tokensOut: 50,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// OpenAI — the asymmetric provider
// ---------------------------------------------------------------------------

const openAiClient = () =>
  new OpenAILlmClient({ apiKey: "k", baseUrl: "https://example.invalid/v1" });

const structuredRequest = (cache?: SingleShotCachePolicy) => ({
  system: "SYS",
  user: "hello",
  model: "gpt-test",
  schema,
  nodeId: N("n1"),
  ...(cache ? { cache } : {}),
});

/** Run one `sendStructured` against a stubbed Responses body and return both sides. */
const sendOnce = async (usage: unknown, cache?: SingleShotCachePolicy) =>
  withStubbedFetch([openAiResponseBody(usage)], async (captured) => {
    const result = await openAiClient().sendStructured(structuredRequest(cache));
    return { result, captured };
  });

describe("OpenAI request shape — FR-PC-004: a declared policy changes nothing on the wire", () => {
  // ADR-0081 states the Anthropic/OpenAI asymmetry is deliberate: OpenAI caches
  // automatically and exposes no request-side control, so the policy is a no-op
  // on request construction there. A no-op is only pinned by comparing the body
  // it produced against the body it produces without one — otherwise a future
  // refactor could start emitting an Anthropic-shaped `cache_control` into the
  // Responses API and nothing would notice.
  const usage = { input_tokens: 100, output_tokens: 20 };

  it("sends a body identical to the no-policy body for static-prefix", async () => {
    const withPolicy = await sendOnce(usage, { kind: "static-prefix", ttl: "5m" });
    const without = await sendOnce(usage);
    expect(withPolicy.captured[0]!.body).toEqual(without.captured[0]!.body);
  });

  it("sends a body identical to the no-policy body for an explicit none", async () => {
    const explicit = await sendOnce(usage, { kind: "none" });
    const omitted = await sendOnce(usage);
    expect(explicit.captured[0]!.body).toEqual(omitted.captured[0]!.body);
  });

  it("never emits a cache_control anywhere in the request", async () => {
    for (const ttl of ["5m", "1h"] as const) {
      const { captured } = await sendOnce(usage, { kind: "static-prefix", ttl });
      const serialized = JSON.stringify(captured[0]!.body);
      expect(serialized).not.toContain("cache_control");
      expect(serialized).not.toContain("ephemeral");
    }
  });

  it("leaves a tool-loop request unchanged under a conversation policy", async () => {
    const finalTurn = openAiResponseBody(usage, '{"answer":"done"}');
    const run = async (cache?: ConversationCachePolicy) =>
      withStubbedFetch([finalTurn], async (captured) => {
        await openAiClient().sendWithTools(
          {
            system: "SYS",
            user: "hello",
            model: "gpt-test",
            tools: [],
            schema,
            nodeId: N("n1"),
            ...(cache ? { cache } : {}),
          },
          OPENAI_RUNTIME,
        );
        return captured;
      });
    const withPolicy = await run({ kind: "conversation", ttl: "5m" });
    const without = await run();
    expect(withPolicy[0]!.body).toEqual(without[0]!.body);
    expect(JSON.stringify(withPolicy[0]!.body)).not.toContain("cache_control");
  });
});

describe("OpenAI usage normalisation — FR-PC-010", () => {
  it("does NOT double-count: input_tokens already includes cached_tokens", async () => {
    const { result } = await sendOnce({
      input_tokens: 1000,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 800 },
    });
    const res = unwrap(result);
    // 1000, NOT 1800 — the mirror image of the Anthropic case above.
    expect(res.tokensIn).toBe(1000);
    expect(res.cacheReadTokens).toBe(800);
    expect(uncachedInputTokens(res)).toBe(200);
  });

  it("never reports a cache WRITE, which OpenAI does not expose", async () => {
    const { result } = await sendOnce({
      input_tokens: 1000,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 800 },
    });
    expect(unwrap(result).cacheWriteTokens).toBe(0);
  });

  it("clamps a cached_tokens larger than the prompt itself", async () => {
    const { result } = await sendOnce({
      input_tokens: 100,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 999_999 },
    });
    const res = unwrap(result);
    expect(res.cacheReadTokens).toBe(100);
    expect(uncachedInputTokens(res)).toBe(0);
  });

  it("reads a NON-NUMERIC cached_tokens as zero rather than propagating NaN", async () => {
    // The field is untrusted JSON: a string or null here would otherwise flow
    // into `tokensIn` arithmetic and poison every downstream total with NaN.
    for (const hostile of ["800", null, Number.NaN, {}]) {
      const { result } = await sendOnce({
        input_tokens: 100,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: hostile },
      });
      const res = unwrap(result);
      expect(res.cacheReadTokens).toBe(0);
      expect(Number.isFinite(res.tokensIn)).toBe(true);
      expect(uncachedInputTokens(res)).toBe(100);
    }
  });

  it("reports the cache split on a usage-carrying ERROR arm — FR-PC-006", async () => {
    // A failed turn's cached tokens were still billed; dropping them here is
    // exactly the budget under-count the normalisation exists to prevent.
    const failed = {
      id: "resp_1",
      model: "gpt-test",
      status: "failed",
      error: { code: "invalid_prompt", message: "nope" },
      output: [],
      usage: {
        input_tokens: 1000,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 900 },
      },
    };
    await withStubbedFetch([failed], async () => {
      const result = await openAiClient().sendStructured(structuredRequest());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const usage = usageOfError(result.error);
      expect(usage).toBeDefined();
      if (usage === undefined) return;
      expect(usage.tokensIn).toBe(1000);
      expect(usage.cacheReadTokens).toBe(900);
      expect(usage.cacheWriteTokens).toBe(0);
    });
  });
});
