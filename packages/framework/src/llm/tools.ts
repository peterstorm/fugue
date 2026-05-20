// Tool-name runtime helpers. The `ToolDef`, `ToolContext`, and `ToolName`
// brand types live in `types/llm.ts` (which has no `llm/` dependency); this
// module owns the runtime smart constructors that produce branded values.

import type { ToolDef, ToolName } from "../types/llm.js";

const TOOL_NAME_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export function assertValidToolName(name: string): asserts name is ToolName {
  if (!TOOL_NAME_REGEX.test(name)) {
    throw new Error(
      `Invalid tool name "${name}": must match ${TOOL_NAME_REGEX.source}`,
    );
  }
}

/**
 * Smart constructor for `ToolName`. Validates `name` against the model-API
 * regex and brands the result so it can be assigned to a `ToolName`-typed
 * field. Throws on rejection — failures surface at definition time, not at
 * first dispatch.
 */
export function toolName(name: string): ToolName {
  assertValidToolName(name);
  return name;
}

/**
 * Authoring shape for `tool()`. Accepts a raw `name: string` and brands it
 * in the smart constructor; everything else mirrors `ToolDef`.
 */
export interface ToolDefInput<I, O> extends Omit<ToolDef<I, O>, "name"> {
  readonly name: string;
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
export const tool = <I, O>(def: ToolDefInput<I, O>): ToolDef<I, O> => {
  const branded = toolName(def.name);
  return { ...def, name: branded };
};
