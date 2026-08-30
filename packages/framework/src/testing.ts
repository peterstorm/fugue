// @fuguejs/framework/testing — stable subpath for test utilities.
// FakeLlmClient is also reachable from the main barrel (via llm/index.ts)
// for convenience; this subpath exists as the documented, stable import
// path for test tooling.

export { FakeLlmClient } from "./llm/fake-client.js";
export { createFakeHttpCapability, type FakeHttpRoute } from "./http/http-capability.js";

import type { BudgetCapability, CeilingHeadroom, Remaining } from "./types/budget-capability.js";
import { snapshotSpend } from "./types/budget-capability.js";
import type { Spend } from "./types/spend.js";
import { NO_SPEND } from "./types/spend.js";

const snapshotHeadroom = (headroom: CeilingHeadroom): CeilingHeadroom => {
  if (headroom.kind === "unpriced") {
    return Object.freeze({
      ...headroom,
      ceiling: Object.freeze({ ...headroom.ceiling }),
      models: Object.freeze([...headroom.models]) as typeof headroom.models,
    });
  }
  switch (headroom.unit) {
    case "tokens":
      return Object.freeze({ ...headroom, ceiling: Object.freeze({ ...headroom.ceiling }) });
    case "calls":
      return Object.freeze({ ...headroom, ceiling: Object.freeze({ ...headroom.ceiling }) });
    case "usd":
      return Object.freeze({ ...headroom, ceiling: Object.freeze({ ...headroom.ceiling }) });
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
