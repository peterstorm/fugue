import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import { ceilings } from "../types/budget.js";
import { remainingFor, snapshotSpend } from "../types/budget-capability.js";
import { fixedBudgetCapability } from "../testing.js";
import type { Ceiling } from "../types/budget.js";
import type { MicroUsd, Spend } from "../types/spend.js";

const nonNegativeInteger = fc.integer({ min: 0, max: 1_000_000 });
const pricedSpend = fc.record({
  tokens: nonNegativeInteger,
  calls: nonNegativeInteger,
  micros: nonNegativeInteger,
}).map(({ tokens, calls, micros }): Spend => ({
  usage: "known",
  tokens,
  calls,
  usd: { kind: "priced", micros: micros as MicroUsd },
}));

const declaredCeilings = fc
  .array(
    fc.oneof(
      nonNegativeInteger.map((limit): Ceiling => ({ kind: "tokens", limit })),
      nonNegativeInteger.map((limit): Ceiling => ({ kind: "calls", limit })),
      nonNegativeInteger.map((limit): Ceiling => ({ kind: "usd", limit: limit as MicroUsd })),
    ),
    { minLength: 1, maxLength: 8 },
  )
  .map((raw) => ceilings(raw)!);

describe("remainingFor", () => {
  it("an unbudgeted run remains total and distinct", () => {
    expect(remainingFor(undefined, {
      usage: "known",
      tokens: 99,
      calls: 2,
      usd: { kind: "priced", micros: 30 as MicroUsd },
    })).toEqual({ kind: "unbudgeted" });
  });

  it("clamps reached numeric ceilings to zero", () => {
    const limits = ceilings([{ kind: "tokens", limit: 10 }])!;
    expect(remainingFor(limits, {
      usage: "known",
      tokens: 12,
      calls: 1,
      usd: { kind: "priced", micros: 0 as MicroUsd },
    })).toEqual({
      kind: "budgeted",
      basis: "projected",
      headroom: [{ kind: "available", unit: "tokens", ceiling: { kind: "tokens", limit: 10 }, amount: 0 }],
    });
  });

  it("returns fresh deeply frozen snapshots with MicroUsd monetary headroom", () => {
    const limits = ceilings([
      { kind: "tokens", limit: 10 },
      { kind: "usd", limit: 500 as MicroUsd },
    ])!;
    const projected: Spend = {
      usage: "known",
      tokens: 3,
      calls: 1,
      usd: { kind: "priced", micros: 20 as MicroUsd },
    };
    const first = remainingFor(limits, projected);
    const second = remainingFor(limits, projected);

    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    if (first.kind !== "budgeted" || second.kind !== "budgeted") {
      throw new Error("expected budgeted snapshots");
    }
    expect(first.headroom).not.toBe(second.headroom);
    expect(Object.isFrozen(first.headroom)).toBe(true);
    for (const headroom of first.headroom) {
      expect(Object.isFrozen(headroom)).toBe(true);
      expect(Object.isFrozen(headroom.ceiling)).toBe(true);
      if (headroom.kind === "available" && headroom.unit === "usd") {
        const amount: MicroUsd = headroom.amount;
        expect(amount).toBe(480 as MicroUsd);
      }
    }
    expect(() => (first.headroom as unknown as Ceiling[]).push({ kind: "calls", limit: 1 })).toThrow();
    expect(second.headroom).toEqual(first.headroom);
  });

  it("reports unknown token and USD headroom without inventing availability", () => {
    const limits = ceilings([
      { kind: "tokens", limit: 500 },
      { kind: "calls", limit: 5 },
      { kind: "usd", limit: 500 as MicroUsd },
    ])!;
    const remaining = remainingFor(limits, {
      usage: "unknown",
      tokens: 3,
      calls: 1,
      usd: { kind: "priced", micros: 20 as MicroUsd },
    });

    if (remaining.kind !== "budgeted") throw new Error("expected budgeted");
    expect(remaining.headroom.map((headroom) => headroom.kind)).toEqual([
      "unknown-usage",
      "unknown-usage",
      "available",
    ]);
  });

  it("reports deeply frozen unpriced USD headroom as domain data, never a number", () => {
    const limits = ceilings([{ kind: "usd", limit: 500 as MicroUsd }])!;
    const remaining = remainingFor(limits, {
      usage: "known",
      tokens: 3,
      calls: 1,
      usd: { kind: "unpriced", models: ["new-model"], knownMicros: 20 as MicroUsd },
    });
    expect(remaining).toEqual({
      kind: "budgeted",
      basis: "projected",
      headroom: [{
        kind: "unpriced",
        ceiling: { kind: "usd", limit: 500 as MicroUsd },
        models: ["new-model"],
        observedAtLeast: 20 as MicroUsd,
      }],
    });
    const unpriced = remaining.kind === "budgeted" ? remaining.headroom[0] : undefined;
    if (unpriced?.kind !== "unpriced") throw new Error("expected unpriced budget headroom");
    expect(Object.isFrozen(unpriced.models)).toBe(true);
    expect(() => {
      (unpriced.models as unknown as string[]).push("poison");
    }).toThrow();
  });

  it("preserves canonical axes and never exposes negative headroom (property)", () => {
    fc.assert(fc.property(declaredCeilings, pricedSpend, (limits, spend) => {
      const remaining = remainingFor(limits, spend);
      expect(remaining.kind).toBe("budgeted");
      if (remaining.kind !== "budgeted") return;
      expect(remaining.headroom.map((h) => h.ceiling.kind)).toEqual(limits.map((c) => c.kind));
      for (const headroom of remaining.headroom) {
        expect(headroom.kind).toBe("available");
        if (headroom.kind === "available") expect(headroom.amount).toBeGreaterThanOrEqual(0);
      }
    }));
  });

  it("emits unpriced iff a USD axis must evaluate unpriced projected spend (property)", () => {
    fc.assert(fc.property(
      declaredCeilings,
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 1, maxLength: 4 }),
      nonNegativeInteger,
      (limits, names, knownMicros) => {
        const [head, ...rest] = [...names].sort();
        const remaining = remainingFor(limits, {
          usage: "known",
          tokens: 0,
          calls: 1,
          usd: {
            kind: "unpriced",
            models: [head!, ...rest],
            knownMicros: knownMicros as MicroUsd,
          },
        });
        if (remaining.kind !== "budgeted") throw new Error("generated limits are non-empty");
        expect(remaining.headroom.some((h) => h.kind === "unpriced"))
          .toBe(limits.some((c) => c.kind === "usd"));
      },
    ));
  });
});

