/**
 * Dedicated tests for tool-use-loop.ts — provider-agnostic iteration control.
 * Tests: deadline enforcement, iteration limits, abort propagation, token
 * accumulation, final-answer parsing, schema validation failures.
 */

import { describe, test, expect } from "bun:test";
import { tokensOnly } from "../types/token-usage.js";
import { toolUseLoop, type ToolLoopProvider } from "../llm/tool-use-loop.js";
import { toolName } from "../llm/tools.js";
import { z } from "zod";
import { ok, err } from "../types/result.js";
import { N } from "./_id-helpers.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import type { NodeContext } from "../types/node.js";
import { stubLlmClient } from "./_llm-mocks.js";
import { setFrameworkLogger, __resetFrameworkLogger } from "../logger.js";

const schema = z.object({ answer: z.string() });

const makeCtx = () =>
  makeNodeContext({ runId: "test-run", dagId: "test-dag", llm: stubLlmClient });

/** Create a simple provider that returns a final answer on the first call. */
const immediateProvider = (text: string): ToolLoopProvider => ({
  call: async () => ok({ toolCalls: [], textContent: text, ...tokensOnly(10, 20) }),
  appendToolResults: () => {},
});

/** Provider that calls tools for N turns then returns a final answer. */
const multiTurnProvider = (turns: number, finalText: string): ToolLoopProvider => {
  let callCount = 0;
  return {
    call: async () => {
      callCount++;
      if (callCount > turns) {
        return ok({ toolCalls: [], textContent: finalText, ...tokensOnly(5, 10) });
      }
      return ok({
        toolCalls: [{ id: `call-${callCount}`, name: "test_tool", input: {} }],
        textContent: undefined,
        ...tokensOnly(10, 15),
      });
    },
    appendToolResults: () => {},
  };
};

/** Provider that always returns tool calls (never a final answer). */
const infiniteToolProvider = (): ToolLoopProvider => ({
  call: async () =>
    ok({
      toolCalls: [{ id: "call-loop", name: "tool", input: {} }],
      textContent: undefined,
      ...tokensOnly(5, 5),
    }),
  appendToolResults: () => {},
});

/** Provider that returns an error on a specific turn. */
const errorOnTurn = (errorTurn: number): ToolLoopProvider => {
  let callCount = 0;
  return {
    call: async () => {
      callCount++;
      if (callCount === errorTurn) {
        return err({ kind: "transient", nodeId: N("test"), message: "rate limit" });
      }
      return ok({ toolCalls: [], textContent: '{"answer":"ok"}', ...tokensOnly(5, 5) });
    },
    appendToolResults: () => {},
  };
};

