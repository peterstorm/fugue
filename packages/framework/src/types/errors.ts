// Discriminated union of all framework errors

import { match } from "ts-pattern";
import { z } from "zod";
import { tryNodeId, tryRunId } from "./ids.js";
// The checkpoint-address ADTs and their ONE construction path live in a leaf
// module that imports only `ids.js`, so parsing a persisted record can reuse
// the builder here without creating an import cycle.
import { buildCheckpointWriteFailed } from "./checkpoint-address.js";
import type { CheckpointWriteFailedError } from "./checkpoint-address.js";
import type { RunId, NodeId } from "./ids.js";
// Type-only circular reference with `types/node.ts` (which imports
// `FrameworkError` from this module) — safe: type imports erase at compile
// time, so no runtime cycle exists.
import type { Capability } from "./node.js";
import type { Breach } from "./budget.js";
import { formatBreach } from "./budget.js";
import type { MicroUsd } from "./spend.js";
import { microUsd, unpricedModels } from "./spend.js";
import type { TokenUsage } from "./token-usage.js";
import { safeDiagnosticRender, safeErrorMessage } from "./safe-error.js";

/** A single unsatisfied capability declaration: which node required which capability. */
export type MissingCapability = {
  readonly nodeId: NodeId;
  readonly capability: Capability;
};

/**
 * Tokens consumed by a call that ultimately failed. Carried on the error
 * variants emitted by the tool-use loop (`node-crash`, `transient`, `aborted`)
 * and the clients' terminal-status short-circuits (e.g. OpenAI
 * `sendStructured`'s `status:"failed"` arm, which attaches usage via
 * `responseFailedError` outside any loop) so that the partial usage burned
 * across already-completed turns — or a single non-looping call — is
 * representable on the `Err` path and can be metered UNCONDITIONALLY (FR-W0-001:
 * 100% attribution). Absent (`undefined`) means the failure consumed no
 * attributable tokens (e.g. an upfront validation error before any turn ran).
 *
 * An ALIAS, not a distinct brand: partiality is expressed by the OPTIONALITY of
 * each variant's `usage` field, never by this type. A value here is
 * structurally a complete `TokenUsage` — it is simply the share of one that a
 * failed call burned.
 */
export type PartialTokenUsage = TokenUsage;

// The `checkpoint-write-failed` address ADTs are re-exported here so consumers
// keep reaching the whole error vocabulary through this module.
export type {
  CheckpointPlaceholderNodeId,
  CheckpointPlaceholderRunId,
  CheckpointWriteFailedError,
  CheckpointWriteNodeAddress,
  CheckpointWriteRunAddress,
} from "./checkpoint-address.js";

