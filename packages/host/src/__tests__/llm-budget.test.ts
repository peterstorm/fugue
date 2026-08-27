/**
 * Tests for the budget declaration → `Ceilings` translation (domain/llm-budget.ts).
 *
 * This is the anti-corruption layer between what an operator writes and what the
 * meter enforces, so the cases that matter are the ones where the two
 * vocabularies disagree: dollars as a decimal vs integer micro-USD, a legacy
 * scalar vs the block, and absence vs an empty declaration.
 */

import { describe, it, expect } from "bun:test";
import { usdToMicros } from "@fuguejs/framework";
import { LlmBudgetConfigSchema, ceilingsOf } from "../domain/llm-budget.js";

describe("ceilingsOf: no declaration means no enforcement (FR-W1-006)", () => {
  it("returns undefined when nothing is declared", () => {
    expect(ceilingsOf({})).toBeUndefined();
    expect(ceilingsOf({ llmBudget: {} })).toBeUndefined();
  });
});

describe("ceilingsOf: the legacy scalar (FR-B-008)", () => {
  it("normalises llmBudgetTokens into a tokens ceiling", () => {
    // It shipped in v0.5.1 and live deployments set it, so it stays honoured —
    // but as SUGAR that lands in the same value as the block, not as a second
    // enforcement path where a bug could hide.
    expect(ceilingsOf({ llmBudgetTokens: 5000 })).toEqual([{ kind: "tokens", limit: 5000 }]);
  });

  it("takes the TIGHTER limit when both spellings are declared", () => {
    // Not a special case written here: `ceilings` collapses duplicate axes to
    // their minimum, which is the same rule that stops a caller-supplied
    // ceiling relaxing a DAG's (FR-B-009).
    expect(ceilingsOf({ llmBudgetTokens: 5000, llmBudget: { tokens: 100 } })).toEqual([
      { kind: "tokens", limit: 100 },
    ]);
    expect(ceilingsOf({ llmBudgetTokens: 100, llmBudget: { tokens: 5000 } })).toEqual([
      { kind: "tokens", limit: 100 },
    ]);
  });
});

describe("ceilingsOf: the block", () => {
  it("converts dollars to integer micro-USD at the boundary", () => {
    // An operator writes `usd: 2.50`; the comparison happens in integers so a
    // run's total cannot drift with the order its calls settled.
    expect(ceilingsOf({ llmBudget: { usd: 2.5 } })).toEqual([
      { kind: "usd", limit: usdToMicros(2.5) },
    ]);
  });

  it("carries every declared axis, canonically ordered", () => {
    expect(ceilingsOf({ llmBudget: { calls: 20, tokens: 1000, usd: 1 } })?.map((c) => c.kind)).toEqual(
      ["usd", "tokens", "calls"],
    );
  });

  it("carries a single axis alone", () => {
    expect(ceilingsOf({ llmBudget: { calls: 20 } })).toEqual([{ kind: "calls", limit: 20 }]);
  });
});

describe("LlmBudgetConfigSchema: an empty block is a config error", () => {
  it("rejects a declaration that limits nothing", () => {
    // Writing `llmBudget: {}` expresses an intent to limit something. Reading it
    // as "unlimited" would be the most expensive possible misreading, so it is
    // refused at parse time rather than honoured silently. Absence — omitting
    // the key entirely — is how "no budget" is spelled.
    const parsed = LlmBudgetConfigSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("accepts any single axis and rejects non-positive limits", () => {
    expect(LlmBudgetConfigSchema.safeParse({ tokens: 1 }).success).toBe(true);
    expect(LlmBudgetConfigSchema.safeParse({ usd: 0.01 }).success).toBe(true);
    expect(LlmBudgetConfigSchema.safeParse({ calls: 1 }).success).toBe(true);
    expect(LlmBudgetConfigSchema.safeParse({ tokens: 0 }).success).toBe(false);
    expect(LlmBudgetConfigSchema.safeParse({ usd: -1 }).success).toBe(false);
  });

  it("rejects a fractional token or call count", () => {
    // Tokens and calls are counted, not measured. Dollars are measured, which is
    // why `usd` alone accepts a decimal.
    expect(LlmBudgetConfigSchema.safeParse({ tokens: 1.5 }).success).toBe(false);
    expect(LlmBudgetConfigSchema.safeParse({ calls: 1.5 }).success).toBe(false);
    expect(LlmBudgetConfigSchema.safeParse({ usd: 1.5 }).success).toBe(true);
  });
});
