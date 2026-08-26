import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { FakeLlmClient } from "../src/llm/fake-client.js";
import { computeCostUsd } from "../src/llm/cost.js";
import { tokensOnly } from "../src/types/token-usage.js";
import type { LlmRequest } from "../src/llm/client.js";
import type { FrameworkError } from "../src/types/errors.js";

const schema = z.object({ answer: z.string() });

function makeReq(model = "test-model"): LlmRequest<{ answer: string }> {
  return { system: "sys", user: "hello", model, schema };
}

describe("FakeLlmClient", () => {
  test("returns configured response from map by model", async () => {
    const responses = new Map<string, unknown>([["test-model", { answer: "42" }]]);
    const client = new FakeLlmClient(responses);
    const result = await client.sendStructured(makeReq());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toEqual({ answer: "42" });
      expect(result.value.tokensIn).toBe(100);
      expect(result.value.tokensOut).toBe(50);
    }
  });

  test("returns configured response from function", async () => {
    const client = new FakeLlmClient((req) => ({ answer: req.user }));
    const result = await client.sendStructured(makeReq());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toEqual({ answer: "hello" });
    }
  });

  test("returns error when configured with FrameworkError", async () => {
    const fwError: FrameworkError = { kind: "node-crash", nodeId: "n1", message: "boom" };
    const responses = new Map<string, unknown>([["test-model", fwError]]);
    const client = new FakeLlmClient(responses);
    const result = await client.sendStructured(makeReq());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
    }
  });

  test("returns error for unconfigured model", async () => {
    const client = new FakeLlmClient(new Map());
    const result = await client.sendStructured(makeReq());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
    }
  });
});

describe("computeCostUsd", () => {
  test("calculates correctly for known model", () => {
    // claude-sonnet-4: 3.0 input, 15.0 output per 1M
    const cost = computeCostUsd("claude-sonnet-4-20250514", tokensOnly(1_000_000,500_000));
    expect(cost).toBeCloseTo(3.0 + 7.5, 5); // 10.5
  });

  test("returns 0 for unknown model", () => {
    const cost = computeCostUsd("unknown-model", tokensOnly(1000,1000));
    expect(cost).toBe(0);
  });

  test("calculates correctly for haiku", () => {
    const cost = computeCostUsd("claude-haiku-4-20250514", tokensOnly(2_000_000,1_000_000));
    // 2M * 0.8/1M + 1M * 4.0/1M = 1.6 + 4.0 = 5.6
    expect(cost).toBeCloseTo(5.6, 5);
  });
});
