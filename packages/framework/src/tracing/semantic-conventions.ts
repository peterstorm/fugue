/**
 * Framework-level semantic conventions for span attributes and events.
 * Vendor-neutral — no mention of any specific backend (MLflow, Jaeger, etc.).
 */

// --- Span Attributes (flat primitives) ---

export const AI_NODE_ID = "ai.node.id";
export const AI_NODE_KIND = "ai.node.kind";
export const AI_SPAN_TYPE = "ai.span.type";
export const AI_DAG_ID = "ai.dag.id";
export const AI_RUN_ID = "ai.run.id";

export const AI_LLM_MODEL = "ai.llm.model";
export const AI_LLM_PROVIDER = "ai.llm.provider";
export const AI_LLM_TOKENS_IN = "ai.llm.tokens_in";
export const AI_LLM_TOKENS_OUT = "ai.llm.tokens_out";
export const AI_LLM_COST_USD = "ai.llm.cost_usd";
export const AI_LLM_HAS_THINKING = "ai.llm.has_thinking";

export const AI_GUARDRAIL_PASSED = "ai.guardrail.passed";

// --- Span Event Names ---

export const EVENT_NODE_INPUT = "ai.node.input";
export const EVENT_NODE_OUTPUT = "ai.node.output";
export const EVENT_LLM_REQUEST = "ai.llm.request";
export const EVENT_LLM_COST = "ai.llm.cost";
export const EVENT_LLM_THINKING = "ai.llm.thinking";

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