export type FrameworkError =
  | { readonly kind: "validation"; readonly nodeId: NodeId; readonly message: string; readonly path?: string }
  | {
      readonly kind: "retry-exhausted";
      readonly nodeId: NodeId;
      readonly attempts: number;
      /**
       * Human-readable summary of the final failure. For `node-crash` and
       * `transient` this is the original `message` field; for other kinds it
       * is `JSON.stringify(error)` so the structured payload is still
       * legible. Prefer `rootErrorKind` for programmatic pattern-matching.
       */
      readonly lastError: string;
      /**
       * Discriminant of the underlying error that exhausted the budget.
       * Lets consumers tell a rate-limit storm (`"transient"`) from a logic
       * crash (`"node-crash"`) without parsing `lastError`. The recursive
       * `"retry-exhausted"` value is excluded — a retry-exhausted error
       * never wraps itself.
       */
      readonly rootErrorKind: Exclude<FrameworkError["kind"], "retry-exhausted">;
    }
  | { readonly kind: "checkpoint-missing"; readonly runId: RunId }
  | {
      readonly kind: "checkpoint-expired";
      readonly runId: RunId;
      /** ISO 8601 UTC timestamp. Stored as a string so the error round-trips
       * through `JSON.stringify` / `JSON.parse` without losing type fidelity. */
      readonly expiredAt: string;
    }
  | { readonly kind: "checkpoint-corrupt"; readonly runId: RunId; readonly nodeId?: NodeId; readonly message: string }
  | {
      readonly kind: "checkpoint-version-mismatch";
      readonly runId: RunId;
      readonly expected: string;
      readonly actual: string | undefined;
    }
  | CheckpointWriteFailedError
  | { readonly kind: "prompt-not-found"; readonly promptName: string; readonly reason: string }
  | {
      readonly kind: "cache-error";
      readonly operation: string;
      readonly message: string;
      /**
       * Explicit failure-class discriminant (additive): `"permanent"` marks a
       * deterministic failure that re-running cannot clear (journal capacity
       * exhaustion, FR-015 dedup-key violations, invalid progress values,
       * non-lossless event/checkpoint values, malformed filename inputs),
       * so `retriabilityOf` can fast-fail it instead of burning the retry
       * budget. `"transient"`/absent = environment-class failures (fs/lock)
       * that replay may clear. Populated by the file backend's error shell;
       * the taxonomy's contract — a new kind can never silently default to
       * `retriable` — is what this discriminant restores for the closed
       * `cache-error` kind whose operation vocabulary mixes both classes.
       */
      readonly failureClass?: "transient" | "permanent";
    }
  | {
      readonly kind: "node-crash";
      readonly nodeId: NodeId;
      readonly message: string;
      readonly stack?: string;
      /**
       * Explicit retriability discriminant. `"non-retriable"` makes the DAG
       * transition fast-fail this error without consuming the retry budget;
       * use it for deterministic failures (tool-call iteration exhaustion,
       * schema mismatches, prompt-defect loops). `"retriable"` is the default
       * and goes through the standard backoff path.
       */
      readonly retriability: Retriability;
      /**
       * HTTP status code when this crash originated from an HTTP response —
       * a deterministic 4xx client error (non-retriable, e.g. 401/400/404), a
       * 5xx server error (retriable), or a malformed-success 2xx body — on the
       * raw-HTTP path or a duck-typed SDK error. Lets consumers branch on
       * `httpStatus === 401` instead of string-matching `HTTP 401` out of the
       * message. Absent on non-HTTP `node-crash` producers (iteration limit,
       * schema mismatch, thrown exception with no `.status`).
       */
      readonly httpStatus?: number;
      /**
       * Tokens already consumed by the failed call. The tool-use loop populates
       * this from its accumulated cross-turn totals so a crash (iteration limit,
       * schema mismatch, JSON parse failure) still attributes the burned tokens
       * (FR-W0-001) and counts them toward the per-run budget. Absent when no
       * tokens were consumed before the failure.
       */
      readonly usage?: PartialTokenUsage;
    }
  | { readonly kind: "cycle-detected"; readonly nodeIds: readonly NodeId[] }
  | {
      readonly kind: "aborted";
      readonly reason: string;
      /**
       * Tokens already consumed before the abort signal halted the loop. See
       * `node-crash.usage`.
       */
      readonly usage?: PartialTokenUsage;
    }
  | { readonly kind: "rejected"; readonly nodeId: NodeId; readonly reason: string }
  | { readonly kind: "invalid-reroute"; readonly targetNodeId: NodeId; readonly message: string }
  | {
      readonly kind: "transient";
      readonly nodeId: NodeId;
      readonly message: string;
      /**
       * HTTP status code when the transient failure originated from an HTTP
       * response (e.g. the built-in http capability). Lets consumers branch
       * on `httpStatus === 404` instead of string-matching the message.
       */
      readonly httpStatus?: number;
      /**
       * Tokens already consumed before a transient failure (e.g. a total
       * deadline exceeded mid-loop). See `node-crash.usage`.
       */
      readonly usage?: PartialTokenUsage;
    }
  | { readonly kind: "missing-default-edge"; readonly nodeId: NodeId }
  | {
      readonly kind: "output-unreachable-under-routing";
      readonly outputNodeId: NodeId;
      readonly missedFromNode: NodeId;
    }
  | { readonly kind: "predicate-malformed"; readonly nodeId: NodeId; readonly message: string }
  | { readonly kind: "duplicate-edge"; readonly fromNodeId: NodeId; readonly toNodeId: NodeId }
  | {
      /**
       * A node has zero incoming edges but is not a source node (C0 / 0.2.0).
       * Under 0.2.0 semantics no node implicitly receives the DAG input: a root
       * is by definition a *source* (build it with `createSourceNode`, which
       * sets `isSource: true`), and any other consumption of the request must flow over
       * an explicit `DAG_INPUT` edge. This replaces the old "root inputSchema
       * matches the DAG inputSchema" rule with a structural one.
       */
      readonly kind: "root-expects-input";
      readonly nodeId: NodeId;
      readonly message: string;
    }
  | {
      /**
       * A node marked `isSource` has at least one incoming edge. A source
       * produces from the context alone and consumes no input, so an incoming
       * edge (including a `DAG_INPUT` edge) is a definition error — drop the
       * `isSource` form and accept the input, or remove the edge.
       */
      readonly kind: "source-has-incoming";
      readonly nodeId: NodeId;
      readonly message: string;
    }
  | {
      /**
       * A `DAG_INPUT` edge is malformed: `$input` appears as a `to` target, or
       * carries conditional/default routing semantics. The virtual request
       * source can only be an unconditional `from`. The offending edge endpoints
       * are carried verbatim as raw strings — one end is `$input`, which is the
       * virtual request source, not a real (brandable) node id.
       */
      readonly kind: "invalid-dag-input-edge";
      readonly edge: { readonly from: string; readonly to: string };
      readonly message: string;
    }
  | {
      /**
       * Emitted at run start when one or more nodes declare a capability
       * (`requires: ["llm"]`, etc.) that the wired NodeContext does not
       * supply. The run aborts before any `node.run` is called.
       *
       * `missing` is a non-empty tuple — an error of this kind always names at
       * least one gap, so `missing[0]` is the guaranteed first miss (read it
       * for single-gap programmatic access). The full tuple lists every
       * `(nodeId, capability)` pair so callers can fix all gaps in one pass
       * instead of replaying the run for each field. The first miss is *not*
       * duplicated as scalar fields — that would be a representable illegal
       * state (scalar disagreeing with `missing[0]`).
       */
      readonly kind: "missing-capability";
      readonly missing: readonly [MissingCapability, ...MissingCapability[]];
    }
  | {
      /**
       * Emitted by the host's metered LLM decorator (FR-W1-003) when a per-run
       * budget is reached. The admission check runs BEFORE the call, so at most
       * one call passes a reached ceiling (FR-W1-004); the first parallel burst
       * may overshoot by its call count while the per-call reservation estimate
       * is still unlearned, and the reservation bounds it thereafter.
       *
       * `cause` says WHICH ceiling and on WHAT figure, because a run may declare
       * several (tokens, calls, dollars) and "budget exceeded" alone is not
       * actionable when it could mean any of them. It also states outright
       * whether the SETTLED spend or the PROJECTION including in-flight
       * reservations drove the refusal — previously a single `cumulative` field
       * carried the settled figure while the decision might have come from the
       * projection, reconciled only by a comment.
       */
      readonly kind: "llm-budget-exceeded";
      readonly runId: RunId;
      readonly nodeId: NodeId;
      readonly cause: Breach;
    }
  | {
      /**
       * The capability broker could not reach the identity provider / token
       * endpoint to mint or exchange a token — a TRANSIENT infrastructure
       * failure (Keycloak down, DNS/socket error, 5xx from the mint endpoint),
       * NOT an authorization decision. Callers may retry. Kept deliberately
       * DISTINCT from `downstream-denied` (FR-X-002): a denial is a settled
       * authorization answer ("no"), whereas `infra-unreachable` is "we never
       * got an answer". Conflating the two would make a retry loop hammer a
       * provider that has already said no, or fail-closed on a blip that a
       * retry would clear.
       *
       * `operation` names the ROLE of the broker hop that failed, as a closed
       * literal union so a consumer can branch on it exhaustively. The roles
       * are provider-agnostic on purpose (ADR-0054: no vendor literal crosses
       * the framework boundary; ADR-0059 amendment 2026-06-12):
       *   - `mint`       — acquiring a fresh token from the local IdP
       *                    (e.g. a client-credentials grant),
       *   - `exchange`   — exchanging one local token for another
       *                    (e.g. Token Exchange V2),
       *   - `federation` — crossing a trust boundary into an external IdP
       *                    (e.g. an Entra WIF exchange),
       *   - `downstream` — the final resource request (e.g. Graph/Dynamics).
       * `hop` carries the host-specific hop name for audit/diagnostics
       * (free-form: each embedder names its own topology), and `message` the
       * diagnostic detail (status line, socket error). (FR-X-001)
       */
      readonly kind: "infra-unreachable";
      readonly operation: "mint" | "exchange" | "federation" | "downstream";
      readonly hop: string;
      readonly message: string;
    }
  | {
      /**
       * A required scope is not assigned to the agent's client in the identity
       * provider's policy — an AUTHORIZATION refusal raised FAIL-CLOSED by the
       * broker's local policy check BEFORE any downstream (Entra) call is made
       * (FR-X-001). This is the cheap, deterministic gate: if the agent client
       * was never granted `scope`, there is no point minting or exchanging a
       * token, so the broker refuses up front. Because it precedes any network
       * call it is never transient and must never be retried — distinct from
       * `infra-unreachable`.
       *
       * `scope` is the unassigned scope that triggered the refusal.
       *
       * `agentClientId` is the agent client whose policy lacks the scope (the
       * same id carried on `InvocationOrigin`), so an assignment-time refusal is
       * attributable to a concrete client without re-deriving identity. It is
       * OPTIONAL because a refusal has two possible origins:
       *   - PARSE-TIME (an unrecognised scope name, no client known yet): the
       *     field is ABSENT. NOTE: this origin is currently unrealised in
       *     production — the host's scope parser models "not a downstream
       *     scope" as first-class absence (`DownstreamScope | undefined`), not
       *     a refusal: an unknown name in a node's `requires` defers to
       *     run-start `missing-capability`, and the boot-time
       *     `AGENT_CLIENT_SCOPES` policy validator rejects a typo'd entry at
       *     startup instead. So all emitted refusals today are
       *     assignment-time. The variant keeps the absent-field shape for
       *     parsers that DO choose to surface it.
       *   - ASSIGNMENT-TIME (the broker, with a known client, finds the scope
       *     unassigned): the field is PRESENT and names that client.
       * Modelling absence as an absent field (not an empty string) keeps the
       * "unknown client" state honest rather than representable-but-illegal.
       * (FR-X-001)
       */
      readonly kind: "policy-refusal";
      readonly scope: string;
      readonly agentClientId?: string;
    }
  | {
      /**
       * A downstream identity decision rejected the invocation: an Entra
       * Federated Identity Credential (FIC) subject/issuer mismatch, a Workload
       * Identity Federation (WIF) rejection, or a resource-scoping denial.
       * These are deliberately COLLAPSED into one authorization category
       * (FR-X-002): from the node's perspective they are all "the downstream
       * said no", and a settled "no" is handled identically (fail-closed, no
       * retry) regardless of which mechanism produced it. Kept DISTINCT from
       * `infra-unreachable` — a denial is an answer, not an outage — so retry
       * policy can branch on the kind alone.
       *
       * `resource` is the downstream resource/audience that was refused (e.g. a
       * Graph or Dynamics resource id); `reason` carries the provider's stated
       * cause (FIC mismatch, audience not permitted) for the audit record.
       * (FR-X-002)
       */
      readonly kind: "downstream-denied";
      readonly resource: string;
      readonly reason: string;
    };

