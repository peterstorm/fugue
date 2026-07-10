import { describe, it, expect } from "bun:test";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { z } from "zod";
import { APIUserAbortError } from "@anthropic-ai/sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicLlmClient } from "../llm/anthropic-client.js";
import type { ToolDef } from "../types/llm.js";
import { tool } from "../llm/tools.js";
import { N, R, D, nodeMap, nodeSet } from "./_id-helpers.js";

// ---------------------------------------------------------------------------
// Anthropic SDK stub
// ---------------------------------------------------------------------------

type CreateFn = (params: Anthropic.MessageCreateParams, opts?: { signal?: AbortSignal }) => Promise<Anthropic.Message>;

const makeStub = (create: CreateFn) =>
  ({ messages: { create } }) as unknown as Anthropic;

const baseUsage = (input = 100, output = 50) =>
  ({
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    server_tool_use: null,
    service_tier: null,
  }) as unknown as Anthropic.Message["usage"];

const makeToolUseResponse = (
  input: Record<string, unknown>,
  inputTokens = 100,
  outputTokens = 50,
): Anthropic.Message =>
  ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-test",
    stop_reason: "tool_use",
    stop_sequence: null,
    content: [
      {
        type: "tool_use",
        id: "tool_1",
        name: "structured_output",
        input,
      } as Anthropic.ToolUseBlock,
    ],
    usage: baseUsage(inputTokens, outputTokens),
    container: null,
    context_management: null,
  }) as unknown as Anthropic.Message;

const makeTextResponse = (text: string): Anthropic.Message =>
  ({
    id: "msg_text",
    type: "message",
    role: "assistant",
    model: "claude-test",
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [{ type: "text", text, citations: null } as Anthropic.TextBlock],
    usage: baseUsage(),
    container: null,
    context_management: null,
  }) as unknown as Anthropic.Message;

const makeToolUseInWithToolsResponse = (
  toolName: string,
  toolInput: Record<string, unknown>,
): Anthropic.Message =>
  ({
    id: "msg_with_tool",
    type: "message",
    role: "assistant",
    model: "claude-test",
    stop_reason: "tool_use",
    stop_sequence: null,
    content: [
      {
        type: "tool_use",
        id: "tu1",
        name: toolName,
        input: toolInput,
      } as Anthropic.ToolUseBlock,
    ],
    usage: baseUsage(20, 10),
    container: null,
    context_management: null,
  }) as unknown as Anthropic.Message;

const Schema = z.object({ greeting: z.string() });
type SchemaType = z.infer<typeof Schema>;

// ---------------------------------------------------------------------------
// sendStructured
// ---------------------------------------------------------------------------

