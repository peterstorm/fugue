// fan-scheduling — the vocabulary of a concurrent `map` fan (F1 PR-D).
//
// BINDING CONTRACT. This module is the types layer four later tasks build on:
//   - INV-3: the ONLY mint site of the `ChildConcurrency` and
//     `FanConcurrencyCap` brands. Every value of either type in the codebase
//     was produced by `childConcurrency` / `fanConcurrencyCap` or their Result
//     parsers — never by a cast.
//   - FR-001 / FR-032 / FR-046 (AD-8, AD-5): the parse layer for AUTHORED
//     scheduling. `parseFanScheduling` is the single place defaults are
//     acquired (`childConcurrency` 1, `largest-seen`); an invalid authored
//     field is rejected with a `validation` error naming the node, the field
//     and the offending value.
//   - FR-030: `DEFAULT_FAN_CONCURRENCY_CAP` = 8, the host-wide maximum.
//     The `min(authored, cap)` effective value itself is T5's
//     `effectiveConcurrency`, not this module.
//   - FR-014 / FR-021 / FR-022 / FR-025 (AD-6): the `FanRefusal` record a
//     projection refusal reports — axis and ceiling correlated by
//     construction, the redeploy hint, the lower-bound flag, and `completed`
//     counting drain completions — plus the three-arm `FanFailureCauses`
//     whose fourth combination ("one failure, no refusal") is unwritable:
//     that case returns the bare primary error, preserving C=1 identity.
//   - FR-026 / AD-9 / AD-11: the persisted refusal seed — a version 1 wire
//     schema stored under the `fan-seed` checkpoint namespace, purely
//     additive (no framework-version bump; the fingerprint exclusion is
//     declared where the fingerprint is computed, not here).
//
// Functional core: pure values, smart constructors and one persisted schema.
// No I/O.
//
// It is deliberately a LEAF with respect to `errors.ts`: `errors.ts` (the
// `fan-budget-refused` / `fan-child-failed` kinds) and `events.ts` (the fan
// observer events) both embed `FanRefusal`, so an edge from here back to
// `errors.ts` would close an import cycle (`module-graph-acyclic.test.ts`).
// That is why:
//   - the parsers return `FanSchedulingRejection`, the precise `validation`
//     arm they can produce — a structural subtype of `FrameworkError`, so
//     every caller holding a `Result<_, FrameworkError>` accepts it unchanged;
//   - `IndexedError` / `FanFailureCauses` are parameterised by the failure
//     type, which `errors.ts` instantiates with `FrameworkError`.

import { match } from "ts-pattern";
import { z } from "zod";
import type { Ceiling, CeilingKind, CallsCeiling, TokensCeiling, UsdCeiling } from "./budget.js";
import type { NodeId } from "./ids.js";
import type { MapIndex } from "./map-index.js";
import { err, ok, type Result } from "./result.js";
import { safeDiagnosticRender } from "./safe-error.js";
import { microUsd, type MicroUsd } from "./spend.js";

// ---------------------------------------------------------------------------
// Concurrency brands (AD-8)
// ---------------------------------------------------------------------------

declare const __childConcurrencyBrand: unique symbol;
declare const __fanConcurrencyCapBrand: unique symbol;

/**
 * The author-declared maximum number of a fan's children in flight at once: a
 * positive safe integer. Authored on the map node, defaulting to 1 (FR-001).
 * Named distinctly from the run-level `MAX_GLOBAL_CONCURRENCY` /
 * `DEFAULT_DAG_CONCURRENCY` (FR-035).
 */
export type ChildConcurrency = number & { readonly [__childConcurrencyBrand]: void };

/**
 * The host operator's ceiling on any fan's child concurrency: a positive safe
 * integer, host-wide (not per tenant), defaulting to
 * {@link DEFAULT_FAN_CONCURRENCY_CAP} (FR-030). Effective concurrency is
 * `min(ChildConcurrency, FanConcurrencyCap)` (FR-002).
 */
export type FanConcurrencyCap = number & { readonly [__fanConcurrencyCapBrand]: void };

/**
 * The single positivity rule both brands share. `typeof` first, as in
 * `asMaxWidth`: the guard must reject before any comparison coerces a forged
 * value (`"3"`, a hostile `valueOf`).
 */
const isPositiveSafeInteger = (raw: unknown): raw is number =>
  typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0;

const positiveSafeIntegerExpected = (raw: unknown): string =>
  `expected a positive safe integer, got ${safeDiagnosticRender(raw)}`;

/**
 * Throwing gateway to {@link ChildConcurrency} — for definition-time sites,
 * where a bad literal is a programmer error caught at module load (the
 * `maxWidth` precedent).
 */
