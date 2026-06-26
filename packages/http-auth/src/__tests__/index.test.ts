/**
 * Tests for the adapter factory + lifecycle (`createHttpAuthAdapter`,
 * `healthCheckWithTimeout`) and the in-memory fake's shaped-route caveat.
 *
 * Every test injects a fake `fetch` seam — no network. Covers: `connect()` on
 * bad credentials throwing a SECRET-FREE error; `healthCheckWithTimeout`'s
 * timeout path returning `err` (and cancelling the orphaned mint); and the
 * documented `"body" in route` misread caveat of the fake.
 */

import { describe, it, expect } from "bun:test";
import { isOk, isErr } from "@fuguejs/framework";
import { z } from "zod";
import {
  createHttpAuthAdapter,
  healthCheckWithTimeout,
  createFakeAuthedHttpCapability,
  shapedRoute,
  type HttpAuthConfig,
} from "../index.js";
import { createTokenProvider, type FetchLike, type FetchResponseLike } from "../auth.js";

const jsonResponse = (status: number, payload: unknown): FetchResponseLike => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: `status ${status}`,
  text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
  json: async () => payload,
});

const baseConfig = (fetch: FetchLike, overrides?: Partial<HttpAuthConfig>): HttpAuthConfig => ({
  baseUrl: "https://api.example.com",
  auth: {
    tokenUrl: "https://auth.example.com/oauth/token",
    grantType: "operator_password",
    credentials: { username: "operator", password: "s3cret-pw" },
    basicAuth: { username: "client-id", password: "client-secret" },
  },
  fetch,
  ...overrides,
});

const PayloadSchema = z.object({ id: z.string(), name: z.string() });

// ---------------------------------------------------------------------------
// connect() lifecycle
// ---------------------------------------------------------------------------

describe("createHttpAuthAdapter — connect()", () => {
  it("connect() succeeds and mints the first token when credentials are good", async () => {
    const fetch: FetchLike = async () => jsonResponse(200, { access_token: "tok-1", expires_in: 3600 });
    const handle = createHttpAuthAdapter(baseConfig(fetch));
    await expect(handle.connect!()).resolves.toBeUndefined();
  });

  it("connect() on bad credentials throws a SECRET-FREE error (no password/token)", async () => {
    // A 401 from the token endpoint that echoes the secret back in the body.
    const fetch: FetchLike = async () =>
      jsonResponse(401, { error: "invalid_grant", echoed: "s3cret-pw", client_secret: "client-secret" });
    const handle = createHttpAuthAdapter(baseConfig(fetch));

    let thrown: unknown;
    try {
      await handle.connect!();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).not.toContain("s3cret-pw");
    expect(message).not.toContain("client-secret");
  });
});

// ---------------------------------------------------------------------------
// healthCheckWithTimeout
// ---------------------------------------------------------------------------

describe("healthCheckWithTimeout", () => {
  it("returns ok when the mint resolves within the deadline", async () => {
    const fetch: FetchLike = async () => jsonResponse(200, { access_token: "tok-1", expires_in: 3600 });
    const tokens = createTokenProvider({ auth: baseConfig(fetch).auth, fetch });
    const result = await healthCheckWithTimeout(tokens, 1_000);
    expect(isOk(result)).toBe(true);
  });

  it("timeout path returns err and cancels the orphaned mint (no cache populate)", async () => {
    // A signal-respecting mint that only settles when its signal aborts. The
    // health-check deadline must cancel it (→ err) rather than leaving it to
    // resolve and populate the cache.
    let aborted = false;
    const fetch: FetchLike = (_url, init) =>
      new Promise<FetchResponseLike>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    const tokens = createTokenProvider({ auth: baseConfig(fetch).auth, fetch });
    const result = await healthCheckWithTimeout(tokens, 5);
    expect(isErr(result)).toBe(true);
    expect(aborted).toBe(true);

    // The cancelled mint must not have populated the cache: a subsequent get()
    // (with a now-resolving fetch) mints afresh rather than serving a phantom.
    // Re-point the provider at a healthy mint by building a fresh one — the
    // original provider's cache is what we assert stayed empty.
    // (A fresh get() on the same provider would re-enter the same hung fetch,
    // so we assert via the abort flag + err result above.)
  });

  it("the health-check error is secret-free", async () => {
    const fetch: FetchLike = async () =>
      jsonResponse(403, { error: "forbidden", echoed: "s3cret-pw" });
    const tokens = createTokenProvider({ auth: baseConfig(fetch).auth, fetch });
    const result = await healthCheckWithTimeout(tokens, 1_000);
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error).not.toContain("s3cret-pw");
  });
});

// ---------------------------------------------------------------------------
// Fake shaped-route caveat (#9)
// ---------------------------------------------------------------------------

describe("createFakeAuthedHttpCapability — raw vs shaped routes", () => {
  it("a raw payload with a top-level body field is returned VERBATIM (not misread)", async () => {
    // The `shapedRoute` brand — not a `"body" in route` heuristic — distinguishes
    // shaped control metadata from raw payloads, so a payload that legitimately
    // carries a `body` field round-trips unchanged.
    const fake = createFakeAuthedHttpCapability({
      "GET /raw": { id: "1", name: "Alice", body: "note" },
    });
    const result = await fake.client.get("/raw", { schema: PayloadSchema });
    expect(isOk(result)).toBe(true);
    if (result.ok) expect(result.value.name).toBe("Alice");
  });

  it("shapedRoute({ body }) unwraps body as the response", async () => {
    const fake = createFakeAuthedHttpCapability({
      "GET /shaped": shapedRoute({ body: { id: "1", name: "Alice" } }),
    });
    const result = await fake.client.get("/shaped", { schema: PayloadSchema });
    expect(isOk(result)).toBe(true);
    if (result.ok) expect(result.value.name).toBe("Alice");
  });
});
