import { match } from "ts-pattern";
import type { Ceiling, Ceilings, UsdCeiling } from "./budget.js";
import type { MicroUsd, Spend, UnpricedModels } from "./spend.js";

export type CeilingHeadroom =
  | {
      readonly kind: "available";
      readonly ceiling: Ceiling;
      /** Non-negative headroom in the ceiling's own unit. */
      readonly amount: number;
    }
  | {
      readonly kind: "unpriced";
      readonly ceiling: UsdCeiling;
      readonly models: UnpricedModels;
      readonly observedAtLeast: MicroUsd;
    };

export type Remaining =
  | { readonly kind: "unbudgeted" }
  | {
      readonly kind: "budgeted";
      readonly basis: "projected";
      readonly headroom: readonly CeilingHeadroom[];
    };

/** Read-only node view over the run-scoped spend authority. */
export interface BudgetCapability {
  readonly spent: () => Spend;
  readonly remaining: () => Remaining;
}

const snapshotModels = (models: UnpricedModels): UnpricedModels =>
  Object.freeze([...models]) as unknown as UnpricedModels;

/** Fresh, deeply frozen spend snapshot suitable for crossing a capability seam. */
export const snapshotSpend = (spend: Spend): Spend =>
  Object.freeze({
    tokens: spend.tokens,
    calls: spend.calls,
    usd: spend.usd.kind === "priced"
      ? Object.freeze({ kind: "priced", micros: spend.usd.micros })
      : Object.freeze({
          kind: "unpriced",
          models: snapshotModels(spend.usd.models),
          knownMicros: spend.usd.knownMicros,
        }),
  });

const snapshotCeiling = (ceiling: Ceiling): Ceiling => Object.freeze({ ...ceiling });

const available = (ceiling: Ceiling, observed: number): CeilingHeadroom =>
  Object.freeze({
    kind: "available",
    ceiling: snapshotCeiling(ceiling),
    amount: Math.max(0, ceiling.limit - observed),
  });

/**
 * Admission-safe headroom for the same projected spend used by the next gate.
 * Unknown USD cost remains domain data; it is never rendered as fictional zero.
 */
export const remainingFor = (
  limits: Ceilings | undefined,
  projected: Spend,
): Remaining => {
  if (limits === undefined) return Object.freeze({ kind: "unbudgeted" });

  const headroom = limits.map((ceiling): CeilingHeadroom =>
    match(ceiling)
      .returnType<CeilingHeadroom>()
      .with({ kind: "tokens" }, (c) => available(c, projected.tokens))
      .with({ kind: "calls" }, (c) => available(c, projected.calls))
      .with({ kind: "usd" }, (c) =>
        projected.usd.kind === "priced"
          ? available(c, projected.usd.micros)
          : Object.freeze({
              kind: "unpriced",
              ceiling: snapshotCeiling(c) as UsdCeiling,
              models: snapshotModels(projected.usd.models),
              observedAtLeast: projected.usd.knownMicros,
            }),
      )
      .exhaustive(),
  );

  return Object.freeze({
    kind: "budgeted",
    basis: "projected",
    headroom: Object.freeze(headroom),
  });
};