describe("AnthropicLlmClient.sendStructured", () => {
  it("parses tool_use input against the Zod schema and returns ok with token usage", async () => {
    const client = new AnthropicLlmClient(
      makeStub(async () => makeToolUseResponse({ greeting: "hi" }, 12, 7)),
    );

    const result = await client.sendStructured<SchemaType>({
      system: "system",
      user: "user",
      model: "claude-test",
      schema: Schema,
      nodeId: "test-node" as NodeId,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toEqual({ greeting: "hi" });
      expect(result.value.tokensIn).toBe(12);
      expect(result.value.tokensOut).toBe(7);
      expect(result.value.rawText).toBe(JSON.stringify({ greeting: "hi" }));
    }
  });

  it("threads req.temperature into MessageCreateParams, and omits it when absent", async () => {
    const seen: Anthropic.MessageCreateParams[] = [];
    const client = new AnthropicLlmClient(
      makeStub(async (params) => {
        seen.push(params);
        return makeToolUseResponse({ greeting: "hi" });
      }),
    );

    const base = {
      system: "s",
      user: "u",
      model: "claude-test",
      schema: Schema,
      nodeId: "test-node" as NodeId,
    };
    // A pinned temperature reaches the wire (compose pins 0 for determinism)…
    await client.sendStructured<SchemaType>({ ...base, temperature: 0 });
    expect(seen[0]?.temperature).toBe(0);
    // …and an absent temperature stays ABSENT (provider default) — never a
    // fabricated value.
    await client.sendStructured<SchemaType>(base);
    expect("temperature" in (seen[1] ?? {})).toBe(false);
  });

  it("missing tool_use block → RETRIABLE node-crash naming the stop_reason", async () => {
    const client = new AnthropicLlmClient(makeStub(async () => makeTextResponse("just text")));
    const result = await client.sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "claude-test",
      schema: Schema,
      nodeId: "my-node" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.nodeId).toBe(N("my-node"));
        // The stop_reason is the primary diagnostic for a tool_use-less
        // response — the message must carry it.
        expect(result.error.message).toContain("stop_reason: end_turn");
        expect(result.error.retriability).toBe("retriable");
      }
    }
  });

  it("stop_reason max_tokens (truncation) → NON-retriable on both the missing-tool_use and schema-failure arms", async () => {
    // A max_tokens stop means the output was truncated at the fixed cap —
    // retrying the identical request hits the identical cap, so spending the
    // retry budget on it is pure waste.
    const truncatedText = {
      ...makeTextResponse("partial"),
      stop_reason: "max_tokens",
    } as Anthropic.Message;
    const missingToolUse = new AnthropicLlmClient(makeStub(async () => truncatedText));
    const r1 = await missingToolUse.sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "claude-test",
      schema: Schema,
      nodeId: "trunc-1" as NodeId,
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      // Hard assertion (not a soft guard) — a reclassified arm must FAIL
      // here, never pass vacuously by skipping the narrowed block.
      expect(r1.error.kind).toBe("node-crash");
      if (r1.error.kind === "node-crash") {
        expect(r1.error.retriability).toBe("non-retriable");
        expect(r1.error.message).toContain("stop_reason: max_tokens");
      }
    }

    // Truncated tool input that no longer parses against the schema.
    const truncatedToolUse = {
      ...makeToolUseResponse({ wrong: "shape" }),
      stop_reason: "max_tokens",
    } as Anthropic.Message;
    const schemaFails = new AnthropicLlmClient(makeStub(async () => truncatedToolUse));
    const r2 = await schemaFails.sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "claude-test",
      schema: Schema,
      nodeId: "trunc-2" as NodeId,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error.kind).toBe("node-crash");
      if (r2.error.kind === "node-crash") {
        expect(r2.error.retriability).toBe("non-retriable");
        expect(r2.error.message).toContain("stop_reason: max_tokens");
      }
    }
  });

  it("stop_reason refusal → NON-retriable node-crash (sendStructured)", async () => {
    const refused = {
      ...makeTextResponse(""),
      content: [],
      stop_reason: "refusal",
    } as unknown as Anthropic.Message;
    const client = new AnthropicLlmClient(makeStub(async () => refused));
    const result = await client.sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "claude-test",
      schema: Schema,
      nodeId: "refuse-struct" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("non-retriable");
        expect(result.error.message).toContain("stop_reason: refusal");
      }
    }
  });

  it("out-of-range/non-finite temperature → typed validation error before any request is sent", async () => {
    let calls = 0;
    const client = new AnthropicLlmClient(
      makeStub(async () => {
        calls++;
        return makeToolUseResponse({ greeting: "hi" });
      }),
    );
    for (const temperature of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.5]) {
      const result = await client.sendStructured<SchemaType>({
        system: "s",
        user: "u",
        model: "claude-test",
        schema: Schema,
        nodeId: "temp-node" as NodeId,
        temperature,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("validation");
        if (result.error.kind === "validation") {
          expect(result.error.nodeId).toBe(N("temp-node"));
          expect(result.error.message).toMatch(/temperature/);
        }
      }
    }
    // The boundary values of the documented [0, 1] range are legal.
    for (const temperature of [0, 1]) {
      const result = await client.sendStructured<SchemaType>({
        system: "s",
        user: "u",
        model: "claude-test",
        schema: Schema,
        nodeId: "temp-node" as NodeId,
        temperature,
      });
      expect(result.ok).toBe(true);
    }
    // None of the rejected requests reached the wire.
    expect(calls).toBe(2);
  });

  it("a throwing schema construction stays inside the Result boundary as a typed validation error", async () => {
    // zodToJsonSchema over a non-schema throws — the pre-flight wrap must
    // convert that into a typed validation error, never an escaped exception,
    // and nothing may reach the wire (mirrors the sendWithTools pin below).
    let calls = 0;
    const client = new AnthropicLlmClient(
      makeStub(async () => {
        calls++;
        return makeToolUseResponse({ greeting: "hi" });
      }),
    );
    const result = await client.sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "claude-test",
      schema: {} as unknown as z.ZodType<SchemaType>,
      nodeId: "bad-schema" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      if (result.error.kind === "validation") {
        expect(result.error.nodeId).toBe(N("bad-schema"));
        expect(result.error.message).toMatch(/Schema construction failed/);
      }
    }
    expect(calls).toBe(0);
  });

  it("schema validation failure → node-crash with nodeId", async () => {
    const client = new AnthropicLlmClient(
      makeStub(async () => makeToolUseResponse({ wrong: "shape" })),
    );
    const result = await client.sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "claude-test",
      schema: Schema,
      nodeId: "schema-node" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.nodeId).toBe(N("schema-node"));
      expect(result.error.message).toMatch(/Schema validation failed/);
    }
  });

  it("APIUserAbortError → aborted", async () => {
    const client = new AnthropicLlmClient(
      makeStub(async () => {
        throw new APIUserAbortError();
      }),
    );
    const result = await client.sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "claude-test",
      schema: Schema,
      nodeId: "test-node" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("aborted");
    }
  });

  it("AbortError → aborted", async () => {
    const client = new AnthropicLlmClient(
      makeStub(async () => {
        const e = new Error("aborted by user");
        e.name = "AbortError";
        throw e;
      }),
    );
    const result = await client.sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "claude-test",
      schema: Schema,
      nodeId: "test-node" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("aborted");
    }
  });

  it("generic error → node-crash with nodeId and stack", async () => {
    const client = new AnthropicLlmClient(
      makeStub(async () => {
        throw new Error("network down");
      }),
    );
    const result = await client.sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "claude-test",
      schema: Schema,
      nodeId: "n" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.nodeId).toBe(N("n"));
      expect(result.error.message).toMatch(/network down/);
      expect(result.error.stack).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// sendWithTools
// ---------------------------------------------------------------------------

// `sendWithTools` now takes the full `NodeContext` (ADR 0024). Use the
// framework's sanctioned constructor so tests can't accidentally pass a
// stub that no longer satisfies the contract.
import { makeNodeContext } from "../shared/index.js";
import { stubLlmClient } from "./_llm-mocks.js";
const RUNTIME = makeNodeContext({
  runId: "anthropic-test-run" as RunId,
  dagId: "anthropic-test-dag" as DagId,
  llm: stubLlmClient,
});

const makeTool = (
  name: string,
  run: (input: { id: string }) => Promise<{ found: boolean }>,
): ToolDef<unknown, unknown> => tool({
  name,
  description: "test tool",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ found: z.boolean() }),
  run: run as unknown as ToolDef<unknown, unknown>["run"],
}) as ToolDef<unknown, unknown>;

