import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import { ceilings } from "../types/budget.js";
import { remainingFor, snapshotSpend } from "../types/budget-capability.js";
import { fixedBudgetCapability } from "../testing.js";
import type { Ceiling } from "../types/budget.js";
import type { MicroUsd, Spend, SpendInput } from "../types/spend.js";
import type { Remaining } from "../types/budget-capability.js";
import { NO_SPEND } from "../types/spend.js";
import { makeSpend, unpricedModels } from "../types/spend.js";

const spendOf = (input: SpendInput): Spend => makeSpend(input);
const modelsOf = (names: readonly string[]) => {
  const models = unpricedModels(names);
  if (models === undefined) throw new Error("expected non-empty models");
  return models;
};

const nonNegativeInteger = fc.integer({ min: 0, max: 1_000_000 });
const pricedSpend = fc.record({
  tokens: nonNegativeInteger,
  calls: nonNegativeInteger,
  micros: nonNegativeInteger,
}).map(({ tokens, calls, micros }): Spend => spendOf({
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
    expect(remainingFor(undefined, spendOf({
      usage: "known",
      tokens: 99,
      calls: 2,
      usd: { kind: "priced", micros: 30 as MicroUsd },
    }))).toEqual({ kind: "unbudgeted" });
  });

  it("clamps reached numeric ceilings to zero", () => {
    const limits = ceilings([{ kind: "tokens", limit: 10 }])!;
    expect(remainingFor(limits, spendOf({
      usage: "known",
      tokens: 12,
      calls: 1,
      usd: { kind: "priced", micros: 0 as MicroUsd },
    }))).toEqual({
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
    const projected = spendOf({
      usage: "known",
      tokens: 3,
      calls: 1,
      usd: { kind: "priced", micros: 20 as MicroUsd },
    });
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
    const remaining = remainingFor(limits, spendOf({
      usage: "unknown",
      tokens: 3,
      calls: 1,
      usd: { kind: "priced", micros: 20 as MicroUsd },
    }));

    if (remaining.kind !== "budgeted") throw new Error("expected budgeted");
    expect(remaining.headroom.map((headroom) => headroom.kind)).toEqual([
      "unknown-usage",
      "unknown-usage",
      "available",
    ]);
  });

  it("reports deeply frozen unpriced USD headroom as domain data, never a number", () => {
    const limits = ceilings([{ kind: "usd", limit: 500 as MicroUsd }])!;
    const remaining = remainingFor(limits, spendOf({
      usage: "known",
      tokens: 3,
      calls: 1,
      usd: {
        kind: "unpriced",
        models: modelsOf(["new-model"]),
        knownMicros: 20 as MicroUsd,
      },
    }));
    expect(remaining).toEqual({
      kind: "budgeted",
      basis: "projected",
      headroom: [{
        kind: "unpriced",
        ceiling: { kind: "usd", limit: 500 as MicroUsd },
        models: modelsOf(["new-model"]),
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
        const remaining = remainingFor(limits, spendOf({
          usage: "known",
          tokens: 0,
          calls: 1,
          usd: {
            kind: "unpriced",
            models: modelsOf(names),
            knownMicros: knownMicros as MicroUsd,
          },
        }));
        if (remaining.kind !== "budgeted") throw new Error("generated limits are non-empty");
        expect(remaining.headroom.some((h) => h.kind === "unpriced"))
          .toBe(limits.some((c) => c.kind === "usd"));
      },
    ));
  });
});

describe("fixedBudgetCapability", () => {
  it.each([
    [
      "tokens available",
      { kind: "available", unit: "tokens", ceiling: { kind: "tokens", limit: 1000 }, amount: 400 },
    ],
    [
      "calls available",
      { kind: "available", unit: "calls", ceiling: { kind: "calls", limit: 5 }, amount: 2 },
    ],
    [
      "usd available",
      { kind: "available", unit: "usd", ceiling: { kind: "usd", limit: 900 as MicroUsd }, amount: 250 as MicroUsd },
    ],
    [
      "unpriced",
      {
        kind: "unpriced",
        ceiling: { kind: "usd", limit: 900 as MicroUsd },
        models: modelsOf(["a-model", "z-model"]),
        observedAtLeast: 120 as MicroUsd,
      },
    ],
    [
      "unknown-usage on the tokens axis",
      { kind: "unknown-usage", ceiling: { kind: "tokens", limit: 1000 }, observedAtLeast: 30 },
    ],
    [
      "unknown-usage on the usd axis",
      { kind: "unknown-usage", ceiling: { kind: "usd", limit: 900 as MicroUsd }, observedAtLeast: 30 as MicroUsd },
    ],
  ] as const)(
    "snapshots and isolates a budgeted %s headroom",
    (_label, headroom) => {
      // The fixture's whole job is handing a node a value it cannot use to
      // reach back into the test's own state — and `snapshotHeadroom` has one
      // branch per headroom member to do it. Only the default `unbudgeted`
      // path was ever exercised, so a branch that forgot to copy the ceiling
      // (or dropped the discriminant that keeps the tokens and usd arms apart,
      // which the module's own comment flags as easy to de-correlate) would
      // have quietly corrupted every node test built on this fixture.
      const source: Remaining = { kind: "budgeted", basis: "projected", headroom: [headroom] };
      const fake = fixedBudgetCapability(NO_SPEND, source);

      const first = fake.remaining();
      expect(first).toEqual(source);

      // A fresh, deeply frozen value every read — never the caller's object.
      const second = fake.remaining();
      expect(first).not.toBe(second);
      expect(first).toEqual(second);
      if (first.kind !== "budgeted") throw new Error("expected budgeted");
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.headroom)).toBe(true);
      expect(Object.isFrozen(first.headroom[0])).toBe(true);
      expect(first.headroom[0]).not.toBe(headroom);
      expect(Object.isFrozen(first.headroom[0]?.ceiling)).toBe(true);
      expect(first.headroom[0]?.ceiling).not.toBe(headroom.ceiling);
    },
  );

  it("keeps every headroom member of a multi-ceiling budget, in order", () => {
    // The `.map(snapshotHeadroom)` has to be total: a budget declaring three
    // axes must come back with three, not with the ones whose branch happened
    // to be implemented.
    const headroom = [
      { kind: "available", unit: "tokens", ceiling: { kind: "tokens", limit: 10 }, amount: 4 },
      { kind: "available", unit: "calls", ceiling: { kind: "calls", limit: 3 }, amount: 1 },
      { kind: "unknown-usage", ceiling: { kind: "usd", limit: 5 as MicroUsd }, observedAtLeast: 2 as MicroUsd },
    ] as const;
    const fake = fixedBudgetCapability(NO_SPEND, {
      kind: "budgeted",
      basis: "projected",
      headroom: [...headroom],
    });

    const snapshot = fake.remaining();
    if (snapshot.kind !== "budgeted") throw new Error("expected budgeted");
    expect(snapshot.headroom).toEqual([...headroom]);
    expect(snapshot.headroom.map((h) => h.ceiling.kind)).toEqual(["tokens", "calls", "usd"]);
  });

  it("provides deterministic fresh snapshots for node tests", () => {
    const fake = fixedBudgetCapability(spendOf({
      usage: "known",
      tokens: 7,
      calls: 1,
      usd: { kind: "priced", micros: 3 as MicroUsd },
    }));
    expect(fake.spent()).toEqual(spendOf({
      usage: "known",
      tokens: 7,
      calls: 1,
      usd: { kind: "priced", micros: 3 as MicroUsd },
    }));
    expect(fake.spent()).not.toBe(fake.spent());
    expect(fake.remaining()).toEqual({ kind: "unbudgeted" });
  });
});

describe("snapshotSpend", () => {
  it("returns fresh deeply frozen snapshots isolated from consumer mutation", () => {
    const source = spendOf({
      usage: "known",
      tokens: 4,
      calls: 1,
      usd: {
        kind: "unpriced",
        models: modelsOf(["x"]),
        knownMicros: 2 as MicroUsd,
      },
    });
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
