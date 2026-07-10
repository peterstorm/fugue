import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { z } from "zod";
import { OpenAILlmClient } from "../llm/openai-client.js";
import type { ToolDef } from "../types/llm.js";
import { tool } from "../llm/tools.js";
import { N, R, D, nodeMap, nodeSet } from "./_id-helpers.js";

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
import { stubLlmClient } from "./_llm-mocks.js";
const RUNTIME = makeNodeContext({
  runId: "openai-test-run" as RunId,
  dagId: "openai-test-dag" as DagId,
  llm: stubLlmClient,
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

  it("rewrites body.model to modelOverride when set (Azure single-deployment routing)", async () => {
    handler = async () =>
      jsonResponse({
        output: [makeMessageOutput(JSON.stringify({ greeting: "hi" }))],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    const client = new OpenAILlmClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      modelOverride: "azure-deployment-x",
    });

    await client.sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "test-node" as NodeId,
    });

    // The Azure override must win over the per-request model in the wire body —
    // silently sending the wrong model is a billing/routing regression.
    const sentBody = JSON.parse(fetchCalls[0]!.init.body as string);
    expect(sentBody.model).toBe("azure-deployment-x");
  });

  it("sends req.model verbatim when no modelOverride is configured", async () => {
    handler = async () =>
      jsonResponse({
        output: [makeMessageOutput(JSON.stringify({ greeting: "hi" }))],
        usage: { input_tokens: 1, output_tokens: 1 },
      });

    await makeClient().sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "test-node" as NodeId,
    });

    const sentBody = JSON.parse(fetchCalls[0]!.init.body as string);
    expect(sentBody.model).toBe("gpt-test");
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
        expect(result.error.nodeId).toBe(N("n"));
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
        expect(result.error.nodeId).toBe(N("n"));
        expect(result.error.message).toMatch(/500/);
        // 5xx is server-side — the retry budget MAY be spent on it.
        expect(result.error.retriability).toBe("retriable");
      }
    }
  });

  it("non-429 4xx → node-crash NON-retriable (deterministic client error, retrying burns budget)", async () => {
    for (const status of [400, 401, 422]) {
      handler = async () => jsonResponse({ error: "client error" }, status);
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
          expect(result.error.retriability).toBe("non-retriable");
          expect(result.error.message).toMatch(new RegExp(String(status)));
        }
      }
    }
  });

  it("a throwing schema construction stays inside the Result boundary as a typed validation error", async () => {
    // buildJsonSchema over a non-schema throws — the pre-flight wrap must
    // convert that into a typed validation error, never an escaped exception,
    // and nothing may reach the wire (mirrors the sendWithTools pin below).
    handler = async () => jsonResponse({ output: [] });
    const result = await makeClient().sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
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
    expect(fetchCalls).toHaveLength(0);
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

  it("missing output_text → node-crash with nodeId, snapshotting status + body", async () => {
    handler = async () => jsonResponse({ output: [], usage: {}, status: "incomplete" });
    const result = await makeClient().sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "missing" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Hard assertion (not a soft guard) — a reclassified arm must FAIL
      // here, never pass vacuously by skipping the narrowed block.
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.nodeId).toBe(N("missing"));
        // A malformed 200 must be debuggable from this error alone: the
        // response's own status and a truncated body snapshot ride along.
        expect(result.error.message).toContain("response.status: incomplete");
        expect(result.error.message).toContain('"output":[]');
        // status incomplete = truncation — deterministic, non-retriable.
        expect(result.error.retriability).toBe("non-retriable");
      }
    }
  });

  it("response.status failed → node-crash carrying error.code/message, retriability from the code (sendStructured)", async () => {
    handler = async () =>
      jsonResponse({
        output: [],
        usage: { input_tokens: 3, output_tokens: 0 },
        status: "failed",
        error: { code: "invalid_prompt", message: "prompt was rejected" },
      });
    const result = await makeClient().sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "failed-struct" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("non-retriable");
        expect(result.error.message).toContain("response.status: failed");
        expect(result.error.message).toContain("error.code: invalid_prompt");
        expect(result.error.message).toContain("prompt was rejected");
      }
    }
  });

  it("response.status failed with rate_limit_exceeded → transient (sendStructured)", async () => {
    handler = async () =>
      jsonResponse({
        output: [],
        usage: {},
        status: "failed",
        error: { code: "rate_limit_exceeded", message: "slow down" },
      });
    const result = await makeClient().sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "failed-rl" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
    }
  });

  it("response.status incomplete (truncation) → NON-retriable on the JSON-parse and schema-failure arms", async () => {
    // Truncated output that is no longer valid JSON.
    handler = async () =>
      jsonResponse({
        output: [makeMessageOutput('{"greeting": "cut off')],
        usage: { input_tokens: 1, output_tokens: 1 },
        status: "incomplete",
      });
    const r1 = await makeClient().sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "trunc-json" as NodeId,
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.error.kind).toBe("node-crash");
      if (r1.error.kind === "node-crash") {
        expect(r1.error.retriability).toBe("non-retriable");
        expect(r1.error.message).toContain("response.status: incomplete");
      }
    }

    // Truncated output that parses but no longer matches the schema.
    handler = async () =>
      jsonResponse({
        output: [makeMessageOutput(JSON.stringify({ wrong: "shape" }))],
        usage: { input_tokens: 1, output_tokens: 1 },
        status: "incomplete",
      });
    const r2 = await makeClient().sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "trunc-schema" as NodeId,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error.kind).toBe("node-crash");
      if (r2.error.kind === "node-crash") {
        expect(r2.error.retriability).toBe("non-retriable");
        expect(r2.error.message).toContain("response.status: incomplete");
      }
    }
  });

  it("HTTP 200 with a non-JSON body → node-crash carrying HTTP 200 + the body snapshot", async () => {
    // A proxy interstitial / HTML error page on a 200 must not escape as a
    // raw SyntaxError from `.json()` — it takes the same hardened
    // malformed-success arm as any other HTTP failure.
    handler = async () =>
      new Response("<html>gateway maintenance</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    const result = await makeClient().sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "non-json-200" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.nodeId).toBe(N("non-json-200"));
        expect(result.error.message).toContain("HTTP 200");
        expect(result.error.message).toContain("gateway maintenance");
        expect(result.error.retriability).toBe("retriable");
      }
    }
  });

  it("out-of-range/non-finite temperature → typed validation error before any request is sent", async () => {
    handler = async () =>
      jsonResponse({
        output: [makeMessageOutput(JSON.stringify({ greeting: "hi" }))],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    for (const temperature of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.5]) {
      const result = await makeClient().sendStructured<SchemaType>({
        system: "s",
        user: "u",
        model: "gpt-test",
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
    // None of the rejected requests reached the wire…
    expect(fetchCalls).toHaveLength(0);
    // …while the boundary values of the documented [0, 1] range are legal.
    for (const temperature of [0, 1]) {
      const result = await makeClient().sendStructured<SchemaType>({
        system: "s",
        user: "u",
        model: "gpt-test",
        schema: Schema,
        nodeId: "temp-node" as NodeId,
        temperature,
      });
      expect(result.ok).toBe(true);
    }
    expect(fetchCalls).toHaveLength(2);
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
      expect(result.error.nodeId).toBe(N("malformed"));
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
      expect(result.error.message).toMatch(/Not valid JSON/);
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
      expect(result.error.nodeId).toBe(N("schema-node"));
      expect(result.error.message).toMatch(/Schema validation failed/);
    }
  });

  it("threads req.temperature into the wire body, and omits it when absent", async () => {
    handler = async () =>
      jsonResponse({
        output: [makeMessageOutput(JSON.stringify({ greeting: "hi" }))],
        usage: { input_tokens: 1, output_tokens: 1 },
      });

    const base = {
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "test-node" as NodeId,
    };
    // A pinned temperature reaches the wire (compose pins 0 for determinism)…
    await makeClient().sendStructured<SchemaType>({ ...base, temperature: 0 });
    const first = JSON.parse(fetchCalls[0]!.init.body as string);
    expect(first.temperature).toBe(0);
    // …and an absent temperature stays ABSENT (provider default) — never a
    // fabricated value.
    await makeClient().sendStructured<SchemaType>(base);
    const second = JSON.parse(fetchCalls[1]!.init.body as string);
    expect("temperature" in second).toBe(false);
  });

  it("thinking + temperature → typed validation error before any request is sent", async () => {
    // Reasoning models reject `temperature` alongside `reasoning` with an
    // opaque HTTP 400 — the illegal combination is caught at the seam as a
    // validation FrameworkError (never silently dropped, never a node-crash).
    handler = async () => {
      throw new Error("should never reach the wire");
    };
    const result = await makeClient().sendStructured<SchemaType>({
      system: "s",
      user: "u",
      model: "gpt-test",
      schema: Schema,
      nodeId: "reasoning-node" as NodeId,
      thinking: { type: "enabled", budgetTokens: 1024 },
      temperature: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      if (result.error.kind === "validation") {
        expect(result.error.nodeId).toBe(N("reasoning-node"));
        expect(result.error.message).toMatch(/temperature/);
        expect(result.error.message).toMatch(/thinking/);
      }
    }
    // The request never left the process.
    expect(fetchCalls).toHaveLength(0);
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
  it("a throwing schema construction stays inside the Result boundary as a typed validation error", async () => {
    // zodToJsonSchema over a non-schema throws — the pre-flight wrap must
    // convert that into a typed validation error, never an escaped exception,
    // and nothing may reach the wire.
    handler = async () => jsonResponse({ output: [] });
    const result = await makeClient().sendWithTools<SchemaType>(
      {
        system: "s",
        user: "u",
        model: "gpt-test",
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
    expect(fetchCalls).toHaveLength(0);
  });

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

  it("non-429 4xx → node-crash NON-retriable (sendWithTools arm)", async () => {
    handler = async () => jsonResponse({ error: "bad request" }, 400);
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
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("non-retriable");
        expect(result.error.message).toMatch(/400/);
      }
    }
  });

  it("response.status failed → node-crash carrying error.code/message + usage (sendWithTools)", async () => {
    handler = async () =>
      jsonResponse({
        output: [],
        usage: { input_tokens: 7, output_tokens: 2 },
        status: "failed",
        error: { code: "invalid_prompt", message: "prompt was rejected" },
      });
    const result = await makeClient().sendWithTools<SchemaType>(
      {
        system: "s",
        user: "u",
        model: "gpt-test",
        tools: [],
        schema: Schema,
        nodeId: "failed-tools" as NodeId,
      },
      RUNTIME,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        // invalid_prompt is deterministic — retrying repeats it.
        expect(result.error.retriability).toBe("non-retriable");
        expect(result.error.message).toContain("response.status: failed");
        expect(result.error.message).toContain("error.code: invalid_prompt");
        expect(result.error.message).toContain("prompt was rejected");
        expect(result.error.usage).toEqual({ tokensIn: 7, tokensOut: 2 });
      }
    }
  });

  it("response.status failed with a server_error code → RETRIABLE node-crash (sendWithTools)", async () => {
    handler = async () =>
      jsonResponse({
        output: [],
        usage: { input_tokens: 1, output_tokens: 0 },
        status: "failed",
        error: { code: "server_error", message: "internal failure mid-generation" },
      });
    const result = await makeClient().sendWithTools<SchemaType>(
      { system: "s", user: "u", model: "gpt-test", tools: [], schema: Schema, nodeId: "failed-5xx" as NodeId },
      RUNTIME,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.retriability).toBe("retriable");
      expect(result.error.message).toContain("error.code: server_error");
    }
  });

  it("response.status incomplete (truncation) → NON-retriable node-crash carrying the turn's usage", async () => {
    // A truncated turn's tool calls / final answer are unreliable, and
    // retrying the identical request hits the identical cap (mirrors the
    // Anthropic stop_reason max_tokens treatment on sendWithTools).
    handler = async () =>
      jsonResponse({
        output: [makeMessageOutput('{"greeting": "cut off')],
        usage: { input_tokens: 9, output_tokens: 4 },
        status: "incomplete",
      });
    const result = await makeClient().sendWithTools<SchemaType>(
      {
        system: "s",
        user: "u",
        model: "gpt-test",
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
        expect(result.error.message).toContain("response.status: incomplete");
        // The truncated turn still burned tokens — they must be attributed.
        expect(result.error.usage).toEqual({ tokensIn: 9, tokensOut: 4 });
      }
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
        expect(result.error.nodeId).toBe(N("loop-node"));
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
        expect(result.error.nodeId).toBe(N("rl"));
        expect(result.error.message).toMatch(/429/);
      }
    }
  });
});
