import { afterEach, describe, expect, it } from "bun:test";
import { createBotTokenVerifier } from "../../hitl/adapters/bot/verify.js";

const realFetch = globalThis.fetch;

const stubMetadata = (response: () => Response): void => {
  globalThis.fetch = (async () => response()) as unknown as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("createBotTokenVerifier OpenID metadata parsing (wire boundary)", () => {
  it.each([
    ["missing jwks_uri", {}],
    ["non-string jwks_uri", { jwks_uri: 42 }],
    ["JSON null", null],
    ["JSON array", []],
    ["JSON string", "https://example.test/keys"],
  ])("reports %s as an unavailable JWKS (retriable, never a forged-token 401)", async (_label, body) => {
    stubMetadata(() => new Response(JSON.stringify(body), { status: 200 }));
    const verify = createBotTokenVerifier({ appId: "app" });
    const result = await verify("Bearer a.b.c");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("unavailable");
      expect(result.error.reason).toContain("JWKS unavailable");
    }
  });

  it("reports an unparseable metadata body as an unavailable JWKS", async () => {
    stubMetadata(() => new Response("<html>", { status: 200 }));
    const result = await createBotTokenVerifier({ appId: "app" })("Bearer a.b.c");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unavailable");
  });

  it("still fails closed as invalid for a malformed token once the JWKS resolves", async () => {
    stubMetadata(() =>
      new Response(JSON.stringify({ jwks_uri: "https://login.botframework.com/v1/.well-known/keys" }), { status: 200 }));
    const result = await createBotTokenVerifier({ appId: "app" })("Bearer not-a-jwt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid");
  });
});
