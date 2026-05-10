import type { NodeContext } from "../types/node.js";
import type { ToolDef } from "./tools.js";
import { withToolSpan, setToolIoAttributes } from "./spans.js";

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ToolDispatchResult {
  readonly id: string;
  readonly name: string;
  readonly content: unknown;
  readonly isError: boolean;
}

const errResult = (
  call: ToolCall,
  message: string,
): ToolDispatchResult => ({
  id: call.id,
  name: call.name,
  content: { error: message },
  isError: true,
});

/**
 * Run a single tool call through Zod input validation, execution, and Zod
 * output validation. Failures at any stage become an `is_error` result rather
 * than aborting the run, so the model can recover or apologize.
 */
export async function dispatchToolCall(
  call: ToolCall,
  tools: readonly ToolDef<any, any>[],
  ctx: NodeContext,
): Promise<ToolDispatchResult> {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) return errResult(call, `unknown_tool: ${call.name}`);

  const inputParse = tool.inputSchema.safeParse(call.input);
  if (!inputParse.success) {
    return errResult(call, `invalid_input: ${inputParse.error.message}`);
  }

  try {
    const output = await tool.run(inputParse.data, ctx);
    const outputParse = tool.outputSchema.safeParse(output);
    if (!outputParse.success) {
      return errResult(call, `invalid_output: ${outputParse.error.message}`);
    }
    return {
      id: call.id,
      name: call.name,
      content: outputParse.data,
      isError: false,
    };
  } catch (e) {
    return errResult(call, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Dispatch a batch of tool calls in parallel under per-call TOOL spans.
 * Each span is annotated with GenAI semconv attributes plus tool I/O.
 */
export async function dispatchToolCallsWithSpans(
  calls: readonly ToolCall[],
  tools: readonly ToolDef<any, any>[],
  ctx: NodeContext,
): Promise<ToolDispatchResult[]> {
  return Promise.all(
    calls.map((call) =>
      withToolSpan(
        ctx.tracer ?? null,
        { toolName: call.name, toolCallId: call.id },
        async () => {
          const result = await dispatchToolCall(call, tools, ctx);
          setToolIoAttributes(call.input, result.content, result.isError);
          return result;
        },
      ),
    ),
  );
}
