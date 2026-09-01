// LLM-facing public types. Moved out of `llm/client.ts` + `llm/tools.ts` to
// break the `types/node.ts ↔ llm/**` import cycle. With the contract living
// here, both `NodeContext` and `LlmClient` sit in the same `types/` layer;
// the only remaining edge is a 2-step type-only cycle `types/node.ts ↔
// types/llm.ts`, which TypeScript erases at runtime.
//
// Runtime helpers (`tool`, `toolName`, `assertValidToolName`, `ensureToolNames`,
// the `ToolName` brand) stay in `llm/tools.ts` since they have no dependency
// on `types/node.ts` and are reachable from the `llm/` barrel.

import type { z } from "zod";
import type { Result } from "./result.js";
import type { FrameworkError } from "./errors.js";
import type { NodeContext, TypedNodeContext } from "./node.js";
import type { NodeId } from "./ids.js";
import type { TokenUsage } from "./token-usage.js";
import type { Tracer } from "./tracer.js";

// ---------------------------------------------------------------------------
// Branded `ToolName`
//
// The brand is a module-level `unique symbol` — only the smart constructors
// in `llm/tools.ts` (`toolName()`, `assertValidToolName()`) produce values
// that pass the structural check. Direct object-literal construction of a
// `ToolDef` with a raw string `name` is rejected at the type level:
// `name: "foo"` fails because the literal `"foo"` lacks the brand witness.
// ---------------------------------------------------------------------------

declare const __toolNameBrand: unique symbol;
export type ToolName = string & { readonly [__toolNameBrand]: void };

// ---------------------------------------------------------------------------
// Prompt caching
//
// The caller declares WHAT IS STABLE; the framework derives WHERE the
// breakpoints go (`llm/prompt-cache.ts`). Callers never write a breakpoint
// index, never count against the provider's four-slot cap, and cannot place a
// breakpoint after volatile content — the types give them no way to say it.
// ---------------------------------------------------------------------------

/**
 * Provider-side prompt-cache lifetime. Not a raw string: the provider accepts
 * exactly two values, priced differently — a 5-minute entry costs 1.25x the
 * base input rate to write, a 1-hour entry 2x. Reads are ~0.1x either way, so
 * `5m` breaks even at two requests and `1h` at three.
 */
export type CacheTtl = "5m" | "1h";

/**
 * Cache policy for a single-shot call.
 *
 * `static-prefix` asserts that the tools and system prompt are stable across
 * calls, which is what the provider needs to reuse them: caching is a PREFIX
 * match over the rendered `tools → system → messages` order, so one breakpoint
 * at the end of `system` covers both.
 *
 * Omitted or `none` emits no `cache_control` at all — byte-identical to the
 * pre-caching request (FR-PC-004). Caching is opt-in everywhere because a
 * single call over a large UNIQUE prefix pays the write premium and never
 * reads it back.
 */
export type SingleShotCachePolicy =
  | { readonly kind: "none" }
  | { readonly kind: "static-prefix"; readonly ttl: CacheTtl };

/**
 * Cache policy for a tool-use loop, which additionally offers `conversation`:
 * roll a breakpoint onto the last block of each completed turn so turn N reads
 * the prefix turn N-1 wrote. A loop re-sends its whole accumulated history
 * every turn, so this is where caching pays most.
 *
 * `conversation` is deliberately ABSENT from `SingleShotCachePolicy`: a single
 * call has no second turn to read what the first wrote, so asking for it is a
 * compile error rather than a silently wasted write premium.
 */
export type ConversationCachePolicy =
  | SingleShotCachePolicy
  | { readonly kind: "conversation"; readonly ttl: CacheTtl };

/**
 * Which model identity an LLM binding authorizes for pricing and egress.
 * Dynamic providers use the request model; fixed deployments bind one model
 * during composition and reject conflicting requests before provider egress.
 */
export type LlmPricingModel =
  | { readonly kind: "request" }
  | { readonly kind: "fixed"; readonly model: string };

// ---------------------------------------------------------------------------
// Single-shot structured responses
// ---------------------------------------------------------------------------

export interface LlmRequest<O> {
  readonly system: string;
  readonly user: string;
  readonly model: string;
  readonly schema: z.ZodType<O>;
  /**
   * Anthropic ignores this in `sendStructured` (extended thinking requires
   * streaming, not yet implemented). OpenAI maps it to `reasoning.effort: "high"`.
   */
  readonly thinking?: { type: "enabled"; budgetTokens: number };
  /**
   * Sampling temperature in [0, 1] — the providers' common denominator
   * (Anthropic caps sampling at 1.0; OpenAI accepts up to 2 but this seam
   * pins the portable range). Both clients reject a non-finite or
   * out-of-range value pre-flight as a typed `validation` error before
   * anything reaches the wire. Omitted → the provider's default.
   * Deterministic drafting loops (e.g. `fugue compose`) pin this to 0 so
   * structured turns are as reproducible as the provider allows. Cannot be
   * combined with `thinking` on OpenAI — the client rejects the pair
   * pre-flight the same way.
   */
  readonly temperature?: number;
  readonly signal?: AbortSignal;
  /**
   * Provider-side prompt caching. Omitted ≡ `{ kind: "none" }` ≡ no
   * `cache_control` on the wire.
   *
   * Anthropic honours it. **OpenAI ignores this field entirely** — it caches
   * automatically and exposes no request-side control, so declaring a policy
   * changes neither what that client sends nor what it reports. Its
   * `cacheReadTokens` reflects whatever the provider did on its own, with or
   * without a policy here.
   *
   * The field is still meaningful on an OpenAI-backed node, one layer up: the
   * pipeline compares the DECLARED policy against the usage that actually came
   * back to detect an inert policy (FR-PC-009) and to stamp
   * `ai.prompt_cache.policy` on the span. That check is provider-agnostic.
   */
  readonly cache?: SingleShotCachePolicy;
  /**
   * DAG node identifier for error reporting. Required so failures attribute
   * to the right place in the DAG.
   */
  readonly nodeId: NodeId;
  /**
   * Optional tracer for LLM span creation. When omitted or `null`, no OTel
   * span is created for this call. Prefer passing `ctx.tracer` when available.
   */
  readonly tracer?: Tracer | null;
}

