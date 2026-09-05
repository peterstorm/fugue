// Types barrel — explicit named exports. Runtime parsers and derivations live
// on the executor surface; this barrel mirrors the README authoring types.

// ── Result (Either) ────────────────────────────────────────────────────────
export type { Result, Ok, Err } from "./result.js";
export {
  ok,
  err,
  isOk,
  isErr,
  andThen,
  andThenAsync,
  map,
  mapAsync,
  mapErr,
  unwrapOr,
  fold,
  orElse,
  tryCatch,
  tryCatchAsync,
  sequenceFirst,
  sequenceAll,
  tap,
  tapErr,
} from "./result.js";

// ── Errors ────────────────────────────────────────────────────────────────
export type { FrameworkError, FrameworkErrorKind, MissingCapability, PartialTokenUsage } from "./errors.js";
export { asFrameworkError, formatFrameworkError, isFrameworkError, isFrameworkErrorKind, PersistedFrameworkErrorSchema, FrameworkAugmentedError, usageOfError } from "./errors.js";
export { frameworkError } from "./error-factories.js";

// ── Token usage ───────────────────────────────────────────────────────────
// One vocabulary for LLM token consumption, shared by the clients, the
// tool-use loop, tracing, cost, and the host's per-run meter.
export type { TokenUsage } from "./token-usage.js";
export {
  NO_TOKENS,
  addUsage,
  cacheHitRatio,
  isCacheInert,
  pickUsage,
  tokensOnly,
  totalTokens,
  uncachedInputTokens,
} from "./token-usage.js";

// ── Spend & budget ────────────────────────────────────────────────────────
// What a run COSTS, and what limits it. Separate from `TokenUsage` because
// prompt caching severed the link between token count and money: a cache read
// bills at 0.1x and a write at 1.25-2.0x, so a token ceiling can no longer see
// an order-of-magnitude difference in spend.
export type {
  MicroUsd,
  PricedSpend,
  Spend,
  SpendInput,
  UnpricedModels,
  UsageKnowledge,
} from "./spend.js";
export {
  NO_MICROS,
  NO_SPEND,
  addSpend,
  costFloor,
  makeSpend,
  maxSpend,
  microUsd,
  microsToUsd,
  parseSpend,
  pricedCall,
  unknownUsageCall,
  unpricedCall,
  unpricedModel,
  unpricedModels,
  scaleSpend,
  usdToMicros,
} from "./spend.js";
export type {
  Basis,
  Breach,
  Ceiling,
  CeilingKind,
  Ceilings,
  CallsCeiling,
  TokensCeiling,
  UsdCeiling,
} from "./budget.js";
export { breachOf, ceilings, firstBreach, formatBreach, observedOf } from "./budget.js";
export type { BudgetCapability, CeilingHeadroom, Remaining } from "./budget-capability.js";
export { remainingFor, snapshotSpend } from "./budget-capability.js";

// ── Total error diagnostics ───────────────────────────────────────────────
// Total (never-throwing) inspection helpers for values caught at an `unknown`
// boundary — safe to run while handling an earlier failure. Exported for
// first-party consumers (host adapters) that implement fail-closed errno
// logic at I/O boundaries; `probeErrorCode` + `isMissingPathError` keep the
// absence-vs-failure question one encoding.
export {
  safeErrorMessage,
  probeErrorCode,
  isMissingPathError,
} from "./safe-error.js";

// ── Own-data boundary parsing ─────────────────────────────────────────────
// THE getter/proxy/prototype defence for values crossing an extension
// boundary. Exported because the host's adapters parse the same untrusted
// request/response objects the framework does and previously each carried
// their own copy of the algorithm.
export type { OwnDataFailure } from "./own-data.js";
export {
  isObjectLike,
  readOwnDataProperty,
  ownDataValue,
  ownDescriptors,
  hasExactOwnKeys,
  snapshotOwnDataObject,
  snapshotOwnDataArray,
} from "./own-data.js";

// ── Span kinds ────────────────────────────────────────────────────────────
export type { SpanKind } from "./span.js";

