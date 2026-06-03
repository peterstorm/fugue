// Types barrel — explicit named exports. Internal helpers (`brandAsDagDef`,
// `isUnconditionalEdge`) are reachable from their concrete file paths for
// any caller with a documented need, but the barrel mirrors the README
// "Authoring surface" section.

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
export type { FrameworkError, FrameworkErrorKind } from "./errors.js";
export { formatFrameworkError, FrameworkAugmentedError } from "./errors.js";
export { frameworkError } from "./error-factories.js";

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
export type { WitnessKind, Witness, ResourceName } from "./freshness.js";
export { witness, resourceName } from "./freshness.js";

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
  CapabilityFields,
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
export type { CapabilityHandle, AdapterFactory } from "./capability-handle.js";

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
export { withRetryLimits } from "./dag.js";
// `brandAsDagDef`, `isUnconditionalEdge`, `isConditionalEdge`,
// `isDefaultEdge`, and `DagDefShape` are internal — imported directly
// from `./types/dag.js` where needed.

// ── Branded identifiers ───────────────────────────────────────────────────
export type { RunId, NodeId, DagId, GitSha } from "./ids.js";
export { runId, nodeId, dagId, tryRunId, tryNodeId, tryDagId, gitSha, tryGitSha, ID_PATTERN } from "./ids.js";
export type { NonEmptyString } from "./non-empty-string.js";
export { asNonEmptyString } from "./non-empty-string.js";
