/**
 * The durable encoding of a run's `Spend`, and the parse back out of it.
 *
 * Functional core: two pure total functions, no I/O. Every `SpendLedgerPort`
 * adapter shares them, so a run's spend means the same thing whichever backend
 * stored it — and a backend cannot invent an encoding the others cannot read.
 *
 * WHY THIS SHAPE: the encoding is chosen so that appending to it is the SAME
 * operation as `addSpend`. `Spend`'s monoid is (sum, sum, sum, set-union), and
 * every field below is one of those:
 *
 * | field            | append   | Redis        |
 * |------------------|----------|--------------|
 * | `tokens`         | sum      | `HINCRBY`    |
 * | `calls`          | sum      | `HINCRBY`    |
 * | `micros`         | sum      | `HINCRBY`    |
 * | `unpricedModels` | union    | `SADD`       |
 *
 * All four are atomic, commutative, and idempotent under re-application of the
 * same delta ordering, so concurrent writers cannot corrupt the record no
 * matter how their commands interleave — no lock, no read-modify-write, no
 * compare-and-swap. The alternative encoding (store a `Spend` blob and rewrite
 * it) would have needed all three.
 */

import type { MicroUsd, Spend, UnpricedModels } from "@fuguejs/framework";
import { costFloor } from "@fuguejs/framework";

/**
 * A run's accumulated spend, flattened to the four independently-appendable
 * fields above.
 *
 * `unpricedModels` empty means the total is PRICED; non-empty means some call
 * in the run had no price-table entry, and `micros` is then the priced portion
 * — a lower bound. That is exactly the `PricedSpend` union, encoded so that the
 * discriminant is derived from the set's emptiness rather than stored beside it
 * (a stored discriminant could disagree with the set it describes).
 */
export interface SpendRecord {
  readonly tokens: number;
  readonly calls: number;
  readonly micros: number;
  readonly unpricedModels: readonly string[];
}

/** Flatten a `Spend` for storage. Total — every `Spend` has an encoding. */
export const recordOf = (spend: Spend): SpendRecord => ({
  tokens: spend.tokens,
  calls: spend.calls,
  // The priced total, or the priced FLOOR of an unpriced aggregate. Both are
  // sums, which is what makes the stored field appendable.
  micros: costFloor(spend.usd),
  unpricedModels: spend.usd.kind === "unpriced" ? [...spend.usd.models] : [],
});

/**
 * Parse a stored record back into a `Spend`.
 *
 * Total rather than `Result`-returning: every field is independently coerced to
 * a usable value, so there is no input for which this fails. A backend that
 * returns a malformed figure yields a SAFE spend, not an error — and "safe"
 * here means erring toward MORE spend recorded, never less, because a budget
 * that under-counts is a budget that fails open.
 *
 * Non-finite and negative figures read as zero, exactly as `sanitizeCount` does
 * at the provider boundary and for the same reason: a `NaN` would poison every
 * later sum and make `NaN >= limit` false forever.
 *
 * Model names are sorted and de-duplicated so a hydrated `Spend` is structurally
 * equal to the one that was stored, whatever order the backend enumerated them
 * in. Without that, `addSpend`'s commutativity would hold in memory and break
 * across a resume.
 */
export const spendOfRecord = (record: SpendRecord): Spend => {
  const figure = (n: number): number => (Number.isFinite(n) ? Math.max(0, n) : 0);
  const models = [...new Set(record.unpricedModels.filter((m) => m.length > 0))].sort();
  const micros = figure(record.micros) as MicroUsd;
  const [head, ...rest] = models;
  return {
    tokens: figure(record.tokens),
    calls: figure(record.calls),
    usd:
      head === undefined
        ? { kind: "priced", micros }
        : {
            kind: "unpriced",
            models: [head, ...rest] as UnpricedModels,
            knownMicros: micros,
          },
  };
};

/**
 * Parse one stored numeric field.
 *
 * Absent reads as zero — a hash field a run never wrote is a run that never
 * spent on that axis, which is the same fact. An unparseable string also reads
 * as zero rather than failing the read: see `spendOfRecord` on why a malformed
 * figure must not become an error at this boundary.
 */
export const parseFigure = (raw: string | null | undefined): number => {
  if (raw === null || raw === undefined) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};
