// @fuguejs/framework/testing — stable subpath for test utilities.
// FakeLlmClient is also reachable from the main barrel (via llm/index.ts)
// for convenience; this subpath exists as the documented, stable import
// path for test tooling.

export { FakeLlmClient } from "./llm/fake-client.js";
export { createFakeHttpCapability, type FakeHttpRoute } from "./http/http-capability.js";

import type { BudgetCapability, CeilingHeadroom, Remaining } from "./types/budget-capability.js";
import { snapshotSpend } from "./types/budget-capability.js";
import type { MicroUsd, Spend } from "./types/spend.js";
import { NO_SPEND } from "./types/spend.js";

/**
 * `CeilingHeadroom`'s `unknown-usage` arm is a CORRELATED union: `TokensCeiling`
 * pairs with a plain `number` `observedAtLeast`, `UsdCeiling` with a branded
 * `MicroUsd`. TypeScript will not narrow `headroom` from a nested discriminant
 * (`headroom.ceiling.kind`), so this predicate is the narrowing that keeps the
 * two members apart. The USD and tokens branches below therefore read as
 * duplicates but are not interchangeable — collapsing them de-correlates
 * `ceiling` from `observedAtLeast` and fails the build.
 */
type UnknownUsdHeadroom = Extract<CeilingHeadroom, {
  readonly kind: "unknown-usage";
}> & {
  readonly ceiling: { readonly kind: "usd" };
  readonly observedAtLeast: MicroUsd;
};

const isUnknownUsdHeadroom = (headroom: CeilingHeadroom): headroom is UnknownUsdHeadroom =>
  headroom.kind === "unknown-usage" && headroom.ceiling.kind === "usd";

const snapshotHeadroom = (headroom: CeilingHeadroom): CeilingHeadroom => {
  if (headroom.kind === "unpriced") {
    return Object.freeze({
      ...headroom,
      ceiling: Object.freeze({ ...headroom.ceiling }),
      models: Object.freeze([...headroom.models]) as typeof headroom.models,
    });
  }
  if (isUnknownUsdHeadroom(headroom)) {
    return Object.freeze({
      kind: "unknown-usage",
      ceiling: Object.freeze({ ...headroom.ceiling }),
      observedAtLeast: headroom.observedAtLeast,
    });
  }
  if (headroom.kind === "unknown-usage") {
    return Object.freeze({
      kind: "unknown-usage",
      ceiling: Object.freeze({ ...headroom.ceiling }),
      observedAtLeast: headroom.observedAtLeast,
    });
  }
  switch (headroom.unit) {
    case "tokens":
      return Object.freeze({
        kind: "available",
        unit: "tokens",
        ceiling: Object.freeze({ ...headroom.ceiling }),
        amount: headroom.amount,
      });
    case "calls":
      return Object.freeze({
        kind: "available",
        unit: "calls",
        ceiling: Object.freeze({ ...headroom.ceiling }),
        amount: headroom.amount,
      });
    case "usd":
      return Object.freeze({
        kind: "available",
        unit: "usd",
        ceiling: Object.freeze({ ...headroom.ceiling }),
        amount: headroom.amount,
      });
  }
};

const snapshotRemaining = (remaining: Remaining): Remaining =>
  remaining.kind === "unbudgeted"
    ? Object.freeze({ kind: "unbudgeted" })
    : Object.freeze({
        kind: "budgeted",
        basis: "projected",
        headroom: Object.freeze(remaining.headroom.map(snapshotHeadroom)),
      });

/** Deterministic read-only budget fixture for node tests. */
export const fixedBudgetCapability = (
  spent: Spend = NO_SPEND,
  remaining: Remaining = { kind: "unbudgeted" },
): BudgetCapability => ({
  spent: () => snapshotSpend(spent),
  remaining: () => snapshotRemaining(remaining),
});
