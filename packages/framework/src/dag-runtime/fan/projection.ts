// projection — may the fan dispatch another child? (AD-4, FR-011, FR-013)
//
// Headroom-native: it reads only the host's `Remaining` ADT, never ceilings
// from config. `remainingChildren` = width − successfully completed, so it
// counts in-flight slots and the slot about to start. Their partial spend is
// therefore counted twice — once inside the host's projected spend, once in
// `remainingChildren × estimate` — which is deliberate and conservative.
//
// Per headroom kind:
//   unbudgeted        never refuses; no axis is projected
//   available         refuse when remainingChildren × estimate > amount
//   unpriced (usd)    refuse when observedAtLeast + remainingChildren × estimate
//   unknown-usage       > ceiling.limit, flagged lowerBound (so the known
//                       bound alone breaching refuses)
// The first breached axis in ceiling (headroom) order is reported. A null
// budget is the caller's `{ kind: "unbudgeted" }`: reading the budget is the
// shell's I/O, not this module's.
//
// Functional core: pure, no I/O.

import { match } from "ts-pattern";
import type { CeilingHeadroom, Remaining } from "../../types/budget-capability.js";
import type { Ceiling, CeilingKind } from "../../types/budget.js";
import type { SpendSample } from "../../types/fan-scheduling.js";

type CeilingOf<K extends CeilingKind> = Extract<Ceiling, { readonly kind: K }>;

type AxisCheckOf<K extends CeilingKind> = Readonly<{
  axis: K;
  ceiling: CeilingOf<K>;
  /** The per-child estimate on this axis, in the axis's unit. */
  estimate: number;
  /** The projected figure compared against `allowance`. */
  projected: number;
  /** What `projected` may not exceed: the headroom amount, or the ceiling limit for a lower bound. */
  allowance: number;
  /** True when the axis's spend is only a known lower bound (unpriced / unknown usage). */
  lowerBound: boolean;
}>;

/** One budgeted axis's projection. `axis` always equals `ceiling.kind`, by construction. */
export type AxisCheck = { [K in CeilingKind]: AxisCheckOf<K> }[CeilingKind];

export type Projection =
  | Readonly<{ kind: "admit"; checks: readonly AxisCheck[] }>
  | (Readonly<{ kind: "breach" }> & AxisCheck);

const axisCheck = <K extends CeilingKind>(
  axis: K,
  ceiling: CeilingOf<K>,
  estimate: number,
  base: number,
  remainingChildren: number,
  allowance: number,
  lowerBound: boolean,
): AxisCheckOf<K> =>
  Object.freeze({ axis, ceiling, estimate, projected: base + remainingChildren * estimate, allowance, lowerBound });

const checkOf = (h: CeilingHeadroom, n: number, e: SpendSample): AxisCheck =>
  match(h)
    .returnType<AxisCheck>()
    .with({ kind: "available", unit: "tokens" }, (a) => axisCheck("tokens", a.ceiling, e.tokens, 0, n, a.amount, false))
    .with({ kind: "available", unit: "calls" }, (a) => axisCheck("calls", a.ceiling, e.calls, 0, n, a.amount, false))
    .with({ kind: "available", unit: "usd" }, (a) => axisCheck("usd", a.ceiling, e.usdMicros, 0, n, a.amount, false))
    .with({ kind: "unpriced" }, (u) =>
      axisCheck("usd", u.ceiling, e.usdMicros, u.observedAtLeast, n, u.ceiling.limit, true))
    .with({ kind: "unknown-usage", ceiling: { kind: "tokens" } }, (u) =>
      axisCheck("tokens", u.ceiling, e.tokens, u.observedAtLeast, n, u.ceiling.limit, true))
    .with({ kind: "unknown-usage", ceiling: { kind: "usd" } }, (u) =>
      axisCheck("usd", u.ceiling, e.usdMicros, u.observedAtLeast, n, u.ceiling.limit, true))
    .exhaustive();

/** Fail-closed: a non-finite figure (`NaN`) breaches rather than admitting forever. */
const breaches = (c: AxisCheck): boolean => !(c.projected <= c.allowance);

const ADMIT_UNBUDGETED: Projection = Object.freeze({ kind: "admit", checks: Object.freeze([]) });

/** Project the fan's remaining spend on every budgeted axis against its headroom. */
export const project = (remaining: Remaining, remainingChildren: number, estimate: SpendSample): Projection =>
  match(remaining)
    .returnType<Projection>()
    .with({ kind: "unbudgeted" }, () => ADMIT_UNBUDGETED)
    .with({ kind: "budgeted" }, (b) => {
      const checks = Object.freeze(b.headroom.map((h) => checkOf(h, remainingChildren, estimate)));
      const breached = checks.find(breaches);
      return breached === undefined
        ? Object.freeze({ kind: "admit", checks })
        : Object.freeze({ kind: "breach", ...breached });
    })
    .exhaustive();
