import { NoopObserver } from "../observer/observer.js";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { NodeContext } from "../types/node.js";
import type { LlmRequest, LlmResponse } from "../types/llm.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { ok } from "../types/result.js";
import { createLlmNode } from "../nodes/llm.js";
import { stubSendWithTools } from "./_llm-mocks.js";

const OutputSchema = z.object({ greeting: z.string() });

const mkLlmCtx = (outputs: unknown[]): NodeContext => {
  let callCount = 0;
  return {
    runId: "test" as RunId,
    dagId: "test" as DagId,
    observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
    cache: null,
    logger: { warn: () => {}, error: () => {} },
    prompts: { get: (_name: string) => "prompt template" },
    llm: {
      sendWithTools: stubSendWithTools,
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
      promptName: "greet",
      model: "test-model",
      buildInput: (i) => i,
    });

    // First response invalid, second valid
    const ctx = mkLlmCtx([
      { greeting: 123 },        // fails zod validation
      { greeting: "hello" },    // passes
    ]);

    const result = await node.run({ name: "world" }, ctx as any);
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
      promptName: "greet",
      model: "test-model",
      buildInput: (i) => i,
    });

    // Both responses invalid
    const ctx = mkLlmCtx([
      { greeting: 123 },
      { greeting: 456 },
    ]);

    const result = await node.run({ name: "world" }, ctx as any);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("retry-exhausted");
    }
  });
});
