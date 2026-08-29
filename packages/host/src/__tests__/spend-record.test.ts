/**
 * The durable encoding of `Spend` (domain/spend-record.ts).
 *
 * The load-bearing property is a ROUND TRIP: a spend written to a ledger and
 * read back in a later slice must be the same value, or the budget silently
 * changes meaning across a resume. It gets a property test rather than
 * examples, because the interesting inputs are the ones nobody thinks of.
 */

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import type { MicroUsd, PricedSpend, Spend } from "@fuguejs/framework";
import { NO_SPEND, addSpend, pricedCall, unpricedCall } from "@fuguejs/framework";
import { parseFigure, recordOf, spendOfRecord } from "../domain/spend-record.js";

const micros = (n: number): MicroUsd => n as MicroUsd;

const arbSpend: fc.Arbitrary<Spend> = fc.oneof(
  fc.record({
    tokens: fc.nat({ max: 1_000_000 }),
    calls: fc.nat({ max: 100 }),
    usd: fc.nat({ max: 10_000_000 }).map((m): PricedSpend => ({ kind: "priced", micros: micros(m) })),
  }),
  fc.record({
    tokens: fc.nat({ max: 1_000_000 }),
    calls: fc.nat({ max: 100 }),
    usd: fc
      .tuple(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 3 }),
        fc.nat({ max: 10_000_000 }),
      )
      .map(([models, m]): PricedSpend => ({
        kind: "unpriced",
        models: [...models].sort() as unknown as readonly [string, ...string[]],
        knownMicros: micros(m),
      })),
  }),
);

describe("spend-record: round trip", () => {
  it("is the identity for every Spend", () => {
    // If this ever stops holding, a run's budget means one thing before a park
    // and something else after it.
    fc.assert(
      fc.property(arbSpend, (spend) => {
        expect(spendOfRecord(recordOf(spend))).toEqual(spend);
      }),
    );
  });

  it("round-trips NO_SPEND to a PRICED zero, not an unpriced one", () => {
    // A run that has spent nothing has a known cost of zero. Decoding it as
    // `unpriced` would make every fresh budgeted run refuse on its first call.
    expect(spendOfRecord(recordOf(NO_SPEND))).toEqual(NO_SPEND);
    expect(spendOfRecord(recordOf(NO_SPEND)).usd.kind).toBe("priced");
  });

  it("preserves the priced/unpriced discriminant through the encoding", () => {
    fc.assert(
      fc.property(arbSpend, (spend) => {
        expect(spendOfRecord(recordOf(spend)).usd.kind).toBe(spend.usd.kind);
      }),
    );
  });
});

describe("spend-record: the discriminant is DERIVED from the model set", () => {
  it("reads an empty model list as priced and a non-empty one as unpriced", () => {
    // Storing the discriminant beside the set it describes would make
    // `kind: "priced"` with a non-empty set representable — a record that
    // contradicts itself. Deriving it removes that state entirely.
    expect(spendOfRecord({ tokens: 1, calls: 1, micros: 5, unpricedModels: [] }).usd.kind).toBe("priced");
    expect(spendOfRecord({ tokens: 1, calls: 1, micros: 5, unpricedModels: ["m"] }).usd.kind).toBe("unpriced");
  });

  it("ignores empty-string model names rather than fabricating an unpriced total", () => {
    // A backend that returned `[""]` for an absent set would otherwise flip a
    // perfectly priced run to unevaluable and refuse it under a usd ceiling.
    expect(spendOfRecord({ tokens: 1, calls: 1, micros: 5, unpricedModels: [""] }).usd.kind).toBe("priced");
  });

  it("sorts and de-duplicates, so a hydrated spend equals the stored one", () => {
    // Redis SMEMBERS has no defined order. Without canonicalising here,
    // `addSpend`'s commutativity would hold in memory and break across a
    // resume — the same value comparing unequal to itself.
    const decoded = spendOfRecord({
      tokens: 0, calls: 0, micros: 0,
      unpricedModels: ["z", "a", "z", "m"],
    });
    if (decoded.usd.kind !== "unpriced") throw new Error("expected unpriced");
    expect([...decoded.usd.models]).toEqual(["a", "m", "z"]);
  });
});

describe("spend-record: malformed figures read SAFE, never as an error", () => {
  it("clamps non-finite and negative figures to zero", () => {
    const decoded = spendOfRecord({
      tokens: Number.NaN,
      calls: -5,
      micros: Number.POSITIVE_INFINITY,
      unpricedModels: [],
    });
    expect(decoded.tokens).toBe(0);
    expect(decoded.calls).toBe(0);
    if (decoded.usd.kind !== "priced") throw new Error("expected priced");
    expect(decoded.usd.micros).toBe(micros(0));
  });

  it("parses a stored string field, treating absent and unparseable as zero", () => {
    expect(parseFigure("1234")).toBe(1234);
    expect(parseFigure(undefined)).toBe(0);
    expect(parseFigure(null)).toBe(0);
    expect(parseFigure("not-a-number")).toBe(0);
    expect(parseFigure("-99")).toBe(0);
  });
});

describe("spend-record: the encoding is appendable", () => {
  it("summing two records equals encoding their sum — the whole reason for the shape", () => {
    // This is what lets an adapter use HINCRBY instead of a read-modify-write.
    // If it stopped holding, concurrent appends would need a lock.
    fc.assert(
      fc.property(arbSpend, arbSpend, (a, b) => {
        const summed = recordOf(addSpend(a, b));
        const ra = recordOf(a);
        const rb = recordOf(b);
        expect(summed.tokens).toBe(ra.tokens + rb.tokens);
        expect(summed.calls).toBe(ra.calls + rb.calls);
        expect(summed.micros).toBe(ra.micros + rb.micros);
        expect([...summed.unpricedModels].sort()).toEqual(
          [...new Set([...ra.unpricedModels, ...rb.unpricedModels])].sort(),
        );
      }),
    );
  });

  it("keeps the priced floor when an unpriced call joins a priced total", () => {
    const record = recordOf(addSpend(pricedCall(10, micros(750)), unpricedCall(5, "mystery")));
    expect(record.micros).toBe(750);
    expect([...record.unpricedModels]).toEqual(["mystery"]);
  });
});