describe("toolUseLoop", () => {
  test("hostile tool-name validation failures remain typed", async () => {
    const hostile = {
      get message(): never { throw new Error("message getter escaped"); },
      [Symbol.toPrimitive](): never { throw new Error("coercion escaped"); },
    };
    const tools = [{
      get name(): never { throw hostile; },
    }] as never;

    const result = await toolUseLoop(
      immediateProvider('{"answer":"unreachable"}'),
      { nodeId: N("n1"), model: "m", schema, tools, maxIterations: 1 },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      if (result.error.kind === "validation") expect(typeof result.error.message).toBe("string");
    }
  });

  test("immediate final answer — parses JSON and validates schema", async () => {
    const result = await toolUseLoop(
      immediateProvider('{"answer":"hello"}'),
      { nodeId: N("n1"), model: "m", schema, tools: [], maxIterations: 5 },
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toEqual({ answer: "hello" });
      expect(result.value.tokensIn).toBe(10);
      expect(result.value.tokensOut).toBe(20);
    }
  });

  test("strips code fences from final answer", async () => {
    const result = await toolUseLoop(
      immediateProvider('```json\n{"answer":"fenced"}\n```'),
      { nodeId: N("n1"), model: "m", schema, tools: [], maxIterations: 5 },
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.output).toEqual({ answer: "fenced" });
  });

  test("iteration limit exhausted → non-retriable error, carrying accumulated usage", async () => {
    const result = await toolUseLoop(
      infiniteToolProvider(), // 5 in / 5 out per turn
      { nodeId: N("n1"), model: "m", schema, tools: [{ name: toolName("tool"), description: "t", inputSchema: z.object({}), outputSchema: z.string(), run: async () => ok("") }], maxIterations: 3 },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("non-retriable");
        expect(result.error.message).toContain("iteration limit");
        // FR-W0-001: tokens burned across all 3 turns are attributed on the Err.
        expect(result.error.usage).toEqual({ ...tokensOnly(15, 15) });
      }
    }
  });

  test("deadline enforcement with injectable clock", async () => {
    let time = 1000;
    const nowFn = () => time;

    // Provider that advances time by 500ms each call
    const provider: ToolLoopProvider = {
      call: async () => {
        time += 500;
        return ok({
          toolCalls: [{ id: "c", name: "tool", input: {} }],
          textContent: undefined,
          ...tokensOnly(1, 1),
        });
      },
      appendToolResults: () => {},
    };

    const result = await toolUseLoop(
      provider,
      {
        nodeId: N("n1"),
        model: "m",
        schema,
        tools: [{ name: toolName("tool"), description: "t", inputSchema: z.object({}), outputSchema: z.string(), run: async () => ok("") }],
        maxIterations: 100,
        deadlineMs: 1200, // deadline at time 2200
        now: nowFn,
      },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      if (result.error.kind === "transient") {
        expect(result.error.message).toContain("deadline");
      }
    }
  });

  test("abort signal propagation", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await toolUseLoop(
      immediateProvider('{"answer":"x"}'),
      { nodeId: N("n1"), model: "m", schema, tools: [], maxIterations: 5, signal: controller.signal },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("aborted");
  });

  test("token accumulation across multiple turns", async () => {
    const result = await toolUseLoop(
      multiTurnProvider(3, '{"answer":"done"}'),
      {
        nodeId: N("n1"),
        model: "m",
        schema,
        tools: [{ name: toolName("test_tool"), description: "t", inputSchema: z.object({}), outputSchema: z.string(), run: async () => ok("result") }],
        maxIterations: 10,
      },
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 3 tool turns: 10 + 10 + 10 = 30 in, 15 + 15 + 15 = 45 out
      // 1 final turn: 5 in, 10 out
      expect(result.value.tokensIn).toBe(35);
      expect(result.value.tokensOut).toBe(55);
    }
  });

  test("invalid JSON in final answer → retriable node-crash", async () => {
    const result = await toolUseLoop(
      immediateProvider("not json at all"),
      { nodeId: N("n1"), model: "m", schema, tools: [], maxIterations: 5 },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("retriable");
        expect(result.error.message).toContain("Not valid JSON");
      }
    }
  });

  test("schema validation failure → retriable node-crash", async () => {
    const result = await toolUseLoop(
      immediateProvider('{"wrong_field": 123}'),
      { nodeId: N("n1"), model: "m", schema, tools: [], maxIterations: 5 },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("retriable");
        expect(result.error.message).toContain("Schema validation failed");
      }
    }
  });

  test("provider returns error on first call → propagated", async () => {
    const result = await toolUseLoop(
      errorOnTurn(1),
      { nodeId: N("n1"), model: "m", schema, tools: [], maxIterations: 5 },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      // First-call error consumed no prior turns and the provider reported no
      // own usage → usage stays ABSENT (the errors.ts contract: absent means
      // "no attributable tokens" — never a stamped {0,0} second representation).
      if (result.error.kind === "transient") {
        expect(result.error.usage).toBeUndefined();
      }
    }
  });

  test("mid-loop provider error carries prior-turn accumulated usage (FR-W0-001)", async () => {
    // Turn 1: a tool-call turn that burns 10/15. Turn 2: the provider errors,
    // itself reporting 3/4 partial usage for the in-flight turn.
    let callCount = 0;
    const provider: ToolLoopProvider = {
      call: async () => {
        callCount++;
        if (callCount === 1) {
          return ok({
            toolCalls: [{ id: "c", name: "tool", input: {} }],
            textContent: undefined,
            ...tokensOnly(10, 15),
          });
        }
        return err({
          kind: "transient",
          nodeId: N("n1"),
          message: "rate limit",
          usage: { ...tokensOnly(3, 4) },
        });
      },
      appendToolResults: () => {},
    };
    const result = await toolUseLoop(
      provider,
      {
        nodeId: N("n1"),
        model: "m",
        schema,
        tools: [{ name: toolName("tool"), description: "t", inputSchema: z.object({}), outputSchema: z.string(), run: async () => ok("r") }],
        maxIterations: 5,
      },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "transient") {
      // Prior turn (10/15) + the in-flight turn's own reported usage (3/4).
      expect(result.error.usage).toEqual({ ...tokensOnly(13, 19) });
    }
  });

  test("deadline-exceeded transient carries accumulated usage", async () => {
    let time = 1000;
    const nowFn = () => time;
    const provider: ToolLoopProvider = {
      call: async () => {
        time += 500;
        return ok({
          toolCalls: [{ id: "c", name: "tool", input: {} }],
          textContent: undefined,
          ...tokensOnly(7, 3),
        });
      },
      appendToolResults: () => {},
    };
    const result = await toolUseLoop(
      provider,
      {
        nodeId: N("n1"),
        model: "m",
        schema,
        tools: [{ name: toolName("tool"), description: "t", inputSchema: z.object({}), outputSchema: z.string(), run: async () => ok("r") }],
        maxIterations: 10,
        deadlineMs: 700,
        now: nowFn,
      },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "transient") {
      // deadline=1700: turn0 (1000<1700) burns 7/3 →1500; turn1 (1500<1700)
      // burns 7/3 →2000; turn2 check 2000>=1700 trips. Two turns completed.
      expect(result.error.usage).toEqual({ ...tokensOnly(14, 6) });
    }
  });

  test("final turn with no text content → retriable error", async () => {
    const provider: ToolLoopProvider = {
      call: async () => ok({ toolCalls: [], textContent: undefined, ...tokensOnly(1, 1) }),
      appendToolResults: () => {},
    };
    const result = await toolUseLoop(
      provider,
      { nodeId: N("n1"), model: "m", schema, tools: [], maxIterations: 5 },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.message).toContain("no text content");
      }
    }
  });

  test("llm.usage-unattributed warning carries nodeId/runId/dagId correlation (A6)", async () => {
    // A `validation` error has no `usage` channel — tokens burned by prior
    // turns surface via the structured warning instead, and the warning MUST
    // carry the correlation triple so the burned tokens are joinable to a run.
    const warns: { msg: string; data: Record<string, unknown> }[] = [];
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: (msg, ...args) => warns.push({ msg, data: (args[0] ?? {}) as Record<string, unknown> }),
      error: () => {},
    });
    try {
      let calls = 0;
      const provider: ToolLoopProvider = {
        call: async () => {
          calls++;
          if (calls === 1) {
            // Turn 1 burns 10/15 across a tool-call turn.
            return ok({
              toolCalls: [{ id: "c", name: "tool", input: {} }],
              textContent: undefined,
              ...tokensOnly(10, 15),
            });
          }
          // Turn 2 fails with a kind that cannot carry usage.
          return err({ kind: "validation", nodeId: N("n1"), message: "bad tool schema" });
        },
        appendToolResults: () => {},
      };
      const result = await toolUseLoop(
        provider,
        {
          nodeId: N("n1"),
          model: "m",
          schema,
          tools: [{ name: toolName("tool"), description: "t", inputSchema: z.object({}), outputSchema: z.string(), run: async () => ok("r") }],
          maxIterations: 5,
        },
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("validation");

      const w = warns.find((x) => x.msg === "llm.usage-unattributed");
      expect(w).toBeDefined();
      expect(w?.data.errorKind).toBe("validation");
      expect(w?.data.tokensIn).toBe(10);
      expect(w?.data.tokensOut).toBe(15);
      // The correlation triple — without these the burned tokens are unjoinable.
      expect(w?.data.nodeId).toBe("n1");
      expect(w?.data.runId).toBe("test-run");
      expect(w?.data.dagId).toBe("test-dag");
    } finally {
      __resetFrameworkLogger();
    }
  });

  test("throwing usage diagnostics preserve the original validation Result", async () => {
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: () => { throw new Error("logger transport failed"); },
      error: () => {},
    });
    try {
      let calls = 0;
      const provider: ToolLoopProvider = {
        call: async () => {
          calls += 1;
          return calls === 1
            ? ok({
                toolCalls: [{ id: "c", name: "tool", input: {} }],
                textContent: undefined,
                ...tokensOnly(10, 15),
              })
            : err({ kind: "validation", nodeId: N("n1"), message: "bad schema" });
        },
        appendToolResults: () => {},
      };

      const result = await toolUseLoop(
        provider,
        {
          nodeId: N("n1"),
          model: "m",
          schema,
          tools: [{ name: toolName("tool"), description: "t", inputSchema: z.object({}), outputSchema: z.string(), run: async () => ok("r") }],
          maxIterations: 3,
        },
        makeCtx(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("validation");
    } finally {
      __resetFrameworkLogger();
    }
  });

  test("a hostile tool-dispatch throw remains a typed non-retriable error", async () => {
    const hostile = {
      [Symbol.toPrimitive](): never { throw new Error("coercion escaped"); },
      toString(): never { throw new Error("toString escaped"); },
    };
    const base = makeCtx();
    const hostileCtx = {
      ...base,
      get llm(): never { throw hostile; },
    } as NodeContext;
    const provider: ToolLoopProvider = {
      call: async () => ok({
        toolCalls: [{ id: "c", name: "tool", input: {} }],
        textContent: undefined,
        ...tokensOnly(4, 6),
      }),
      appendToolResults: () => {},
    };

    const result = await toolUseLoop(
      provider,
      {
        nodeId: N("n1"),
        model: "m",
        schema,
        tools: [{ name: toolName("tool"), description: "t", inputSchema: z.object({}), outputSchema: z.string(), run: async () => ok("r") }],
        maxIterations: 2,
      },
      hostileCtx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.retriability).toBe("non-retriable");
      expect(result.error.message).toContain("tool dispatch threw");
      expect(result.error.usage).toEqual({ ...tokensOnly(4, 6) });
    }
  });

  test("appendToolResults failures are typed after tool side effects", async () => {
    let providerCalls = 0;
    let toolCalls = 0;
    const provider: ToolLoopProvider = {
      call: async () => {
        providerCalls += 1;
        return ok({
          toolCalls: [{ id: "c", name: "tool", input: {} }],
          textContent: undefined,
          ...tokensOnly(7, 9),
        });
      },
      appendToolResults: () => { throw new Error("conversation serialization failed"); },
    };

    const result = await toolUseLoop(
      provider,
      {
        nodeId: N("n1"),
        model: "m",
        schema,
        tools: [{
          name: toolName("tool"),
          description: "t",
          inputSchema: z.object({}),
          outputSchema: z.string(),
          run: async () => { toolCalls += 1; return ok("r"); },
        }],
        maxIterations: 3,
      },
      makeCtx(),
    );

    expect(providerCalls).toBe(1);
    expect(toolCalls).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.retriability).toBe("non-retriable");
      expect(result.error.message).toContain("provider.appendToolResults threw");
      expect(result.error.usage).toEqual({ ...tokensOnly(7, 9) });
    }
  });

  test("tool dispatch throw (ctx without llm) → non-retriable node-crash carrying accumulated usage", async () => {
    // `asToolContext` (tool-dispatch.ts) throws when ctx.llm is null — the node
    // forgot `requires: ["llm"]`. The loop fences `dispatchToolCallsWithSpans`
    // in try/catch: the throw must surface as a typed err (not an escaping
    // exception), non-retriable (authoring errors are deterministic), and the
    // tokens burned producing the tool calls must still ride the error's
    // `usage` channel (FR-W0-001).
    const provider: ToolLoopProvider = {
      call: async () =>
        ok({
          toolCalls: [{ id: "c1", name: "tool", input: {} }],
          textContent: undefined,
          ...tokensOnly(10, 15),
        }),
      appendToolResults: () => {},
    };
    // NodeContext WITHOUT llm — makeNodeContext defaults the capability to null.
    const ctxWithoutLlm = makeNodeContext({ runId: "test-run", dagId: "test-dag" });

    const result = await toolUseLoop(
      provider,
      {
        nodeId: N("n1"),
        model: "m",
        schema,
        tools: [{ name: toolName("tool"), description: "t", inputSchema: z.object({}), outputSchema: z.string(), run: async () => ok("r") }],
        maxIterations: 5,
      },
      ctxWithoutLlm,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("non-retriable");
        expect(result.error.message).toContain("tool dispatch threw");
        // The turn that produced the tool calls completed before the throw —
        // its 10/15 are accumulated and attributed on the Err.
        expect(result.error.usage).toEqual({ ...tokensOnly(10, 15) });
      }
    }
  });

  test("thinking content from last turn is preserved", async () => {
    let callCount = 0;
    const provider: ToolLoopProvider = {
      call: async () => {
        callCount++;
        if (callCount === 1) {
          return ok({ toolCalls: [{ id: "c", name: "tool", input: {} }], textContent: undefined, ...tokensOnly(1, 1), thinking: "step 1" });
        }
        return ok({ toolCalls: [], textContent: '{"answer":"done"}', ...tokensOnly(1, 1), thinking: "final thought" });
      },
      appendToolResults: () => {},
    };
    const result = await toolUseLoop(
      provider,
      { nodeId: N("n1"), model: "m", schema, tools: [{ name: toolName("tool"), description: "t", inputSchema: z.object({}), outputSchema: z.string(), run: async () => ok("r") }], maxIterations: 5 },
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.thinking).toBe("final thought");
  });
});
