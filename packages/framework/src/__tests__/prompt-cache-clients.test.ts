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
  structuredOutputResponse,
  type CreateFn,
} from "./_prompt-cache-helpers.js";

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

const openAiClientWithUsage = (usage: unknown) => {
  const client = new OpenAILlmClient({ apiKey: "k", baseUrl: "https://example.invalid/v1" });
  const body = {
    id: "resp_1",
    model: "gpt-test",
    status: "completed",
    output: [
      { type: "message", content: [{ type: "output_text", text: '{"answer":"hi"}' }] },
    ],
    usage,
  };
  // The client posts with `fetch`; stub it for the duration of one call.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
  return { client, restore: () => { globalThis.fetch = originalFetch; } };
};

describe("OpenAI usage normalisation — FR-PC-010", () => {
  it("does NOT double-count: input_tokens already includes cached_tokens", async () => {
    const { client, restore } = openAiClientWithUsage({
      input_tokens: 1000,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 800 },
    });
    try {
      const res = unwrap(
        await client.sendStructured({
          system: "SYS",
          user: "hello",
          model: "gpt-test",
          schema,
          nodeId: N("n1"),
        }),
      );
      // 1000, NOT 1800 — the mirror image of the Anthropic case above.
      expect(res.tokensIn).toBe(1000);
      expect(res.cacheReadTokens).toBe(800);
      expect(uncachedInputTokens(res)).toBe(200);
    } finally {
      restore();
    }
  });

  it("never reports a cache WRITE, which OpenAI does not expose", async () => {
    const { client, restore } = openAiClientWithUsage({
      input_tokens: 1000,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 800 },
    });
    try {
      const res = unwrap(
        await client.sendStructured({
          system: "SYS",
          user: "hello",
          model: "gpt-test",
          schema,
          nodeId: N("n1"),
        }),
      );
      expect(res.cacheWriteTokens).toBe(0);
    } finally {
      restore();
    }
  });

  it("clamps a malformed cached_tokens rather than breaking the usage invariant", async () => {
    const { client, restore } = openAiClientWithUsage({
      input_tokens: 100,
      output_tokens: 20,
      // Hostile: more cached tokens than the prompt had, and not even a number
      // in the general case. Either would make `uncachedInputTokens` negative.
      input_tokens_details: { cached_tokens: 999_999 },
    });
    try {
      const res = unwrap(
        await client.sendStructured({
          system: "SYS",
          user: "hello",
          model: "gpt-test",
          schema,
          nodeId: N("n1"),
        }),
      );
      expect(res.cacheReadTokens).toBe(100);
      expect(uncachedInputTokens(res)).toBe(0);
    } finally {
      restore();
    }
  });
});
