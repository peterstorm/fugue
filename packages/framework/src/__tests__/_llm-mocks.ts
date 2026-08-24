import type { LlmClient } from "../types/llm.js";
import type { NodeId } from "../types/ids.js";
import { err } from "../types/result.js";

/**
 * Stub implementation of `sendWithTools` for tests that only exercise
 * `sendStructured`. Returning `node-crash` makes accidental usage loud.
 */
export const stubSendWithTools: LlmClient["sendWithTools"] = async () =>
  err({
    kind: "node-crash",
    retriability: "retriable",
    nodeId: "stub" as NodeId,
    message: "stub sendWithTools — test did not configure tool-use behavior",
  });

/**
 * Minimal non-null `LlmClient` for tests that need a populated `ctx.llm`
 * (tool dispatch requires it — `asToolContext` throws on a null `ctx.llm`)
 * but do not exercise the client itself. Both methods return `node-crash`
 * so accidental use is loud.
 */
export const stubLlmClient: LlmClient = {
  sendStructured: async () =>
    err({
      kind: "node-crash",
      retriability: "retriable",
      nodeId: "stub" as NodeId,
      message: "stub sendStructured — test did not configure LLM behavior",
    }),
  sendWithTools: stubSendWithTools,
};