// ── Observer events ───────────────────────────────────────────────────────
export type {
  ObserverEvent,
  RunStartEvent,
  NodeStartEvent,
  NodeEndEvent,
  NodeSkippedEvent,
  NodeErrorEvent,
  SubSpanEvent,
  RunEndEvent,
  RouteDecidedEvent,
  RouteEvidence,
  NodePrunedEvent,
  WitnessCapturedEvent,
  WriteAttemptedEvent,
  FreshnessViolationEvent,
  HumanActionDetailed,
  HumanInterventionEvent,
} from "./events.js";

// ── Side-effects taxonomy ─────────────────────────────────────────────────
export type { SideEffectKind, SideEffectProfile } from "./side-effects.js";

// ── Confidence types ──────────────────────────────────────────────────────
export type {
  ConfidenceBucket,
  ConfidenceSource,
  Confidence,
} from "./confidence.js";
export { CONFIDENCE_ORDER, meetsConfidence, confidence, tryConfidence } from "./confidence.js";

// ── Freshness witness types ───────────────────────────────────────────────
export type {
  FreshnessExecutionEpoch,
  FreshnessWriteIdentity,
  ResourceName,
  Witness,
  WitnessKind,
  WitnessValue,
} from "./freshness.js";
// `stampWitness` is intentionally NOT exported here — it is framework-internal
// (only `dag-runtime/freshness-emission.ts` stamps). Authors return a
// resource-free `witnessValue(...)`; the framework supplies the resource.
export {
  freshnessExecutionEpoch,
  freshnessWriteIdentityOf,
  resourceName,
  witness,
  witnessValue,
} from "./freshness.js";

// ── JSON Patch ────────────────────────────────────────────────────────────
export type { JsonPatchOp, JsonPatch } from "./json-patch.js";
export { computeJsonPatch } from "../shared/json-patch.js";

// ── Node authoring ────────────────────────────────────────────────────────
export type {
  NodeDef,
  NodeKind,
  NodeRetryConfig,
  NodeHumanReviewConfig,
  ConfidenceMode,
  CapabilityRegistry,
  Capability,
  BaseNodeContext,
  NodeContext,
  TypedNodeContext,
  NodeContextInit,
  ContextCacheAdapter,
  CheckpointWriter,
  CacheLookup,
  PromptAccess,
  Logger,
  Tracer,
  HttpCapability,
} from "./node.js";
// `ValidatedNodeContext` and `brandAsValidatedNodeContext` are intentionally
// not re-exported — only `validateCapabilities` constructs them.

// ── Capability lifecycle ──────────────────────────────────────────────────
export type {
  CapabilityHandle,
  AdapterFactory,
  RunScopedLlmOperation,
  RunScopedLlmOperations,
} from "./capability-handle.js";

// ── Capability authority (per-invocation broker seam) ─────────────────────
export type {
  CapabilityBroker,
  Invocation,
  InvocationCorrelation,
  InvocationOrigin,
  MintingAuthority,
  ScopedCapabilityHandle,
  ScopedLlmCapability,
  ScopedNonLlmCapability,
  ScopedLlmMeter,
} from "./capability-broker.js";
export { invocationFor } from "./capability-broker.js";

// ── DAG shape ─────────────────────────────────────────────────────────────
export type {
  DagDef,
  DagDefInput,
  EdgeDef,
  EdgeDefInput,
  EdgeDefRawInput,
  Predicate,
  PredicateResult,
} from "./dag.js";
// Edge narrowing helpers remain internal to the runtime.

// ── Branded identifiers ───────────────────────────────────────────────────
export type { RunId, NodeId, DagId, GitSha, DagInputId } from "./ids.js";
export { runId, nodeId, dagId, tryRunId, tryNodeId, tryDagId, gitSha, tryGitSha, ID_PATTERN, DAG_INPUT, isDagInput } from "./ids.js";

// ── Clock capability (C2) ─────────────────────────────────────────────────
export type { ClockCapability } from "./clock.js";
export { systemClock, fixedClock, isRepresentableTimestampMs } from "./clock.js";

export type { NonEmptyString } from "./non-empty-string.js";
export { asNonEmptyString, nonEmptyString } from "./non-empty-string.js";
