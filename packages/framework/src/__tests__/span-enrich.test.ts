// span-enrich.test.ts — Tests for LLM cost calculation and content filtering
// Finding #18: cost calculation had no unit test.

import { describe, it, expect } from "bun:test";
import { tokensOnly } from "../types/token-usage.js";
import { computeCostUsd, PRICE_TABLE } from "../llm/cost.js";
import { resolveContentFilter, IDENTITY_FILTER } from "../tracing/content-filter.js";
import { context, trace, type Span } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { enrichLlmSpan } from "../tracing/span-enrich.js";
import {
  AI_LLM_COST_USD,
  AI_PROMPT_CACHE_EFFECTIVE,
  AI_PROMPT_CACHE_POLICY,
  EVENT_LLM_COST,
  GEN_AI_USAGE_CACHE_READ_TOKENS,
  GEN_AI_USAGE_CACHE_WRITE_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
} from "../tracing/semantic-conventions.js";

// ---------------------------------------------------------------------------
// computeCostUsd — pure cost calculation
// ---------------------------------------------------------------------------

describe("computeCostUsd", () => {
  it("computes correct cost for a known model (gpt-4o)", () => {
    const rates = PRICE_TABLE["gpt-4o"]!;
    const tokensIn = 1000;
    const tokensOut = 500;
    const expected = (tokensIn * rates.inputPer1M + tokensOut * rates.outputPer1M) / 1_000_000;
    expect(computeCostUsd("gpt-4o", tokensOnly(tokensIn,tokensOut))).toBeCloseTo(expected, 10);
  });

  it("computes correct cost for Anthropic model", () => {
    const rates = PRICE_TABLE["claude-sonnet-4-20250514"]!;
    const tokensIn = 2000;
    const tokensOut = 1000;
    const expected = (tokensIn * rates.inputPer1M + tokensOut * rates.outputPer1M) / 1_000_000;
    expect(computeCostUsd("claude-sonnet-4-20250514", tokensOnly(tokensIn,tokensOut))).toBeCloseTo(expected, 10);
  });

  it("returns 0 for unknown model", () => {
    expect(computeCostUsd("unknown-model-xyz", tokensOnly(5000,2000))).toBe(0);
  });

  it("returns 0 for zero tokens on known model", () => {
    expect(computeCostUsd("gpt-4o", tokensOnly(0,0))).toBe(0);
  });

  it("handles large token counts correctly", () => {
    const rates = PRICE_TABLE["gpt-4o"]!;
    const tokensIn = 1_000_000;
    const tokensOut = 500_000;
    const expected = (tokensIn * rates.inputPer1M + tokensOut * rates.outputPer1M) / 1_000_000;
    expect(computeCostUsd("gpt-4o", tokensOnly(tokensIn,tokensOut))).toBeCloseTo(expected, 10);
    // Sanity: 1M input tokens at $2.5/M + 500K output at $10/M = $7.50
    expect(computeCostUsd("gpt-4o", tokensOnly(tokensIn,tokensOut))).toBeCloseTo(7.5, 2);
  });

  it("all PRICE_TABLE models produce non-negative costs", () => {
    for (const [model, rates] of Object.entries(PRICE_TABLE)) {
      const cost = computeCostUsd(model, tokensOnly(100,100));
      expect(cost).toBeGreaterThanOrEqual(0);
      // Every model should have a positive rate for at least one direction
      expect(rates.inputPer1M + rates.outputPer1M).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveContentFilter — content redaction logic
// ---------------------------------------------------------------------------

describe("resolveContentFilter", () => {
  it("returns null when contentFilter is explicitly null", () => {
    const filter = resolveContentFilter({ contentFilter: null });
    expect(filter).toBeNull();
  });

  it("returns the provided filter function when set", () => {
    const myFilter = (s: string) => s.slice(0, 10);
    const filter = resolveContentFilter({ contentFilter: myFilter });
    expect(filter).toBe(myFilter);
    expect(filter!("hello world this is long")).toBe("hello worl");
  });

  it("returns IDENTITY_FILTER when explicitly set", () => {
    const filter = resolveContentFilter({ contentFilter: IDENTITY_FILTER });
    expect(filter).not.toBeNull();
    expect(filter!("secret")).toBe("secret");
  });

  it("returns null when contentFilter is null", () => {
    const filter = resolveContentFilter({ contentFilter: null });
    expect(filter).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// enrichLlmSpan — the cache attributes and cost components on the wire
//
// This is the function FR-PC-009 relies on to make an inert cache visible in a
// trace, and every claim it makes is an attribute KEY or a cost FIELD: a typo,
// an inverted `isCacheInert`, or two swapped components would be invisible to
// every other test in the suite.
// ---------------------------------------------------------------------------

// Without a real context manager the API default is a no-op that does not
// propagate, so `trace.getActiveSpan()` inside the helper would never see the
// recording span. Same registration the tool-call span tests use.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

interface RecordedEvent {
  readonly name: string;
  readonly attrs: Record<string, unknown>;
}

/**
 * Run `enrichLlmSpan` against a recording span installed as the active OTel
 * span, and return everything it set.
 */
const captureEnrichment = (
  opts: Parameters<typeof enrichLlmSpan>[0],
): { attributes: Record<string, unknown>; events: RecordedEvent[] } => {
  const attributes: Record<string, unknown> = {};
  const events: RecordedEvent[] = [];
  const span = {
    setAttribute: (k: string, v: unknown) => {
      attributes[k] = v;
      return span;
    },
    addEvent: (name: string, attrs: Record<string, unknown>) => {
      events.push({ name, attrs });
      return span;
    },
    setStatus: () => span,
    end: () => {},
  } as unknown as Span;

  const ctx = trace.setSpan(context.active(), span);
  context.with(ctx, () => enrichLlmSpan(opts));
  return { attributes, events };
};

const baseOpts = {
  model: "gpt-4o",
  system: "sys",
  user: "usr",
  provider: "openai",
  contentFilter: IDENTITY_FILTER,
};

const cachedUsage = {
  tokensIn: 1000,
  tokensOut: 100,
  cacheWriteTokens: 0,
  cacheReadTokens: 900,
};

describe("enrichLlmSpan — cache usage attributes", () => {
  it("always emits both cache token attributes, including as zeroes", () => {
    // Emitted unconditionally so "caching did nothing" is QUERYABLE — an absent
    // attribute is indistinguishable from an old exporter.
    const { attributes } = captureEnrichment({ ...baseOpts, usage: tokensOnly(100, 20) });
    expect(attributes[GEN_AI_USAGE_CACHE_WRITE_TOKENS]).toBe(0);
    expect(attributes[GEN_AI_USAGE_CACHE_READ_TOKENS]).toBe(0);
  });

  it("reports the cache split when the provider returned one", () => {
    const { attributes } = captureEnrichment({
      ...baseOpts,
      usage: { ...cachedUsage, cacheWriteTokens: 400, cacheReadTokens: 500 },
    });
    expect(attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(1000);
    expect(attributes[GEN_AI_USAGE_CACHE_WRITE_TOKENS]).toBe(400);
    expect(attributes[GEN_AI_USAGE_CACHE_READ_TOKENS]).toBe(500);
  });
});

describe("enrichLlmSpan — prompt-cache policy attributes (FR-PC-009)", () => {
  it("stamps the declared policy", () => {
    const { attributes } = captureEnrichment({
      ...baseOpts,
      usage: cachedUsage,
      cachePolicy: "conversation",
    });
    expect(attributes[AI_PROMPT_CACHE_POLICY]).toBe("conversation");
  });

  it("marks a policy that cached something as effective", () => {
    const { attributes } = captureEnrichment({
      ...baseOpts,
      usage: cachedUsage,
      cachePolicy: "static-prefix",
    });
    expect(attributes[AI_PROMPT_CACHE_EFFECTIVE]).toBe(true);
  });

  it("marks a declared policy that cached NOTHING as ineffective", () => {
    const { attributes } = captureEnrichment({
      ...baseOpts,
      usage: tokensOnly(300, 20),
      cachePolicy: "static-prefix",
    });
    expect(attributes[AI_PROMPT_CACHE_EFFECTIVE]).toBe(false);
  });

  it("omits the effectiveness attribute for `none` — nothing was promised", () => {
    const { attributes } = captureEnrichment({
      ...baseOpts,
      usage: tokensOnly(300, 20),
      cachePolicy: "none",
    });
    expect(attributes[AI_PROMPT_CACHE_POLICY]).toBe("none");
    expect(AI_PROMPT_CACHE_EFFECTIVE in attributes).toBe(false);
  });

  it("omits both policy attributes when no policy was declared at all", () => {
    const { attributes } = captureEnrichment({ ...baseOpts, usage: tokensOnly(300, 20) });
    expect(AI_PROMPT_CACHE_POLICY in attributes).toBe(false);
    expect(AI_PROMPT_CACHE_EFFECTIVE in attributes).toBe(false);
  });
});

describe("enrichLlmSpan — llm.cost components", () => {
  const costEventOf = (events: RecordedEvent[]): Record<string, unknown> => {
    const event = events.find((e) => e.name === EVENT_LLM_COST);
    expect(event).toBeDefined();
    return event?.attrs ?? {};
  };

  it("splits the input side by how each prompt token was billed", () => {
    const usage = {
      tokensIn: 1_000_000,
      tokensOut: 0,
      cacheWriteTokens: 400_000,
      cacheReadTokens: 500_000,
    };
    const { events, attributes } = captureEnrichment({ ...baseOpts, usage });
    const cost = costEventOf(events);
    const rate = PRICE_TABLE["gpt-4o"]!.inputPer1M;
    // 100k uncached at 1.0x, 400k written at 1.25x, 500k read at 0.1x.
    expect(cost["cache_write_cost"]).toBeCloseTo((400_000 * rate * 1.25) / 1_000_000, 10);
    expect(cost["cache_read_cost"]).toBeCloseTo((500_000 * rate * 0.1) / 1_000_000, 10);
    expect(cost["input_cost"]).toBeCloseTo(
      (100_000 * rate + 400_000 * rate * 1.25 + 500_000 * rate * 0.1) / 1_000_000,
      10,
    );
    // The span attribute and the event's total are the same number.
    expect(cost["total_cost"]).toBe(attributes[AI_LLM_COST_USD]);
  });

  it("charges the 1h write premium when that TTL was used", () => {
    const usage = {
      tokensIn: 1_000_000,
      tokensOut: 0,
      cacheWriteTokens: 1_000_000,
      cacheReadTokens: 0,
    };
    const fiveMin = captureEnrichment({ ...baseOpts, usage, cacheWriteTtl: "5m" });
    const oneHour = captureEnrichment({ ...baseOpts, usage, cacheWriteTtl: "1h" });
    const rate = PRICE_TABLE["gpt-4o"]!.inputPer1M;
    expect(costEventOf(fiveMin.events)["cache_write_cost"]).toBeCloseTo(rate * 1.25, 10);
    expect(costEventOf(oneHour.events)["cache_write_cost"]).toBeCloseTo(rate * 2.0, 10);
  });

  it("charges a cached read at a tenth of an uncached token", () => {
    const rate = PRICE_TABLE["gpt-4o"]!.inputPer1M;
    const uncached = captureEnrichment({ ...baseOpts, usage: tokensOnly(1_000_000, 0) });
    const cached = captureEnrichment({
      ...baseOpts,
      usage: { tokensIn: 1_000_000, tokensOut: 0, cacheWriteTokens: 0, cacheReadTokens: 1_000_000 },
    });
    expect(uncached.attributes[AI_LLM_COST_USD]).toBeCloseTo(rate, 10);
    expect(cached.attributes[AI_LLM_COST_USD]).toBeCloseTo(rate * 0.1, 10);
  });
});
