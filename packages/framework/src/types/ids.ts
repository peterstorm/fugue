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

import type { Result } from "./result.js";
import { ok, err } from "./result.js";

declare const __runIdBrand: unique symbol;
declare const __nodeIdBrand: unique symbol;
declare const __dagIdBrand: unique symbol;
declare const __gitShaBrand: unique symbol;
declare const __dagInputBrand: unique symbol;

export type RunId = string & { readonly [__runIdBrand]: void };
export type NodeId = string & { readonly [__nodeIdBrand]: void };
export type DagId = string & { readonly [__dagIdBrand]: void };

// ---------------------------------------------------------------------------
// DAG_INPUT — the reserved virtual edge source carrying the DAG's request
// (C0 / framework 0.2.0). It is spelled "$input": `$` is outside `ID_REGEX`'s
// character class *by construction*, so DAG_INPUT can never collide with a real
// node id (every real id goes through `nodeId()`, which rejects `$`). At run
// start the validated DAG input is seeded into the outputs map under this key,
// so a `{ from: DAG_INPUT, to: <node> }` edge feeds the request to that node
// through the ordinary input-wiring rules (bare value on a single edge, keyed
// `"$input"` slot in a fan-in). No node implicitly receives the input any more.
//
// `DagInputId` is a *subtype* of `NodeId`, so the constant flows transparently
// through every `NodeId`-typed runtime field (`EdgeDef.from`, the outputs map),
// while the distinct brand lets `EdgeDefInput.from` admit it without widening
// real-node literal checking to `string`.
// ---------------------------------------------------------------------------

export type DagInputId = NodeId & { readonly [__dagInputBrand]: void };

/** The reserved virtual source id for a DAG's request input. See above. */
export const DAG_INPUT = "$input" as DagInputId;

/** Narrow a string/NodeId to the `DAG_INPUT` virtual source. */
export const isDagInput = (id: string): id is DagInputId => id === DAG_INPUT;

// Allow `:` so callers can namespace run ids (`tenant:run-abc`) without
// jumping through encoding hoops. The regex stays restrictive enough that
// IDs remain URL-safe and printable in operator UIs.
const ID_REGEX = /^[A-Za-z0-9_:-]{1,128}$/;

/** The regex used to validate all framework identifiers. Exported for client-side validation reuse. */
export const ID_PATTERN = ID_REGEX;

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

/**
 * Pattern for DagId — stricter than the general ID_REGEX.
 * Disallows `:` to prevent Redis key namespace escape (keys use `:` as delimiter).
 */
const DAG_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

/** Smart constructor for `DagId`. Validates against `DAG_ID_REGEX` (no colons). */
export const dagId = (s: string): DagId => {
  if (typeof s !== "string" || !DAG_ID_REGEX.test(s)) {
    throw new Error(
      `Invalid dagId "${s}": must match ${DAG_ID_REGEX.source} (colons not allowed in DAG IDs)`,
    );
  }
  return s as DagId;
};

/**
 * @internal Brand for trusted internal entry points (`defineDag`,
 * `makeNodeContext`, factory helpers). Still validates against `ID_REGEX` —
 * "trusted" code has bugs too, and an unvalidated id silently corrupts every
 * downstream map lookup. Use the `*Unchecked` variants only on profiled hot
 * paths. NOT public API — not re-exported from the barrel (`src/index.ts`).
 */
export const __brandRunId = (s: string): RunId => {
  validate("runId", s);
  return s as RunId;
};
/** @internal See `__brandRunId`. */
export const __brandNodeId = (s: string): NodeId => {
  validate("nodeId", s);
  return s as NodeId;
};
/** @internal See `__brandRunId`. */
export const __brandDagId = (s: string): DagId => {
  validate("dagId", s);
  return s as DagId;
};

/**
 * @internal Unchecked widening cast — bypasses `ID_REGEX`. ONLY for profiled
 * hot deserialization/replay paths where id provenance is already guaranteed.
 * Prefer `__brandRunId` everywhere else.
 */
export const __brandRunIdUnchecked = (s: string): RunId => s as RunId;
/** @internal See `__brandRunIdUnchecked`. */
export const __brandNodeIdUnchecked = (s: string): NodeId => s as NodeId;
/** @internal See `__brandRunIdUnchecked`. */
export const __brandDagIdUnchecked = (s: string): DagId => s as DagId;

// ---------------------------------------------------------------------------
// Result-returning variants — for parse boundaries where throwing is undesirable.
// ---------------------------------------------------------------------------

/** Parse a string into a RunId, returning a Result instead of throwing. */
export const tryRunId = (s: string): Result<RunId, string> =>
  typeof s === "string" && ID_REGEX.test(s)
    ? ok(s as RunId)
    : err(`Invalid runId "${s}": must match ${ID_REGEX.source}`);

/** Parse a string into a NodeId, returning a Result instead of throwing. */
export const tryNodeId = (s: string): Result<NodeId, string> =>
  typeof s === "string" && ID_REGEX.test(s)
    ? ok(s as NodeId)
    : err(`Invalid nodeId "${s}": must match ${ID_REGEX.source}`);

/** Parse a string into a DagId, returning a Result instead of throwing. */
export const tryDagId = (s: string): Result<DagId, string> =>
  typeof s === "string" && DAG_ID_REGEX.test(s)
    ? ok(s as DagId)
    : err(`Invalid dagId "${s}": must match ${DAG_ID_REGEX.source} (colons not allowed)`);


// ---------------------------------------------------------------------------
// GitSha — branded type for git commit hashes.
// ---------------------------------------------------------------------------

/**
 * Branded git SHA string. A GitSha is ALWAYS a non-empty string — "never synced"
 * is modeled as `GitSha | null` at use sites, not as an empty-string sentinel, so
 * a real SHA and "absent" are never structurally confused.
 *
 * No hash-format validation beyond non-emptiness — short and full SHAs both flow
 * from git output and are trusted; the brand guards against the empty sentinel.
 */
export type GitSha = string & { readonly [__gitShaBrand]: void };

/**
 * Brand a string as a GitSha. Throws on the empty string so the old `""`
 * "never synced" sentinel can never be reconstructed — use `null` for absence.
 */
export const gitSha = (s: string): GitSha => {
  if (typeof s !== "string" || s.length === 0) {
    throw new Error('Invalid gitSha: must be a non-empty string (use null for "never synced")');
  }
  return s as unknown as GitSha;
};

/**
 * Parse a string into a GitSha, returning a Result instead of throwing — for parse
 * boundaries (e.g. reading a SHA back from Redis/a checkpoint) where throwing is undesirable.
 * Mirrors `tryRunId`/`tryNodeId`/`tryDagId`. Rejects the empty string.
 */
export const tryGitSha = (s: string): Result<GitSha, string> =>
  typeof s === "string" && s.length > 0
    ? ok(s as unknown as GitSha)
    : err('Invalid gitSha "": must be a non-empty string (use null for "never synced")');
