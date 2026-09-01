export type {
  CacheTtl,
  ConversationCachePolicy,
  LlmClient,
  LlmPricingModel,
  LlmRequest,
  LlmResponse,
  SendWithToolsRequest,
  SingleShotCachePolicy,
  ToolDef,
  ToolContext,
  ToolName,
} from "../types/llm.js";
// Prompt-cache placement. Node authors only need the policy types above; these
// are for adapters translating a plan into a provider's wire format.
export type { PromptCachePlan } from "./prompt-cache.js";
export {
  MAX_CACHE_BREAKPOINTS,
  NO_CACHE_PLAN,
  cachePolicyLabel,
  planPromptCache,
  planRequestsCaching,
  plannedBreakpointCount,
} from "./prompt-cache.js";
export type { ToolDefInput } from "./tools.js";
export { assertValidToolName, ensureToolNames, tool, toolName } from "./tools.js";
export {
  withLlmSpan,
  withToolSpan,
  setLlmUsageAttributes,
  setLlmRequestAttributes,
  setLlmResponseAttributes,
  setToolIoAttributes,
} from "./spans.js";
export type {
  LlmSpanMeta,
  ToolSpanMeta,
  LlmRequestParams,
  LlmResponseMeta,
} from "./spans.js";
export { AnthropicLlmClient, type AnthropicSdkLike } from "./anthropic-client.js";
export { OpenAILlmClient } from "./openai-client.js";
export type { OpenAILlmClientOpts } from "./openai-client.js";
export { FakeLlmClient } from "./fake-client.js";
export type {
  FakeResponseProvider,
  FakeToolUseTurn,
  FakeFinalTurn,
  FakeWithToolsScript,
} from "./fake-client.js";
export {
  CACHE_READ_MULTIPLIER,
  DEFAULT_CACHE_TTL,
  CACHE_WRITE_MULTIPLIER,
  computeCostUsd,
  costRatesFor,
  costUsd,
  spendOfCall,
  spendOfUnknownCall,
  PRICE_TABLE,
} from "./cost.js";
export type { CostRates } from "./cost.js";
export { zodToJsonSchema } from "./zod-schema.js";