/** Discriminant union of all error kinds — use for consumer-side exhaustive switches. */
export type FrameworkErrorKind = FrameworkError["kind"];

// The framework owns the wire parser for its error ADT. Persistence adapters
// compose this schema into their own records instead of duplicating all 27
// variants and drifting when the framework error vocabulary changes.
const persistedBrandedId = <T>(parse: (raw: string) => { readonly ok: true; readonly value: T } | { readonly ok: false }): z.ZodType<T> =>
  z.string().transform((value, context) => {
    const parsed = parse(value);
    if (parsed.ok) return parsed.value;
    context.addIssue({ code: "custom", message: "value is not a valid branded id" });
    return z.NEVER;
  });

const PersistedNodeIdSchema = persistedBrandedId(tryNodeId);
const PersistedRunIdSchema = persistedBrandedId(tryRunId);
// Parse, don't validate: a usage record written before prompt caching existed
// carries only the two token counts. The cache figures default to zero on the
// WIRE schema only — which is exactly what their absence means — so the parsed
// value is a complete `TokenUsage` and no in-memory consumer needs an
// `undefined` branch. The in-memory type keeps all four fields REQUIRED, so no
// construction site can silently omit one (NFR-PC-001).
const persistedUsageSchema = z
  .object({
    tokensIn: z.number(),
    tokensOut: z.number(),
    cacheWriteTokens: z.number().optional().default(0),
    cacheReadTokens: z.number().optional().default(0),
  })
  .optional();
