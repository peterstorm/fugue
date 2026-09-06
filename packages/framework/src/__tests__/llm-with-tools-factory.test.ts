import type { RunId, DagId } from "../types/ids.js";
import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { createLlmWithToolsNode } from "../nodes/llm-with-tools.js";
import { createLlmNode } from "../nodes/llm.js";
import { ok } from "../types/result.js";
import type { NodeContext } from "../types/node.js";
import type { LlmClient, ToolDef } from "../types/llm.js";
import { tool } from "../llm/tools.js";
import { stubSendWithTools } from "./_llm-mocks.js";
import { N } from "./_id-helpers.js";
import { testNodeContext } from "./_context-factories.js";

const InputSchema = z.object({ customerId: z.string() });
const OutputSchema = z.object({ greeting: z.string() });

const makeTool = (): ToolDef<unknown, unknown> => tool({
  name: "lookup",
  description: "test tool",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ found: z.boolean() }),
  run: async () => ({ found: true }),
}) as ToolDef<unknown, unknown>;

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
      id: N("greet"),
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      model: "fake-model",
      tools: [makeTool()],
      system: "You are a greeter.",
      buildUser: (input) => `say hi to ${input.customerId}`,
    });

    const ctx: NodeContext = testNodeContext({
      runId: "r1" as RunId,
      dagId: "d1" as DagId,
      cache,
      llm,
    });

    const result = await node.run({ customerId: "abc" }, ctx as any);
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
      id: N("greet"),
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      model: "fake-model",
      tools: [makeTool()],
      system: "You are a greeter.",
      buildUser: (input) => `say hi to ${input.customerId}`,
    });

    const ctx: NodeContext = testNodeContext({
      runId: "r2" as RunId,
      dagId: "d2" as DagId,
      cache,
      llm,
    });

    const result = await node.run({ customerId: "abc" }, ctx as any);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ greeting: "hello fresh" });
    expect(toolCalls).toBe(1);
    expect(setCalls).toBe(1);
    expect(stored.size).toBe(1);
  });
});

describe("node factories — the `cache` config reaches the request (FR-PC-001)", () => {
  // This is the surface a node AUTHOR touches. Everything else in the
  // prompt-cache suite drives the client or the pipeline directly, so nothing
  // pinned that the field survives the one-line passthrough in either factory —
  // a silent drop here would disable caching for every DAG while every other
  // test stayed green.
  const policy = { kind: "conversation", ttl: "1h" } as const;

  const captureCtx = (
    seen: { cache?: unknown }[],
  ): NodeContext =>
    ({
      ...testNodeContext({ runId: "r1" as RunId, dagId: "d1" as DagId }),
      llm: {
        sendStructured: async (req: { cache?: unknown }) => {
          seen.push({ cache: req.cache });
          return ok({
            output: { greeting: "hi" },
            tokensIn: 1,
            tokensOut: 1,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            rawText: "",
          });
        },
        sendWithTools: async (req: { cache?: unknown }) => {
          seen.push({ cache: req.cache });
          return ok({
            output: { greeting: "hi" },
            tokensIn: 1,
            tokensOut: 1,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            rawText: "",
          });
        },
      },
    }) as unknown as NodeContext;

  it("threads it through createLlmWithToolsNode", async () => {
    const seen: { cache?: unknown }[] = [];
    const node = createLlmWithToolsNode<{ customerId: string }, { greeting: string }>({
      id: N("greet"),
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      model: "fake-model",
      tools: [makeTool()],
      system: "You are a greeter.",
      buildUser: (input) => `say hi to ${input.customerId}`,
      cache: policy,
    });

    await node.run({ customerId: "abc" }, captureCtx(seen) as never);
    expect(seen[0]?.cache).toEqual(policy);
  });

  it("omits it entirely when the node declares none", async () => {
    const seen: { cache?: unknown }[] = [];
    const node = createLlmWithToolsNode<{ customerId: string }, { greeting: string }>({
      id: N("greet"),
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      model: "fake-model",
      tools: [makeTool()],
      system: "You are a greeter.",
      buildUser: (input) => `say hi to ${input.customerId}`,
    });

    await node.run({ customerId: "abc" }, captureCtx(seen) as never);
    expect(seen[0]?.cache).toBeUndefined();
  });

  it("threads it through createLlmNode", async () => {
    const seen: { cache?: unknown }[] = [];
    const node = createLlmNode<{ customerId: string }, { greeting: string }>({
      id: "greet-single",
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      model: "fake-model",
      promptName: "greet",
      buildInput: (input) => ({ customerId: input.customerId }),
      cache: { kind: "static-prefix", ttl: "5m" },
    });

    const ctx = captureCtx(seen) as unknown as Record<string, unknown>;
    ctx["prompts"] = { get: () => "say hi to {{customerId}}" };
    await node.run({ customerId: "abc" }, ctx as never);
    expect(seen[0]?.cache).toEqual({ kind: "static-prefix", ttl: "5m" });
  });
});
