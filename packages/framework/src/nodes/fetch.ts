import type { z } from "zod";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { SideEffectProfile } from "../types/side-effects.js";
import { nodeId } from "../types/ids.js";
import type { NodeId } from "../types/ids.js";

export interface FetchNodeConfig<I, O> {
  readonly id: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly fetch: (input: I, ctx: NodeContext) => Promise<Result<O, FrameworkError>>;
  /** Side-effect profile. Defaults to `{ kind: "reads", resource: id }`. */
  readonly sideEffects?: SideEffectProfile;
}

/** Create a fetch node that retrieves external state (API, database). Defaults to `sideEffects: { kind: "reads", resource: id }`. */
export const createFetchNode = <I, O>(
  config: FetchNodeConfig<I, O>,
): NodeDef<I, O, FrameworkError, readonly []> & { readonly id: NodeId } => ({
  id: nodeId(config.id),
  kind: "fetch",
  inputSchema: config.inputSchema,
  outputSchema: config.outputSchema,
  requires: [] as const,
  sideEffects: config.sideEffects ?? { kind: "reads", resource: config.id },
  confidence: { mode: "none" },
  run: config.fetch,
});
