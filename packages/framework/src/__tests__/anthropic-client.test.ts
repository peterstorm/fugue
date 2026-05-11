import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { APIUserAbortError } from "@anthropic-ai/sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicLlmClient } from "../llm/anthropic-client.js";
import type { ToolDef } from "../llm/tools.js";

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
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toEqual({ greeting: "hi" });
      expect(result.value.tokensIn).toBe(12);
      expect(result.value.tokensOut).toBe(7);
      expect(result.value.rawText).toBe(JSON.stringify({ greeting: "hi" }));
    }
  });

  it("missing tool_use block → node-crash with nodeId", async () => {
    const client = new AnthropicLlmClient(makeStub(async () => makeTextResponse("just text")));
    const result = await client.sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "claude-test",
      schema: Schema,
      nodeId: "my-node",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.nodeId).toBe("my-node");
      }
    }
  });

  it("nodeId defaults to '<llm>' when req.nodeId is omitted", async () => {
    const client = new AnthropicLlmClient(makeStub(async () => makeTextResponse("just text")));
    const result = await client.sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "claude-test",
      schema: Schema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.nodeId).toBe("<llm>");
    }
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
      nodeId: "schema-node",
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.nodeId).toBe("schema-node");
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
      nodeId: "n",
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.nodeId).toBe("n");
      expect(result.error.message).toMatch(/network down/);
      expect(result.error.stack).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// sendWithTools
// ---------------------------------------------------------------------------

const RUNTIME = { tracer: null, signal: undefined } as const;

const makeTool = (
  name: string,
  run: (input: { id: string }) => Promise<{ found: boolean }>,
): ToolDef<unknown, unknown> => ({
  name,
  description: "test tool",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ found: z.boolean() }),
  run: run as unknown as ToolDef<unknown, unknown>["run"],
});

describe("AnthropicLlmClient.sendWithTools", () => {
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
      },
      RUNTIME,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toEqual({ greeting: "hello" });
    }
  });

  it("iteration cap exhausted → transient with nodeId", async () => {
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
        nodeId: "loop-node",
      },
      RUNTIME,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      if (result.error.kind === "transient") {
        expect(result.error.nodeId).toBe("loop-node");
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
        nodeId: "multi",
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
        nodeId: "rate-limited-node",
      },
      RUNTIME,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      if (result.error.kind === "transient") {
        expect(result.error.nodeId).toBe("rate-limited-node");
        expect(result.error.message).toMatch(/429|rate_limit/);
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
        nodeId: "n",
      },
      RUNTIME,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
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
      nodeId: "rl-node",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      if (result.error.kind === "transient") {
        expect(result.error.nodeId).toBe("rl-node");
      }
    }
  });
});
