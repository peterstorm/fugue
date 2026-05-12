import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { z } from "zod";
import { OpenAILlmClient } from "../llm/openai-client.js";
import type { ToolDef } from "../types/llm.js";
import { tool } from "../llm/tools.js";

// ---------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------

type FetchHandler = (url: string, init: RequestInit) => Promise<Response>;

const originalFetch = globalThis.fetch;
let handler: FetchHandler | null = null;
let fetchCalls: Array<{ url: string; init: RequestInit }> = [];

beforeEach(() => {
  fetchCalls = [];
  handler = null;
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    fetchCalls.push({ url: u, init });
    if (!handler) throw new Error("fetch handler not configured");
    return handler(u, init);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const Schema = z.object({ greeting: z.string() });
type SchemaType = z.infer<typeof Schema>;

const makeClient = () => {
  return new OpenAILlmClient({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
  });
};

const jsonResponse = (
  body: Record<string, unknown>,
  status = 200,
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// `sendWithTools` now takes the full `NodeContext` (ADR 0024).
import { makeNodeContext } from "../shared/index.js";
const RUNTIME = makeNodeContext({
  runId: "openai-test-run" as RunId,
  dagId: "openai-test-dag" as DagId,
});

const makeMessageOutput = (text: string) => ({
  type: "message",
  content: [{ type: "output_text", text }],
});

const makeFunctionCallOutput = (
  callId: string,
  name: string,
  args: string,
) => ({
  type: "function_call",
  call_id: callId,
  name,
  arguments: args,
});

// ---------------------------------------------------------------------------
// sendStructured
// ---------------------------------------------------------------------------

describe("OpenAILlmClient.sendStructured", () => {
  it("happy path: parses output_text and returns ok with token usage", async () => {
    handler = async () =>
      jsonResponse({
        output: [makeMessageOutput(JSON.stringify({ greeting: "hi" }))],
        usage: { input_tokens: 11, output_tokens: 22 },
      });

    const result = await makeClient().sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "test-node" as NodeId,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toEqual({ greeting: "hi" });
      expect(result.value.tokensIn).toBe(11);
      expect(result.value.tokensOut).toBe(22);
    }
  });

  // Wave 6 §6.10: 429 maps to `transient`, not `node-crash`. Lets the runner
  // distinguish "retry me" from "permanent failure" without parsing the message.
  it("HTTP 429 → transient with status + body and nodeId", async () => {
    handler = async () => jsonResponse({ error: "rate limit" }, 429);
    const result = await makeClient().sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "n" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      if (result.error.kind === "transient") {
        expect(result.error.nodeId).toBe("n");
        expect(result.error.message).toMatch(/429/);
        expect(result.error.message).toMatch(/rate limit/);
      }
    }
  });

  it("non-429 non-200 → node-crash with status + body and nodeId", async () => {
    handler = async () => jsonResponse({ error: "internal" }, 500);
    const result = await makeClient().sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "n" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.nodeId).toBe("n");
        expect(result.error.message).toMatch(/500/);
      }
    }
  });

  it("AbortError → aborted", async () => {
    handler = async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    };
    const result = await makeClient().sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "test-node" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("aborted");
    }
  });

  it("missing output_text → node-crash with nodeId", async () => {
    handler = async () => jsonResponse({ output: [], usage: {} });
    const result = await makeClient().sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "missing" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.nodeId).toBe("missing");
    }
  });

  // Wave 7 §7.4 — typed traversal regression: unknown output item types
  // (e.g. a future Responses API variant we don't recognize yet) are
  // gracefully ignored by the structural guards; the search continues past
  // them to find the real message block. Pre-§7.4 the `any` traversal would
  // have accepted `block.content` on an unknown item, producing `undefined`
  // dereferences masked as "missing output_text" errors.
  it("unknown output item type is ignored; message block still found", async () => {
    handler = async () =>
      jsonResponse({
        output: [
          { type: "unrecognized_future_variant", payload: { foo: 42 } },
          makeMessageOutput(JSON.stringify({ greeting: "hi" })),
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    const result = await makeClient().sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "test-node" as NodeId,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output.greeting).toBe("hi");
    }
  });

  // Wave 7 §7.4 — typed traversal regression: a message block with a
  // wrong-typed `content` field (string instead of array) is rejected by
  // `isMessageBlock`; the search falls through and produces the same
  // "missing output_text" path as a genuinely empty response. Documents
  // the guard's structural strictness.
  it("malformed message block (content: not array) is skipped by the guard", async () => {
    handler = async () =>
      jsonResponse({
        output: [{ type: "message", content: "definitely not an array" }],
        usage: {},
      });
    const result = await makeClient().sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "malformed" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.nodeId).toBe("malformed");
      expect(result.error.message).toMatch(/no text output/);
    }
  });

  it("non-JSON output → node-crash", async () => {
    handler = async () =>
      jsonResponse({
        output: [makeMessageOutput("not json at all")],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    const result = await makeClient().sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "test-node" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.message).toMatch(/not valid JSON/);
    }
  });

  it("schema validation failure → node-crash with nodeId", async () => {
    handler = async () =>
      jsonResponse({
        output: [makeMessageOutput(JSON.stringify({ wrong: "shape" }))],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    const result = await makeClient().sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "schema-node" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.nodeId).toBe("schema-node");
      expect(result.error.message).toMatch(/Schema validation failed/);
    }
  });

  it("text.format is wired as json_schema with strict=true", async () => {
    handler = async () =>
      jsonResponse({
        output: [makeMessageOutput(JSON.stringify({ greeting: "x" }))],
        usage: {},
      });
    await makeClient().sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "test-node" as NodeId,
    });
    const body = JSON.parse(fetchCalls[0].init.body as string);
    expect(body.text.format.type).toBe("json_schema");
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.name).toBe("structured_output");
  });
});