export const childConcurrency = (raw: number): ChildConcurrency => {
  if (!isPositiveSafeInteger(raw)) {
    throw new Error(`childConcurrency: ${positiveSafeIntegerExpected(raw)}`);
  }
  return raw as ChildConcurrency;
};

/**
 * Throwing gateway to {@link FanConcurrencyCap}. Host configuration validates
 * its setting at startup (FR-032) before reaching this, so a rejection here is
 * a programmer error.
 */
export const fanConcurrencyCap = (raw: number): FanConcurrencyCap => {
  if (!isPositiveSafeInteger(raw)) {
    throw new Error(`fanConcurrencyCap: ${positiveSafeIntegerExpected(raw)}`);
  }
  return raw as FanConcurrencyCap;
};

/** The host maximum fan concurrency when the operator sets none (FR-030). */
export const DEFAULT_FAN_CONCURRENCY_CAP: FanConcurrencyCap = fanConcurrencyCap(8);

// ---------------------------------------------------------------------------
// Estimators (AD-5)
// ---------------------------------------------------------------------------

/** The closed set of per-child cost estimators an author may choose (FR-046). */
export const FAN_ESTIMATORS = ["largest-seen", "p50", "p90", "p95"] as const;

/**
 * How a fan predicts one more child's spend. A percentile estimator falls back
 * to `largest-seen` until 5 children have been observed (FR-046).
 */
export type FanEstimator = (typeof FAN_ESTIMATORS)[number];

const isFanEstimator = (raw: unknown): raw is FanEstimator =>
  typeof raw === "string" && (FAN_ESTIMATORS as readonly string[]).includes(raw);

// ---------------------------------------------------------------------------
// Authored scheduling (AD-8)
// ---------------------------------------------------------------------------

/** The authored, defaulted scheduling of one map node, stored on `mapping.scheduling`. */
export type FanScheduling = Readonly<{
  childConcurrency: ChildConcurrency;
  estimator: FanEstimator;
}>;

/** The authored scheduling field a rejection names. */
export type FanSchedulingField = keyof FanScheduling;

/**
 * Why authored scheduling was refused: the `validation` arm of
 * `FrameworkError`, narrowed to what these parsers can actually produce. It
 * names the offending node, field and value (FR-032).
 */
export type FanSchedulingRejection = Readonly<{
  kind: "validation";
  nodeId: NodeId;
  message: string;
  path: FanSchedulingField;
}>;

const rejection = (
  nodeId: NodeId,
  path: FanSchedulingField,
  expected: string,
): FanSchedulingRejection => ({
  kind: "validation",
  nodeId,
  path,
  message: `map node '${nodeId}': ${path} ${expected}`,
});

/** Result-returning gateway to {@link ChildConcurrency}, for authored/loaded input. */
export const parseChildConcurrency = (
  nodeId: NodeId,
  raw: unknown,
): Result<ChildConcurrency, FanSchedulingRejection> =>
  isPositiveSafeInteger(raw)
    ? ok(raw as ChildConcurrency)
    : err(rejection(nodeId, "childConcurrency", positiveSafeIntegerExpected(raw)));

/** Result-returning gateway to {@link FanEstimator}, for authored/loaded input. */
export const parseFanEstimator = (
  nodeId: NodeId,
  raw: unknown,
): Result<FanEstimator, FanSchedulingRejection> =>
  isFanEstimator(raw)
    ? ok(raw)
    : err(rejection(
        nodeId,
        "estimator",
        `expected one of ${FAN_ESTIMATORS.join(", ")}, got ${safeDiagnosticRender(raw)}`,
      ));

/** Defaults for an author who declares nothing: sequential, largest-seen. */
const DEFAULT_CHILD_CONCURRENCY: ChildConcurrency = childConcurrency(1);
const DEFAULT_FAN_ESTIMATOR: FanEstimator = "largest-seen";

/**
 * THE single place authored scheduling acquires its defaults (FR-001, FR-046):
 * an absent field takes its default (`childConcurrency` 1, `largest-seen`), a
 * present one must parse, and an invalid present one is rejected naming the
 * node, the field and the offending value. The `mapping.scheduling` consumer
 * rule in `dag.ts` and T6's `snapshotMapping` freeze both route through here —
 * no other site may hand-write the defaults. The result is frozen, ready to
 * be stored on `mapping.scheduling`; unrelated extra fields on the authored
 * object are ignored (strictness for authored JSON lives in the AuthoredDag
 * schema, not in this parser).
 */
