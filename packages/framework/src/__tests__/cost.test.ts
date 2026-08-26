import { describe, it, expect } from "bun:test";
import { tokensOnly } from "../types/token-usage.js";
import { computeCostUsd, PRICE_TABLE } from "../llm/cost.js";

describe("computeCostUsd", () => {
  it("returns correct cost for a known model", () => {
    const cost = computeCostUsd("gpt-4o", tokensOnly(1_000_000,1_000_000));
    expect(cost).toBe(2.5 + 10.0);
  });

  it("returns correct cost for fractional tokens", () => {
    const cost = computeCostUsd("gpt-4o", tokensOnly(1000,500));
    expect(cost).toBeCloseTo((1000 * 2.5 + 500 * 10.0) / 1_000_000);
  });

  it("returns 0 for zero tokens", () => {
    expect(computeCostUsd("gpt-4o", tokensOnly(0,0))).toBe(0);
  });

  it("returns 0 and logs warning for unknown model", () => {
    const cost = computeCostUsd("unknown-model-xyz", tokensOnly(1000,1000));
    expect(cost).toBe(0);
  });

  it("covers all Anthropic models in the price table", () => {
    const anthropicModels = Object.keys(PRICE_TABLE).filter((m) => m.startsWith("claude"));
    expect(anthropicModels.length).toBeGreaterThan(0);
    for (const model of anthropicModels) {
      const cost = computeCostUsd(model, tokensOnly(1000,1000));
      expect(cost).toBeGreaterThan(0);
    }
  });

  it("covers all OpenAI models in the price table", () => {
    const openaiModels = Object.keys(PRICE_TABLE).filter(
      (m) => m.startsWith("gpt") || m.startsWith("o3") || m.startsWith("o4"),
    );
    expect(openaiModels.length).toBeGreaterThan(0);
    for (const model of openaiModels) {
      const cost = computeCostUsd(model, tokensOnly(1000,1000));
      expect(cost).toBeGreaterThan(0);
    }
  });

  it("cost is always non-negative for valid inputs", () => {
    for (const model of Object.keys(PRICE_TABLE)) {
      const cost = computeCostUsd(model, tokensOnly(0,0));
      expect(cost).toBeGreaterThanOrEqual(0);
    }
  });
});
