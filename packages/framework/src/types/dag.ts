import type { NodeDef } from "./node.js";
import type { EvalJudgeNodeDef } from "../nodes/eval-judge.js";
import type {
  NodesRecord,
  OutputsByNodeId,
  ConsistentNodes,
} from "./dag-internals.js";
import type { DagId, NodeId } from "./ids.js";

// Inference helpers (NodesRecord, OutputOf, OutputsByNodeId, ConsistentNodes)
// are imported above but NOT re-exported. They live in `./dag-internals.ts`,
// reachable directly when genuinely needed; keeping them off the barrel
// (`types/index.ts` → `export * from "./dag.js"`) shrinks the public surface
// without losing intra-framework usability.

/**
 * Structural-match predicate over a node's output. Pure data — no closures —
 * so serialization and replay are deterministic. Boolean composition is
 * intentionally absent; see ADR 0016 for the classifier-node pattern.
 */
export type Predicate<O> = {
  readonly [K in keyof O]?: O[K] | { readonly oneOf: readonly O[K][] };
};

/**
 * Type-guard helper for the `oneOf` form. Narrows an expected predicate
 * value to its `oneOf` variant.
 */
export const isOneOfMatch = (
  value: unknown,
): value is { readonly oneOf: readonly unknown[] } =>
  typeof value === "object" &&
  value !== null &&
  "oneOf" in value &&
  Array.isArray((value as { oneOf: unknown }).oneOf);

/**
 * Edge variants (runtime shape, after `defineDag` strips literal id types).
 *
 * Discriminated by `kind` — every variant carries an explicit tag so single-
 * field narrowing replaces the brittle `"when" in e && !("kind" in e)` checks
 * of earlier revisions. `EdgeDefInput` still accepts the implicit-unconditional
 * form for authoring; `defineDag` materializes `kind: "unconditional"` after
 * validation.
 *
 * NOTE: `when` is typed `Predicate<unknown>` at runtime because the DAG carries
 * heterogeneous node types. Authoring-time type safety is enforced by
 * `defineDag` (where `when` is checked against `OutputsByNodeId[F]`). Runtime
 * correctness is enforced by `evaluatePredicate` + the node's `outputSchema`
 * validation. This widening is intentional — see ADR 0016.
 */
export type EdgeDef =
  | { readonly from: NodeId; readonly to: NodeId; readonly kind: "unconditional" }
  | { readonly from: NodeId; readonly to: NodeId; readonly kind: "conditional"; readonly when: Predicate<unknown> }
  | { readonly from: NodeId; readonly to: NodeId; readonly kind: "default" };

export const isUnconditionalEdge = (
  e: EdgeDef,
): e is { readonly from: NodeId; readonly to: NodeId; readonly kind: "unconditional" } =>
  e.kind === "unconditional";

export const isConditionalEdge = (
  e: EdgeDef,
): e is { readonly from: NodeId; readonly to: NodeId; readonly kind: "conditional"; readonly when: Predicate<unknown> } =>
  e.kind === "conditional";

export const isDefaultEdge = (
  e: EdgeDef,
): e is { readonly from: NodeId; readonly to: NodeId; readonly kind: "default" } =>
  e.kind === "default";

/**
 * Raw edge input as accepted by `defineDag` / `defineDagFromArray` / authoring
 * call sites. Kind discriminants may be omitted on the unconditional and
 * conditional variants — the validator materializes the explicit kind. This
 * is the **input** shape; runtime code always sees the tagged `EdgeDef`.
 */
export type EdgeDefRawInput =
  | { readonly from: string; readonly to: string }
  | { readonly from: string; readonly to: string; readonly kind: "unconditional" }
  | { readonly from: string; readonly to: string; readonly when: Predicate<unknown> }
  | { readonly from: string; readonly to: string; readonly kind: "conditional"; readonly when: Predicate<unknown> }
  | { readonly from: string; readonly to: string; readonly kind: "default" };

/**
 * Normalize a raw input edge into the tagged-discriminant `EdgeDef`. The
 * conditional branch is detected by presence of `when`; the default branch
 * by explicit `kind === "default"`; everything else is unconditional.
 */
export const normalizeEdge = (e: EdgeDefRawInput): EdgeDef => {
  if ("kind" in e && e.kind === "default") return e as EdgeDef;
  if ("when" in e) {
    return {
      from: e.from as NodeId,
      to: e.to as NodeId,
      kind: "conditional",
      when: e.when,
    };
  }
  return { from: e.from as NodeId, to: e.to as NodeId, kind: "unconditional" };
};

