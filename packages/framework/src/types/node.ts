import type { z } from "zod";
import type { Result } from "./result.js";
import type { FrameworkError } from "./errors.js";
import type { Observer } from "../observer/observer.js";
import type { LlmClient } from "../llm/client.js";
import type { Tracer } from "../tracing/tracer.js";
import type { RunId, NodeId, DagId } from "./ids.js";

export type { Tracer };

export type NodeKind = "fetch" | "transform" | "llm" | "guardrail" | "eval-judge";

/** Retry configuration for a single node. */
export interface NodeRetryConfig {
  /** Backoff delays in ms for successive attempts [attempt0, attempt1, ...]. Defaults to [1000, 2000, 4000]. */
  readonly backoffMs?: readonly number[];
  /** Jitter ratio (0–1) multiplied by the backoff delay and added randomly. Defaults to 0.2. */
  readonly jitterRatio?: number;
}

/**
 * Human-review gate configuration for a node.
 *
 * Setting this field on any node routes the run through the durable
 * state-machine runtime — the call to `runDag` MUST also supply
 * `RunOptions.onHumanReview`, otherwise it returns a validation error.
 */
export interface NodeHumanReviewConfig {
  /** Prompt shown to the reviewer. */
  readonly prompt: string;
}

export interface PromptAccess {
  readonly get: (name: string) => string | null;
}

export interface Logger {
  readonly warn: (msg: string) => void;
  readonly error: (msg: string) => void;
}

/**
 * Discriminated hit/miss result from a cache lookup. The explicit tag
 * separates "cache miss" from "cache hit with value `null`" — a problem for
 * any node that caches a nullable result.
 */
export type CacheLookup =
  | { readonly hit: true; readonly value: unknown }
  | { readonly hit: false };

