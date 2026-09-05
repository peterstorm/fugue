import { describe, it, expect } from "bun:test";
import { tokensOnly } from "../types/token-usage.js";
import { computeCostUsd, isPricedModel, PRICE_TABLE, spendOfCall, spendOfUnknownCall } from "../llm/cost.js";
import * as fc from "fast-check";

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

  it("deeply freezes the shared pricing authority against tenant/DAG mutation", () => {
    const original = PRICE_TABLE["gpt-4o"];
    if (original === undefined) throw new Error("expected gpt-4o pricing");
    const before = spendOfCall("gpt-4o", tokensOnly(1_000_000, 0));

    expect(Object.isFrozen(PRICE_TABLE)).toBe(true);
    expect(Object.isFrozen(original)).toBe(true);
    expect(Reflect.set(PRICE_TABLE, "gpt-4o", { inputPer1M: 0, outputPer1M: 0 })).toBe(false);
    expect(Reflect.set(original, "inputPer1M", 0)).toBe(false);
    expect(Reflect.deleteProperty(PRICE_TABLE, "gpt-4o")).toBe(false);
    expect(Reflect.set(PRICE_TABLE, "attacker-model", { inputPer1M: 0, outputPer1M: 0 })).toBe(false);

    expect(PRICE_TABLE["gpt-4o"]).toBe(original);
    expect(PRICE_TABLE["attacker-model"]).toBeUndefined();
    expect(spendOfCall("gpt-4o", tokensOnly(1_000_000, 0))).toEqual(before);
  });
});

// ── Fail-closed classification of a call with untrustworthy usage ────────────
// When a provider does not report usable usage, the call axis stays exact but
// token and USD admission must fail closed. Whether that closure is `priced
// NO_MICROS` (a known model whose cost we simply could not read) or `unpriced`
// (a model we could never have costed) is the decision these two make, and it
// is what stops an unpriceable model from being free.

describe("isPricedModel", () => {
  it("is true for every model in the price table", () => {
    for (const model of Object.keys(PRICE_TABLE)) {
      expect(isPricedModel(model)).toBe(true);
    }
  });

  it("is false for a model with no price-table entry", () => {
    expect(isPricedModel("unknown-model-xyz")).toBe(false);
  });

  it("does not treat inherited Object properties as priced models", () => {
    // A prototype-chain lookup would make "toString"/"constructor" free.
    for (const key of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(isPricedModel(key)).toBe(false);
    }
  });

  it("is false for any string the price table does not own", () => {
    fc.assert(
      fc.property(fc.string(), (model) => {
        expect(isPricedModel(model)).toBe(
          Object.prototype.hasOwnProperty.call(PRICE_TABLE, model),
        );
      }),
    );
  });
});

describe("spendOfUnknownCall", () => {
  it("counts exactly one call and no tokens", () => {
    const spend = spendOfUnknownCall("gpt-4o");
    expect(spend.calls).toBe(1);
    expect(spend.tokens).toBe(0);
  });

  it("marks the usage unknown so ceiling evaluation fails closed", () => {
    expect(spendOfUnknownCall("gpt-4o").usage).toBe("unknown");
    expect(spendOfUnknownCall("unknown-model-xyz").usage).toBe("unknown");
  });

  it("reports a priced model's unreadable cost as priced-zero, not unpriced", () => {
    // The model IS costable; only this call's usage was unusable. The `unknown`
    // usage flag — not an unpriced marker — is what fails the token/USD axes.
    const spend = spendOfUnknownCall("gpt-4o");
    expect(spend.usd.kind).toBe("priced");
    if (spend.usd.kind === "priced") expect(spend.usd.micros as number).toBe(0);
  });

  it("reports an unpriceable model as unpriced, naming the model", () => {
    const spend = spendOfUnknownCall("unknown-model-xyz");
    expect(spend.usd.kind).toBe("unpriced");
    if (spend.usd.kind === "unpriced") {
      expect([...spend.usd.models]).toEqual(["unknown-model-xyz"]);
      expect(spend.usd.knownMicros as number).toBe(0);
    }
  });

  it("names any unpriceable model it is handed", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((m) => !isPricedModel(m)),
        (model) => {
          const spend = spendOfUnknownCall(model);
          expect(spend.usd.kind).toBe("unpriced");
          if (spend.usd.kind === "unpriced") expect([...spend.usd.models]).toContain(model);
        },
      ),
    );
  });

  it("never reports a positive cost — an unread usage must not look expensive OR free-with-headroom", () => {
    fc.assert(
      fc.property(fc.string(), (model) => {
        const spend = spendOfUnknownCall(model);
        expect(spend.usage).toBe("unknown");
        expect(
          (spend.usd.kind === "priced" ? spend.usd.micros : spend.usd.knownMicros) as number,
        ).toBe(0);
      }),
    );
  });
});
