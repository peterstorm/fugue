import type { NodeContext } from "../types/node.js";
import type { ToolDef, ToolContext } from "../types/llm.js";
import { nodeId } from "../types/ids.js";
import { withToolSpan, setToolIoAttributes } from "./spans.js";
import { dispatchEvent } from "../observer/buffered.js";

/**
 * The dispatcher receives a wide `NodeContext` from the LLM client (cycle
 * break at the client → NodeContext boundary), but tools are typed against
 * `ToolContext` (= `TypedNodeContext<["llm"]>`). Cast at this single seam.
 *
 * Contract: callers (LLM-with-tools nodes) MUST have `llm` in their
 * `requires` so `ctx.llm` is non-null. Tools that read `ctx.llm` and find it
 * null get a runtime error — which correctly surfaces the violated contract
 * rather than masking it via a null-tolerant type.
 */
const asToolContext = (ctx: NodeContext): ToolContext => ctx as ToolContext;

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
    const output = await tool.run(inputParse.data, asToolContext(ctx));
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
    ctx.logger.warn(`[tool-dispatch] Tool '${call.name}' threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    // Emit observer event so tool failures appear in telemetry.
    // Use dispatchEvent (error-isolating wrapper) so an observer failure
    // does not replace the original tool error.
    dispatchEvent(ctx.observer, {
      type: "sub-span",
      runId: ctx.runId,
      dagId: ctx.dagId,
      nodeId: nodeId(`tool:${call.name}`),
      parentSpanId: call.id,
      kind: "CHAIN",
      timestamp: new Date(),
      duration: 0,
      attributes: {
        "tool.error": true,
        "tool.name": call.name,
        "tool.error_message": e instanceof Error ? e.message : String(e),
      },
    });
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
  opts?: { readonly model?: string },
): Promise<ToolDispatchResult[]> {
  return Promise.all(
    calls.map((call) =>
      withToolSpan(
        ctx.tracer ?? null,
        { toolName: call.name, toolCallId: call.id, model: opts?.model },
        async () => {
          const result = await dispatchToolCall(call, tools, ctx);
          setToolIoAttributes(call.input, result.content, result.isError);
          return result;
        },
      ),
    ),
  );
}
