import type { z } from "zod";
import type { TypedNodeContext } from "../types/node.js";

/**
 * The context shape passed to a tool body. Tools always run inside an
 * LLM-with-tools node which declares `requires: ["llm"]`, so `ctx.llm` is
 * guaranteed non-null — tool authors don't need to null-check it.
 *
 * Other capability fields (`cache`, `prompts`) remain optional and must be
 * null-checked at use. A tool that genuinely needs `prompts` should validate
 * at dispatch time rather than relying on the host node's declaration.
 */
export type ToolContext = TypedNodeContext<readonly ["llm"]>;

/**
 * Provider-agnostic tool definition consumed by `LlmClient.sendWithTools`.
 *
 * The framework owns the tool-use loop and translates this shape into
 * provider-specific specs (Anthropic `input_schema`, OpenAI `parameters`).
 * Tool bodies receive Zod-validated input and return values validated against
 * `outputSchema` before being passed back to the model.
 */
export interface ToolDef<I, O> {
  /** Identifier sent to the model. Must match `^[A-Za-z0-9_-]{1,64}$`. */
  readonly name: string;
  /** Natural-language description shown to the model — drives selection. */
  readonly description: string;
  /** Zod schema for the input. Translated to JSON Schema for the provider. */
  readonly inputSchema: z.ZodType<I>;
  /** Zod schema for the output. Validated post-dispatch. */
  readonly outputSchema: z.ZodType<O>;
  /**
   * Tool body. Thrown errors and invalid outputs are caught by the loop and
   * surfaced back to the model as `is_error: true` results so it can recover
   * rather than crashing the run.
   *
   * `ctx.llm` is non-null (tools always run inside an LLM node).
   */
  readonly run: (input: I, ctx: ToolContext) => Promise<O>;
}

const TOOL_NAME_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export function assertValidToolName(name: string): void {
  if (!TOOL_NAME_REGEX.test(name)) {
    throw new Error(
      `Invalid tool name "${name}": must match ${TOOL_NAME_REGEX.source}`,
    );
  }
}

export function ensureToolNames(tools: readonly ToolDef<unknown, unknown>[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    assertValidToolName(tool.name);
    if (seen.has(tool.name)) {
      throw new Error(`Duplicate tool name "${tool.name}"`);
    }
    seen.add(tool.name);
  }
}

/**
 * Smart constructor for `ToolDef` — validates `name` at construction so
 * mistakes surface at definition time rather than the first dispatch. The
 * runtime `ensureToolNames` check at the LLM-loop boundary stays as
 * defense-in-depth (e.g., for tools assembled programmatically without
 * going through this constructor).
 */
export const tool = <I, O>(def: ToolDef<I, O>): ToolDef<I, O> => {
  assertValidToolName(def.name);
  return def;
};