const persistedRetriabilitySchema = z.enum(["retriable", "non-retriable"]);
// A budget breach on the wire. `MicroUsd` is an integer brand, so the parse
// re-establishes the domain the same way `PersistedCapabilitySchema` does —
// the brand declares the domain, deserialization restores it.
const PersistedMicroUsdSchema: z.ZodType<MicroUsd> = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .transform(microUsd);
const persistedUsdCeilingSchema = z.object({
  kind: z.literal("usd"),
  limit: PersistedMicroUsdSchema,
});
const persistedBasisSchema = z.enum(["settled", "projected"]);
const persistedTokensCeilingSchema = z.object({ kind: z.literal("tokens"), limit: z.number() });
const persistedCallsCeilingSchema = z.object({ kind: z.literal("calls"), limit: z.number() });
const persistedUnpricedModelsSchema = z.array(z.string()).min(1).transform((models, context) => {
  const canonical = unpricedModels(models);
  if (canonical !== undefined) return canonical;
  context.addIssue({ code: "custom", message: "unpriced breach requires a model" });
  return z.NEVER;
});
const persistedBreachSchema = z.union([
  z.object({
    kind: z.literal("reached"),
    ceiling: persistedTokensCeilingSchema,
    basis: persistedBasisSchema,
    observed: z.number(),
  }),
  z.object({
    kind: z.literal("reached"),
    ceiling: persistedCallsCeilingSchema,
    basis: persistedBasisSchema,
    observed: z.number(),
  }),
  z.object({
    kind: z.literal("reached"),
    ceiling: persistedUsdCeilingSchema,
    basis: persistedBasisSchema,
    observed: PersistedMicroUsdSchema,
  }),
  z.object({
    kind: z.literal("unpriced"),
    ceiling: persistedUsdCeilingSchema,
    basis: persistedBasisSchema,
    models: persistedUnpricedModelsSchema,
    observedAtLeast: PersistedMicroUsdSchema,
  }),
  z.object({
    kind: z.literal("unknown-usage"),
    ceiling: persistedTokensCeilingSchema,
    basis: persistedBasisSchema,
    observedAtLeast: z.number(),
  }),
  z.object({
    kind: z.literal("unknown-usage"),
    ceiling: persistedUsdCeilingSchema,
    basis: persistedBasisSchema,
    observedAtLeast: PersistedMicroUsdSchema,
  }),
]);
const PersistedCapabilitySchema: z.ZodType<Capability> = z.string().transform((value) => value as Capability);
const persistedFrameworkErrorKinds = z.enum([
  "validation", "retry-exhausted", "checkpoint-missing", "checkpoint-expired",
  "checkpoint-corrupt", "checkpoint-version-mismatch", "checkpoint-write-failed",
  "prompt-not-found", "cache-error", "node-crash", "cycle-detected", "aborted",
  "rejected", "invalid-reroute", "transient", "missing-default-edge",
  "output-unreachable-under-routing", "predicate-malformed", "duplicate-edge",
  "root-expects-input", "source-has-incoming", "invalid-dag-input-edge",
  "missing-capability", "llm-budget-exceeded", "infra-unreachable",
  "policy-refusal", "downstream-denied",
]);

/** Parse the standalone serialized kind marker carried by FrameworkAugmentedError. */
export const isFrameworkErrorKind = (value: unknown): value is FrameworkErrorKind =>
  persistedFrameworkErrorKinds.safeParse(value).success;

