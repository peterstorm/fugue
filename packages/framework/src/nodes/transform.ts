import type { z } from "zod";
import type { NodeDef } from "../types/node.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { nodeId } from "../types/ids.js";
import type { NodeId } from "../types/ids.js";

export interface TransformNodeConfig<I, O> {
  readonly id: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly transform: (input: I) => Result<O, FrameworkError>;
}

/** Create a pure transformation node with no side effects. Maps input → output without I/O. */
export const createTransformNode = <I, O>(
  config: TransformNodeConfig<I, O>,
): NodeDef<I, O, FrameworkError, readonly []> & { readonly id: NodeId } => ({
  id: nodeId(config.id),
  kind: "transform",
  inputSchema: config.inputSchema,
  outputSchema: config.outputSchema,
  requires: [] as const,
  sideEffects: { kind: "none" },
  confidence: { mode: "none" },
  run: async (input, _ctx) => config.transform(input),
});