/** Cache adapter expected by framework nodes (LLM cache + checkpoint). */
export interface ContextCacheAdapter {
  readonly get: (key: string) => Promise<CacheLookup>;
  readonly set: (
    key: string,
    value: unknown,
    ttlSec?: number,
  ) => Promise<Result<void, FrameworkError>>;
  readonly writeCheckpoint?: (runId: RunId, nodeId: NodeId, value: unknown) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Capability-typed NodeContext
//
// Design decisions:
//
//  - Capabilities are the things the framework cannot synthesize a sensible
//    no-op default for: real LLM clients, real cache backends, real prompt
//    registries. Logger/Tracer/Observer are *always* present (no-op defaults
//    are wired by the runtime) so they never appear as capabilities.
//
//  - Every `NodeDef` declares `requires: readonly Capability[]` — empty is
//    valid (a pure transform requires nothing), but the field is mandatory.
//    The declared set is statically reflected into the node's `ctx` type:
//    nodes that declare `requires: ["llm"]` see `ctx.llm: LlmClient`, not
//    `LlmClient | null`. Boilerplate null-checks at the use site disappear.
//
//  - At run start, the runtime walks `dag.nodes`, unions the declared
//    capabilities, and validates the wired ctx against that set. A missing
//    capability fails the run *before* the first `node.run` is called, with
//    `Err({ kind: "missing-capability", capability, nodeId })`.
// ---------------------------------------------------------------------------

/**
 * The set of capability names a node can require. Each maps to a non-null
 * concrete type in `CapabilityFields` below.
 */
export type Capability = "llm" | "cache" | "prompts" | "judgeLlm";

/**
 * Concrete types injected for each capability when a node declares it in
 * `requires`. The field name on `NodeContext` matches the capability name.
 */
export interface CapabilityFields {
  readonly llm: LlmClient;
  readonly cache: ContextCacheAdapter;
  readonly prompts: PromptAccess;
  readonly judgeLlm: LlmClient;
}

// Compile-time assertion that `Capability` (the discriminator union) and
// `keyof CapabilityFields` (the record type) match exactly. Adding an entry
// to one without the other turns the matching `_AssertCapabilitySync`
// position into a non-`never` type, making the trailing assignment fail to
// compile with a message that names the offending side.
type _AssertCapabilitySync =
  | (Capability extends keyof CapabilityFields
      ? never
      : "Capability has a key missing from CapabilityFields")
  | (keyof CapabilityFields extends Capability
      ? never
      : "CapabilityFields has a key missing from Capability");
// Assignment to `never` proves the union collapsed — any drift surfaces here.
const _capabilityCheck: _AssertCapabilitySync = undefined as never;
void _capabilityCheck;

/**
 * Always-present part of NodeContext — fields the runtime guarantees by
 * injecting a no-op default when none is supplied.
 */
export interface BaseNodeContext {
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly observer: Observer;
  readonly cache: ContextCacheAdapter | null;
  readonly llm: LlmClient | null;
  readonly prompts: PromptAccess | null;
  readonly judgeLlm: LlmClient | null;
  readonly signal?: AbortSignal;
  /**
   * When `true`, span events include full prompt/response bodies. When
   * `false` (default), bodies are redacted. Set once at bootstrap (typically
   * from an env var) and seeded into every spawned context — the framework
   * does not read process.env directly.
   */
  readonly includeContent?: boolean;
}

/**
 * The runtime-facing NodeContext shape (capability fields nullable). The
 * runtime executor passes this to `runNodeShared`; each node's `run` callback
 * sees a `TypedNodeContext<R>` derived from its own `requires`.
 */
export type NodeContext = BaseNodeContext;

/**
 * Narrows nullable capability fields to their non-null concrete types based
 * on a node's declared `requires`. Used as the parameter type of `NodeDef.run`.
 */
export type TypedNodeContext<R extends readonly Capability[]> =
  Omit<BaseNodeContext, R[number]> & {
    readonly [K in R[number]]: CapabilityFields[K];
  };

/**
 * Phantom-tagged `NodeContext` — only `validateCapabilities` can construct
 * one. Threaded into `runNodeShared` so the capability-erasure cast at the
 * run boundary operates on a type-system-witnessed value rather than a raw
 * `NodeContext`. The brand is a module-private symbol; downstream code cannot
 * forge it.
 */
declare const __capabilitiesValidated: unique symbol;
export type ValidatedNodeContext = NodeContext & {
  readonly [__capabilitiesValidated]: true;
};

/**
 * Apply the validated-capabilities brand to a `NodeContext`. Intentionally
 * `internal` — the only legitimate caller is `validateCapabilities` after
 * its checks pass. Exported only so the validator module can reach it.
 */
export const brandAsValidatedNodeContext = (
  ctx: NodeContext,
): ValidatedNodeContext => ctx as ValidatedNodeContext;

export interface NodeDef<
  I,
  O,
  E extends FrameworkError = FrameworkError,
  R extends readonly Capability[] = readonly Capability[],
> {
  readonly id: NodeId;
  readonly kind: NodeKind;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  /**
   * Capabilities this node requires on its `NodeContext`. The runtime
   * validates that the wired ctx satisfies them before any node runs;
   * each required field appears as non-null in the `ctx` parameter of `run`.
   * Use `[] as const` for nodes that need no capabilities.
   */
  readonly requires: R;
  readonly run: (input: I, ctx: TypedNodeContext<R>) => Promise<Result<O, E>>;
  /**
   * When set, the DAG pauses after this node completes and awaits a human
   * response. Routing to the state-machine path is driven by this field.
   */
  readonly humanReview?: NodeHumanReviewConfig;
  /**
   * Per-node retry configuration (backoff delays, jitter). Falls back to
   * `DagDef.retryLimits` / `DagDef.defaultRetryLimit` when omitted.
   */
  readonly retry?: NodeRetryConfig;
}

/**
 * Caller-facing input shape for `makeNodeContext`. `logger`, `tracer`, and
 * `observer` are optional — when omitted the runtime injects no-op defaults.
 * Capability fields stay as in `BaseNodeContext`.
 */
export type NodeContextInit = {
  readonly runId: string | RunId;
  readonly dagId: string | DagId;
  readonly logger?: Logger;
  readonly tracer?: Tracer;
  readonly observer?: Observer;
  readonly cache?: ContextCacheAdapter | null;
  readonly llm?: LlmClient | null;
  readonly prompts?: PromptAccess | null;
  readonly judgeLlm?: LlmClient | null;
  readonly signal?: AbortSignal;
  readonly includeContent?: boolean;
};
