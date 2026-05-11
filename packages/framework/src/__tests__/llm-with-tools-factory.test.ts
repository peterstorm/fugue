import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { createLlmWithToolsNode } from "../nodes/llm-with-tools.js";
import { ok } from "../types/result.js";
import type { NodeContext } from "../types/node.js";
import type { LlmClient } from "../llm/client.js";
import type { ToolDef } from "../llm/tools.js";
import { stubSendWithTools } from "./_llm-mocks.js";

const InputSchema = z.object({ customerId: z.string() });
const OutputSchema = z.object({ greeting: z.string() });

const makeTool = (): ToolDef<unknown, unknown> => ({
  name: "lookup",
  description: "test tool",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ found: z.boolean() }),
  run: async () => ({ found: true }),
});

describe("createLlmWithToolsNode — factory", () => {
  it("returns cached value without calling sendWithTools when cache hit", async () => {
    let toolCalls = 0;
    const cached = { greeting: "hello cached" };
    const cache = {
      get: async () => ({ hit: true, value: cached }) as const,
      set: async () => ok(undefined),
    };
    const llm: LlmClient = {
      sendStructured: async () => {
        throw new Error("sendStructured should not be called");
      },
      sendWithTools: async () => {
        toolCalls++;
        return ok({ output: { greeting: "fresh" }, tokensIn: 10, tokensOut: 5, rawText: "" }) as any;
      },
    };

    const node = createLlmWithToolsNode<{ customerId: string }, { greeting: string }>({
      id: "greet",
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      model: "fake-model",
      tools: [makeTool()],
      system: "You are a greeter.",
      buildUser: (input) => `say hi to ${input.customerId}`,
    });

    const ctx: NodeContext = {
      runId: "r1",
      dagId: "d1",
      observer: null,
      cache,
      prompts: null,
      llm,
      logger: null,
    };

    const result = await node.run({ customerId: "abc" }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(cached);
    expect(toolCalls).toBe(0); // Cache hit must short-circuit the LLM call.
  });

  it("calls sendWithTools and writes cache on miss", async () => {
    const stored: Map<string, unknown> = new Map();
    let setCalls = 0;
    const cache = {
      get: async (k: string) =>
        stored.has(k)
          ? ({ hit: true, value: stored.get(k) } as const)
          : ({ hit: false } as const),
      set: async (k: string, v: unknown) => {
        setCalls++;
        stored.set(k, v);
        return ok(undefined);
      },
    };

    let toolCalls = 0;
    const llm: LlmClient = {
      sendStructured: stubSendWithTools as unknown as LlmClient["sendStructured"],
      sendWithTools: async () => {
        toolCalls++;
        return ok({
          output: { greeting: "hello fresh" },
          tokensIn: 10,
          tokensOut: 5,
          rawText: "",
        }) as any;
      },
    };

    const node = createLlmWithToolsNode<{ customerId: string }, { greeting: string }>({
      id: "greet",
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      model: "fake-model",
      tools: [makeTool()],
      system: "You are a greeter.",
      buildUser: (input) => `say hi to ${input.customerId}`,
    });

    const ctx: NodeContext = {
      runId: "r2",
      dagId: "d2",
      observer: null,
      cache,
      prompts: null,
      llm,
      logger: null,
    };

    const result = await node.run({ customerId: "abc" }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ greeting: "hello fresh" });
    expect(toolCalls).toBe(1);
    expect(setCalls).toBe(1);
    expect(stored.size).toBe(1);
  });
});
