import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { dispatchToolCall, dispatchToolCallsWithSpans } from "../llm/tool-dispatch.js";
import type { ToolDef } from "../types/llm.js";
import { tool } from "../llm/tools.js";
import type { NodeContext } from "../types/node.js";
import type { Tracer } from "../tracing/tracer.js";
import type { ToolCall } from "../llm/tool-dispatch.js";
import { stubLlmClient } from "./_llm-mocks.js";
import { testNodeContext } from "./_context-factories.js";

const makeCtx = (overrides: Partial<NodeContext> = {}): NodeContext =>
  testNodeContext({ llm: stubLlmClient, ...overrides });

const echoTool: ToolDef<{ msg: string }, { echo: string }> = tool({
  name: "echo",
  description: "Echo input",
  inputSchema: z.object({ msg: z.string() }),
  outputSchema: z.object({ echo: z.string() }),
  run: async ({ msg }) => ({ echo: msg }),
});

const failTool: ToolDef<{ msg: string }, { echo: string }> = tool({
  name: "fail",
  description: "Always throws",
  inputSchema: z.object({ msg: z.string() }),
  outputSchema: z.object({ echo: z.string() }),
  run: async () => { throw new Error("tool-exploded"); },
});

describe("dispatchToolCall", () => {
  test("returns error result for unknown tool", async () => {
    const call: ToolCall = { id: "c1", name: "nonexistent", input: {} };
    const result = await dispatchToolCall(call, [echoTool], makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "unknown_tool: nonexistent" });
  });

  test("returns error result when tool throws", async () => {
    const call: ToolCall = { id: "c1", name: "fail", input: { msg: "hi" } };
    const result = await dispatchToolCall(call, [failTool], makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "tool-exploded" });
  });

  test("emits observer sub-span when tool throws", async () => {
    const events: unknown[] = [];
    const observer = {
      observe(e: unknown) {
        if ((e as { type?: string }).type === "sub-span") events.push(e);
      },
    };

    const call: ToolCall = { id: "c1", name: "fail", input: { msg: "hi" } };
    await dispatchToolCall(call, [failTool], makeCtx({ observer }));

    expect(events).toHaveLength(1);
    expect((events[0] as any).attributes["tool.error"]).toBe(true);
    expect((events[0] as any).attributes["tool.name"]).toBe("fail");
    expect((events[0] as any).attributes["tool.error_message"]).toBe("tool-exploded");
  });

  test("returns error result when input validation fails", async () => {
    const call: ToolCall = { id: "c1", name: "echo", input: { msg: 123 } };
    const result = await dispatchToolCall(call, [echoTool], makeCtx());
    expect(result.isError).toBe(true);
    expect((result.content as any).error).toContain("invalid_input");
  });

  test("returns successful result for valid call", async () => {
    const call: ToolCall = { id: "c1", name: "echo", input: { msg: "hello" } };
    const result = await dispatchToolCall(call, [echoTool], makeCtx());
    expect(result.isError).toBe(false);
    expect(result.content).toEqual({ echo: "hello" });
  });
});

describe("dispatchToolCallsWithSpans", () => {
  test("dispatches multiple tools in parallel", async () => {
    const calls: ToolCall[] = [
      { id: "c1", name: "echo", input: { msg: "a" } },
      { id: "c2", name: "echo", input: { msg: "b" } },
    ];
    const results = await dispatchToolCallsWithSpans(calls, [echoTool], makeCtx());
    expect(results).toHaveLength(2);
    expect(results[0].content).toEqual({ echo: "a" });
    expect(results[1].content).toEqual({ echo: "b" });
  });

  test("tracer.withSpan throwing propagates as rejection", async () => {
    const brokenTracer: Tracer = {
      withSpan: async () => { throw new Error("tracer-broken"); },
    };
    const calls: ToolCall[] = [{ id: "c1", name: "echo", input: { msg: "a" } }];
    await expect(
      dispatchToolCallsWithSpans(calls, [echoTool], makeCtx({ tracer: brokenTracer })),
    ).rejects.toThrow("tracer-broken");
  });

  test("works without tracer (null path)", async () => {
    const calls: ToolCall[] = [{ id: "c1", name: "echo", input: { msg: "x" } }];
    const results = await dispatchToolCallsWithSpans(
      calls,
      [echoTool],
      makeCtx({ tracer: undefined as unknown as Tracer }),
    );
    expect(results[0].content).toEqual({ echo: "x" });
  });
});

describe("asToolContext null-llm guard", () => {
  test("dispatchToolCallsWithSpans throws an authoring error when ctx.llm is null", async () => {
    const calls: ToolCall[] = [{ id: "c1", name: "echo", input: { msg: "hi" } }];
    await expect(
      dispatchToolCallsWithSpans(calls, [echoTool], makeCtx({ llm: null })),
    ).rejects.toThrow(/ctx\.llm is null/);
  });

  test("the guard names the missing requires declaration", async () => {
    const calls: ToolCall[] = [{ id: "c1", name: "echo", input: { msg: "hi" } }];
    await expect(
      dispatchToolCallsWithSpans(calls, [echoTool], makeCtx({ llm: null })),
    ).rejects.toThrow(/requires: \["llm"\]/);
  });
});
