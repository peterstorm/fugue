// seed — the ceiling half of resume-after-refusal (AD-11, FR-017, FR-026).
//
// A refused fan persists, in its refusal seed, every budgeted ceiling in force
// at the refusal decision (`ceilingsOfRemaining`). On resume in the same
// epoch, `ceilingsRaised` decides whether a budget-raising redeploy happened:
//   - the run is now unbudgeted, or
//   - a seeded axis is no longer limited, or
//   - some seeded axis's limit went UP.
// Anything else — equal limits, lowered limits, an extra axis added — keeps
// the refusal STICKY: the fan refuses again before dispatching any child.
// Ceilings cannot change without a redeploy, so "not raised" means "no
// budget-raising redeploy", independent of the remainder or per-child cost.
//
// Functional core: pure, no I/O.

import { match } from "ts-pattern";
import type { Remaining } from "../../types/budget-capability.js";
import type { Ceiling } from "../../types/budget.js";

/** Every budgeted ceiling of a headroom snapshot, in its (canonical) order. */
export const ceilingsOfRemaining = (remaining: Remaining): readonly Ceiling[] =>
  match(remaining)
    .returnType<readonly Ceiling[]>()
    .with({ kind: "unbudgeted" }, () => Object.freeze([]))
    .with({ kind: "budgeted" }, (b) => Object.freeze(b.headroom.map((h) => h.ceiling)))
    .exhaustive();

/** Whether `current` raised the budget relative to the `seeded` ceilings. */
export const ceilingsRaised = (seeded: readonly Ceiling[], current: Remaining): boolean => {
  if (current.kind === "unbudgeted") return true;
  const now = ceilingsOfRemaining(current);
  return seeded.some((s) => {
    const same = now.find((c) => c.kind === s.kind);
    return same === undefined || same.limit > s.limit;
  });
};
