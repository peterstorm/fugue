import { NoopObserver } from "../observer/observer.js";
import { describe, test, expect, beforeAll } from "bun:test";
import { z } from "zod";
import { context as otelContext } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { FakeLlmClient } from "../llm/fake-client.js";
import type { ToolDef } from "../llm/tools.js";
import type { NodeContext, Tracer } from "../types/node.js";
import type { SendWithToolsRequest } from "../llm/client.js";

beforeAll(() => {
  // Register an async-hooks context manager so trace.getActiveSpan() in span helpers
  // can see fake spans set via context.with(...) in the recording tracer below.
  otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

const FinalSchema = z.object({ result: z.number() });

const makeCtx = (overrides: Partial<NodeContext> = {}): NodeContext => ({
  runId: "test-run",
  dagId: "test-dag",
  observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null,
  logger: { warn: () => {}, error: () => {} },
  ...overrides,
});

const addNumbers: ToolDef<{ a: number; b: number }, { sum: number }> = {
  name: "add_numbers",
  description: "Add two numbers",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  outputSchema: z.object({ sum: z.number() }),
  run: async ({ a, b }) => ({ sum: a + b }),
};

const baseReq = (
  overrides: Partial<SendWithToolsRequest<{ result: number }>> = {},
): SendWithToolsRequest<{ result: number }> => ({
  system: "sys",
  user: "user",
  model: "fake-model",
  tools: [addNumbers],
  schema: FinalSchema,
  ...overrides,
});

describe("FakeLlmClient.sendWithTools — loop behavior", () => {
  test("single turn, no tools needed → Ok(parsed)", async () => {
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: [
        { type: "final", content: { result: 7 }, tokensIn: 12, tokensOut: 4 },
      ],
    });
    const result = await client.sendWithTools(baseReq(), makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toEqual({ result: 7 });
      expect(result.value.tokensIn).toBe(12);
      expect(result.value.tokensOut).toBe(4);
    }
  });

  test("one tool call → tool runs, result fed back, final emitted", async () => {
    let toolInvocations = 0;
    const tool: ToolDef<{ a: number; b: number }, { sum: number }> = {
      ...addNumbers,
      run: async (input) => {
        toolInvocations++;
        return { sum: input.a + input.b };
      },
    };
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: (_req, ctx) => {
        if (ctx.turn === 0) {
          return {
            type: "tool_use",
            calls: [{ id: "c1", name: "add_numbers", input: { a: 17, b: 25 } }],
          };
        }
        const sum = (ctx.toolResults[0]?.content as { sum: number }).sum;
        return { type: "final", content: { result: sum } };
      },
    });
    const result = await client.sendWithTools(
      baseReq({ tools: [tool] }),
      makeCtx(),
    );
    expect(toolInvocations).toBe(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.output).toEqual({ result: 42 });
  });

  test("parallel tool calls in one turn → both run, both feed back", async () => {
    const calls: Array<{ a: number; b: number }> = [];
    const tool: ToolDef<{ a: number; b: number }, { sum: number }> = {
      ...addNumbers,
      run: async (input) => {
        calls.push(input);
        return { sum: input.a + input.b };
      },
    };
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: (_req, ctx) => {
        if (ctx.turn === 0) {
          return {
            type: "tool_use",
            calls: [
              { id: "c1", name: "add_numbers", input: { a: 1, b: 2 } },
              { id: "c2", name: "add_numbers", input: { a: 10, b: 20 } },
            ],
          };
        }
        const total = ctx.toolResults.reduce(
          (acc, r) => acc + (r.content as { sum: number }).sum,
          0,
        );
        return { type: "final", content: { result: total } };
      },
    });
    const result = await client.sendWithTools(
      baseReq({ tools: [tool] }),
      makeCtx(),
    );
    expect(calls).toHaveLength(2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.output).toEqual({ result: 33 });
  });

  test("tool throws → loop continues with is_error result, model recovers", async () => {
    const tool: ToolDef<{ a: number; b: number }, { sum: number }> = {
      ...addNumbers,
      run: async () => {
        throw new Error("downstream broke");
      },
    };
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: (_req, ctx) => {
        if (ctx.turn === 0) {
          return {
            type: "tool_use",
            calls: [{ id: "c1", name: "add_numbers", input: { a: 1, b: 2 } }],
          };
        }
        const r = ctx.toolResults[0];
        expect(r?.isError).toBe(true);
        expect((r?.content as { error: string }).error).toContain(
          "downstream broke",
        );
        return { type: "final", content: { result: -1 } };
      },
    });
    const result = await client.sendWithTools(
      baseReq({ tools: [tool] }),
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.output).toEqual({ result: -1 });
  });

  test("tool returns invalid output → is_error surfaced to model", async () => {
    const tool: ToolDef<{ a: number; b: number }, { sum: number }> = {
      ...addNumbers,
      run: async () => ({ sum: "not a number" } as any),
    };
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: (_req, ctx) => {
        if (ctx.turn === 0) {
          return {
            type: "tool_use",
            calls: [{ id: "c1", name: "add_numbers", input: { a: 1, b: 2 } }],
          };
        }
        const r = ctx.toolResults[0];
        expect(r?.isError).toBe(true);
        expect((r?.content as { error: string }).error).toContain(
          "invalid_output",
        );
        return { type: "final", content: { result: 0 } };
      },
    });
    const result = await client.sendWithTools(
      baseReq({ tools: [tool] }),
      makeCtx(),
    );
    expect(result.ok).toBe(true);
  });

  test("unknown tool name → is_error: 'unknown_tool', loop continues", async () => {
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: (_req, ctx) => {
        if (ctx.turn === 0) {
          return {
            type: "tool_use",
            calls: [
              { id: "c1", name: "nonexistent_tool", input: { x: 1 } },
            ],
          };
        }
        const r = ctx.toolResults[0];
        expect(r?.isError).toBe(true);
        expect((r?.content as { error: string }).error).toContain(
          "unknown_tool",
        );
        return { type: "final", content: { result: 0 } };
      },
    });
    const result = await client.sendWithTools(baseReq(), makeCtx());
    expect(result.ok).toBe(true);
  });

  test("iteration cap reached → Err(transient)", async () => {
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: () => ({
        type: "tool_use",
        calls: [{ id: "c", name: "add_numbers", input: { a: 1, b: 1 } }],
      }),
    });
    const result = await client.sendWithTools(
      baseReq({ maxIterations: 3 }),
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      if (result.error.kind === "transient") {
        expect(result.error.message).toContain("(3)");
      }
    }
  });

  test("cancellation between turns → Err(aborted)", async () => {
    const controller = new AbortController();
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: (_req, ctx) => {
        if (ctx.turn === 0) {
          // Trigger abort after the first turn dispatches.
          return {
            type: "tool_use",
            calls: [{ id: "c1", name: "add_numbers", input: { a: 1, b: 2 } }],
          };
        }
        return { type: "final", content: { result: 3 } };
      },
    });
    // Pre-abort: the loop should bail on entry.
    controller.abort();
    const result = await client.sendWithTools(
      baseReq({ signal: controller.signal }),
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("aborted");
    }
  });

  test("toolChoice='none' rejects tool_use turns from the script", async () => {
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: [
        {
          type: "tool_use",
          calls: [{ id: "c", name: "add_numbers", input: { a: 1, b: 1 } }],
        },
      ],
    });
    const result = await client.sendWithTools(
      baseReq({ toolChoice: "none" }),
      makeCtx(),
    );
    expect(result.ok).toBe(false);
  });

  test("invalid tool name at registration → Err(validation)", async () => {
    const bad: ToolDef<unknown, unknown> = {
      name: "bad name with spaces",
      description: "x",
      inputSchema: z.any(),
      outputSchema: z.any(),
      run: async () => ({}),
    };
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: [{ type: "final", content: { result: 0 } }],
    });
    const result = await client.sendWithTools(
      baseReq({ tools: [bad] }),
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("validation");
  });

  test("token usage accumulates across turns", async () => {
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: [
        {
          type: "tool_use",
          calls: [{ id: "c1", name: "add_numbers", input: { a: 1, b: 1 } }],
          tokensIn: 100,
          tokensOut: 20,
        },
        {
          type: "final",
          content: { result: 2 },
          tokensIn: 50,
          tokensOut: 10,
        },
      ],
    });
    const result = await client.sendWithTools(baseReq(), makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tokensIn).toBe(150);
      expect(result.value.tokensOut).toBe(30);
    }
  });
});

