/**
 * The rolling conversation breakpoint, exercised through a real two-turn loop.
 *
 * This is where prompt caching earns its keep and where it is easiest to get
 * wrong: the history grows every turn, so a breakpoint that ACCUMULATED rather
 * than rolled would march straight into the provider's four-slot cap, and a
 * per-turn cache figure that the loop forgot to fold would under-report a
 * cached run's tokens.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicLlmClient } from "../llm/anthropic-client.js";
import { tool } from "../llm/tools.js";
import { makeNodeContext } from "../shared/index.js";
import { unwrap } from "../types/result.js";
import { uncachedInputTokens } from "../types/token-usage.js";
import type { ToolDef } from "../types/llm.js";
import type { DagId, RunId } from "../types/ids.js";
import { N } from "./_id-helpers.js";
import {
  anthropicUsageBlock,
  breakpointsIn,
  textResponse,
  toolUseResponse,
  type CreateFn,
} from "./_prompt-cache-helpers.js";

const schema = z.object({ answer: z.string() });

/** A two-turn loop: the model calls a tool, then answers. */
const twoTurnClient = (turnUsages: readonly Anthropic.Message["usage"][]) => {
  const seen: Anthropic.MessageCreateParams[] = [];
  let turn = 0;
  const create: CreateFn = async (params) => {
    // Snapshot: the client renders the breakpoint onto a COPY each turn, and a
    // by-reference capture would show only the final state.
    seen.push(structuredClone(params));
    const usage = turnUsages[turn] ?? anthropicUsageBlock(0, 0);
    turn += 1;
    return turn === 1 ? toolUseResponse(usage) : textResponse('{"answer":"done"}', usage);
  };
  const client = new AnthropicLlmClient({ messages: { create } } as never);
  return { client, seen };
};

const lookupTool = tool({
  name: "lookup",
  description: "test tool",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ found: z.boolean() }),
  run: async () => ({ found: true }),
}) as ToolDef<unknown, unknown>;

const RUNTIME = makeNodeContext({
  runId: "prompt-cache-run" as RunId,
  dagId: "prompt-cache-dag" as DagId,
  llm: {
    sendStructured: async () => {
      throw new Error("unused");
    },
    sendWithTools: async () => {
      throw new Error("unused");
    },
  } as never,
});

const runLoop = async (
  client: AnthropicLlmClient,
  cache: Parameters<AnthropicLlmClient["sendWithTools"]>[0]["cache"],
) =>
  client.sendWithTools(
    {
      system: "SYS",
      user: "hello",
      model: "claude-test",
      tools: [lookupTool],
      schema,
      nodeId: N("n1"),
      ...(cache ? { cache } : {}),
    },
    RUNTIME,
  );

describe("conversation policy — FR-PC-003 / INV-PC-5", () => {
  it("emits at most two breakpoints per turn, however long the loop runs", async () => {
    const { client, seen } = twoTurnClient([
      anthropicUsageBlock(10, 5, 500, 0),
      anthropicUsageBlock(10, 5, 0, 500),
    ]);
    await runLoop(client, { kind: "conversation", ttl: "5m" });
    expect(seen.length).toBe(2);
    for (const params of seen) {
      // One on system, one rolling onto the latest turn — never accumulating
      // toward the provider's four-slot cap as the history grows.
      expect(breakpointsIn(params).length).toBeLessThanOrEqual(2);
    }
  });

  it("moves the turn breakpoint onto the newest message instead of leaving a trail", async () => {
    const { client, seen } = twoTurnClient([anthropicUsageBlock(10, 5), anthropicUsageBlock(10, 5)]);
    await runLoop(client, { kind: "conversation", ttl: "5m" });
    const second = seen[1]!;
    expect(second.messages.length).toBeGreaterThan(1);
    const annotatedIndexes = second.messages
      .map((m, i) =>
        typeof m.content !== "string" &&
        m.content.some((b) => (b as { cache_control?: unknown }).cache_control)
          ? i
          : -1,
      )
      .filter((i) => i >= 0);
    expect(annotatedIndexes).toEqual([second.messages.length - 1]);
  });

  it("emits no message breakpoint for static-prefix — the history is not asserted stable", async () => {
    const { client, seen } = twoTurnClient([anthropicUsageBlock(10, 5), anthropicUsageBlock(10, 5)]);
    await runLoop(client, { kind: "static-prefix", ttl: "5m" });
    for (const params of seen) {
      expect(breakpointsIn(params).length).toBe(1);
      for (const message of params.messages) {
        if (typeof message.content === "string") continue;
        for (const block of message.content) {
          expect((block as { cache_control?: unknown }).cache_control).toBeUndefined();
        }
      }
    }
  });

  it("sends no cache_control at all without a policy — FR-PC-004", async () => {
    const { client, seen } = twoTurnClient([anthropicUsageBlock(10, 5), anthropicUsageBlock(10, 5)]);
    await runLoop(client, undefined);
    for (const params of seen) {
      expect(breakpointsIn(params)).toEqual([]);
      expect(typeof params.system).toBe("string");
    }
  });

  it("accumulates the cache split across turns — FR-PC-007", async () => {
    const { client } = twoTurnClient([anthropicUsageBlock(10, 5, 500, 0), anthropicUsageBlock(10, 5, 0, 500)]);
    const res = unwrap(await runLoop(client, { kind: "conversation", ttl: "5m" }));
    // Turn 1 wrote 500, turn 2 read 500; each turn also had 10 uncached input.
    expect(res.cacheWriteTokens).toBe(500);
    expect(res.cacheReadTokens).toBe(500);
    expect(res.tokensIn).toBe(1020);
    expect(res.tokensOut).toBe(10);
    expect(uncachedInputTokens(res)).toBe(20);
  });
});

