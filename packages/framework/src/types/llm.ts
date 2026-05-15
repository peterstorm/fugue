// LLM-facing public types. Moved out of `llm/client.ts` + `llm/tools.ts` to
// break the `types/node.ts ↔ llm/**` import cycle. Pre-ADR-0024,
// `sendWithTools` took a structural `LlmRuntime` (now deleted) and cast to
// `NodeContext` at the dispatch boundary. With the contract living here, both
// `NodeContext` and `LlmClient` sit in the same `types/` layer; the only
// remaining edge is a 2-step type-only cycle `types/node.ts ↔ types/llm.ts`,
// which TypeScript erases at runtime.
//
// Runtime helpers (`tool`, `toolName`, `assertValidToolName`, `ensureToolNames`,
// the `ToolName` brand) stay in `llm/tools.ts` since they have no dependency
// on `types/node.ts` and are reachable from the `llm/` barrel.

import type { z } from "zod";
import type { Result } from "./result.js";
import type { FrameworkError } from "./errors.js";
import type { NodeContext, TypedNodeContext } from "./node.js";
import type { NodeId } from "./ids.js";

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
  readonly signal?: AbortSignal;
  /**
   * DAG node identifier for error reporting. Required so failures attribute
   * to the right place in the DAG.
   */
  readonly nodeId: NodeId;
  /**
   * Optional tracer for LLM span creation. When omitted or `null`, no OTel
   * span is created for this call. Prefer passing `ctx.tracer` when available.
   */
  readonly tracer?: import("../tracing/tracer.js").Tracer | null;
}

export interface LlmResponse<O> {
  readonly output: O;
  readonly tokensIn: number;
  readonly tokensOut: number;
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
  /** Cap on tool-use turns. Default 10. Exceed → Err({ kind: "transient" }). */
  readonly maxIterations?: number;
  /** Anthropic-only — extended thinking. Ignored by other providers. */
  readonly thinking?: { type: "enabled"; budgetTokens: number };
  /** Cancellation. Aborted mid-loop returns Err({ kind: "aborted" }). */
  readonly signal?: AbortSignal;
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
