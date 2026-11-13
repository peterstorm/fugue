import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createBotConnector } from "../../hitl/adapters/bot/connector.js";
import type { ConversationReference } from "../../hitl/adapters/bot/ports.js";

const REF: ConversationReference = {
  serviceUrl: "https://smba.trafficmanager.net/emea/",
  conversationId: "conv-1",
};

type FetchCall = { readonly url: string; readonly init: RequestInit | undefined };

const realFetch = globalThis.fetch;
let calls: FetchCall[];

/** Install a fetch stub: token endpoint answers `tokenBody`, activity posts answer 200. */
const stubFetch = (tokenResponse: () => Response): void => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return url.includes("/oauth2/") ? tokenResponse() : new Response("{}", { status: 200 });
  }) as typeof fetch;
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const connector = (now: () => number = () => 0) =>
  createBotConnector({ appId: "app", appPassword: "secret", now });

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("createBotConnector token parsing (wire boundary)", () => {
  it("attaches the fetched bearer token to the activity post", async () => {
    stubFetch(() => jsonResponse({ access_token: "tok-1", expires_in: 3600 }));
    const result = await connector().sendToConversation(REF, { type: "message" });
    expect(result.ok).toBe(true);
    const post = calls.find((c) => c.url.includes("/v3/conversations/"));
    expect(post).toBeDefined();
    expect((post!.init!.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
  });

  it("caches the token until shortly before expiry", async () => {
    stubFetch(() => jsonResponse({ access_token: "tok-1", expires_in: 3600 }));
    let t = 0;
    const c = connector(() => t);
    await c.sendToConversation(REF, {});
    t = 1_000;
    await c.sendToConversation(REF, {});
    expect(calls.filter((c2) => c2.url.includes("/oauth2/"))).toHaveLength(1);
  });

  it.each([
    ["missing access_token", { expires_in: 3600 }],
    ["non-string access_token", { access_token: 7, expires_in: 3600 }],
    ["missing expires_in", { access_token: "tok" }],
    ["string expires_in", { access_token: "tok", expires_in: "3600" }],
    ["JSON null", null],
    ["JSON array", ["tok", 3600]],
    ["JSON string", "tok"],
    ["JSON number", 3600],
  ])("rejects a token response with %s as notification-failed", async (_label, body) => {
    stubFetch(() => jsonResponse(body));
    const result = await connector().sendToConversation(REF, {});
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "notification-failed",
        operation: "bot token response missing access_token/expires_in",
      },
    });
    expect(calls.some((c) => c.url.includes("/v3/conversations/"))).toBe(false);
  });

  it("rejects a non-JSON token body as notification-failed", async () => {
    stubFetch(() => new Response("<html>proxy error</html>", { status: 200 }));
    const result = await connector().sendToConversation(REF, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("notification-failed");
      expect(JSON.stringify(result.error)).toContain("bot token response not valid JSON");
    }
  });
});