describe("AnthropicLlmClient.sendWithTools", () => {
  it("a throwing schema construction stays inside the Result boundary as a typed validation error", async () => {
    // zodToJsonSchema over a non-schema throws — the pre-flight wrap must
    // convert that into a typed validation error, never an escaped exception,
    // and nothing may reach the wire.
    let calls = 0;
    const client = new AnthropicLlmClient(
      makeStub(async () => {
        calls++;
        return makeTextResponse(`{"greeting":"x"}`);
      }),
    );
    const result = await client.sendWithTools<SchemaType>(
      {
        system: "s",
        user: "u",
        model: "claude-test",
        tools: [],
        schema: {} as unknown as z.ZodType<SchemaType>,
        nodeId: "bad-schema" as NodeId,
      },
      RUNTIME,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      if (result.error.kind === "validation") {
        expect(result.error.nodeId).toBe(N("bad-schema"));
        expect(result.error.message).toMatch(/Schema construction failed/);
      }
    }
    expect(calls).toBe(0);
  });

  it("pre-aborted signal returns aborted", async () => {
    const client = new AnthropicLlmClient(
      makeStub(async () => makeTextResponse(`{"greeting":"x"}`)),
    );
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await client.sendWithTools<SchemaType>(
      {
        system: "s",
        user: "u",
        model: "claude-test",
        tools: [],
        schema: Schema,
        nodeId: "test-node" as NodeId,
        signal: ctrl.signal,
      },
      RUNTIME,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("aborted");
    }
  });

  it("single text-only turn parses JSON and returns ok", async () => {
    const client = new AnthropicLlmClient(
      makeStub(async () => makeTextResponse(`\`\`\`json\n{"greeting":"hello"}\n\`\`\``)),
    );
    const result = await client.sendWithTools<SchemaType>(
      {
        system: "s",
        user: "u",
        model: "claude-test",
        tools: [],
        schema: Schema,
        nodeId: "test-node" as NodeId,
      },
      RUNTIME,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toEqual({ greeting: "hello" });
    }
  });

  it("iteration cap exhausted → node-crash retriable:false with nodeId", async () => {
    const client = new AnthropicLlmClient(
      makeStub(async () => makeToolUseInWithToolsResponse("looper", { id: "x" })),
    );
    const tool = makeTool("looper", async () => ({ found: true }));

    const result = await client.sendWithTools<SchemaType>(
      {
        system: "s",
        user: "u",
        model: "claude-test",
        tools: [tool],
        schema: Schema,
        maxIterations: 2,
        nodeId: "loop-node" as NodeId,
      },
      RUNTIME,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.nodeId).toBe(N("loop-node"));
        expect(result.error.retriability).toBe("non-retriable");
      }
    }
  });

  it("multi-turn: tool_use then end_turn final answer", async () => {
    let turn = 0;
    const client = new AnthropicLlmClient(
      makeStub(async () => {
        turn++;
        if (turn === 1) {
          return makeToolUseInWithToolsResponse("lookup", { id: "abc" });
        }
        return makeTextResponse(`{"greeting":"after-tool"}`);
      }),
    );

    let toolRan = 0;
    const tool = makeTool("lookup", async () => {
      toolRan++;
      return { found: true };
    });

    const result = await client.sendWithTools<SchemaType>(
      {
        system: "s",
        user: "u",
        model: "claude-test",
        tools: [tool],
        schema: Schema,
        nodeId: "multi" as NodeId,
      },
      RUNTIME,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toEqual({ greeting: "after-tool" });
    }
    expect(toolRan).toBe(1);
    expect(turn).toBe(2);
  });

  it("APIUserAbortError mid-loop → aborted", async () => {
    const client = new AnthropicLlmClient(
      makeStub(async () => {
        throw new APIUserAbortError();
      }),
    );
    const result = await client.sendWithTools<SchemaType>(
      {
        system: "s",
        user: "u",
        model: "claude-test",
        tools: [],
        schema: Schema,
        nodeId: "test-node" as NodeId,
      },
      RUNTIME,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("aborted");
    }
  });

  // Wave 6 §6.10: SDK throw with status === 429 → transient
  it("SDK throws RateLimitError-shaped error → transient", async () => {
    const rateLimitError = Object.assign(new Error("rate_limit_error: 429"), { status: 429 });
    const client = new AnthropicLlmClient(
      makeStub(async () => { throw rateLimitError; }),
    );
    const tool = makeTool("lookup", async () => ({ found: true }));

    const result = await client.sendWithTools<SchemaType>(
      {
        system: "s",
        user: "u",
        model: "claude-test",
        tools: [tool],
        schema: Schema,
        nodeId: "rate-limited-node" as NodeId,
      },
      RUNTIME,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      if (result.error.kind === "transient") {
        expect(result.error.nodeId).toBe(N("rate-limited-node"));
        expect(result.error.message).toMatch(/429|rate_limit/);
      }
    }
  });

  it("stop_reason max_tokens (truncation) → NON-retriable node-crash carrying the turn's usage", async () => {
    // A max_tokens stop means this turn's output was truncated at the fixed
    // cap — the tool calls / final answer are unreliable, and retrying the
    // identical request hits the identical cap (mirrors sendStructured).
    const truncated = {
      ...makeTextResponse("partial"),
      stop_reason: "max_tokens",
    } as Anthropic.Message;
    const client = new AnthropicLlmClient(makeStub(async () => truncated));
    const result = await client.sendWithTools<SchemaType>(
      {
        system: "s",
        user: "u",
        model: "claude-test",
        tools: [],
        schema: Schema,
        nodeId: "trunc-tools" as NodeId,
      },
      RUNTIME,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("non-retriable");
        expect(result.error.message).toContain("stop_reason: max_tokens");
        // The truncated turn still burned tokens — they must be attributed.
        expect(result.error.usage).toEqual({ tokensIn: 100, tokensOut: 50 });
      }
    }
  });

  it("stop_reason refusal → NON-retriable node-crash naming the stop_reason, carrying usage", async () => {
    // A refusal has no tool_use and no text; without an explicit arm it falls
    // through to the loop's context-free "no text content to parse" retriable
    // arm. Retrying a deterministic refusal is pure waste.
    const refused = {
      ...makeTextResponse(""),
      content: [],
      stop_reason: "refusal",
    } as unknown as Anthropic.Message;
    const client = new AnthropicLlmClient(makeStub(async () => refused));
    const result = await client.sendWithTools<SchemaType>(
      { system: "s", user: "u", model: "claude-test", tools: [], schema: Schema, nodeId: "refuse-tools" as NodeId },
      RUNTIME,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("non-retriable");
        expect(result.error.message).toContain("stop_reason: refusal");
        expect(result.error.usage).toEqual({ tokensIn: 100, tokensOut: 50 });
      }
    }
  });

  it("SDK throws non-rate-limit error → node-crash (regression for §6.10)", async () => {
    const client = new AnthropicLlmClient(
      makeStub(async () => { throw new Error("connection refused"); }),
    );
    const tool = makeTool("lookup", async () => ({ found: true }));

    const result = await client.sendWithTools<SchemaType>(
      {
        system: "s",
        user: "u",
        model: "claude-test",
        tools: [tool],
        schema: Schema,
        nodeId: "n" as NodeId,
      },
      RUNTIME,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
    }
  });
});

