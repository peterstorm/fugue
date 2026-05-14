import type { z } from "zod";
import type { NodeDef } from "../types/node.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { __brandNodeId } from "../types/ids.js";
import type { NodeId } from "../types/ids.js";

export interface TransformNodeConfig<I, O, Id extends NodeId = NodeId> {
  readonly id: Id;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly transform: (input: I) => Result<O, FrameworkError>;
}

export const createTransformNode = <I, O, const Id extends NodeId = NodeId>(
  config: TransformNodeConfig<I, O, Id>,
): NodeDef<I, O, FrameworkError, readonly []> & { readonly id: Id & NodeId } => ({
  id: __brandNodeId(config.id) as Id & NodeId,
  kind: "transform",
  inputSchema: config.inputSchema,
  outputSchema: config.outputSchema,
  requires: [] as const,
  sideEffects: { kind: "none" },
  confidence: { mode: "none" },
  run: async (input, _ctx) => config.transform(input),
});
