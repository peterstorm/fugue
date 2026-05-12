import type { LlmClient } from "../llm/client.js";
import { err } from "../types/result.js";

/**
 * Stub implementation of `sendWithTools` for tests that only exercise
 * `sendStructured`. Returning `node-crash` makes accidental usage loud.
 */
export const stubSendWithTools: LlmClient["sendWithTools"] = async () =>
  err({
    kind: "node-crash",
    retriability: "retriable",
    nodeId: "stub",
    message: "stub sendWithTools — test did not configure tool-use behavior",
  });
