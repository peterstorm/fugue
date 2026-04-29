import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { NodeContext } from "../types/node.js";
import type { LlmRequest, LlmResponse } from "../llm/client.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { ok } from "../types/result.js";
import { createLlmNode } from "../nodes/llm.js";

const OutputSchema = z.object({ greeting: z.string() });

const mkLlmCtx = (outputs: unknown[]): NodeContext => {
  let callCount = 0;
  return {
    runId: "test",
    dagId: "test",
    observer: null,
    cache: null,
    logger: null,
    prompts: { get: (_name: string) => "prompt template" },
    llm: {
      sendStructured: async (_req: LlmRequest<any>): Promise<Result<LlmResponse<any>, FrameworkError>> => {
        const output = outputs[callCount++];
        return ok({
          output,
          tokensIn: 10,
          tokensOut: 5,
          rawText: JSON.stringify(output),
        });
      },
    },
  };
};

describe("LLM node retry", () => {
  it("retries once on output validation failure then succeeds", async () => {
    const node = createLlmNode({
      id: "llm1",
      inputSchema: z.object({ name: z.string() }),
      outputSchema: OutputSchema,
      deps: [],
      promptName: "greet",
      model: "test-model",
      buildInput: (i) => i,
    });

    // First response invalid, second valid
    const ctx = mkLlmCtx([
      { greeting: 123 },        // fails zod validation
      { greeting: "hello" },    // passes
    ]);

    const result = await node.run({ name: "world" }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ greeting: "hello" });
    }
  });

  it("second validation failure returns Err(retry-exhausted)", async () => {
    const node = createLlmNode({
      id: "llm2",
      inputSchema: z.object({ name: z.string() }),
      outputSchema: OutputSchema,
      deps: [],
      promptName: "greet",
      model: "test-model",
      buildInput: (i) => i,
    });

    // Both responses invalid
    const ctx = mkLlmCtx([
      { greeting: 123 },
      { greeting: 456 },
    ]);

    const result = await node.run({ name: "world" }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("retry-exhausted");
    }
  });
});
