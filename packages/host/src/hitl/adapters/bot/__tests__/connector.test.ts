// connector.test.ts — production BotConnector (ADR-0060): app-only token
// acquisition + caching, proactive-send HTTP mapping, and the trusted-serviceUrl
// guard. Drives the real connector over a fake `fetch` + injected clock.

import { describe, it, expect, afterEach } from "bun:test";
import { createBotConnector } from "../connector.js";
import type { ConversationReference } from "../ports.js";

const TOKEN_URL = "https://login.example/token";
const ref: ConversationReference = { serviceUrl: "https://smba.trafficmanager.net/amer/", conversationId: "19:abc" };

type Resp = { ok: boolean; status: number; json: () => Promise<unknown> };
const resp = (status: number, body: unknown): Resp => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** Install a fake global fetch that routes by URL; returns the recorded calls. */
const installFetch = (handler: (url: string, init?: RequestInit) => Resp) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  // @ts-expect-error — override global fetch for the test
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init) as unknown as Response;
  };
  return calls;
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const tokenBody = (expiresIn: number) => ({ access_token: "tok-" + expiresIn, expires_in: expiresIn });

describe("createBotConnector", () => {
  it("caches the token across sends and refetches after expiry", async () => {
    let nowMs = 1_000_000;
    let tokenFetches = 0;
    const calls = installFetch((url) => {
      if (url === TOKEN_URL) { tokenFetches++; return resp(200, tokenBody(3600)); }
      return resp(200, {}); // send
    });
    const connector = createBotConnector({ appId: "a", appPassword: "p", tokenUrl: TOKEN_URL, now: () => nowMs });

    expect((await connector.sendToConversation(ref, {})).ok).toBe(true);
    expect((await connector.sendToConversation(ref, {})).ok).toBe(true);
    expect(tokenFetches).toBe(1); // second send reused the cached token

    // Advance past (expires_in - 60s) → the next send refetches.
    nowMs += 3600 * 1000;
    expect((await connector.sendToConversation(ref, {})).ok).toBe(true);
    expect(tokenFetches).toBe(2);
    // Sanity: every send hit the activities endpoint.
    expect(calls.filter((c) => c.url.includes("/v3/conversations/"))).toHaveLength(3);
  });

  it("maps a token-endpoint non-2xx to notification-failed", async () => {
    installFetch((url) => (url === TOKEN_URL ? resp(401, {}) : resp(200, {})));
    const connector = createBotConnector({ appId: "a", appPassword: "p", tokenUrl: TOKEN_URL, now: () => 1 });
    const res = await connector.sendToConversation(ref, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("notification-failed");
  });

  it("keeps a hostile token-fetch throw inside the notification-failed Result", async () => {
    const hostile = Object.create(null) as unknown;
    installFetch(() => { throw hostile; });
    const connector = createBotConnector({ appId: "a", appPassword: "p", tokenUrl: TOKEN_URL, now: () => 1 });

    const res = await connector.sendToConversation(ref, {});

    expect(res.ok).toBe(false);
    if (!res.ok && res.error.kind === "notification-failed") {
      expect(typeof res.error.operation).toBe("string");
    }
  });

  it("maps a malformed token response (missing expires_in) to notification-failed", async () => {
    installFetch((url) => (url === TOKEN_URL ? resp(200, { access_token: "t" }) : resp(200, {})));
    const connector = createBotConnector({ appId: "a", appPassword: "p", tokenUrl: TOKEN_URL, now: () => 1 });
    const res = await connector.sendToConversation(ref, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("notification-failed");
  });

  it("keeps a hostile token JSON rejection inside the notification-failed Result", async () => {
    const hostile = Object.create(null) as unknown;
    installFetch((url) => url === TOKEN_URL
      ? { ok: true, status: 200, json: async () => { throw hostile; } }
      : resp(200, {}));
    const connector = createBotConnector({ appId: "a", appPassword: "p", tokenUrl: TOKEN_URL, now: () => 1 });

    const res = await connector.sendToConversation(ref, {});

    expect(res.ok).toBe(false);
    if (!res.ok && res.error.kind === "notification-failed") {
      expect(typeof res.error.operation).toBe("string");
    }
  });

  it("maps a send non-2xx to notification-failed", async () => {
    installFetch((url) => (url === TOKEN_URL ? resp(200, tokenBody(3600)) : resp(502, {})));
    const connector = createBotConnector({ appId: "a", appPassword: "p", tokenUrl: TOKEN_URL, now: () => 1 });
    const res = await connector.sendToConversation(ref, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("notification-failed");
  });

  it("keeps a hostile proactive-send throw inside the notification-failed Result", async () => {
    const hostile = Object.create(null) as unknown;
    installFetch((url) => {
      if (url === TOKEN_URL) return resp(200, tokenBody(3600));
      throw hostile;
    });
    const connector = createBotConnector({ appId: "a", appPassword: "p", tokenUrl: TOKEN_URL, now: () => 1 });

    const res = await connector.sendToConversation(ref, {});

    expect(res.ok).toBe(false);
    if (!res.ok && res.error.kind === "notification-failed") {
      expect(typeof res.error.operation).toBe("string");
    }
  });

  it("refuses to send to an untrusted serviceUrl WITHOUT acquiring a token", async () => {
    let tokenFetches = 0;
    installFetch((url) => { if (url === TOKEN_URL) tokenFetches++; return resp(200, tokenBody(3600)); });
    const connector = createBotConnector({ appId: "a", appPassword: "p", tokenUrl: TOKEN_URL, now: () => 1 });
    const res = await connector.sendToConversation({ serviceUrl: "https://attacker.example.com/", conversationId: "19:x" }, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("notification-failed");
    expect(tokenFetches).toBe(0); // never minted a token for the attacker host
  });
});