export const parseFanScheduling = (
  nodeId: NodeId,
  authored: Readonly<{ childConcurrency?: unknown; estimator?: unknown }>,
): Result<FanScheduling, FanSchedulingRejection> => {
  const concurrency = authored.childConcurrency === undefined
    ? ok(DEFAULT_CHILD_CONCURRENCY)
    : parseChildConcurrency(nodeId, authored.childConcurrency);
  if (!concurrency.ok) return concurrency;
  const estimator = authored.estimator === undefined
    ? ok(DEFAULT_FAN_ESTIMATOR)
    : parseFanEstimator(nodeId, authored.estimator);
  if (!estimator.ok) return estimator;
  return ok(Object.freeze({ childConcurrency: concurrency.value, estimator: estimator.value }));
};

// ---------------------------------------------------------------------------
// Spend samples and refusals (AD-3, AD-6)
// ---------------------------------------------------------------------------

/**
 * One child's measured spend on every budget axis. `lowerBound` is true when
 * the measurement is known to under-count (true spend may be higher).
 */
export type SpendSample = Readonly<{
  tokens: number;
  calls: number;
  usdMicros: MicroUsd;
  lowerBound: boolean;
}>;

/** The remedy every refusal names (FR-014). */
export const FAN_REFUSAL_HINT =
  "continuing requires a larger budget: redeploy the DAG with a larger budget ceiling, then resume the run";

/**
 * The breached axis paired with the ceiling OF that axis. Distributing over
 * `CeilingKind` makes a refusal whose `axis` disagrees with its `ceiling.kind`
 * unrepresentable.
 */
type BreachedCeiling = {
  readonly [K in CeilingKind]: Readonly<{ axis: K; ceiling: Extract<Ceiling, { readonly kind: K }> }>;
}[CeilingKind];

/** The measured facts a projection refusal reports, before its axis is derived. */
export type FanRefusalFacts = Readonly<{
  ceiling: Ceiling;
  /** The estimator's per-child figure on the breached axis. */
  perChildEstimate: number;
  /** The estimator actually applied (a percentile may have fallen back). */
  estimatorApplied: FanEstimator;
  effectiveConcurrency: number;
  /** Children completed, including those that finished during the drain (FR-022). */
  completed: number;
  remaining: number;
  /** True spend may be higher than the figures reported. */
  lowerBound: boolean;
}>;

/**
 * A whole-fan projection refusal (FR-014): the fan cannot finish its remaining
 * children inside the breached ceiling. `scopePath` is always empty in D1; it
 * is reserved for nested-fan attribution (D2).
 */
export type FanRefusal = BreachedCeiling & Omit<FanRefusalFacts, "ceiling"> & Readonly<{
  hint: string;
  scopePath: readonly [];
}>;

/**
 * THE constructor for a {@link FanRefusal}: derives `axis` from the ceiling,
 * attaches {@link FAN_REFUSAL_HINT}, pins `scopePath` to `[]`, and freezes.
 */
export const fanRefusal = (facts: FanRefusalFacts): FanRefusal => {
  const { ceiling, ...rest } = facts;
  const breached = match(ceiling)
    .returnType<BreachedCeiling>()
    .with({ kind: "tokens" }, (c) => ({ axis: "tokens", ceiling: c }))
    .with({ kind: "calls" }, (c) => ({ axis: "calls", ceiling: c }))
    .with({ kind: "usd" }, (c) => ({ axis: "usd", ceiling: c }))
    .exhaustive();
  return Object.freeze({ ...rest, ...breached, hint: FAN_REFUSAL_HINT, scopePath: Object.freeze([]) as readonly [] });
};

/** One fan child's failure, located by its index. */
export type IndexedError<Failure> = Readonly<{ index: MapIndex; error: Failure }>;

/**
 * What accompanies the primary (lowest-index) child failure of a fan
 * (AD-6, FR-021, FR-025). "One failure, no refusal" is deliberately absent:
 * that case returns the bare primary error, preserving C=1 error identity.
 */
export type FanFailureCauses<Failure> =
  | Readonly<{ kind: "secondaries"; secondary: readonly [IndexedError<Failure>, ...IndexedError<Failure>[]] }>
  | Readonly<{ kind: "refusal"; refusal: FanRefusal }>
  | Readonly<{
      kind: "secondaries-and-refusal";
      secondary: readonly [IndexedError<Failure>, ...IndexedError<Failure>[]];
      refusal: FanRefusal;
    }>;

// ---------------------------------------------------------------------------
// Refusal seed (AD-9, AD-11) — persisted
// ---------------------------------------------------------------------------