// Round 15: non-429 4xx (401/400/…) is a deterministic client error — the
// duck-typed status path in classifyLlmError must mark it NON-retriable
// (same policy as OpenAI's httpFailureToError; previously it fell through
// as a retriable generic crash, silently burning the retry budget).
describe("AnthropicLlmClient — non-429 4xx mapping (sendStructured)", () => {
  it("SDK throws status=401 → node-crash NON-retriable", async () => {
    const authError = Object.assign(new Error("authentication_error: invalid x-api-key"), {
      status: 401,
    });
    const client = new AnthropicLlmClient(
      makeStub(async () => { throw authError; }),
    );
    const result = await client.sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "claude-test",
      schema: Schema,
      nodeId: "auth-node" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.nodeId).toBe(N("auth-node"));
        expect(result.error.retriability).toBe("non-retriable");
        expect(result.error.message).toContain("authentication_error");
      }
    }
  });
});

// Wave 6 §6.10: sendStructured path also maps 429 → transient.
describe("AnthropicLlmClient — 429 mapping (sendStructured)", () => {
  it("SDK throws status=429 → transient", async () => {
    const rateLimitError = Object.assign(new Error("rate_limit_error: 429"), { status: 429 });
    const client = new AnthropicLlmClient(
      makeStub(async () => { throw rateLimitError; }),
    );
    const result = await client.sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "claude-test",
      schema: Schema,
      nodeId: "rl-node" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      if (result.error.kind === "transient") {
        expect(result.error.nodeId).toBe(N("rl-node"));
      }
    }
  });
});