const PersistedFrameworkErrorSchemaDefinition = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("validation"), nodeId: PersistedNodeIdSchema, message: z.string(), path: z.string().optional() }),
  z.looseObject({ kind: z.literal("retry-exhausted"), nodeId: PersistedNodeIdSchema, attempts: z.number(), lastError: z.string(), rootErrorKind: persistedFrameworkErrorKinds.exclude(["retry-exhausted"]) }),
  z.looseObject({ kind: z.literal("checkpoint-missing"), runId: PersistedRunIdSchema }),
  z.looseObject({ kind: z.literal("checkpoint-expired"), runId: PersistedRunIdSchema, expiredAt: z.string() }),
  z.looseObject({ kind: z.literal("checkpoint-corrupt"), runId: PersistedRunIdSchema, nodeId: PersistedNodeIdSchema.optional(), message: z.string() }),
  z.looseObject({ kind: z.literal("checkpoint-version-mismatch"), runId: PersistedRunIdSchema, expected: z.string(), actual: z.union([z.string(), z.undefined()]) }),
  z.looseObject({ kind: z.literal("checkpoint-write-failed"), runId: PersistedRunIdSchema, nodeId: PersistedNodeIdSchema, invalidRunId: z.string().optional(), invalidNodeId: z.string().optional(), message: z.string() }),
  z.looseObject({ kind: z.literal("prompt-not-found"), promptName: z.string(), reason: z.string() }),
  z.looseObject({ kind: z.literal("cache-error"), operation: z.string(), message: z.string(), failureClass: z.enum(["transient", "permanent"]).optional() }),
  z.looseObject({ kind: z.literal("node-crash"), nodeId: PersistedNodeIdSchema, message: z.string(), stack: z.string().optional(), retriability: persistedRetriabilitySchema, httpStatus: z.number().optional(), usage: persistedUsageSchema }),
  z.looseObject({ kind: z.literal("cycle-detected"), nodeIds: z.array(PersistedNodeIdSchema) }),
  z.looseObject({ kind: z.literal("aborted"), reason: z.string(), usage: persistedUsageSchema }),
  z.looseObject({ kind: z.literal("rejected"), nodeId: PersistedNodeIdSchema, reason: z.string() }),
  z.looseObject({ kind: z.literal("invalid-reroute"), targetNodeId: PersistedNodeIdSchema, message: z.string() }),
  z.looseObject({ kind: z.literal("transient"), nodeId: PersistedNodeIdSchema, message: z.string(), httpStatus: z.number().optional(), usage: persistedUsageSchema }),
  z.looseObject({ kind: z.literal("missing-default-edge"), nodeId: PersistedNodeIdSchema }),
  z.looseObject({ kind: z.literal("output-unreachable-under-routing"), outputNodeId: PersistedNodeIdSchema, missedFromNode: PersistedNodeIdSchema }),
  z.looseObject({ kind: z.literal("predicate-malformed"), nodeId: PersistedNodeIdSchema, message: z.string() }),
  z.looseObject({ kind: z.literal("duplicate-edge"), fromNodeId: PersistedNodeIdSchema, toNodeId: PersistedNodeIdSchema }),
  z.looseObject({ kind: z.literal("root-expects-input"), nodeId: PersistedNodeIdSchema, message: z.string() }),
  z.looseObject({ kind: z.literal("source-has-incoming"), nodeId: PersistedNodeIdSchema, message: z.string() }),
  z.looseObject({ kind: z.literal("invalid-dag-input-edge"), edge: z.object({ from: z.string(), to: z.string() }), message: z.string() }),
  z.looseObject({
    kind: z.literal("missing-capability"),
    missing: z.tuple(
      [z.object({ nodeId: PersistedNodeIdSchema, capability: PersistedCapabilitySchema })],
      z.object({ nodeId: PersistedNodeIdSchema, capability: PersistedCapabilitySchema }),
    ),
  }),
  z.looseObject({ kind: z.literal("llm-budget-exceeded"), runId: PersistedRunIdSchema, nodeId: PersistedNodeIdSchema, cause: persistedBreachSchema }),
  z.looseObject({ kind: z.literal("infra-unreachable"), operation: z.enum(["mint", "exchange", "federation", "downstream"]), hop: z.string(), message: z.string() }),
  z.looseObject({ kind: z.literal("policy-refusal"), scope: z.string(), agentClientId: z.string().optional() }),
  z.looseObject({ kind: z.literal("downstream-denied"), resource: z.string(), reason: z.string() }),
]);

type MissingPersistedFrameworkErrorKind = Exclude<
  FrameworkErrorKind,
  z.output<typeof PersistedFrameworkErrorSchemaDefinition>["kind"]
>;
type ExhaustivePersistedFrameworkErrorSchema = [MissingPersistedFrameworkErrorKind] extends [never]
  ? z.ZodType<FrameworkError>
  : never;

/**
 * Re-correlate a parsed `checkpoint-write-failed` record.
 *
 * The wire record is four independent fields; the in-memory ADT is two
 * correlated address arms. Routing the parsed record back through THE ONE
 * construction path (`buildCheckpointWriteFailed`) rebuilds the correlation
 * from the same rule the writer used, so a persisted record can never enter
 * the process as a half-correlated value (a placeholder id with no
 * `invalidRunId`, or a real id carrying one). The rebuild is idempotent on
 * every record this framework writes.
 */
const correlateCheckpointAddresses = (
  parsed: z.output<typeof PersistedFrameworkErrorSchemaDefinition>,
): FrameworkError =>
  parsed.kind === "checkpoint-write-failed"
    ? buildCheckpointWriteFailed(
        parsed.invalidRunId ?? parsed.runId,
        parsed.invalidNodeId ?? parsed.nodeId,
        parsed.message,
      )
    : parsed;

/** Loose, exhaustive wire parser for persisted `FrameworkError` control-plane data. */
export const PersistedFrameworkErrorSchema: ExhaustivePersistedFrameworkErrorSchema =
  PersistedFrameworkErrorSchemaDefinition.transform(correlateCheckpointAddresses);

