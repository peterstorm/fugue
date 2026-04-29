import type { z } from "zod";
import type { NodeDef } from "../types/node.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";

export interface TransformNodeConfig<I, O> {
  readonly id: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly deps: readonly string[];
  readonly transform: (input: I) => Result<O, FrameworkError>;
}

export const createTransformNode = <I, O>(
  config: TransformNodeConfig<I, O>,
): NodeDef<I, O, FrameworkError> => ({
  id: config.id,
  kind: "transform",
  inputSchema: config.inputSchema,
  outputSchema: config.outputSchema,
  deps: config.deps,
  run: async (input, _ctx) => config.transform(input),
});
