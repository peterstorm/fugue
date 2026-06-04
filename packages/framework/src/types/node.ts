import type { z } from "zod";
import type { Result } from "./result.js";
import type { FrameworkError } from "./errors.js";
import type { Observer } from "./observer.js";
import type { LlmClient } from "./llm.js";
import type { Tracer } from "./tracer.js";
import type { RunId, NodeId, DagId } from "./ids.js";
import type { ContentFilter } from "./content-filter.js";
import type { SideEffectProfile } from "./side-effects.js";
import type { Confidence } from "./confidence.js";
import type { HttpCapability } from "./http-capability.js";

export type { Tracer };
export type { HttpCapability } from "./http-capability.js";

/**
 * Confidence extraction mode for a node. Every node declares how (or whether)
 * it produces a confidence signal. The framework never coerces a bare number
 * into a confidence value.
 *
 * - `{ mode: "none" }` — node does not produce confidence (explicitly opting out).
 * - `{ mode: "value"; extract }` — node produces confidence; `extract` is called
 *   on the node's output after successful execution.
 */
export type ConfidenceMode<O> =
  | { readonly mode: "none" }
  | { readonly mode: "value"; readonly extract: (output: O) => Confidence };

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

/** Cache adapter for ephemeral LLM response caching. */
export interface ContextCacheAdapter {
  readonly get: (key: string) => Promise<CacheLookup>;
  readonly set: (
    key: string,
    value: unknown,
    ttlSec?: number,
  ) => Promise<Result<void, FrameworkError>>;
}

