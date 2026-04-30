import type { z } from "zod";
import type { Result } from "./result.js";
import type { Observer } from "../observer/observer.js";

export type NodeKind = "fetch" | "transform" | "llm" | "guardrail";

export interface NodeDef<I, O, E> {
  readonly id: string;
  readonly kind: NodeKind;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly deps: readonly string[];
  readonly run: (input: I, ctx: NodeContext) => Promise<Result<O, E>>;
}

export interface Tracer {
  /** Wrap execution in a traced span. Auto-instrumented child calls nest under it. */
  withSpan<T>(name: string, spanType: string, fn: () => Promise<T>): Promise<T>;
}

export interface NodeContext {
  readonly runId: string;
  readonly dagId: string;
  readonly observer: Observer | null;
  readonly cache: any;
  readonly prompts: any;
  readonly llm: any;
  readonly logger: any;
  readonly tracer?: Tracer | null;
  readonly signal?: AbortSignal;
}
