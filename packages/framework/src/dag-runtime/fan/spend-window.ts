// spend-window — one fan child's measured spend (AD-3, FR-018's M).
//
// The shell samples the run-wide `budget.spent()` at slot start (before
// `executeChild`) and at slot settle (after `saveNode`); the child's sample is
// the per-axis delta of that LIFETIME WINDOW. `BudgetCapability` is run-wide,
// so under concurrency a child's own cost is unobservable — but the window
// delta is never LESS than the child's true settled cost (sibling spend inside
// the window only adds to it), and it is exact at concurrency 1. Projection
// fed with it can therefore only refuse earlier, and every bound stated
// against M (the per-axis maximum of these samples over the fan, including
// drain completions and seeded samples) is no weaker against true spend.
//
// A replayed index produces NO sample: it spent nothing in this run.
//
// Functional core: pure, no I/O.

import type { SpendSample } from "../../types/fan-scheduling.js";
import { costFloor, microUsd, type Spend } from "../../types/spend.js";

/**
 * True when a snapshot's figures are known to under-count: unknown usage
 * (tokens and cost are lower bounds) or an unpriced model (cost is the priced
 * floor only).
 */
const undercounts = (s: Spend): boolean => s.usage === "unknown" || s.usd.kind === "unpriced";

/**
 * The window sample `after − before`, per axis, floored at 0. Tokens and calls
 * are integer counts; USD is the difference of the known cost floors in
 * MicroUsd, flagged `lowerBound` when either end of the window under-counts.
 */
export const spendDelta = (before: Spend, after: Spend): SpendSample =>
  Object.freeze({
    tokens: Math.max(0, after.tokens - before.tokens),
    calls: Math.max(0, after.calls - before.calls),
    usdMicros: microUsd(Math.max(0, costFloor(after.usd) - costFloor(before.usd))),
    lowerBound: undercounts(before) || undercounts(after),
  });
