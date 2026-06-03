import type { z } from "zod";
import type { NodeDef, NodeContext, Capability, TypedNodeContext } from "../types/node.js";
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
