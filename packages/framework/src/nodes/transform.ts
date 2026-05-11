import type { z } from "zod";
import type { NodeDef } from "../types/node.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";

export interface TransformNodeConfig<I, O, Id extends string = string> {
  readonly id: Id;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly transform: (input: I) => Result<O, FrameworkError>;
}

export const createTransformNode = <I, O, const Id extends string = string>(
  config: TransformNodeConfig<I, O, Id>,
): NodeDef<I, O, FrameworkError, readonly []> & { readonly id: Id } => ({
  id: config.id,
  kind: "transform",
  inputSchema: config.inputSchema,
  outputSchema: config.outputSchema,
  requires: [] as const,
  run: async (input, _ctx) => config.transform(input),
});
