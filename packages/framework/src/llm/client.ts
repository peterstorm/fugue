import type { z } from "zod";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeContext } from "../types/node.js";
import type { ToolDef } from "./tools.js";

export interface LlmRequest<O> {
  readonly system: string;
  readonly user: string;
  readonly model: string;
  readonly schema: z.ZodType<O>;
  readonly thinking?: { type: "enabled"; budgetTokens: number };
  readonly signal?: AbortSignal;
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
}

export interface LlmClient {
  sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>>;
  sendWithTools<O>(
    req: SendWithToolsRequest<O>,
    ctx: NodeContext,
  ): Promise<Result<LlmResponse<O>, FrameworkError>>;
}