/** Compare an unknown source with its canonical parser output using data properties only. */
const isSameOwnData = (
  source: unknown,
  canonical: unknown,
  seen: WeakMap<object, object> = new WeakMap(),
): boolean => {
  if (Object.is(source, canonical)) return true;
  if (typeof source !== "object" || source === null ||
      typeof canonical !== "object" || canonical === null) return false;
  if (Array.isArray(source) !== Array.isArray(canonical)) return false;

  const observed = seen.get(source);
  if (observed !== undefined) return observed === canonical;
  seen.set(source, canonical);

  const sourceDescriptors = Object.getOwnPropertyDescriptors(source) as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const canonicalDescriptors = Object.getOwnPropertyDescriptors(canonical) as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const sourceKeys = Reflect.ownKeys(sourceDescriptors);
  const canonicalKeys = new Set(Reflect.ownKeys(canonicalDescriptors));
  if (sourceKeys.length !== canonicalKeys.size) return false;

  return sourceKeys.every((key) => {
    if (!canonicalKeys.has(key)) return false;
    const sourceProperty = sourceDescriptors[key];
    const canonicalProperty = canonicalDescriptors[key];
    return sourceProperty !== undefined && canonicalProperty !== undefined &&
      Object.hasOwn(sourceProperty, "value") &&
      Object.hasOwn(canonicalProperty, "value") &&
      isSameOwnData(sourceProperty.value, canonicalProperty.value, seen);
  });
};

/**
 * Runtime type guard for `FrameworkError` at unknown exception boundaries.
 * The exhaustive wire parser validates the complete selected variant, not
 * merely its discriminant, so `{ kind: "node-crash" }` cannot acquire typed
 * retry/authorization authority without the required payload. The original
 * value must also equal the canonical parsed data: a wire migration/default or
 * correlation repair proves the parser output, not the source object narrowed
 * by this predicate. Parsing and comparison are fenced for hostile proxies.
 */
export const isFrameworkError = (value: unknown): value is FrameworkError => {
  try {
    const parsed = PersistedFrameworkErrorSchema.safeParse(value);
    return parsed.success && isSameOwnData(value, parsed.data);
  } catch {
    return false;
  }
};

/**
 * Extract the partial token usage carried by a failed call, if any. Only the
 * tool-use-loop error variants (`node-crash`, `transient`, `aborted`) carry
 * usage; every other kind reads as `undefined` (no attributable tokens). Lets
 * the metering shell attribute consumed tokens on the `Err` path without
 * widening every call site to know which variants carry usage (FR-W0-001).
 */
export const usageOfError = (e: FrameworkError): PartialTokenUsage | undefined =>
  match(e)
    .with({ kind: "node-crash" }, (e) => e.usage)
    .with({ kind: "transient" }, (e) => e.usage)
    .with({ kind: "aborted" }, (e) => e.usage)
    // Every other kind carries no attributable tokens. Listed exhaustively (not
    // `.otherwise`) so adding a new `usage?`-carrying variant without extending
    // the three arms above is a COMPILE error here — it can never silently drop
    // burned tokens and regress FR-W0-001's 100% attribution.
    .with(
      { kind: "validation" },
      { kind: "retry-exhausted" },
      { kind: "checkpoint-missing" },
      { kind: "checkpoint-expired" },
      { kind: "checkpoint-corrupt" },
      { kind: "checkpoint-version-mismatch" },
      { kind: "checkpoint-write-failed" },
      { kind: "prompt-not-found" },
      { kind: "cache-error" },
      { kind: "cycle-detected" },
      { kind: "rejected" },
      { kind: "invalid-reroute" },
      { kind: "missing-default-edge" },
      { kind: "output-unreachable-under-routing" },
      { kind: "predicate-malformed" },
      { kind: "duplicate-edge" },
      { kind: "root-expects-input" },
      { kind: "source-has-incoming" },
      { kind: "invalid-dag-input-edge" },
      { kind: "missing-capability" },
      { kind: "llm-budget-exceeded" },
      { kind: "infra-unreachable" },
      { kind: "policy-refusal" },
      { kind: "downstream-denied" },
      () => undefined,
    )
    .exhaustive();

/** Whether replay may clear a failure or must fast-fail deterministically. */
export type Retriability = "retriable" | "non-retriable";

/**
 * The single total classification used by the DAG retry machinery. Adding a
 * FrameworkError kind without classifying it is a compile error, so a new kind
 * can never silently default to the unsafe retriable direction.
 *
 * `non-retriable` means replay cannot clear the failure; `handleNodeFailed`
 * fast-fails it and preserves retry budget for genuinely transient failures.
 */