// ---------------------------------------------------------------------------
// DagDefInput — what authors construct, what `defineDag` accepts.
//
// `nodes` is a record keyed by node id. The record shape lets the type
// system carry the literal union of ids, so `edges[].from` / `edges[].to`
// and `outputNodeId` are constrained to known nodes at edit time. With
// `defineDag<const Nodes>(...)`, TypeScript flags edge typos before the
// runtime validator sees them.
// ---------------------------------------------------------------------------

/**
 * Edge variant *for authoring* — distributes over `Ids` for the conditional
 * branch so each edge's `when` is typed against the actual `from` node's
 * output. With `<const Nodes>` inference, `OutputsByNodeId` carries every
 * node's `O` (from `NodeDef<I, O, E>`), so a path typo in `when` fails to
 * compile.
 *
 * Authoring ergonomics: the unconditional form may omit `kind` (defineDag
 * materializes `kind: "unconditional"` after validation). The conditional
 * form may omit `kind` when `when` is supplied; defineDag materializes
 * `kind: "conditional"`.
 */
export type EdgeDefInput<
  Ids extends string,
  OutputsByNodeId extends { readonly [K in Ids]: unknown } = { readonly [K in Ids]: unknown },
> =
  | { readonly from: Ids; readonly to: Ids }
  | {
      readonly [F in Ids]: {
        readonly from: F;
        readonly to: Ids;
        readonly when: Predicate<OutputsByNodeId[F]>;
      };
    }[Ids]
  | { readonly from: Ids; readonly to: Ids; readonly kind: "default" };

// Inference machinery (NodesRecord, OutputOf, OutputsByNodeId, ConsistentNodes)
// lives in `./dag-internals.ts` so the public barrel doesn't leak them.

export interface DagDefInput<Nodes extends NodesRecord = NodesRecord> {
  readonly id: string;
  readonly nodes: Nodes & ConsistentNodes<Nodes>;
  readonly edges: readonly EdgeDefInput<keyof Nodes & string, OutputsByNodeId<Nodes>>[];
  /** Explicit output node. If omitted, falls back to the last active node walking back through waves. */
  readonly outputNodeId?: keyof Nodes & string;
  /** Eval-judge nodes — run after output node completes, mark trace ERROR on failure. */
  readonly evalJudges?: readonly EvalJudgeNodeDef[];
  /** Per-node retry limits — overrides `defaultRetryLimit` for a specific node. */
  readonly retryLimits?: { readonly [K in keyof Nodes]?: number };
  /**
   * Default retry limit applied to all nodes without an entry in `retryLimits`.
   * When `0` (the default), nodes are not retried.
   */
  readonly defaultRetryLimit?: number;
}

// ---------------------------------------------------------------------------
// DagDef — branded, validated DagDefInput in the runtime-friendly array
// shape. Only `defineDag` produces values of this type, so `runDag` /
// `runDagStateful` / `compileDagToMachine` can refuse hand-rolled literals
// at the type level.
// ---------------------------------------------------------------------------

declare const __dagValidated: unique symbol;

export interface DagDef {
  readonly id: DagId;
  readonly nodes: readonly NodeDef<unknown, unknown>[];
  readonly edges: readonly EdgeDef[];
  readonly outputNodeId?: NodeId;
  readonly evalJudges?: readonly EvalJudgeNodeDef[];
  readonly retryLimits?: Readonly<Record<string, number>>;
  readonly defaultRetryLimit?: number;
  /** Brand — present only on values that have passed `validateDagShape`. */
  readonly [__dagValidated]: true;
}

/**
 * The structural shape of a `DagDef` minus its brand. Exposed for internal
 * builders (`validateDagShape`) so they can construct the object with full
 * field-shape checking, then apply the brand via `brandAsDagDef` — replacing
 * the prior `as unknown as DagDef` cast that bypassed structural checks.
 */
export type DagDefShape = Omit<DagDef, typeof __dagValidated>;

/**
 * Apply the `DagDef` brand to a structurally-valid shape. The brand is a
 * module-private unique symbol — only this function can construct it — so
 * callers can NOT hand-roll a branded value by spread or cast. Intended for
 * use by `validateDagShape` exclusively.
 */
export const brandAsDagDef = (shape: DagDefShape): DagDef =>
  shape as DagDef;

/**
 * Sanctioned derivation: produce a new `DagDef` with overridden retry limits
 * while preserving the validation brand. Use this instead of a raw spread
 * (`{ ...dag, retryLimits: ... }`) — spread does not re-validate, and the
 * brand was specifically introduced to prevent silent post-validation
 * mutation. Per-node entries in `limits` override the original `dag.retryLimits`.
 */
export const withRetryLimits = (
  dag: DagDef,
  limits: Readonly<Record<string, number>>,
): DagDef =>
  brandAsDagDef({
    ...(dag as DagDefShape),
    retryLimits: { ...(dag.retryLimits ?? {}), ...limits },
  });
