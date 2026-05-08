import type { z } from "zod";
import type { Result } from "./result.js";
import type { Observer } from "../observer/observer.js";
import type { LlmClient } from "../llm/client.js";

export type NodeKind = "fetch" | "transform" | "llm" | "guardrail" | "eval-judge";

/** Retry configuration for a single node. */
export interface NodeRetryConfig {
  /** Backoff delays in ms for successive attempts [attempt0, attempt1, ...]. Defaults to [1000, 2000, 4000]. */
  readonly backoffMs?: readonly number[];
  /** Jitter ratio (0–1) multiplied by the backoff delay and added randomly. Defaults to 0.2. */
  readonly jitterRatio?: number;
}

/** Human-review gate configuration for a node. */
export interface NodeHumanReviewConfig {
  /** Prompt shown to the reviewer. */
  readonly prompt: string;
}

export interface NodeDef<I, O, E> {
  readonly id: string;
  readonly kind: NodeKind;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly deps: readonly string[];
  readonly run: (input: I, ctx: NodeContext) => Promise<Result<O, E>>;
  /**
   * When set, the DAG pauses after this node completes and awaits a human response.
   * Optional for back-compat; existing nodes without this field behave as before.
   */
  readonly humanReview?: NodeHumanReviewConfig;
  /**
   * Per-node retry configuration (backoff delays, jitter).
   * Optional for back-compat; uses DAG-level or default settings when omitted.
   */
  readonly retry?: NodeRetryConfig;
}

export interface Tracer {
  /** Wrap execution in a traced span. Auto-instrumented child calls nest under it. */
  withSpan<T>(name: string, spanType: string, fn: () => Promise<T>): Promise<T>;
}

export interface PromptAccess {
  readonly get: (name: string) => string | null;
}

export interface Logger {
  readonly warn: (msg: string) => void;
  readonly error: (msg: string) => void;
}

/** Cache adapter expected by framework nodes (LLM cache + checkpoint). */
export interface ContextCacheAdapter {
  readonly get: (key: string) => Promise<unknown | null>;
  readonly set: (key: string, value: unknown, ttlSec?: number) => Promise<unknown>;
  readonly writeCheckpoint?: (runId: string, nodeId: string, value: unknown) => Promise<void>;
}

export interface NodeContext {
  readonly runId: string;
  readonly dagId: string;
  readonly observer: Observer | null;
  readonly cache: ContextCacheAdapter | null;
  readonly prompts: PromptAccess | null;
  readonly llm: LlmClient | null;
  /** Optional cheaper LLM client for eval-judge nodes. Falls back to `llm` if not set. */
  readonly judgeLlm?: LlmClient | null;
  readonly logger: Logger | null;
  readonly tracer?: Tracer | null;
  readonly signal?: AbortSignal;
}
