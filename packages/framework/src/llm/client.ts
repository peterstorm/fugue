import type { z } from "zod";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { Tracer } from "../tracing/tracer.js";
import type { ToolDef } from "./tools.js";

/**
 * Per-call runtime threaded into `LlmClient.sendWithTools`. Carries the OTel
 * tracer + cancellation signal without forcing the client to depend on the
 * full `NodeContext` (which would create a `types/node.ts ↔ llm/client.ts`
 * import cycle: `types/node.ts` imports `LlmClient`, so the reverse direction
 * is closed off).
 *
 * Wave 4 §4.4 — the implementation in `AnthropicLlmClient.sendWithTools`
 * structurally widens this to `NodeContext` before passing to tool dispatch.
 * Tools may read fields beyond `tracer` / `signal` (commonly `cache`,
 * `logger`, `runId`, `dagId`); callers wiring tools MUST pass a value that
 * provides those fields — typically the calling node's `NodeContext`. The
 * `LlmRuntime` type is the *minimum* the framework needs; tool authors
 * effectively constrain the actual minimum to whatever their `run` reads.
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
  // `any` (not `unknown`) is load-bearing here: `ToolDef.run` is contravariant
  // in its input type, so an array of heterogeneous `ToolDef<I_n, O_n>` can
  // only be widened via `any`'s bivariance. `dispatchToolCall` runs Zod-based
  // narrowing at the dispatch boundary, which is the real invariant guard;
  // see §4.7 of the Wave 4 plan for the analysis.
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
   * DAG node identifier for error reporting. When omitted, errors carry
   * `"<llm>"` as nodeId. Pass the calling node's `id` so failures attribute
   * to the right place in the DAG.
   */
  readonly nodeId?: string;
}

export interface LlmClient {
  sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>>;
  /**
   * Run a tool-using LLM loop until the model emits a final response that
   * parses against `req.schema`.
   *
   * `runtime` is structurally typed as `LlmRuntime` to avoid the cycle with
   * `types/node.ts`. However, the tool dispatch loop forwards `runtime` to
   * `tool.run(input, ctx)` — tools may read any `NodeContext` field. Callers
   * wiring tools MUST pass a `NodeContext` (which is a structural superset of
   * `LlmRuntime`); passing a bare `LlmRuntime` is safe only when no tool
   * reads beyond `tracer` / `signal`.
   */
  sendWithTools<O>(
    req: SendWithToolsRequest<O>,
    runtime: LlmRuntime,
  ): Promise<Result<LlmResponse<O>, FrameworkError>>;
}
