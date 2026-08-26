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
import type { FrameworkError, PartialTokenUsage } from "../types/errors.js";
import { usageOfError } from "../types/errors.js";
import { logFrameworkWithoutThrowing } from "../logger.js";
import type { NodeId, RunId, DagId } from "../types/ids.js";
import { safeErrorMessage } from "../types/safe-error.js";
import type { LlmResponse, ToolDef } from "../types/llm.js";
import type { TokenUsage } from "../types/token-usage.js";
import { NO_TOKENS, addUsage, totalTokens } from "../types/token-usage.js";
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

/**
 * Result of one LLM turn, normalized across providers.
 *
 * Extends `TokenUsage`, so a turn reports its provider-side cache split as
 * well as its raw counts. That is what lets the loop fold turns with
 * `addUsage` (FR-PC-007) and stops a provider adapter from quietly dropping a
 * cache figure it received.
 */
interface TurnResult extends TokenUsage {
  /** Tool calls requested by the model. Empty array = final answer turn. */
  readonly toolCalls: readonly ToolCall[];
  /** Text content from the model (present on final-answer turns). */
  readonly textContent: string | undefined;
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
interface ToolUseLoopConfig<O> {
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
 * Attach the loop's accumulated cross-turn token totals onto a usage-carrying
 * `FrameworkError`, so a mid-loop failure still attributes the tokens burned by
 * already-completed turns (FR-W0-001). Errors that do not carry a `usage` field
 * (e.g. `validation`) cannot hold the totals — rather than DROP them silently
 * (a budget under-count), the accumulated figure is emitted as
 * a structured `llm.usage-unattributed` warning so the burned tokens remain
 * observable even though they can't ride the typed error channel. The warning
 * carries the `nodeId`/`runId`/`dagId` correlation triple so the burned tokens
 * stay JOINABLE to the run that burned them — without the ids, the figure is a
 * number nobody can reconcile against a run's budget.
 *
 * When the underlying error already carries its own `usage` (the provider
 * reported partial tokens for the in-flight turn that just failed — these have
 * NOT yet been added to `priorIn`/`priorOut`), the two are summed. Otherwise
 * the accumulated totals stand alone.
 */
const withAccumulatedUsage = (
  e: FrameworkError,
  prior: TokenUsage,
  corr: { readonly nodeId: NodeId; readonly runId: RunId; readonly dagId: DagId },
): FrameworkError => {
  const own = usageOfError(e);
  // `usageOfError` returning a value is exactly the set of variants that carry
  // a `usage` field — guard so we never stamp usage onto a variant without one.
  if (e.kind !== "node-crash" && e.kind !== "transient" && e.kind !== "aborted") {
    // This error kind has nowhere to carry usage. If real tokens were burned
    // before it, surface them so a budget reconciler isn't silently under-counted.
    if (totalTokens(prior) > 0) {
      logFrameworkWithoutThrowing("warn", "llm.usage-unattributed", {
        errorKind: e.kind,
        tokensIn: prior.tokensIn,
        tokensOut: prior.tokensOut,
        cacheWriteTokens: prior.cacheWriteTokens,
        cacheReadTokens: prior.cacheReadTokens,
        nodeId: corr.nodeId,
        runId: corr.runId,
        dagId: corr.dagId,
      });
    }
    return e;
  }
  // Nothing accumulated and the error carries no own usage: leave `usage`
  // ABSENT. The errors.ts contract is "absent means the failure consumed no
  // attributable tokens" — stamping `{0, 0}` here would make that state
  // representable two ways.
  if (own === undefined && totalTokens(prior) === 0) return e;
  const usage: PartialTokenUsage = addUsage(prior, own ?? NO_TOKENS);
  return { ...e, usage };
};

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
      message: safeErrorMessage(e),
    });
  }

  // One folded value rather than a pair of counters: `addUsage` carries the
  // cache split across turns for free, so a long loop's cache reads land in the
  // same place its raw counts do (FR-PC-007).
  let accumulated: TokenUsage = NO_TOKENS;
  let lastThinking: string | undefined;
  const nowFn = config.now ?? Date.now;
  const deadline = config.deadlineMs ? nowFn() + config.deadlineMs : Infinity;
  // Correlation triple for usage attribution: stamped onto every error and onto
  // the `llm.usage-unattributed` warning, so burned tokens are joinable to a run.
  const corr = { nodeId: config.nodeId, runId: ctx.runId, dagId: ctx.dagId } as const;

  for (let turn = 0; turn < config.maxIterations; turn++) {
    // Deadline check
    if (nowFn() >= deadline) {
      return err(
        withAccumulatedUsage(
          {
            kind: "transient",
            nodeId: config.nodeId,
            message: `Total deadline of ${config.deadlineMs}ms exceeded after ${turn} turns`,
          },
          accumulated,
          corr,
        ),
      );
    }
    // Abort check
    if (config.signal?.aborted || ctx.signal?.aborted) {
      return err(
        withAccumulatedUsage({ kind: "aborted", reason: "signal" }, accumulated, corr),
      );
    }

    // Call provider for one turn
    const turnResult = await provider.call(turn);
    if (!turnResult.ok) {
      // The provider's error is for the in-flight turn — its own `usage` (if
      // any) covers that turn, and we add the prior-turn totals on top.
      return err(withAccumulatedUsage(turnResult.error, accumulated, corr));
    }

    const t = turnResult.value;
    accumulated = addUsage(accumulated, t);
    if (t.thinking) lastThinking = t.thinking;

    // No tool calls = final answer
    if (t.toolCalls.length === 0) {
      if (t.textContent === undefined) {
        return err(
          withAccumulatedUsage(
            {
              kind: "node-crash",
              retriability: "retriable",
              nodeId: config.nodeId,
              message: "Final turn had no text content to parse",
            },
            accumulated,
            corr,
          ),
        );
      }
      return parseFinalAnswer(t.textContent, config, accumulated, lastThinking);
    }

    // Dispatch tools and feed results back to provider. Fenced: a throw here
    // (e.g. `asToolContext` rejecting a node that omitted `requires: ["llm"]`)
    // is an authoring error — deterministic, so non-retriable — and the tokens
    // burned producing these tool calls must still ride the typed error channel
    // (FR-W0-001); an escaping throw would surface as a usage-less retriable
    // node-crash upstream.
    let results: Awaited<ReturnType<typeof dispatchToolCallsWithSpans>>;
    try {
      results = await dispatchToolCallsWithSpans(t.toolCalls, config.tools, ctx, { model: config.model });
    } catch (e) {
      return err(
        withAccumulatedUsage(
          {
            kind: "node-crash",
            retriability: "non-retriable",
            nodeId: config.nodeId,
            message: `tool dispatch threw: ${safeErrorMessage(e)}`,
          },
          accumulated,
          corr,
        ),
      );
    }
    try {
      provider.appendToolResults(results);
    } catch (e) {
      return err(
        withAccumulatedUsage(
          {
            kind: "node-crash",
            retriability: "non-retriable",
            nodeId: config.nodeId,
            message: `provider.appendToolResults threw: ${safeErrorMessage(e)}`,
          },
          accumulated,
          corr,
        ),
      );
    }
  }

  // Iteration limit exhausted — non-retriable. Tokens burned across every turn
  // of the (now-exhausted) loop must still be attributed (FR-W0-001).
  return err(
    withAccumulatedUsage(
      {
        kind: "node-crash",
        nodeId: config.nodeId,
        message: `Tool-call iteration limit (${config.maxIterations}) reached`,
        retriability: "non-retriable",
      },
      accumulated,
      corr,
    ),
  );
};

// ---------------------------------------------------------------------------
// parseFinalAnswer — shared JSON parse + schema validation
// ---------------------------------------------------------------------------

const parseFinalAnswer = <O>(
  text: string,
  config: ToolUseLoopConfig<O>,
  usage: TokenUsage,
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
      // The whole loop's tokens were consumed to produce this final (unparseable)
      // turn — attribute them even though parsing failed (FR-W0-001).
      usage,
    });
  }
  const validated = config.schema.safeParse(parsed);
  if (!validated.success) {
    return err({
      kind: "node-crash",
      retriability: "retriable",
      nodeId: config.nodeId,
      message: `Schema validation failed: ${validated.error.message}`,
      usage,
    });
  }
  return ok({
    output: validated.data as O,
    ...usage,
    thinking,
    rawText: text,
  });
};
