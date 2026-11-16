// The Responses API 200 body is wire data: it is parsed through a structural
// guard, never cast. JSON that parses but is not a Responses document takes
// the SAME failure arm as a non-JSON body (a typed `node-crash` carrying
// `HTTP 200` and the body snapshot) instead of crashing on a property read.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { OpenAILlmClient } from "../llm/openai-client.js";
import type { NodeId } from "../types/ids.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const Schema = z.object({ greeting: z.string() });

const send = async (body: string) => {
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
  return new OpenAILlmClient({ apiKey: "k", baseUrl: "https://api.example.com/v1" }).sendStructured({
    system: "s",
    user: "u",
    model: "gpt-test",
    schema: Schema,
    nodeId: "shape-test" as NodeId,
  });
};

describe("OpenAILlmClient — Responses body is parsed, not cast", () => {
  const malformed: ReadonlyArray<readonly [string, string]> = [
    ["null", "null"],
    ["a JSON array", "[]"],
    ["a JSON string", '"hello"'],
    ["a number", "42"],
    ["output that is not an array", '{"output":"x"}'],
    ["output items without a string type", '{"output":[{"type":1}]}'],
    ["output items that are not objects", '{"output":[null]}'],
    ["a non-string status", '{"status":7}'],
    ["a non-object usage", '{"usage":"lots"}'],
    ["a non-object input_tokens_details", '{"usage":{"input_tokens_details":5}}'],
    ["a non-object error", '{"error":"boom"}'],
    ["a non-string error.code", '{"error":{"code":5}}'],
    ["a non-object incomplete_details", '{"incomplete_details":[]}'],
  ];

  for (const [label, body] of malformed) {
    it(`rejects ${label} into the HTTP 200 failure arm`, async () => {
      const result = await send(body);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "node-crash") {
        expect(result.error.message).toContain("HTTP 200");
        expect(result.error.message).toContain(body.slice(0, 20));
        expect(result.error.retriability).toBe("retriable");
      } else {
        throw new Error(`expected node-crash, got ${JSON.stringify(result)}`);
      }
    });
  }

  it("degrades a non-numeric token count to zero instead of rejecting the response", async () => {
    const result = await send(
      JSON.stringify({
        status: "completed",
        usage: { input_tokens: "5", output_tokens: "7" },
        output: [{ type: "message", content: [{ type: "output_text", text: '{"greeting":"hi"}' }] }],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("still accepts a null usage / error / incomplete_details (the wire sends them)", async () => {
    const result = await send(
      JSON.stringify({
        status: "completed",
        usage: null,
        error: null,
        incomplete_details: null,
        output: [{ type: "message", content: [{ type: "output_text", text: '{"greeting":"hi"}' }] }],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.output).toEqual({ greeting: "hi" });
  });
});
