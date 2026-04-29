import type { z } from "zod";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";

export interface FetchNodeConfig<I, O> {
  readonly id: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly deps: readonly string[];
  readonly fetch: (input: I, ctx: NodeContext) => Promise<Result<O, FrameworkError>>;
}

export const createFetchNode = <I, O>(
  config: FetchNodeConfig<I, O>,
): NodeDef<I, O, FrameworkError> => ({
  id: config.id,
  kind: "fetch",
  inputSchema: config.inputSchema,
  outputSchema: config.outputSchema,
  deps: config.deps,
  run: config.fetch,
});
