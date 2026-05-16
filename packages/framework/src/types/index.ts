// Types barrel — explicit named exports. `export *` re-exports leaked internal
// helpers (`brandAsDagDef`, `normalizeEdge`, `isOneOfMatch`,
// `isUnconditionalEdge`) onto the framework's public surface; they are
// reachable from their concrete file paths for any caller with a documented
// need, but the barrel mirrors the README "Authoring surface" section.

// ── Result (Either) ────────────────────────────────────────────────────────
export type { Result, Ok, Err } from "./result.js";
export {
  ok,
  err,
  isOk,
  isErr,
  andThen,
  map,
  mapErr,
  unwrapOr,
  fold,
} from "./result.js";

// ── Errors ────────────────────────────────────────────────────────────────
export type { FrameworkError } from "./errors.js";
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
export { CONFIDENCE_ORDER, meetsConfidence } from "./confidence.js";

// ── Freshness witness types ───────────────────────────────────────────────
export type { WitnessKind, Witness } from "./freshness.js";

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
  Capability,
  CapabilityFields,
  BaseNodeContext,
  NodeContext,
  TypedNodeContext,
  NodeContextInit,
  ContextCacheAdapter,
  CacheLookup,
  PromptAccess,
  Logger,
  Tracer,
} from "./node.js";
// `ValidatedNodeContext` and `brandAsValidatedNodeContext` are intentionally
// not re-exported — only `validateCapabilities` constructs them.

// ── DAG shape ─────────────────────────────────────────────────────────────
export type {
  DagDef,
  DagDefInput,
  EdgeDef,
  EdgeDefInput,
  EdgeDefRawInput,
  Predicate,
} from "./dag.js";
export { withRetryLimits } from "./dag.js";
// `brandAsDagDef`, `normalizeEdge`, `isOneOfMatch`, `isUnconditionalEdge`,
// `isConditionalEdge`, `isDefaultEdge`, and `DagDefShape` are internal —
// imported directly from `./types/dag.js` where needed.

// ── Branded identifiers ───────────────────────────────────────────────────
export type { RunId, NodeId, DagId } from "./ids.js";
export { runId, nodeId, dagId } from "./ids.js";
