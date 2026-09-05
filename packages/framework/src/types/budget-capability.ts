import { match } from "ts-pattern";
import type {
  CallsCeiling,
  Ceilings,
  TokensCeiling,
  UsdCeiling,
} from "./budget.js";
import type { MicroUsd, Spend, UnpricedModels } from "./spend.js";
import { costFloor, makeSpend, microUsd } from "./spend.js";

export type CeilingHeadroom =
  | {
      readonly kind: "available";
      readonly unit: "tokens";
      readonly ceiling: TokensCeiling;
      readonly amount: number;
    }
  | {
      readonly kind: "available";
      readonly unit: "calls";
      readonly ceiling: CallsCeiling;
      readonly amount: number;
    }
  | {
      readonly kind: "available";
      readonly unit: "usd";
      readonly ceiling: UsdCeiling;
      /** Non-negative monetary headroom; never interchangeable with raw USD. */
      readonly amount: MicroUsd;
    }
  | {
      readonly kind: "unpriced";
      readonly ceiling: UsdCeiling;
      readonly models: UnpricedModels;
      readonly observedAtLeast: MicroUsd;
    }
  | {
      readonly kind: "unknown-usage";
      readonly ceiling: TokensCeiling;
      readonly observedAtLeast: number;
    }
  | {
      readonly kind: "unknown-usage";
      readonly ceiling: UsdCeiling;
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
export const snapshotSpend = (spend: Spend): Spend => {
  const snapshot = makeSpend({
    usage: spend.usage,
    tokens: spend.tokens,
    calls: spend.calls,
    usd: spend.usd.kind === "priced"
      ? { kind: "priced", micros: spend.usd.micros }
      : {
          kind: "unpriced",
          models: snapshotModels(spend.usd.models),
          knownMicros: spend.usd.knownMicros,
        },
  });
  if (snapshot.usd.kind === "unpriced") Object.freeze(snapshot.usd.models);
  Object.freeze(snapshot.usd);
  return Object.freeze(snapshot);
};

/** Defensive copy for a value crossing the capability seam. */
const frozenCopy = <T extends object>(value: T): T => Object.freeze({ ...value }) as T;

const availableTokens = (ceiling: TokensCeiling, observed: number): CeilingHeadroom =>
  Object.freeze({
    kind: "available",
    unit: "tokens",
    ceiling: frozenCopy(ceiling),
    amount: Math.max(0, ceiling.limit - observed),
  });

const availableCalls = (ceiling: CallsCeiling, observed: number): CeilingHeadroom =>
  Object.freeze({
    kind: "available",
    unit: "calls",
    ceiling: frozenCopy(ceiling),
    amount: Math.max(0, ceiling.limit - observed),
  });

const availableUsd = (ceiling: UsdCeiling, observed: MicroUsd): CeilingHeadroom =>
  Object.freeze({
    kind: "available",
    unit: "usd",
    ceiling: frozenCopy(ceiling),
    amount: microUsd(Math.max(0, ceiling.limit - observed)),
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
      .with({ kind: "tokens" }, (c) =>
        projected.usage === "unknown"
          ? Object.freeze({
              kind: "unknown-usage",
              ceiling: frozenCopy(c),
              observedAtLeast: projected.tokens,
            })
          : availableTokens(c, projected.tokens),
      )
      .with({ kind: "calls" }, (c) => availableCalls(c, projected.calls))
      .with({ kind: "usd" }, (c) => {
        if (projected.usage === "unknown") {
          return Object.freeze({
            kind: "unknown-usage",
            ceiling: frozenCopy(c),
            observedAtLeast: costFloor(projected.usd),
          });
        }
        return projected.usd.kind === "priced"
          ? availableUsd(c, projected.usd.micros)
          : Object.freeze({
              kind: "unpriced",
              ceiling: frozenCopy(c),
              models: snapshotModels(projected.usd.models),
              observedAtLeast: projected.usd.knownMicros,
            });
      })
      .exhaustive(),
  );

  return Object.freeze({
    kind: "budgeted",
    basis: "projected",
    headroom: Object.freeze(headroom),
  });
};
