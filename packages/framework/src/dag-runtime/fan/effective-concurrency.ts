// effective-concurrency — how many of a fan's children may be in flight
// (FR-002, FR-033): the authored limit, clamped to the host maximum.
//
// `clamped` is what the shell turns into the once-per-fan-start warning and
// the `fan-start` event naming the authored and effective values.
//
// Functional core: pure, no I/O.

import {
  childConcurrency,
  type ChildConcurrency,
  type FanConcurrencyCap,
} from "../../types/fan-scheduling.js";

type EffectiveConcurrency = Readonly<{
  /** `min(authored, cap)` — a positive safe integer, so a fan can never stall at 0 slots. */
  effective: ChildConcurrency;
  /** True iff the host cap lowered the authored value. */
  clamped: boolean;
}>;

export const effectiveConcurrency = (
  authored: ChildConcurrency,
  cap: FanConcurrencyCap,
): EffectiveConcurrency =>
  Object.freeze({
    // Both operands are positive safe integers, so the smart constructor
    // cannot throw here; it mints the brand without a cast (INV-3).
    effective: childConcurrency(Math.min(authored, cap)),
    clamped: authored > cap,
  });
