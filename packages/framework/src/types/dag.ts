import type { NodeDef } from "./node.js";
import type { EvalJudgeNodeDef } from "../nodes/eval-judge.js";

/**
 * A structural-match predicate over a node's output. The predicate's keys
 * are top-level field names of the upstream output; the values are the
 * expected matches. A `{ oneOf: [...] }` value matches any of the listed
 * values.
 *
 * Predicates are pure data by construction — there is no closure to capture
 * external state — so replay is deterministic by the type system, predicates
 * are serializable and hashable, and operators can read the matched
 * predicate verbatim from observer events.
 *
 * `O` is the upstream node's output type. When `O` is `unknown` (e.g. when
 * the upstream output type wasn't inferred), `keyof O` is `never` and the
 * predicate degrades to the empty object — runtime validation is the
 * fallback.
 *
 * Boolean composition (`and`/`or`/`not`/`<`/`>`) is intentionally absent.
 * Authors needing complex logic add a classifier node upstream that
 * pre-computes a routing key — see ADR 0016.
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
 * - Unconditional: always fires. Target is always reachable when source runs.
 * - Conditional (`when`): fires only when the predicate matches the upstream
 *   output. First-match-wins per source node; mutually exclusive across
 *   predicates from the same source.
 * - Default (`kind: "default"`): fires only when no guarded edge from the
 *   same source matched. Required if any conditional edge originates from
 *   the source.
 *
 * Narrowing: use the helpers below — never inspect `"when" in e` ad-hoc.
 */
export type EdgeDef =
  | { readonly from: string; readonly to: string }
  | { readonly from: string; readonly to: string; readonly when: Predicate<unknown> }
  | { readonly from: string; readonly to: string; readonly kind: "default" };

export const isUnconditionalEdge = (
  e: EdgeDef,
): e is { readonly from: string; readonly to: string } =>
  !("when" in e) && !("kind" in e);

export const isConditionalEdge = (
  e: EdgeDef,
): e is { readonly from: string; readonly to: string; readonly when: Predicate<unknown> } =>
  "when" in e;

export const isDefaultEdge = (
  e: EdgeDef,
): e is { readonly from: string; readonly to: string; readonly kind: "default" } =>
  "kind" in e && e.kind === "default";

// ---------------------------------------------------------------------------
// DagDefInput — what authors construct, what `defineDag` accepts.
//
// `nodes` is a record keyed by node id. The record shape lets the type
// system carry the literal union of ids, so `edges[].from` / `edges[].to`
// and `outputNodeId` are constrained to known nodes at edit time. With
// `defineDag<const Nodes>(...)`, TypeScript flags edge typos before the
// runtime validator sees them.
//
// `deps` / `optionalDeps` inside each `NodeDef` remain plain `string[]` —
// per-node cross-typing would require a builder DSL we judge non-idiomatic.
// The runtime validator catches deps typos at module load (inside
// `defineDag` itself), so the surface that ships is still safe.
// ---------------------------------------------------------------------------

/**
 * Edge variant *for authoring* — distributes over `Ids` for the conditional
 * branch so each edge's `when` is typed against the actual `from` node's
 * output. With `<const Nodes>` inference, `OutputsByNodeId` carries every
 * node's `O` (from `NodeDef<I, O, E>`), so a path typo in `when` fails to
 * compile.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak: nodes are heterogeneous
export type NodesRecord = { readonly [id: string]: NodeDef<any, any, any> };

/** Extract the output type of a `NodeDef`, or `unknown` if it isn't one. */
export type OutputOf<N> = N extends NodeDef<unknown, infer O, unknown> ? O : unknown;

/** Map each node id in `Nodes` to its output type — feeds `EdgeDefInput`. */
export type OutputsByNodeId<Nodes extends NodesRecord> = {
  readonly [K in keyof Nodes & string]: OutputOf<Nodes[K]>;
};

/**
 * Mapped type that flags any record entry whose key disagrees with its
 * `node.id`. The factory helpers (`createTransformNode` etc.) preserve
 * the literal `id` via `<const Id>`, so `Nodes[K]["id"]` is a literal
 * string for any node built with a helper.
 *
 * The `string extends Nodes[K]["id"]` branch means "the id type is the
 * wide `string`, not a literal" — typically because the node was built
 * via a hand-rolled object literal or a custom helper that doesn't
 * preserve literal ids. In that case we can't compare at the type level,
 * so we accept the entry and let the runtime validator catch any
 * mismatch at module load.
 *
 * For literal ids, mismatches turn into a sentinel type that no real
 * `NodeDef` satisfies — the compiler reports the offending entry with a
 * descriptive message in its diagnostic.
 */
export type ConsistentNodes<Nodes extends NodesRecord> = {
  readonly [K in keyof Nodes]: string extends Nodes[K]["id"]
    ? Nodes[K]
    : Nodes[K] extends { readonly id: K }
      ? Nodes[K]
      : { readonly __error: `nodes['${K & string}'].id must equal '${K & string}'` };
};

export interface DagDefInput<Nodes extends NodesRecord = NodesRecord> {
  readonly id: string;
  readonly nodes: Nodes & ConsistentNodes<Nodes>;
  readonly edges: readonly EdgeDefInput<keyof Nodes & string, OutputsByNodeId<Nodes>>[];
  /** Explicit output node. If omitted, falls back to the last active node walking back through waves. */
  readonly outputNodeId?: keyof Nodes & string;
  /** Eval-judge nodes — run after output node completes, mark trace ERROR on failure. */
  readonly evalJudges?: readonly EvalJudgeNodeDef[];
  /**
   * Per-node retry limits — overrides `defaultRetryLimit` for a specific node.
   * Setting a non-empty value routes runDag to the state-machine path.
   */
  readonly retryLimits?: { readonly [K in keyof Nodes]?: number };
  /**
   * Default retry limit applied to all nodes without an entry in `retryLimits`.
   * Setting any value routes runDag to the state-machine path; omit for the
   * legacy fast path with no retries.
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
  readonly id: string;
  readonly nodes: readonly NodeDef<unknown, unknown, unknown>[];
  readonly edges: readonly EdgeDef[];
  readonly outputNodeId?: string;
  readonly evalJudges?: readonly EvalJudgeNodeDef[];
  readonly retryLimits?: Readonly<Record<string, number>>;
  readonly defaultRetryLimit?: number;
  /** Brand — present only on values that have passed `validateDagShape`. */
  readonly [__dagValidated]: true;
}