describe("fixedBudgetCapability", () => {
  it("provides deterministic fresh snapshots for node tests", () => {
    const fake = fixedBudgetCapability({
      usage: "known",
      tokens: 7,
      calls: 1,
      usd: { kind: "priced", micros: 3 as MicroUsd },
    });
    expect(fake.spent()).toEqual({
      usage: "known",
      tokens: 7,
      calls: 1,
      usd: { kind: "priced", micros: 3 as MicroUsd },
    });
    expect(fake.spent()).not.toBe(fake.spent());
    expect(fake.remaining()).toEqual({ kind: "unbudgeted" });
  });
});

describe("snapshotSpend", () => {
  it("returns fresh deeply frozen snapshots isolated from consumer mutation", () => {
    const source: Spend = {
      usage: "known",
      tokens: 4,
      calls: 1,
      usd: { kind: "unpriced", models: ["x"], knownMicros: 2 as MicroUsd },
    };
    const first = snapshotSpend(source);
    const second = snapshotSpend(source);

    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.usd)).toBe(true);
    const firstUsd = first.usd;
    if (firstUsd.kind === "unpriced") {
      expect(Object.isFrozen(firstUsd.models)).toBe(true);
      expect(() => (firstUsd.models as unknown as string[]).push("poison")).toThrow();
    }
    expect(second).toEqual(source);
  });
});
