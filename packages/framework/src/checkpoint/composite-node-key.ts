// Composite checkpoint node-key codec (ADR-0075).
//
// Pure, backend-agnostic encoding of the composite node address space for the
// `Checkpointer` port — no I/O, no imports from infra. The file backend keys
// durable checkpoint entries by these strings; in-memory and Redis backends
// ignore the composite options entirely (FR-023), so this module is the single
// definition of what a composite nodeKey IS.
//
// Invariants (collision-free by construction):
//   - The separator `@` is outside `ID_PATTERN` (`^[A-Za-z0-9_:-]{1,128}$`),
//     so a canonical key (a bare nodeId) can never contain it and a composite
//     key always contains it — the two forms can never collide.
//   - `compositeNodeKey` returns either a bare nodeId (exactly 0 separators,
//     canonical folding when index AND attempt are both absent) or
//     `namespace@nodeId@index@attempt` (exactly 3 separators). No other shape
//     is producible, so `parseCompositeNodeKey` can classify any key by a
//     single unambiguous separator count.
//   - Every composite component is re-validated against the same constraints
//     the encoder enforces, so `parse(encode(a)) = a` for every valid address
//     and out-of-contract keys are rejected outright (parse, don't validate).
//
// Error-channel contract (the three channels
// are deliberate, not drift):
//   - `parseCompositeNodeKey → … | null` is the read-side CLASSIFIER over
//     untrusted stored bytes: it answers "is this a well-formed key?" and
//     nothing more. Callers on the corrupt-entry path already compose their
//     own per-site verdict message around the (recoverable) key, so a `Result`
//     would force every read site to unwrap a message it does not use.
//   - `compositeNodeKey` throws — a write-side CONSTRUCTOR INVARIANT over
//     validated inputs, per ADR-0080 ("low-level pure implementation
//     functions may use local exceptions as control flow, but every exported
//     throwing boundary catches and converts them before they can escape").
//     The single production call site (the file checkpointer's `saveNode`)
//     re-validates the boundary first, so the only throw reachable there is
//     this module's own `assertNoNamespaceAlone` rule (which the boundary
//     parse intentionally does not pre-reject — the ambiguity rule belongs to
//     this module as the single definition of the composite key), and it is
//     converted to typed `checkpoint-write-failed` at that boundary.
//   - The port-level `Result<_, FrameworkError>` channel is the Checkpointer's
//     own — this module sits below it and never crosses it.

import type { NodeId } from "../types/ids.js";
import { ID_PATTERN } from "../types/ids.js";
import { safeDiagnosticRender } from "../types/safe-error.js";

/** Default namespace applied when a composite save omits `namespace`. */
export const DEFAULT_NODE_NAMESPACE = "dag";

/**
 * Per-call options for composite checkpoint addressing on `saveNode` (ADR-0075).
 *
 * Canonical folding: when `index` AND `attempt` are BOTH absent, the stored
 * key is exactly the bare `nodeId` and the options are ignored entirely —
 * byte-identical behavior with every existing consumer — EXCEPT a `namespace`
 * alone, which is rejected as an ambiguous caller error (a namespace-only
 * address would be silently folded into the canonical nodeId): supply `index`
 * and/or `attempt` to address a composite entry (ADR-0075 amendment,
 * `assertNoNamespaceAlone`). When `index` and/or `attempt` are
 * present, the stored key is `${namespace ?? "dag"}@${nodeId}@${index ?? 0}@${attempt ?? 0}`,
 * so mapped/fan-out instances (index) and retry attempts address distinct
 * durable entries without overwriting each other.
 */
type CanonicalNodeKeyOpts = {
  readonly namespace?: never;
  readonly index?: never;
  readonly attempt?: never;
};

type IndexedNodeKeyOpts = {
  /** Composite namespace; defaults to `DEFAULT_NODE_NAMESPACE` ("dag"). Must match `ID_PATTERN`. */
  readonly namespace?: string;
  /** Instance index for mapped/fan-out node instances; non-negative safe integer (default 0). */
  readonly index: number;
  /** Retry/attempt counter; non-negative safe integer (default 0). */
  readonly attempt?: number;
};

type AttemptedNodeKeyOpts = {
  /** Composite namespace; defaults to `DEFAULT_NODE_NAMESPACE` ("dag"). Must match `ID_PATTERN`. */
  readonly namespace?: string;
  /** Instance index for mapped/fan-out node instances; non-negative safe integer (default 0). */
  readonly index?: number;
  /** Retry/attempt counter; non-negative safe integer (default 0). */
  readonly attempt: number;
};

/**
 * Canonical options are empty. Composite options carry at least `index` or
 * `attempt`, making the namespace-only caller error unrepresentable for typed
 * consumers while runtime boundaries still reject forged JavaScript values.
 */