// --- Span emission tests ---

interface RecordedSpan {
  readonly name: string;
  readonly spanType: string;
  readonly attributes: Record<string, unknown>;
}

const makeRecordingTracer = (
  recorded: RecordedSpan[],
): Tracer => {
  // Patch the active OTel span for the duration of fn so attribute setters land somewhere.
  const otelMod = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
  return {
    withSpan: async <T,>(name: string, spanType: string, fn: () => Promise<T>) => {
      const attrs: Record<string, unknown> = {};
      const fakeSpan = {
        setAttribute: (k: string, v: unknown) => {
          attrs[k] = v;
          return fakeSpan;
        },
        setAttributes: (a: Record<string, unknown>) => {
          Object.assign(attrs, a);
          return fakeSpan;
        },
        addEvent: () => fakeSpan,
        end: () => undefined,
        isRecording: () => true,
        recordException: () => undefined,
        setStatus: () => fakeSpan,
        spanContext: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 }),
        updateName: () => fakeSpan,
      };
      const ctx = otelMod.trace.setSpan(otelMod.context.active(), fakeSpan as any);
      return otelMod.context.with(ctx, async () => {
        const result = await fn();
        recorded.push({ name, spanType, attributes: attrs });
        return result;
      });
    },
  };
};

describe("sendWithTools span emission (GenAI semconv)", () => {
  test("emits CHAT_MODEL span per LLM turn and TOOL span per tool call", async () => {
    const recorded: RecordedSpan[] = [];
    const tracer = makeRecordingTracer(recorded);
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: [
        {
          type: "tool_use",
          calls: [{ id: "c1", name: "add_numbers", input: { a: 7, b: 8 } }],
          tokensIn: 100,
          tokensOut: 20,
        },
        { type: "final", content: { result: 15 }, tokensIn: 30, tokensOut: 5 },
      ],
    });
    const result = await client.sendWithTools(baseReq(), makeCtx({ tracer }));
    expect(result.ok).toBe(true);

    const llmSpans = recorded.filter((r) => r.spanType === "CHAT_MODEL");
    const toolSpans = recorded.filter((r) => r.spanType === "TOOL");
    expect(llmSpans).toHaveLength(2);
    expect(toolSpans).toHaveLength(1);

    expect(llmSpans[0]?.name).toBe("chat fake-model");
    expect(llmSpans[0]?.attributes["gen_ai.system"]).toBe("fake");
    expect(llmSpans[0]?.attributes["gen_ai.request.model"]).toBe("fake-model");
    expect(llmSpans[0]?.attributes["gen_ai.operation.name"]).toBe("chat");
    expect(llmSpans[0]?.attributes["gen_ai.usage.input_tokens"]).toBe(100);
    expect(llmSpans[0]?.attributes["gen_ai.usage.output_tokens"]).toBe(20);

    expect(toolSpans[0]?.name).toBe("execute_tool add_numbers");
    expect(toolSpans[0]?.attributes["gen_ai.tool.name"]).toBe("add_numbers");
    expect(toolSpans[0]?.attributes["gen_ai.tool.call.id"]).toBe("c1");
    expect(toolSpans[0]?.attributes["gen_ai.tool.type"]).toBe("function");
    expect(toolSpans[0]?.attributes["gen_ai.tool.is_error"]).toBe(false);
    expect(toolSpans[0]?.attributes["gen_ai.operation.name"]).toBe(
      "execute_tool",
    );
  });

  test("tool error sets gen_ai.tool.is_error = true", async () => {
    const recorded: RecordedSpan[] = [];
    const tracer = makeRecordingTracer(recorded);
    const tool: ToolDef<{ a: number; b: number }, { sum: number }> = {
      ...addNumbers,
      run: async () => {
        throw new Error("boom");
      },
    };
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: [
        {
          type: "tool_use",
          calls: [{ id: "c1", name: "add_numbers", input: { a: 1, b: 2 } }],
        },
        { type: "final", content: { result: 0 } },
      ],
    });
    await client.sendWithTools(baseReq({ tools: [tool] }), makeCtx({ tracer }));
    const toolSpan = recorded.find((r) => r.spanType === "TOOL");
    expect(toolSpan?.attributes["gen_ai.tool.is_error"]).toBe(true);
  });
});

// --- Property-style: any K turns terminate ---

describe("sendWithTools convergence", () => {
  test("K tool turns then final produces Ok with sum of token usage", async () => {
    for (const K of [0, 1, 5, 9]) {
      const script: any[] = [];
      for (let i = 0; i < K; i++) {
        script.push({
          type: "tool_use",
          calls: [{ id: `c${i}`, name: "add_numbers", input: { a: 1, b: 1 } }],
          tokensIn: 1,
          tokensOut: 1,
        });
      }
      script.push({ type: "final", content: { result: K }, tokensIn: 1, tokensOut: 1 });

      const client = new FakeLlmClient(new Map(), { withToolsScript: script });
      const result = await client.sendWithTools(
        baseReq({ maxIterations: 10 }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.output).toEqual({ result: K });
        expect(result.value.tokensIn).toBe(K + 1);
        expect(result.value.tokensOut).toBe(K + 1);
      }
    }
  });
});