// ---------------------------------------------------------------------------
// sendWithTools
// ---------------------------------------------------------------------------

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

describe("OpenAILlmClient.sendWithTools", () => {
  it("pre-aborted signal → aborted", async () => {
    handler = async () => jsonResponse({ output: [] });
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await makeClient().sendWithTools<SchemaType>(
      {
        system: "s",
        user: "u",
        model: "gpt-test",
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

  it("multi-turn tool dispatch loop produces final answer", async () => {
    let turn = 0;
    handler = async () => {
      turn++;
      if (turn === 1) {
        return jsonResponse({
          output: [makeFunctionCallOutput("c1", "lookup", JSON.stringify({ id: "abc" }))],
          usage: { input_tokens: 5, output_tokens: 5 },
        });
      }
      return jsonResponse({
        output: [makeMessageOutput(JSON.stringify({ greeting: "after-tool" }))],
        usage: { input_tokens: 7, output_tokens: 7 },
      });
    };

    let toolRan = 0;
    const tool = makeTool("lookup", async () => {
      toolRan++;
      return { found: true };
    });

    const result = await makeClient().sendWithTools<SchemaType>(
      {
        system: "s",
        user: "u",
        model: "gpt-test",
        tools: [tool],
        schema: Schema,
        nodeId: "multi" as NodeId,
      },
      RUNTIME,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toEqual({ greeting: "after-tool" });
      // Tokens accumulated across both turns.
      expect(result.value.tokensIn).toBe(12);
      expect(result.value.tokensOut).toBe(12);
    }
    expect(toolRan).toBe(1);
    expect(turn).toBe(2);
  });

  it("iteration cap exhausted → node-crash retriable:false with nodeId", async () => {
    handler = async () =>
      jsonResponse({
        output: [makeFunctionCallOutput("c", "looper", JSON.stringify({ id: "x" }))],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    const tool = makeTool("looper", async () => ({ found: true }));

    const result = await makeClient().sendWithTools<SchemaType>(
      {
        system: "s",
        user: "u",
        model: "gpt-test",
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
        expect(result.error.nodeId).toBe("loop-node");
        expect(result.error.retriability).toBe("non-retriable");
      }
    }
  });

  it("AbortError mid-call → aborted", async () => {
    handler = async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    };
    const result = await makeClient().sendWithTools<SchemaType>(
      {
        system: "s",
        user: "u",
        model: "gpt-test",
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

  // Wave 6 §6.10: HTTP 429 mid-tool-loop → transient
  it("HTTP 429 inside sendWithTools → transient", async () => {
    handler = async () => jsonResponse({ error: "rate limit" }, 429);
    const result = await makeClient().sendWithTools<SchemaType>(
      {
        system: "s",
        user: "u",
        model: "gpt-test",
        tools: [],
        schema: Schema,
        nodeId: "rl" as NodeId,
      },
      RUNTIME,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      if (result.error.kind === "transient") {
        expect(result.error.nodeId).toBe("rl");
        expect(result.error.message).toMatch(/429/);
      }
    }
  });
});
