/**
 * Framework-level semantic conventions for span attributes and events.
 *
 * Source of truth split (ADR-0023):
 * - For anything covered by the OTel GenAI semantic conventions, we emit the
 *   spec attribute (`gen_ai.*`) directly at the call site. Those names are
 *   not re-exported here — call sites use string literals matching the spec
 *   so a grep for `gen_ai.usage.input_tokens` lands on the emission point.
 * - The constants below cover framework concerns the spec does NOT address:
 *   DAG/run/node identity, cost in USD, guardrail outcomes, and the
 *   thinking-presence boolean. These keep the framework-owned `ai.*` prefix.
 */

// --- Framework-owned span attributes (not covered by OTel GenAI semconv) ---

export const AI_NODE_ID = "ai.node.id";
export const AI_NODE_KIND = "ai.node.kind";
export const AI_SPAN_TYPE = "ai.span.type";
export const AI_DAG_ID = "ai.dag.id";
export const AI_RUN_ID = "ai.run.id";

export const AI_LLM_COST_USD = "ai.llm.cost_usd";
export const AI_LLM_HAS_THINKING = "ai.llm.has_thinking";

export const AI_GUARDRAIL_PASSED = "ai.guardrail.passed";

export const AI_NODE_SIDE_EFFECTS_KIND = "ai.node.side_effects.kind";
export const AI_NODE_SIDE_EFFECTS_RESOURCE = "ai.node.side_effects.resource";
export const AI_NODE_IDEMPOTENCY_KEY = "ai.node.idempotency_key";

export const AI_ROUTE_CONFIDENCE_BUCKET = "ai.route.confidence_bucket";
export const AI_ROUTE_CONFIDENCE_SOURCE = "ai.route.confidence_source";

export const AI_FRESHNESS_WITNESS_KIND = "ai.freshness.witness_kind";
export const AI_FRESHNESS_WITNESS_RESOURCE = "ai.freshness.witness_resource";
export const AI_FRESHNESS_WITNESS_VALUE = "ai.freshness.witness_value";
export const AI_FRESHNESS_CONDITIONED_ON_VALUE = "ai.freshness.conditioned_on_value";
export const AI_FRESHNESS_VIOLATION = "ai.freshness.violation";

export const AI_HUMAN_ACTION = "ai.human.action";
export const AI_HUMAN_ACTOR = "ai.human.actor";
export const AI_HUMAN_CONFIDENCE_BUCKET = "ai.human.confidence_bucket_at_intervention";
export const AI_HUMAN_CONFIDENCE_SOURCE = "ai.human.confidence_source_at_intervention";

// --- OTel GenAI semantic conventions used by the framework ---
// Re-exported as string constants so call sites can import them by name.
// Names mirror the OTel `@opentelemetry/semantic-conventions/incubating` exports.

export const GEN_AI_SYSTEM = "gen_ai.system";
export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
export const GEN_AI_REQUEST_TEMPERATURE = "gen_ai.request.temperature";
export const GEN_AI_REQUEST_TOP_P = "gen_ai.request.top_p";
export const GEN_AI_REQUEST_MAX_TOKENS = "gen_ai.request.max_tokens";
export const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
export const GEN_AI_RESPONSE_ID = "gen_ai.response.id";
export const GEN_AI_RESPONSE_FINISH_REASONS = "gen_ai.response.finish_reasons";
export const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
export const GEN_AI_TOOL_NAME = "gen_ai.tool.name";
export const GEN_AI_TOOL_CALL_ID = "gen_ai.tool.call.id";
export const GEN_AI_TOOL_TYPE = "gen_ai.tool.type";
export const GEN_AI_TOOL_CALL_ARGUMENTS = "gen_ai.tool.call.arguments";
export const GEN_AI_TOOL_CALL_RESULT = "gen_ai.tool.call.result";
export const ERROR_TYPE = "error.type";

// --- Span Event Names ---

export const EVENT_NODE_INPUT = "ai.node.input";
export const EVENT_NODE_OUTPUT = "ai.node.output";
/** Framework-specific cost breakdown event. Not part of the GenAI spec. */
export const EVENT_LLM_COST = "ai.llm.cost";

// OTel GenAI prompt / completion events. Names mirror
// `@opentelemetry/semantic-conventions/incubating` events.
export const EVENT_GEN_AI_SYSTEM_MESSAGE = "gen_ai.system.message";
export const EVENT_GEN_AI_USER_MESSAGE = "gen_ai.user.message";
export const EVENT_GEN_AI_ASSISTANT_MESSAGE = "gen_ai.assistant.message";

// --- Span Type Values ---

export const SPAN_TYPE_CHAIN = "chain";
export const SPAN_TYPE_LLM = "llm";
export const SPAN_TYPE_RETRIEVER = "retriever";
export const SPAN_TYPE_TOOL = "tool";

/** Map node kind → span type */
export const NODE_KIND_TO_SPAN_TYPE: Record<string, string> = {
  llm: SPAN_TYPE_LLM,
  fetch: SPAN_TYPE_RETRIEVER,
  transform: SPAN_TYPE_CHAIN,
  guardrail: SPAN_TYPE_TOOL,
  "eval-judge": SPAN_TYPE_TOOL,
};
