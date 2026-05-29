export type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  SendWithToolsRequest,
  ToolDef,
  ToolContext,
  ToolName,
} from "../types/llm.js";
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
export { computeCostUsd, PRICE_TABLE } from "./cost.js";
export { zodToJsonSchema } from "./zod-schema.js";