export type CompositeNodeKeyOpts =
  | CanonicalNodeKeyOpts
  | IndexedNodeKeyOpts
  | AttemptedNodeKeyOpts;

/**
 * A composite address requires an addressing component: `namespace` alone
 * (without `index` or `attempt`) is caller error — the encoder would silently
 * discard it and store under the bare canonical `nodeId`, so the caller's
 * composite intent would be unrepresentable and a later composite save with
 * `index: 0` would land on a DIFFERENT durable entry. Illegal shapes are made
 * unrepresentable instead of silently folded (parse, don't validate).
 */
const assertNoNamespaceAlone = (opts: {
  readonly namespace?: string;
  readonly index?: number;
  readonly attempt?: number;
}): void => {
  if (opts.namespace !== undefined && opts.index === undefined && opts.attempt === undefined) {
    throw new Error(
      `Invalid composite node key opts: namespace "${opts.namespace}" without index/attempt is ambiguous — ` +
        "a namespace-only address would be silently folded into the canonical nodeId; supply index and/or attempt to address a composite entry",
    );
  }
};

const isIdComponent = (value: unknown): boolean =>
  // The typeof guard mirrors `ids.ts`'s `validate()`: `RegExp.prototype.test`
  // coerces non-strings, so `ID_PATTERN.test(42)` would return true and a
  // bypassed brand smuggling a number would mint junk keys instead of
  // failing closed.
  typeof value === "string" && ID_PATTERN.test(value);

/**
 * Non-negative safe integer — ONE encoding of the domain, exported so every
 * boundary that validates a counted component (composite index/attempt,
 * stored `nodeCount`) shares the same rule. `typeof` first: `Number.isSafeInteger`
 * performs NO type coercion — per spec it returns `false` for any non-`number`
 * input before any conversion (it is an ES6 `Number.*` method in the
 * non-coercing family: `Number.isFinite`/`Number.isNaN` are the twins of the
 * coercing legacy globals `isFinite`/`isNaN`; `Number.isSafeInteger` has no
 * global counterpart), so this conjunction can never apply the `>=` tail to a
 * hostile value — `>=` only ever sees the numbers `isSafeInteger` accepted.
 * The `typeof` first conjunct supplies the type-predicate narrowing (the same
 * discipline as `isIdComponent` above, where the coercion is real:
 * `RegExp.prototype.test` coerces via ToString).
 */
export const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const assertIdComponent = (kind: string, value: string): void => {
  if (!isIdComponent(value)) {
    throw new Error(
      `Invalid composite node key ${kind} "${value}": must match ${ID_PATTERN.source} (no "@" — the composite separator)`,
    );
  }
};

const assertIndexOrAttempt = (kind: "index" | "attempt", value: number): void => {
  // `isNonNegativeSafeInteger` carries the `typeof value === "number"` guard
  // as its own first conjunct — no separate clause is needed, and the
  // predicate short-circuits on non-numbers before any `>= 0`/coercion, so a
  // hostile `valueOf`/`toString` cannot trap here (pinned in
  // composite-node-key.test.ts, "rejects a throwing-hook … with the codec's
  // own typed message (never a raw trap)").
  if (!isNonNegativeSafeInteger(value)) {
    // The codec's contract is TYPED throws: the diagnostic names the codec's
    // rule, never the hostile value's own error text. `safeDiagnosticRender`
    // is total — it renders objects via the object tag before any guarded
    // coercion, so a hostile `toString`/`valueOf` cannot trap inside this
    // codec's own message construction (pinned in the same test: the
    // rejection must not contain the hostile's "exploded" text).
    throw new Error(
      `Invalid composite node key ${kind}: expected a non-negative safe integer, got ${safeDiagnosticRender(value)}`,
    );
  }
};

/**
 * Encode a nodeId (+ optional composite address components) into its stored
 * checkpoint nodeKey.
 *
 * Canonical folding: with `index` AND `attempt` both absent (or no opts at
 * all) the result is exactly `nodeId` — no separators, no namespace, nothing
 * appended. A `namespace` supplied WITHOUT `index`/`attempt` is rejected as
 * ambiguous (the intent would be silently discarded). With either present,
 * the result is the composite form
 * `${namespace ?? "dag"}@${nodeId}@${index ?? 0}@${attempt ?? 0}`; missing
 * components default to `DEFAULT_NODE_NAMESPACE` and `0`.
 *
 * Constructor-invariant function: the `NodeId` brand already guarantees a
 * validated id at compile time, but the codec's output contract (canonical ⇔
 * 0 separators, composite ⇔ exactly 3) is enforced at runtime too, so a
 * bypassed brand can never mint an unparseable key. Violations throw — the
 * file backend MUST re-validate identifiers with typed errors
 * (`checkpoint-write-failed`) before calling this, so a throw here means a
 * caller violated the contract.
 *
 * @throws when `nodeId` is not `ID_PATTERN`-valid, when a supplied `namespace`
 *         is not `ID_PATTERN`-valid, or when a supplied `index`/`attempt` is
 *         not a non-negative safe integer.
 */