/**
 * A completed LLM call: the parsed output plus the call's `TokenUsage`.
 *
 * Extends `TokenUsage` rather than nesting it: `tokensIn`/`tokensOut` already
 * lived here with exactly that meaning, so existing readers keep working, and
 * a response can be handed directly to `addUsage`/`computeCostUsd` without an
 * unpacking step.
 */
export interface LlmResponse<O> extends TokenUsage {
  readonly output: O;
  readonly thinking?: string;
  readonly rawText: string;
}

// ---------------------------------------------------------------------------
// Tool-using loop
// ---------------------------------------------------------------------------

/**
 * The context shape passed to a tool body. Tools always run inside an
 * LLM-with-tools node which declares `requires: ["llm"]`, so `ctx.llm` is
 * guaranteed non-null — tool authors don't need to null-check it.
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
  /**
   * Identifier sent to the model. Branded `ToolName` — construct via
   * `tool({ name: ... })` (validates at definition time) or `toolName(...)`
   * (one-shot smart constructor). Direct object-literal construction with a
   * raw string is rejected at the type level.
   */
  readonly name: ToolName;
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

/**
 * Request envelope for `LlmClient.sendWithTools`. The framework owns the
 * `LLM → TOOL → LLM → ...` loop; tools are dispatched, results re-fed to
 * the model, and the loop ends when the model emits a parseable answer
 * matching `schema`.
 */
export interface SendWithToolsRequest<O> {
  readonly system: string;
  readonly user: string;
  readonly model: string;
  // `any` (not `unknown`) is load-bearing here: `ToolDef.run` is contravariant
  // in its input type, so an array of heterogeneous `ToolDef<I_n, O_n>` can
  // only be widened via `any`'s bivariance. `dispatchToolCall` runs Zod-based
  // narrowing at the dispatch boundary — the real invariant guard.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly tools: readonly ToolDef<any, any>[];
  /** Final structured-output schema. */
  readonly schema: z.ZodType<O>;
  /** Cap on tool-use turns. Default 10. Exceed → Err({ kind: "node-crash", retriability: "non-retriable" }). */
  readonly maxIterations?: number;
  /** Total wall-clock deadline across all turns (ms). Default: unlimited. Exceed → Err({ kind: "transient" }). */
  readonly deadlineMs?: number;
  /**
   * Anthropic ignores this in `sendWithTools` (extended thinking requires
   * streaming, not yet implemented). OpenAI maps it to `reasoning.effort: "high"`.
   */
  readonly thinking?: { type: "enabled"; budgetTokens: number };
  /** Cancellation. Aborted mid-loop returns Err({ kind: "aborted" }). */
  readonly signal?: AbortSignal;
  /**
   * Provider-side prompt caching. Accepts `conversation` in addition to the
   * single-shot policies: a loop re-sends its whole accumulated history every
   * turn, so a rolling per-turn breakpoint is what makes turn N read the
   * prefix turn N-1 wrote. Omitted ≡ `{ kind: "none" }`.
   */
  readonly cache?: ConversationCachePolicy;
  /**
   * Tool-choice hint. Default `auto` (model decides).
   * `any` forces a tool call on the first turn; `none` disables tools.
   */
  readonly toolChoice?: "auto" | "any" | "none";
  /**
   * DAG node identifier for error reporting. Required.
   */
  readonly nodeId: NodeId;
}

// ---------------------------------------------------------------------------
// LlmClient — the seam every node-facing LLM call flows through
// ---------------------------------------------------------------------------

export interface LlmClient {
  /**
   * Single-shot structured output request. Sends a system+user prompt to the
   * model and returns a schema-validated response. Retries (when wired through
   * the DAG runtime) are handled at the node level, not within this call.
   */
  sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>>;
  /**
   * Run a tool-using LLM loop until the model emits a final response that
   * parses against `req.schema`. `ctx` is the calling node's `NodeContext` —
   * tools receive it (narrowed to `ToolContext` because LLM-with-tools nodes
   * always declare `requires: ["llm"]`).
   */
  sendWithTools<O>(
    req: SendWithToolsRequest<O>,
    ctx: NodeContext,
  ): Promise<Result<LlmResponse<O>, FrameworkError>>;
}
