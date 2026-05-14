// Identifier types — `RunId`, `NodeId`, `DagId`.
//
// Hard-branded newtypes over `string`. A plain `string` does NOT satisfy
// these types at compile time — callers must go through the smart
// constructors (`runId`, `nodeId`, `dagId`) which validate against
// `ID_REGEX`, or through the internal `__brandXxx` escape hatches for
// trusted framework code that has already validated by other means.
//
// At runtime the values are still plain strings; the brand is erased by
// TypeScript. The hard brand catches argument-swap bugs and ensures that
// every id flowing through the system has been explicitly validated or
// branded at its point of origin.

declare const __runIdBrand: unique symbol;
declare const __nodeIdBrand: unique symbol;
declare const __dagIdBrand: unique symbol;

export type RunId = string & { readonly [__runIdBrand]: void };
export type NodeId = string & { readonly [__nodeIdBrand]: void };
export type DagId = string & { readonly [__dagIdBrand]: void };

// Allow `:` so callers can namespace run ids (`tenant:run-abc`) without
// jumping through encoding hoops. The regex stays restrictive enough that
// IDs remain URL-safe and printable in operator UIs.
const ID_REGEX = /^[A-Za-z0-9_:-]{1,128}$/;

const validate = (kind: string, s: string): void => {
  if (typeof s !== "string" || !ID_REGEX.test(s)) {
    throw new Error(
      `Invalid ${kind} "${s}": must match ${ID_REGEX.source}`,
    );
  }
};

/** Smart constructor for `RunId`. Validates the string against `ID_REGEX`. */
export const runId = (s: string): RunId => {
  validate("runId", s);
  return s as RunId;
};

/** Smart constructor for `NodeId`. Validates the string against `ID_REGEX`. */
export const nodeId = (s: string): NodeId => {
  validate("nodeId", s);
  return s as NodeId;
};

/** Smart constructor for `DagId`. Validates the string against `ID_REGEX`. */
export const dagId = (s: string): DagId => {
  validate("dagId", s);
  return s as DagId;
};

/**
 * Internal-only widening cast. Trusted entry points (`defineDag`,
 * `makeNodeContext`, factory helpers) skip the regex check when they have
 * already validated the incoming string by another invariant.
 */
/**
 * @internal Bypass validation for trusted internal code. NOT part of the
 * public API — do not import from outside the framework package. These are
 * intentionally not re-exported from the barrel (`src/index.ts`).
 */
export const __brandRunId = (s: string): RunId => s as RunId;
/** @internal See `__brandRunId`. */
export const __brandNodeId = (s: string): NodeId => s as NodeId;
/** @internal See `__brandRunId`. */
export const __brandDagId = (s: string): DagId => s as DagId;
