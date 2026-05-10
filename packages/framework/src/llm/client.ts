import type { z } from "zod";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { Tracer } from "../tracing/tracer.js";
import type { ToolDef } from "./tools.js";

/**
 * Per-call runtime threaded into `LlmClient.sendWithTools`. Carries the OTel
 * tracer + cancellation signal without forcing the client to depend on the
 * full `NodeContext` (which would create a `types/node.ts ↔ llm/client.ts`
 * import cycle).
 */
export interface LlmRuntime {
  readonly tracer?: Tracer | null;
  readonly signal?: AbortSignal;
}

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
   * DAG node identifier for error reporting. When omitted, errors carry
   * `"<llm>"` as nodeId. Pass the calling node's `id` so failures attribute
   * to the right place in the DAG.
   */
  readonly nodeId?: string;
}

export interface LlmResponse<O> {
  readonly output: O;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly thinking?: string;
  readonly rawText: string;
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
   * DAG node identifier for error reporting. When omitted, errors carry
   * `"<llm>"` as nodeId. Pass the calling node's `id` so failures attribute
   * to the right place in the DAG.
   */
  readonly nodeId?: string;
}

export interface LlmClient {
  sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>>;
  sendWithTools<O>(
    req: SendWithToolsRequest<O>,
    runtime: LlmRuntime,
  ): Promise<Result<LlmResponse<O>, FrameworkError>>;
}