export const retriabilityOf = (e: FrameworkError): Retriability =>
  match(e)
    // `node-crash` carries its own explicit retriability discriminant.
    .with({ kind: "node-crash" }, (c) => c.retriability)
    // Deterministic failures — re-execution reproduces them, so fast-fail.
    .with(
      { kind: "predicate-malformed" },
      { kind: "validation" },
      { kind: "checkpoint-write-failed" },
      { kind: "aborted" },
      { kind: "policy-refusal" },
      { kind: "downstream-denied" },
      { kind: "llm-budget-exceeded" },
      { kind: "missing-capability" },
      // `cache-error` carries an explicit discriminant where the operation
      // vocabulary mixes deterministic and environment failures: a
      // `"permanent"` class is a deterministic failure like the kinds above
      // (capacity, FR-015, losslessness — re-running reproduces it).
      { kind: "cache-error", failureClass: "permanent" },
      () => "non-retriable" as const,
    )
    // Everything else goes through the standard backoff path. The graph-
    // structural kinds (cycle-detected, duplicate-edge, root-expects-input, …)
    // are emitted at validation time and never reach the retry machinery, so
    // their `"retriable"` label is nominal — it faithfully preserves the
    // historical fall-through default rather than asserting they would retry.
    .with(
      { kind: "transient" },
      { kind: "retry-exhausted" },
      { kind: "checkpoint-missing" },
      { kind: "checkpoint-expired" },
      { kind: "checkpoint-corrupt" },
      { kind: "checkpoint-version-mismatch" },
      { kind: "prompt-not-found" },
      { kind: "cache-error" },
      { kind: "cycle-detected" },
      { kind: "rejected" },
      { kind: "invalid-reroute" },
      { kind: "missing-default-edge" },
      { kind: "output-unreachable-under-routing" },
      { kind: "duplicate-edge" },
      { kind: "root-expects-input" },
      { kind: "source-has-incoming" },
      { kind: "invalid-dag-input-edge" },
      { kind: "infra-unreachable" },
      () => "retriable" as const,
    )
    .exhaustive();

/**
 * The human-readable summary threaded into `retry-exhausted.lastError`.
 * `node-crash`/`transient` carry a purpose-written `message` that IS the whole
 * human story (their other fields — `node-crash`'s `nodeId`/`retriability`/
 * `httpStatus`/`usage`/`stack` and `transient`'s `httpStatus`/`usage` — are
 * structured discriminants for programmatic branching, not part of the
 * human failure story), so it is returned bare.
 * Every other kind is JSON-stringified: several DO carry a `message`/`reason`,
 * but alongside equally-load-bearing context (`checkpoint-corrupt` has `runId`,
 * `downstream-denied` has `resource`, …), so serialising the whole value loses
 * nothing — `formatFrameworkError` is the pretty single-line renderer where a
 * human-facing summary is wanted. Exhaustive (ts-pattern `.exhaustive()`) so a
 * new kind is a compile error here rather than silently inheriting the
 * JSON-stringify arm, and so this stays the single source of truth for the
 * retry-policy call sites (which would otherwise re-list the carrier set and drift).
 *
 * The runtime input is intentionally `unknown`: JavaScript callers and caught
 * failures can bypass the static union. Hostile/cyclic values fall through to
 * the independently guarded total formatter instead of throwing a second
 * error while the first is being summarized.
 */
export const messageOf = (e: unknown): string => {
  try {
    return match(e as FrameworkError)
      .with({ kind: "node-crash" }, { kind: "transient" }, (c) => c.message)
      // Every other kind: serialise the whole value so no context field is lost.
      // Enumerated (not `.otherwise()`) so `.exhaustive()` turns a new kind into a
      // compile error here rather than silently folding it into JSON-stringify.
      .with(
        { kind: "predicate-malformed" },
        { kind: "validation" },
        { kind: "checkpoint-write-failed" },
        { kind: "aborted" },
        { kind: "policy-refusal" },
        { kind: "downstream-denied" },
        { kind: "llm-budget-exceeded" },
        { kind: "missing-capability" },
        { kind: "retry-exhausted" },
        { kind: "checkpoint-missing" },
        { kind: "checkpoint-expired" },
        { kind: "checkpoint-corrupt" },
        { kind: "checkpoint-version-mismatch" },
        { kind: "prompt-not-found" },
        { kind: "cache-error" },
        { kind: "cycle-detected" },
        { kind: "rejected" },
        { kind: "invalid-reroute" },
        { kind: "missing-default-edge" },
        { kind: "output-unreachable-under-routing" },
        { kind: "duplicate-edge" },
        { kind: "root-expects-input" },
        { kind: "source-has-incoming" },
        { kind: "invalid-dag-input-edge" },
        { kind: "infra-unreachable" },
        (rest) => JSON.stringify(rest),
      )
      .exhaustive();
  } catch {
    // Exhaustive matching and JSON serialization are only total for values
    // that truly satisfy FrameworkError. Runtime callers may still hand us a
    // cyclic object or hostile Proxy; diagnostics must never throw while
    // formatting the original failure.
    return safeErrorMessage(e);
  }
};

/**
 * Human-readable single-line summary of a FrameworkError. Exhaustive —
 * adding a new `kind` without a case here is a compile error via
 * ts-pattern's `.exhaustive()`.
 */
