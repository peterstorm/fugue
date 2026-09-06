import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import type { MicroUsd, PricedSpend, Spend } from "@fuguejs/framework";
import {
  NO_MICROS,
  NO_SPEND,
  addSpend,
  pricedCall,
  unknownUsageCall,
  unpricedCall,
} from "@fuguejs/framework";
import {
  recordOf,
  spendOfHash,
  SPEND_HASH_FIELDS,
  SPEND_MARKER_VALUE,
  SPEND_USAGE_UNKNOWN_FIELD,
  unpricedModelHashField,
} from "../domain/spend-record.js";

const micros = (n: number): MicroUsd => n as MicroUsd;
const modelName = fc
  .array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 12 })
  .map((codeUnits) => String.fromCharCode(...codeUnits));
const arbSpend: fc.Arbitrary<Spend> = fc.oneof(
  fc.record({
    usage: fc.constantFrom("known" as const, "unknown" as const),
    tokens: fc.nat({ max: 1_000_000 }),
    calls: fc.nat({ max: 100 }),
    usd: fc.nat({ max: 10_000_000 }).map((m): PricedSpend => ({ kind: "priced", micros: micros(m) })),
  }),
  fc.record({
    usage: fc.constantFrom("known" as const, "unknown" as const),
    tokens: fc.nat({ max: 1_000_000 }),
    calls: fc.nat({ max: 100 }),
    usd: fc
      .tuple(fc.uniqueArray(modelName, { minLength: 1, maxLength: 3 }), fc.nat({ max: 10_000_000 }))
      .map(([models, m]): PricedSpend => ({
        kind: "unpriced",
        models: [...models].sort() as unknown as readonly [string, ...string[]],
        knownMicros: micros(m),
      })),
  }),
);

const hashOf = (spend: Spend): Readonly<Record<string, string>> => {
  const record = recordOf(spend);
  return {
    ...(record.usageUnknown ? { [SPEND_USAGE_UNKNOWN_FIELD]: SPEND_MARKER_VALUE } : {}),
    [SPEND_HASH_FIELDS.micros]: String(record.micros),
    [SPEND_HASH_FIELDS.tokens]: String(record.tokens),
    [SPEND_HASH_FIELDS.calls]: String(record.calls),
    ...Object.fromEntries(record.unpricedModels.map((model) => [
      unpricedModelHashField(model),
      SPEND_MARKER_VALUE,
    ])),
  };
};

const parseOrThrow = (hash: Readonly<Record<string, string>>): Spend => {
  const parsed = spendOfHash(hash);
  if (!parsed.ok) throw new Error(`${parsed.error.field}: ${parsed.error.reason}`);
  return parsed.value;
};

describe("spend-record: one-hash round trip", () => {
  it("is the identity for every Spend", () => {
    fc.assert(fc.property(arbSpend, (spend) => {
      expect(parseOrThrow(hashOf(spend))).toEqual(spend);
    }));
  });

  it("reads an absent hash as priced NO_SPEND", () => {
    expect(parseOrThrow({})).toEqual(NO_SPEND);
  });

  it("sorts marker fields canonically and decodes arbitrary UTF-16 model names", () => {
    fc.assert(fc.property(modelName, (model) => {
      const parsed = parseOrThrow({ [unpricedModelHashField(model)]: "1" });
      if (parsed.usd.kind !== "unpriced") throw new Error("expected unpriced");
      expect([...parsed.usd.models]).toEqual([model]);
    }));
  });

  it("round-trips lone surrogates without throwing", () => {
    const model = `prefix-${String.fromCharCode(0xd800)}-suffix`;
    expect(() => unpricedModelHashField(model)).not.toThrow();
    const parsed = parseOrThrow({ [unpricedModelHashField(model)]: "1" });
    if (parsed.usd.kind !== "unpriced") throw new Error("expected unpriced");
    expect(parsed.usd.models).toEqual([model]);
  });
});

describe("spend-record: strict controlled-field grammar", () => {
  it.each([
    ["unknown", { other: "1" }, "unknown-field"],
    ["negative", { tokens: "-1" }, "invalid-numeric-value"],
    ["decimal", { calls: "1.5" }, "invalid-numeric-value"],
    ["exponent", { micros: "1e3" }, "invalid-numeric-value"],
    ["leading zero", { tokens: "01" }, "invalid-numeric-value"],
    ["unsafe", { tokens: "9007199254740992" }, "invalid-numeric-value"],
    ["marker field", { "$unpriced:000": "1" }, "invalid-marker-field"],
    ["non-canonical marker field", { "$unpriced:004A": "1" }, "invalid-marker-field"],
    ["marker value", { [unpricedModelHashField("model")]: "2" }, "invalid-marker-value"],
    ["usage marker value", { [SPEND_USAGE_UNKNOWN_FIELD]: "2" }, "invalid-marker-value"],
  ] as const)("rejects %s data", (_label, hash, reason) => {
    const parsed = spendOfHash(hash);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.reason).toBe(reason);
  });
});

describe("spend-record: append algebra", () => {
  it("numeric sums and model-field union encode addSpend", () => {
    fc.assert(fc.property(arbSpend, arbSpend, (a, b) => {
      const summed = recordOf(addSpend(a, b));
      const ra = recordOf(a);
      const rb = recordOf(b);
      expect(summed.tokens).toBe(ra.tokens + rb.tokens);
      expect(summed.calls).toBe(ra.calls + rb.calls);
      expect(summed.micros).toBe(ra.micros + rb.micros);
      expect(summed.usageUnknown).toBe(ra.usageUnknown || rb.usageUnknown);
      expect([...summed.unpricedModels].sort()).toEqual(
        [...new Set([...ra.unpricedModels, ...rb.unpricedModels])].sort(),
      );
    }));
  });

  it("persists unknown usage as an absorbing marker", () => {
    const unknown = unknownUsageCall({ kind: "priced", micros: NO_MICROS });
    expect(parseOrThrow(hashOf(unknown))).toEqual(unknown);
    expect(recordOf(addSpend(pricedCall(1, micros(1)), unknown)).usageUnknown).toBe(true);
  });

  it("keeps the priced floor when an unpriced call joins a priced total", () => {
    const record = recordOf(addSpend(pricedCall(10, micros(750)), unpricedCall(5, "mystery")));
    expect(record.micros).toBe(750);
    expect([...record.unpricedModels]).toEqual(["mystery"]);
  });
});
