// tool-use-loop.ts — provider-agnostic tool-use loop.
//
// Deep module: callers supply a ToolLoopProvider (wire-format adapter) and
// configuration. The loop owns:
// - Iteration limit enforcement
// - Total deadline enforcement
// - Abort signal propagation
// - Token accumulation across turns
// - Tool call dispatch (via dispatchToolCallsWithSpans)
// - Final-answer JSON parsing and schema validation
//
// Adding a new LLM provider requires implementing ToolLoopProvider (~50-80 LOC)
// rather than reimplementing the full loop (~120 LOC of control flow).

import type { z } from "zod";
import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import type { LlmResponse, ToolDef } from "../types/llm.js";
import type { NodeContext } from "../types/node.js";
import { ensureToolNames } from "./tools.js";
import {
  dispatchToolCallsWithSpans,
  type ToolCall,
  type ToolDispatchResult,
} from "./tool-dispatch.js";

// ---------------------------------------------------------------------------
// ToolLoopProvider — the seam each provider adapter implements
// ---------------------------------------------------------------------------

/** Result of one LLM turn, normalized across providers. */
export interface TurnResult {
  /** Tool calls requested by the model. Empty array = final answer turn. */
  readonly toolCalls: readonly ToolCall[];
  /** Text content from the model (present on final-answer turns). */
  readonly textContent: string | undefined;
  /** Tokens consumed this turn (input). */
  readonly tokensIn: number;
  /** Tokens produced this turn (output). */
  readonly tokensOut: number;
  /** Extended thinking content (if model supports it). */
  readonly thinking?: string;
}

/**
 * Provider-specific adapter for the tool-use loop. Each provider implements
 * this to translate between its SDK wire format and the normalized loop types.
 */
export interface ToolLoopProvider {
  /**
   * Execute one LLM turn. The provider handles SDK call, timeout, abort
   * detection, and span creation. Returns a normalized TurnResult or an error.
   */
  call(turn: number): Promise<Result<TurnResult, FrameworkError>>;
  /**
   * Append tool dispatch results to the conversation for the next turn.
   * Called after tools are dispatched, before the next `call()`.
   */
  appendToolResults(results: readonly ToolDispatchResult[]): void;
}

/** Configuration for the tool-use loop. */
export interface ToolUseLoopConfig<O> {
  readonly nodeId: NodeId;
  readonly model: string;
  readonly schema: z.ZodType<O>;
  readonly tools: readonly ToolDef<any, any>[];
  readonly maxIterations: number;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  /** Injectable clock for deadline enforcement. Defaults to `Date.now`. */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// toolUseLoop — the deep module
// ---------------------------------------------------------------------------

const stripCodeFences = (text: string): string =>
  text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

/**
 * Run the tool-use loop until the model emits a final answer matching `schema`,
 * or a terminal condition (iteration limit, deadline, abort) is reached.
 *
 * The loop:
 * 1. Checks deadline and abort signal
 * 2. Calls the provider for one turn
 * 3. Accumulates tokens
 * 4. If no tool calls → parse final answer, validate schema, return
 * 5. If tool calls → dispatch via `dispatchToolCallsWithSpans`, append results, continue
 * 6. If max iterations exhausted → return non-retriable error
 */
export const toolUseLoop = async <O>(
  provider: ToolLoopProvider,
  config: ToolUseLoopConfig<O>,
  ctx: NodeContext,
): Promise<Result<LlmResponse<O>, FrameworkError>> => {
  // Validate tool names upfront
  try {
    ensureToolNames(config.tools);
  } catch (e) {
    return err({
      kind: "validation",
      nodeId: config.nodeId,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let lastThinking: string | undefined;
  const nowFn = config.now ?? Date.now;
  const deadline = config.deadlineMs ? nowFn() + config.deadlineMs : Infinity;

  for (let turn = 0; turn < config.maxIterations; turn++) {
    // Deadline check
    if (nowFn() >= deadline) {
      return err({
        kind: "transient",
        nodeId: config.nodeId,
        message: `Total deadline of ${config.deadlineMs}ms exceeded after ${turn} turns`,
      });
    }
    // Abort check
    if (config.signal?.aborted || ctx.signal?.aborted) {
      return err({ kind: "aborted", reason: "signal" });
    }

    // Call provider for one turn
    const turnResult = await provider.call(turn);
    if (!turnResult.ok) return turnResult;

    const t = turnResult.value;
    totalTokensIn += t.tokensIn;
    totalTokensOut += t.tokensOut;
    if (t.thinking) lastThinking = t.thinking;

    // No tool calls = final answer
    if (t.toolCalls.length === 0) {
      if (t.textContent === undefined) {
        return err({
          kind: "node-crash",
          retriability: "retriable",
          nodeId: config.nodeId,
          message: "Final turn had no text content to parse",
        });
      }
      return parseFinalAnswer(t.textContent, config, totalTokensIn, totalTokensOut, lastThinking);
    }

    // Dispatch tools and feed results back to provider
    const results = await dispatchToolCallsWithSpans(t.toolCalls, config.tools, ctx, { model: config.model });
    provider.appendToolResults(results);
  }

  // Iteration limit exhausted — non-retriable
  return err({
    kind: "node-crash",
    nodeId: config.nodeId,
    message: `Tool-call iteration limit (${config.maxIterations}) reached`,
    retriability: "non-retriable",
  });
};

// ---------------------------------------------------------------------------
// parseFinalAnswer — shared JSON parse + schema validation
// ---------------------------------------------------------------------------

const parseFinalAnswer = <O>(
  text: string,
  config: ToolUseLoopConfig<O>,
  tokensIn: number,
  tokensOut: number,
  thinking: string | undefined,
): Result<LlmResponse<O>, FrameworkError> => {
  const stripped = stripCodeFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err({
      kind: "node-crash",
      retriability: "retriable",
      nodeId: config.nodeId,
      message: `Not valid JSON (${msg}): ${text.slice(0, 200)}`,
    });
  }
  const validated = config.schema.safeParse(parsed);
  if (!validated.success) {
    return err({
      kind: "node-crash",
      retriability: "retriable",
      nodeId: config.nodeId,
      message: `Schema validation failed: ${validated.error.message}`,
    });
  }
  return ok({
    output: validated.data as O,
    tokensIn,
    tokensOut,
    thinking,
    rawText: text,
  });
};