export const formatFrameworkError = (e: FrameworkError): string =>
  match(e)
    .with({ kind: "validation" }, (e) => `${e.message} (node '${e.nodeId}')`)
    .with({ kind: "missing-default-edge" }, (e) => `node '${e.nodeId}' has conditional out-edges but no default edge`)
    .with({ kind: "output-unreachable-under-routing" }, (e) => `outputNodeId '${e.outputNodeId}' is not reachable along unconditional + default edges (frontier at '${e.missedFromNode}')`)
    .with({ kind: "duplicate-edge" }, (e) => `duplicate edge '${e.fromNodeId}' -> '${e.toNodeId}'`)
    .with({ kind: "root-expects-input" }, (e) => `${e.message} (node '${e.nodeId}')`)
    .with({ kind: "source-has-incoming" }, (e) => `${e.message} (node '${e.nodeId}')`)
    .with({ kind: "invalid-dag-input-edge" }, (e) => `${e.message} ('${e.edge.from}' -> '${e.edge.to}')`)
    .with({ kind: "predicate-malformed" }, (e) => `${e.message} (node '${e.nodeId}')`)
    .with({ kind: "cycle-detected" }, (e) => `cycle detected: ${e.nodeIds.join(" -> ")}`)
    .with({ kind: "retry-exhausted" }, (e) => `node '${e.nodeId}' exhausted ${e.attempts} retries (root: ${e.rootErrorKind}): ${e.lastError}`)
    .with({ kind: "node-crash" }, (e) => `node '${e.nodeId}' crashed (${e.retriability}): ${e.message}`)
    .with({ kind: "aborted" }, (e) => `run aborted: ${e.reason}`)
    .with({ kind: "rejected" }, (e) => `node '${e.nodeId}' rejected: ${e.reason}`)
    .with({ kind: "transient" }, (e) => `node '${e.nodeId}' transient failure: ${e.message}`)
    .with({ kind: "prompt-not-found" }, (e) => `prompt '${e.promptName}' not found: ${e.reason}`)
    .with({ kind: "cache-error" }, (e) => `cache ${e.operation} failed: ${e.message}`)
    .with({ kind: "invalid-reroute" }, (e) => `invalid reroute to '${e.targetNodeId}': ${e.message}`)
    .with({ kind: "checkpoint-missing" }, (e) => `checkpoint missing for run '${e.runId}'`)
    .with({ kind: "checkpoint-expired" }, (e) => `checkpoint for run '${e.runId}' expired at ${e.expiredAt}`)
    .with({ kind: "checkpoint-corrupt" }, (e) => `checkpoint corrupt for run '${e.runId}'${e.nodeId ? ` (node '${e.nodeId}')` : ""}: ${e.message}`)
    .with({ kind: "checkpoint-version-mismatch" }, (e) => `checkpoint version mismatch for run '${e.runId}': expected '${e.expected}', got '${e.actual ?? "undefined"}'`)
    .with({ kind: "checkpoint-write-failed" }, (e) => {
      // Additive invalid-id fields preserve the rejected RAW bytes for
      // structured consumers, but the rendered message must stay bounded: a
      // hostile multi-KB id must not flood the log line (the same module
      // truncates hostile diagnostics everywhere else via safeDiagnosticRender).
      const run = e.invalidRunId === undefined ? e.runId : safeDiagnosticRender(e.invalidRunId);
      const node = e.invalidNodeId === undefined ? e.nodeId : safeDiagnosticRender(e.invalidNodeId);
      return `checkpoint write failed for run '${run}' node '${node}': ${e.message}`;
    })
    .with({ kind: "missing-capability" }, (e) => `missing capabilities: ${e.missing.map(m => `${m.capability} (node '${m.nodeId}')`).join(", ")}`)
    .with({ kind: "llm-budget-exceeded" }, (e) => `llm budget exceeded for run '${e.runId}' (node '${e.nodeId}'): ${formatBreach(e.cause)}`)
    .with({ kind: "infra-unreachable" }, (e) => `capability provider unreachable during '${e.operation}' (hop '${e.hop}'): ${e.message}`)
    .with({ kind: "policy-refusal" }, (e) =>
      e.agentClientId !== undefined
        ? `policy refusal: scope '${e.scope}' not assigned to agent client '${e.agentClientId}'`
        : `policy refusal: scope '${e.scope}' not recognised (agent client unknown)`)
    .with({ kind: "downstream-denied" }, (e) => `downstream denied resource '${e.resource}': ${e.reason}`)
    .exhaustive();

/**
 * Error subclass thrown by `runDagAsWorkerJob` so queue adapters (BullMQ)
 * can access the structured framework error after serialization round-trips.
 *
 * Queue workers catch this and see typed fields (`frameworkErrorKind`,
 * `frameworkErrorJson`) instead of parsing the message string. The original
 * `FrameworkError` is also available via `Error.cause`.
 */
export class FrameworkAugmentedError extends Error {
  readonly frameworkErrorKind: FrameworkError["kind"];
  readonly frameworkErrorJson: string;

  constructor(message: string, error: FrameworkError) {
    super(message, { cause: error });
    this.name = "FrameworkAugmentedError";
    this.frameworkErrorKind = error.kind;
    this.frameworkErrorJson = JSON.stringify(error);
  }
}


/**
 * Normalize an arbitrary caught value into a `FrameworkError` attributed to a
 * node.
 *
 * ONE encoding of the "a node threw / returned a non-FrameworkError" rule, used
 * by every site that converts a raw failure into the modeled node outcome
 * (`run-node`'s throw and non-Result-error paths, `wave-execution`'s outer
 * catch). Two decisions in here are easy to get subtly wrong in a copy:
 *
 *   - An ALREADY-typed `FrameworkError` passes through UNCHANGED. Re-wrapping it
 *     would bury a precise `policy-refusal` or `infra-unreachable` — and its
 *     retriability — under a generic node-crash.
 *   - An untyped value becomes `non-retriable`. A throw we cannot classify is
 *     assumed deterministic: replaying it would re-run the node's side effects
 *     for a failure that will simply happen again.
 *
 * `safeErrorMessage` renders the value, so a hostile thrown object cannot throw
 * again while being described.
 */
export const asNodeFrameworkError = (caught: unknown, nodeId: NodeId): FrameworkError =>
  isFrameworkError(caught)
    ? caught
    : {
        kind: "node-crash",
        nodeId,
        retriability: "non-retriable",
        message: safeErrorMessage(caught),
      };
