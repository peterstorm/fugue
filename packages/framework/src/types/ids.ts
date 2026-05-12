// Identifier types — `RunId`, `NodeId`, `DagId`.
//
// These are *documentation* aliases over `string`, paired with smart
// constructors (`runId`, `nodeId`, `dagId`) that validate against the shared
// `ID_REGEX` and brand the value. The brand is a TypeScript-level marker; at
// runtime the value is simply the original string.
//
// Why soft aliases rather than full structural brands: every event, error,
// `NodeContext`, and `DagDef` slot threads ids through hundreds of internal
// callsites. A hard `unique symbol` brand turns each of those into a
// compile error unless the caller pre-brands the string. The soft alias
// retains the *documentary* intent (every `runId: RunId` slot signals "this
// is a run identifier, not an arbitrary string") and lets callers opt into
// validation via the smart constructors when they care. The same surface is
// retained — `runId("my-run")` runs the regex check and returns a typed
// value — so the API for hosts that DO want validation is unchanged.

declare const __runIdBrand: unique symbol;
declare const __nodeIdBrand: unique symbol;
declare const __dagIdBrand: unique symbol;

// Intersection with a phantom marker keeps `RunId` distinct in IntelliSense
// (hovering `runId(...)` shows `RunId`, not `string`) without preventing a
// raw string from assigning to it.
export type RunId = string & { readonly [__runIdBrand]?: void };
export type NodeId = string & { readonly [__nodeIdBrand]?: void };
export type DagId = string & { readonly [__dagIdBrand]?: void };

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
export const __brandRunId = (s: string): RunId => s as RunId;
export const __brandNodeId = (s: string): NodeId => s as NodeId;
export const __brandDagId = (s: string): DagId => s as DagId;