/** Durable checkpoint writer — persists node outputs for crash-resume. */
export interface CheckpointWriter {
  readonly write: (runId: RunId, nodeId: NodeId, value: unknown) => Promise<void>;
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
//
// ADR-0051: The registry is now an extensible interface. Adapter packages
// augment `CapabilityRegistry` via module augmentation to register new
// capabilities. `Capability` is derived as `keyof CapabilityRegistry`.
// ---------------------------------------------------------------------------

/**
 * Extensible capability registry. Adapter packages augment this interface
 * to register new capabilities via TypeScript module augmentation.
 *
 * Built-in capabilities are declared here as the base set. To add a custom
 * capability:
 *
 * ```ts
 * declare module "@fugue/framework" {
 *   interface CapabilityRegistry {
 *     db: PgCapability;
 *   }
 * }
 * ```
 *
 * After augmentation, `requires: ["db"]` becomes valid and `ctx.db` is typed
 * as `PgCapability` (non-null) in the node's `run` function.
 */
export interface CapabilityRegistry {
  readonly llm: LlmClient;
  readonly cache: ContextCacheAdapter;
  readonly prompts: PromptAccess;
  readonly judgeLlm: LlmClient;
  readonly http: HttpCapability;
}

/**
 * The set of capability names a node can require. Derived from the
 * extensible `CapabilityRegistry` — adding a key to the registry
 * automatically makes it a valid capability name.
 */
export type Capability = keyof CapabilityRegistry & string;

/**
 * The built-in capability keys — exactly the capability fields declared on
 * `BaseNodeContext`. Single source of truth for runtime code that must
 * distinguish built-in capabilities (named context fields) from custom ones
 * (spread onto the context dynamically, per ADR-0051).
 *
 * The `satisfies` clause guarantees every entry is a registered capability.
 * The reverse direction (every built-in context field is listed) is asserted
 * by `_BuiltinKeysComplete` below `BaseNodeContext` — adding a built-in to
 * `CapabilityRegistry` + `BaseNodeContext` without listing it here is a
 * compile error. The assertion compares against `BaseNodeContext` (not the
 * full registry), so consumer module augmentation does not break it.
 */
export const BUILTIN_CAPABILITY_KEYS = [
  "llm",
  "cache",
  "prompts",
  "judgeLlm",
  "http",
] as const satisfies readonly Capability[];

export type BuiltinCapabilityKey = (typeof BUILTIN_CAPABILITY_KEYS)[number];

/**
 * Concrete types injected for each capability when a node declares it in
 * `requires`. Alias for `CapabilityRegistry` — kept for backward
 * compatibility with existing consumer code that references this type.
 */
export type CapabilityFields = CapabilityRegistry;

/**
 * Always-present part of NodeContext — fields the runtime guarantees by
 * injecting a no-op default when none is supplied.
 *
 * Capability fields appear as nullable here (the runtime may or may not have
 * them wired). After `validateCapabilities` passes, the `TypedNodeContext<R>`
 * narrows declared capabilities to non-null.
 *
 * Custom capabilities registered via `CapabilityRegistry` augmentation do NOT
 * appear as named fields here — they are accessible at runtime as dynamic
 * properties on the context object, and the `TypedNodeContext<R>` type
 * intersection adds their concrete types when declared in `requires`.
 */
export interface BaseNodeContext {
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly observer: Observer;
  readonly cache: ContextCacheAdapter | null;
  readonly checkpointWriter?: CheckpointWriter | null;
  readonly llm: LlmClient | null;
  readonly prompts: PromptAccess | null;
  readonly judgeLlm: LlmClient | null;
  readonly http: HttpCapability | null;
  readonly signal?: AbortSignal;
  /**
   * Optional content filter for trace span data. When set, content (prompts,
   * node inputs/outputs, thinking) is included in spans after being passed
   * through this filter. When `null`/`undefined`, content is fully redacted.
   *
   * Use `piiScrubber` for regex-based PII removal, `IDENTITY_FILTER` for
   * unfiltered content, or provide a custom `(s: string) => string`.
   */
  readonly contentFilter?: ContentFilter | null;
}

// ---------------------------------------------------------------------------
// Negative-space assertion: `BUILTIN_CAPABILITY_KEYS` must equal exactly the
// capability-named fields of `BaseNodeContext`. The `satisfies` on the array
// proves the forward direction (every entry is a capability); this proves the
// reverse (no built-in context field is missing from the array). It compares
// against `BaseNodeContext` keys — fixed at framework-compile time — so
// consumer `CapabilityRegistry` augmentation (which only widens `Capability`)
// cannot break it. If this errors, a built-in was added to the registry +
// `BaseNodeContext` without updating `BUILTIN_CAPABILITY_KEYS`, and
// `makeNodeContext` would mis-handle it as a custom capability.
// ---------------------------------------------------------------------------
type _Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type _StaticAssert<T extends true> = T;
type _BuiltinKeysComplete = _StaticAssert<
  _Equal<BuiltinCapabilityKey, Extract<keyof BaseNodeContext, Capability>>
>;

/**
 * Always-present `BaseNodeContext` fields that are NOT capabilities — the
 * framework guarantees them by injecting a no-op default, so they live as named
 * fields rather than registry entries.
 *
 * A consumer that augments `CapabilityRegistry` with a key equal to one of these
 * creates a name collision: `makeNodeContext` refuses to spread such a
 * capability (it would clobber framework infrastructure), so its client is never
 * wired — meaning the capability can never be satisfied. `validateCapabilities`
 * therefore treats a required capability with one of these names as missing
 * (fail-closed) rather than reading the infra field and passing falsely.
 *
 * Enforcement is necessarily at runtime: the collision is introduced by
 * *consumer* module augmentation, which the framework's own compilation cannot
 * observe, so a static `Capability & ReservedNonCapabilityKey extends never`
 * assertion here would only cover the framework's built-ins (which never
 * collide) and give false reassurance about consumer keys.
 */
export const RESERVED_NON_CAPABILITY_KEYS = [
  "runId",
  "dagId",
  "logger",
  "tracer",
  "observer",
  "checkpointWriter",
  "signal",
  "contentFilter",
] as const satisfies readonly (keyof BaseNodeContext)[];

export type ReservedNonCapabilityKey = (typeof RESERVED_NON_CAPABILITY_KEYS)[number];

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
    readonly [K in R[number]]: CapabilityRegistry[K];
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

/**
 * Base node definition fields shared by all side-effect profiles.
 * The full `NodeDef` type adds optional freshness extractors for `reads`
 * and `writes` nodes. When present, the framework emits witness events;
 * when absent, freshness tracking is silently skipped for that node.
 */
export interface NodeDef<
  I = unknown,
  O = unknown,
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
   * Declares the side-effect profile for this node. The framework uses this
   * for freshness-witness contracts, operator dashboards, and routing safety
   * analysis.
   *
   * - `"none"` — pure transform, no external state read or mutated.
   * - `"reads"` — reads external state (DB, API) without mutation.
   * - `"writes"` — mutates external state (DB writes, state changes).
   * - `"external-call"` — calls an external service with potential side effects.
   *
   * `resource` is mandatory for all kinds except `"none"` and names the logical
   * resource (e.g. `"postgres:orders"`, `"stripe:charges"`).
   */
  readonly sideEffects: SideEffectProfile<I, O>;
  /**
   * Confidence extraction mode. Declares how this node produces a confidence
   * signal for downstream routing decisions.
   *
   * - `{ mode: "none" }` — no confidence signal (default for pure transforms).
   * - `{ mode: "value", extract: (output) => Confidence }` — extract a
   *   bucketed confidence from the node's output.
   *
   * When `mode === "value"`, the framework calls `extract(output)` after
   * successful execution and colocates the result with routing evidence.
   */
  readonly confidence: ConfidenceMode<O>;
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
 *
 * Custom capabilities can be passed via the `capabilities` record or as
 * top-level fields (built-in capabilities remain top-level for backward compat).
 */
export type NodeContextInit = {
  readonly runId: string | RunId;
  readonly dagId: string | DagId;
  readonly logger?: Logger;
  readonly tracer?: Tracer;
  readonly observer?: Observer;
  readonly cache?: ContextCacheAdapter | null;
  readonly checkpointWriter?: CheckpointWriter | null;
  readonly llm?: LlmClient | null;
  readonly prompts?: PromptAccess | null;
  readonly judgeLlm?: LlmClient | null;
  readonly http?: HttpCapability | null;
  readonly signal?: AbortSignal;
  readonly contentFilter?: ContentFilter | null;
  /**
   * Extensible capabilities record. Keys correspond to `CapabilityRegistry`
   * entries. Values are the capability client instances.
   *
   * Built-in capabilities (`llm`, `cache`, `prompts`, `judgeLlm`, `http`) can
   * also be passed here instead of as top-level fields.
   */
  readonly capabilities?: Partial<{ readonly [K in Capability]: CapabilityRegistry[K] | null }>;
};
