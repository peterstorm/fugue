// The Responses API 200 body is wire data: it is PARSED through a schema the
// `ResponsesApiResponse` type is derived from, never cast or guarded by a
// hand-written mirror. The parse returns a Result whose error keeps the two
// failures apart:
//
//   - `not-json`    — a proxy interstitial / HTML error page: the client
//                     reports `HTTP 200: <body>` exactly as before;
//   - `wrong-shape` — JSON the API contract does not allow: still the same
//                     retriable node-crash carrying `HTTP 200` and the body,
//                     but the message now NAMES the mismatch instead of
//                     reading like a non-JSON body (PR #53 review finding).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { z } from "zod";
import { OpenAILlmClient } from "../llm/openai-client.js";
import { parseResponsesBody } from "../llm/openai-types.js";
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

const WRONG_SHAPE = "body is JSON but not a Responses API document";

const malformed: ReadonlyArray<readonly [string, string, string]> = [
  // [label, body, the issue the message must name]
  ["null", "null", "expected object"],
  ["a JSON array", "[]", "expected object"],
  ["a JSON string", '"hello"', "expected object"],
  ["a number", "42", "expected object"],
  ["output that is not an array", '{"output":"x"}', "output:"],
  ["output items without a string type", '{"output":[{"type":1}]}', "output.0.type:"],
  ["output items that are not objects", '{"output":[null]}', "output.0:"],
  ["a non-string status", '{"status":7}', "status:"],
  ["a non-object usage", '{"usage":"lots"}', "usage:"],
  ["a non-object input_tokens_details", '{"usage":{"input_tokens_details":5}}', "usage.input_tokens_details:"],
  ["a non-object error", '{"error":"boom"}', "error:"],
  ["a non-string error.code", '{"error":{"code":5}}', "error.code:"],
  ["a non-object incomplete_details", '{"incomplete_details":[]}', "incomplete_details:"],
];

describe("parseResponsesBody — parse, don't validate", () => {
  it("text that is not JSON is `not-json`", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        let isJson = true;
        try {
          JSON.parse(text);
        } catch {
          isJson = false;
        }
        fc.pre(!isJson);
        expect(parseResponsesBody(text)).toEqual({ ok: false, error: { kind: "not-json" } });
      }),
    );
  });

  it("JSON that is not an object is `wrong-shape`, never `not-json`", () => {
    fc.assert(
      fc.property(
        fc.jsonValue().filter((v) => typeof v !== "object" || v === null || Array.isArray(v)),
        (value) => {
          const parsed = parseResponsesBody(JSON.stringify(value));
          expect(parsed.ok).toBe(false);
          if (!parsed.ok) expect(parsed.error.kind).toBe("wrong-shape");
        },
      ),
    );
  });

  for (const [label, body, issue] of malformed) {
    it(`${label} is \`wrong-shape\` naming ${issue}`, () => {
      const parsed = parseResponsesBody(body);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok && parsed.error.kind === "wrong-shape") {
        expect(parsed.error.issues.join("; ")).toContain(issue);
      } else {
        throw new Error(`expected wrong-shape, got ${JSON.stringify(parsed)}`);
      }
    });
  }

  it("keeps the JSON exactly as received beside the parsed document", () => {
    const sent = { status: "completed", vendor_extension: { a: 1 }, output: [] };
    const parsed = parseResponsesBody(JSON.stringify(sent));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.json).toEqual(sent);
    expect(parsed.value.document.status).toBe("completed");
  });

  it("keeps every field of an output item — items are echoed back to the API verbatim", () => {
    const item = { type: "function_call", call_id: "c1", name: "t", arguments: "{}", id: "fc_1" };
    const parsed = parseResponsesBody(JSON.stringify({ output: [item] }));
    expect(parsed.ok && parsed.value.document.output).toEqual([item]);
  });

  it("a non-number token count parses as absent — the type no longer claims a number nothing checked", () => {
    const parsed = parseResponsesBody(JSON.stringify({ usage: { input_tokens: "5", output_tokens: 7 } }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.document.usage?.input_tokens).toBeUndefined();
    expect(parsed.value.document.usage?.output_tokens).toBe(7);
  });
});

describe("OpenAILlmClient — the two 200-body failures are reported apart", () => {
  for (const [label, body, issue] of malformed) {
    it(`reports ${label} as a wrong-shape document in the HTTP 200 failure arm`, async () => {
      const result = await send(body);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "node-crash") {
        expect(result.error.message).toStartWith(`HTTP 200 (${WRONG_SHAPE} — `);
        expect(result.error.message).toContain(issue);
        expect(result.error.message).toContain(body.slice(0, 20));
        expect(result.error.retriability).toBe("retriable");
        expect(result.error.httpStatus).toBe(200);
      } else {
        throw new Error(`expected node-crash, got ${JSON.stringify(result)}`);
      }
    });
  }

  it("reports a non-JSON body exactly as before — `HTTP 200: <body>`, no shape claim", async () => {
    const result = await send("<html>gateway maintenance</html>");
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.message).toBe("HTTP 200: <html>gateway maintenance</html>");
      expect(result.error.retriability).toBe("retriable");
    } else {
      throw new Error(`expected node-crash, got ${JSON.stringify(result)}`);
    }
  });

  it("degrades a non-numeric token count to zero instead of rejecting the response", async () => {
    const result = await send(
      JSON.stringify({
        status: "completed",
        usage: { input_tokens: "5", output_tokens: "7" },
        output: [{ type: "message", content: [{ type: "output_text", text: '{"greeting":"hi"}' }] }],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tokensIn).toBe(0);
      expect(result.value.tokensOut).toBe(0);
    }
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

  it("diagnostics render the body as the API sent it, fields the parse does not read included", async () => {
    const result = await send(JSON.stringify({ status: "completed", vendor_extension: "kept", output: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.message).toContain('"vendor_extension":"kept"');
    } else {
      throw new Error(`expected node-crash, got ${JSON.stringify(result)}`);
    }
  });
});