/**
 * The seed's wire format version. Bumped only when the shape changes
 * incompatibly; a reader that meets any other version fails closed (the
 * schema's literal pin rejects it).
 */
export const FAN_SEED_VERSION = 1;

/**
 * The checkpoint namespace of a fan's refusal seed (AD-9): stored through the
 * existing checkpoint port as `fan-seed@<map>@0@<epoch>`, riding the composite
 * addressing grammar (ADR-0075/0085) with no codec or backend change. Disjoint
 * from the `dag` namespace, so a seed can never be mistaken for a saved child.
 */
export const FAN_SEED_NAMESPACE = "fan-seed";

/**
 * What a refused fan persists for its current execution epoch (FR-026) so a
 * resume can decide deterministically whether to refuse again (AD-11).
 * Additive persistence only: no `FRAMEWORK_VERSION` bump, no new `NodeState`
 * field, and the structure-only fingerprint never sees it (FR-051).
 * `estimate` is authoritative; `samples` is the advisory history (including
 * drain completions and any prior seeded samples) a resumed estimator
 * restarts from.
 */
export type FanRefusalSeed = Readonly<{
  version: 1;
  estimator: FanEstimator;
  samples: readonly SpendSample[];
  estimate: SpendSample;
  /** Every budgeted ceiling of the `Remaining` snapshot at the refusal decision. */
  ceilings: readonly Ceiling[];
  refusal: FanRefusal;
}>;

const countSchema = z.number().int().nonnegative();
const microUsdSchema: z.ZodType<MicroUsd, number> = countSchema.transform(microUsd);

const tokensCeilingSchema: z.ZodType<TokensCeiling> = z.strictObject({ kind: z.literal("tokens"), limit: countSchema });
const callsCeilingSchema: z.ZodType<CallsCeiling> = z.strictObject({ kind: z.literal("calls"), limit: countSchema });
const usdCeilingSchema: z.ZodType<UsdCeiling> = z.strictObject({ kind: z.literal("usd"), limit: microUsdSchema });
const ceilingSchema = z.union([tokensCeilingSchema, callsCeilingSchema, usdCeilingSchema]);

const spendSampleSchema = z.strictObject({
  tokens: countSchema,
  calls: countSchema,
  usdMicros: microUsdSchema,
  lowerBound: z.boolean(),
});

const refusalFields = {
  perChildEstimate: countSchema,
  estimatorApplied: z.enum(FAN_ESTIMATORS),
  effectiveConcurrency: z.number().int().positive(),
  completed: countSchema,
  remaining: countSchema,
  lowerBound: z.boolean(),
  hint: z.string().min(1),
  scopePath: z.tuple([]),
};

const refusalSchema = z.discriminatedUnion("axis", [
  z.strictObject({ axis: z.literal("tokens"), ceiling: tokensCeilingSchema, ...refusalFields }),
  z.strictObject({ axis: z.literal("calls"), ceiling: callsCeilingSchema, ...refusalFields }),
  z.strictObject({ axis: z.literal("usd"), ceiling: usdCeilingSchema, ...refusalFields }),
]);

/**
 * The wire schema of a {@link FanRefusalSeed} (`FAN_SEED_VERSION`). Strict
 * throughout: an unknown field means a writer this reader does not understand,
 * so it fails closed rather than being silently dropped. Beyond shape it
 * enforces the seed's two correlations — at most one ceiling per axis, and
 * the refusal's ceiling is one of `ceilings` — and deliberately enforces
 * NOTHING between the authored `estimator` and the refusal's
 * `estimatorApplied`: a percentile estimator legally falls back to
 * `largest-seen` below 5 settled children (FR-046), so the two may differ in
 * any valid persisted seed.
 */
export const FanRefusalSeedSchema: z.ZodType<FanRefusalSeed> = z
  .strictObject({
    version: z.literal(FAN_SEED_VERSION),
    estimator: z.enum(FAN_ESTIMATORS),
    samples: z.array(spendSampleSchema),
    estimate: spendSampleSchema,
    ceilings: z.array(ceilingSchema),
    refusal: refusalSchema,
  })
  .superRefine((seed, context) => {
    const kinds = seed.ceilings.map((c) => c.kind);
    if (new Set(kinds).size !== kinds.length) {
      context.addIssue({ code: "custom", path: ["ceilings"], message: "at most one ceiling per axis" });
    }
    const { ceiling } = seed.refusal;
    if (!seed.ceilings.some((c) => c.kind === ceiling.kind && c.limit === ceiling.limit)) {
      context.addIssue({ code: "custom", path: ["refusal", "ceiling"], message: "refusal ceiling must be one of the seed's ceilings" });
    }
  });
