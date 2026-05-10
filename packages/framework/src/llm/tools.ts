import type { z } from "zod";
import type { NodeContext } from "../types/node.js";

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
   */
  readonly run: (input: I, ctx: NodeContext) => Promise<O>;
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
