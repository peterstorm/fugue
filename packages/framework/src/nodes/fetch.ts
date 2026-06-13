import { z } from "zod";
import type { NodeDef, Capability, TypedNodeContext } from "../types/node.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { SideEffectProfile } from "../types/side-effects.js";
import { resourceName } from "../types/freshness.js";
import { nodeId } from "../types/ids.js";
import type { NodeId } from "../types/ids.js";

export interface FetchNodeConfig<I, O, R extends readonly Capability[] = readonly []> {
  readonly id: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly fetch: (input: I, ctx: TypedNodeContext<R>) => Promise<Result<O, FrameworkError>>;
  /** Side-effect profile. Defaults to `{ kind: "reads", resource: id }`. */
  readonly sideEffects?: SideEffectProfile;
  /**
   * Capabilities this fetch node requires. Defaults to `[]`.
   * Declare capabilities here to get typed, non-null access in the `fetch`
   * function's `ctx` parameter.
   *
   * @example
   * ```ts
   * createFetchNode({
   *   id: "lookup-user",
   *   requires: ["db"] as const,
   *   fetch: async (input, ctx) => {
   *     // ctx.db is typed and non-null here
   *     return ctx.db.queryOne(UserSchema, "SELECT * FROM users WHERE id = $1", [input.userId]);
   *   },
   * })
   * ```
   */
  readonly requires?: R;
}

/** Create a fetch node that retrieves external state (API, database). Defaults to `sideEffects: { kind: "reads", resource: id }`. */
export const createFetchNode = <I, O, R extends readonly Capability[] = readonly []>(
  config: FetchNodeConfig<I, O, R>,
): NodeDef<I, O, FrameworkError, R> & { readonly id: NodeId } => ({
  id: nodeId(config.id),
  kind: "fetch",
  inputSchema: config.inputSchema,
  outputSchema: config.outputSchema,
  requires: (config.requires ?? ([] as const)) as R,
  sideEffects: config.sideEffects ?? { kind: "reads", resource: resourceName(config.id) },
  confidence: { mode: "none" },
  run: config.fetch,
});

/**
 * Config for a **source node** (C0 / 0.2.0): a root fetch that consumes NO DAG
 * input. Distinguished from `FetchNodeConfig` by the absence of `inputSchema` —
 * its `fetch` takes only `ctx`. Use this for the parallel root fetches of a
 * multi-source DAG (`defineSources`); the request reaches downstream nodes
 * through `DAG_INPUT` edges, never through a source.
 */
export interface SourceNodeConfig<O, R extends readonly Capability[] = readonly []> {
  readonly id: string;
  readonly outputSchema: z.ZodType<O>;
  readonly fetch: (ctx: TypedNodeContext<R>) => Promise<Result<O, FrameworkError>>;
  /** Side-effect profile. Defaults to `{ kind: "reads", resource: id }`. */
  readonly sideEffects?: SideEffectProfile;
  /** Capabilities this source node requires. Defaults to `[]`. */
  readonly requires?: R;
}

/**
 * Create a **source node** — a root that produces its output from the context
 * alone, consuming no DAG input (C0 / 0.2.0). A source MUST be a root (zero
 * incoming edges); `defineDag` rejects an input-expecting root with
 * `root-expects-input`, and the request is consumed only via `DAG_INPUT` edges.
 *
 * The returned node is marked `isSource: true`; its `inputSchema` is the unit
 * `z.void()` and its `run` ignores the (always-`undefined`) input argument.
 *
 * ```ts
 * const fetchWeights = createSourceNode({
 *   id: "fetch-weights",
 *   outputSchema: WeightsSchema,
 *   requires: ["documents"] as const,
 *   fetch: async (ctx) => readWeights(ctx.documents),
 * });
 * ```
 */
export const createSourceNode = <O, R extends readonly Capability[] = readonly []>(
  config: SourceNodeConfig<O, R>,
): NodeDef<void, O, FrameworkError, R> & { readonly id: NodeId; readonly isSource: true } => ({
  id: nodeId(config.id),
  kind: "fetch",
  isSource: true,
  inputSchema: z.void(),
  outputSchema: config.outputSchema,
  requires: (config.requires ?? ([] as const)) as R,
  sideEffects: config.sideEffects ?? { kind: "reads", resource: resourceName(config.id) },
  confidence: { mode: "none" },
  run: (_input: void, ctx: TypedNodeContext<R>) => config.fetch(ctx),
});