describe("conversation policy — blocks that cannot carry a breakpoint", () => {
  // Anthropic rejects `cache_control` on thinking and redacted_thinking blocks,
  // and the SDK's union encodes that — the compiler surfaced it while this
  // feature was being built. The rolling breakpoint therefore SKIPS annotation
  // when the latest block is one of those, rather than emitting a 400. The same
  // goes for an empty content array, which has no block to annotate at all.
  // `sendWithTools` does not send a `thinking` param today, so this guard is
  // defensive — which is exactly why it needs a test: nothing else would notice
  // if it broke before the day thinking is enabled on the loop.
  const thinkingTurn = (usage: Anthropic.Message["usage"]): Anthropic.Message =>
    ({
      id: "msg_thinking",
      type: "message",
      role: "assistant",
      model: "claude-test",
      stop_reason: "tool_use",
      stop_sequence: null,
      content: [
        { type: "tool_use", id: "call_1", name: "lookup", input: { id: "x" } },
        { type: "thinking", thinking: "still pondering", signature: "sig" },
      ],
      usage,
      container: null,
      context_management: null,
    }) as unknown as Anthropic.Message;

  const emptyTurn = (usage: Anthropic.Message["usage"]): Anthropic.Message =>
    ({
      id: "msg_empty",
      type: "message",
      role: "assistant",
      model: "claude-test",
      stop_reason: "tool_use",
      stop_sequence: null,
      content: [],
      usage,
      container: null,
      context_management: null,
    }) as unknown as Anthropic.Message;

  /** Two turns where the FIRST assistant turn ends with an unannotatable block. */
  const loopEndingWith = (first: Anthropic.Message) => {
    const seen: Anthropic.MessageCreateParams[] = [];
    let turn = 0;
    const create: CreateFn = async (params) => {
      seen.push(structuredClone(params));
      turn += 1;
      return turn === 1
        ? first
        : textResponse('{"answer":"done"}', anthropicUsageBlock(10, 5));
    };
    return { client: new AnthropicLlmClient({ messages: { create } } as never), seen };
  };

  it("omits the turn breakpoint when the newest block is a thinking block", async () => {
    const { client, seen } = loopEndingWith(thinkingTurn(anthropicUsageBlock(10, 5)));
    await runLoop(client, { kind: "conversation", ttl: "5m" });

    // Turn 2 renders the history whose last assistant block is `thinking`.
    const second = seen[1]!;
    for (const message of second.messages) {
      if (typeof message.content === "string") continue;
      for (const block of message.content) {
        if (block.type !== "thinking" && block.type !== "redacted_thinking") continue;
        expect((block as { cache_control?: unknown }).cache_control).toBeUndefined();
      }
    }
    // The system-prefix breakpoint still stands — skipping the turn annotation
    // degrades the plan, it does not abandon it.
    expect(breakpointsIn(second).length).toBeGreaterThanOrEqual(1);
    expect(breakpointsIn(second).length).toBeLessThanOrEqual(2);
  });

  it("never renders a second request at all for an empty assistant turn", async () => {
    // The empty-content arm of the guard is not reachable through this seam:
    // a turn with neither tool calls nor text is a malformed success, so the
    // loop returns a typed error instead of rendering another request. Assert
    // the behaviour that actually occurs rather than contriving a call that
    // cannot happen — the guard remains as defence for a future caller that
    // hands `withTurnBreakpoint` a history the loop did not build.
    const { client, seen } = loopEndingWith(emptyTurn(anthropicUsageBlock(10, 5)));
    const result = await runLoop(client, { kind: "conversation", ttl: "5m" });

    expect(result.ok).toBe(false);
    expect(seen.length).toBe(1);
  });
});