export const compositeNodeKey = (nodeId: NodeId, opts?: CompositeNodeKeyOpts): string => {
  // Always validate the nodeId — even on the folded path, because a canonical
  // key that contained "@" would break the collision-freedom invariant.
  assertIdComponent("nodeId", nodeId);

  if (opts !== undefined) assertNoNamespaceAlone(opts);

  // Canonical folding: index AND attempt both absent ⇒ bare nodeId. The opts
  // are ignored entirely (ADR-0075), so a namespace alone never changes the key
  // (and is rejected above as ambiguous caller error).
  if (opts?.index === undefined && opts?.attempt === undefined) {
    return nodeId;
  }

  const namespace = opts.namespace ?? DEFAULT_NODE_NAMESPACE;
  assertIdComponent("namespace", namespace);
  if (opts.index !== undefined) assertIndexOrAttempt("index", opts.index);
  if (opts.attempt !== undefined) assertIndexOrAttempt("attempt", opts.attempt);

  return `${namespace}@${nodeId}@${opts.index ?? 0}@${opts.attempt ?? 0}`;
};

/** Successful parse of a stored checkpoint nodeKey (see `parseCompositeNodeKey`). */
export type ParsedCompositeNodeKey =
  | { readonly form: "canonical"; readonly nodeId: string }
  | {
      readonly form: "composite";
      readonly namespace: string;
      readonly nodeId: string;
      readonly index: number;
      readonly attempt: number;
    };

// Strict decimal form — the exact surface `compositeNodeKey` produces
// (`String(0)` = "0", `String(n)` = "123"): no signs, no leading zeros, and
// the safe-integer bound is enforced separately after the parse.
const DECIMAL_FORM = /^(0|[1-9][0-9]*)$/;

const parseDecimalComponent = (raw: string): number | null => {
  if (!DECIMAL_FORM.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
};

/**
 * Parse a stored checkpoint nodeKey back into its address components.
 *
 * Classification is by separator count — the codec guarantees no other shape
 * is producible:
 *   - 0 separators  ⇒ canonical: the key is the bare `nodeId`.
 *   - exactly 3     ⇒ composite: `namespace@nodeId@index@attempt`, with every
 *     component re-validated (namespace/nodeId against `ID_PATTERN`,
 *     index/attempt as non-negative safe integers in strict decimal form).
 *   - anything else ⇒ `null` (malformed — 1/2 separators, or a 4+ component
 *     "quad" that could never have been encoded).
 *
 * The count is taken from ONE `key.split("@")` classified by part count
 * (parts = separators + 1): no second pass over the string, and the
 * classification is exactly the separator-count rule above.
 *
 * Round-trip guarantee: for every valid address `a`,
 * `parseCompositeNodeKey(compositeNodeKey(a.nodeId, a.opts))` deep-equals the
 * NORMALIZED address — the discriminated form with defaults materialized
 * (folded addresses ⇒ `{ form: "canonical" }`; composite ⇒ `namespace`
 * resolved to `DEFAULT_NODE_NAMESPACE` and missing `index`/`attempt` to `0`).
 * The re-validation is fail-closed: an out-of-contract key (e.g. a nodeId
 * that is not `ID_PATTERN`-valid, or `@01@` leading-zero index) is rejected
 * rather than half-interpreted — corrupt stored entries surface as `null` and
 * the caller classifies them as a discriminated corrupt checkpoint address.
 */
export const parseCompositeNodeKey = (key: string): ParsedCompositeNodeKey | null => {
  if (typeof key !== "string") return null;

  // One split, one classification: part count is exactly separator count + 1,
  // so 1 part ⇒ 0 separators (canonical), 4 parts ⇒ exactly 3 (composite),
  // 2/3 parts ⇒ 1/2 separators (malformed), 5+ ⇒ more than 3 separators
  // (cannot be composite and cannot be canonical).
  const parts = key.split("@");
  if (parts.length === 1) {
    // Canonical: the whole key is the nodeId. Re-validate so a key that the
    // encoder could never produce (empty, spaces, "..", …) is never reported
    // as a real canonical nodeId.
    return isIdComponent(key) ? { form: "canonical", nodeId: key } : null;
  }

  if (parts.length !== 4) return null; // 1 or 2 separators, or 4+ ⇒ malformed

  const [namespace, nodeId, indexRaw, attemptRaw] = parts;
  if (!isIdComponent(namespace) || !isIdComponent(nodeId)) return null;
  const index = parseDecimalComponent(indexRaw);
  if (index === null) return null;
  const attempt = parseDecimalComponent(attemptRaw);
  if (attempt === null) return null;

  return { form: "composite", namespace, nodeId, index, attempt };
};
