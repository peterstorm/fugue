import type { z } from "zod";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { __brandNodeId } from "../types/ids.js";
import type { NodeId } from "../types/ids.js";

export interface FetchNodeConfig<I, O, Id extends NodeId = NodeId> {
  readonly id: Id;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly fetch: (input: I, ctx: NodeContext) => Promise<Result<O, FrameworkError>>;
}

export const createFetchNode = <I, O, const Id extends NodeId = NodeId>(
  config: FetchNodeConfig<I, O, Id>,
): NodeDef<I, O, FrameworkError, readonly []> & { readonly id: Id & NodeId } => ({
  id: __brandNodeId(config.id) as Id & NodeId,
  kind: "fetch",
  inputSchema: config.inputSchema,
  outputSchema: config.outputSchema,
  requires: [] as const,
  run: config.fetch,
});
