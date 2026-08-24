/**
 * Tests for the adapter factory + lifecycle (`createHttpAuthAdapter`,
 * `healthCheckWithTimeout`) and the in-memory fake's shaped-route caveat.
 *
 * Every test injects a fake `fetch` seam — no network. Covers: `connect()` on
 * bad credentials throwing a SECRET-FREE error; `healthCheckWithTimeout`'s
 * timeout path returning `err` under signal-ignoring probes without touching
 * the request cache; and the fake's explicitly branded shaped-route contract.
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
import { createTokenProvider, type FetchLike, type FetchResponseLike, type TokenProvider } from "../auth.js";

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
  /**
   * A `TokenProvider` that breaks its own `Result` contract. `probe()` is
   * declared to RETURN a `Result`, never to throw — but it is a port, and a
   * third-party implementation can reject anyway. The health check must convert
   * that into a plain `Err`, not let it escape and take down the readiness
   * endpoint that called it. `get`/`invalidate` already have this proof; `probe`
   * did not.
   */
  const contractBreakingProvider = (fail: () => Promise<never>): TokenProvider => ({
    get: async () => { throw new Error("unused"); },
    probe: fail,
    invalidate: () => {},
  });

  it("converts a probe() that REJECTS outside its Result contract into an Err", async () => {
    const tokens = contractBreakingProvider(() => Promise.reject(new Error("provider blew up")));
    const result = await healthCheckWithTimeout(tokens, 1_000);
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error).toContain("outside its Result contract");
  });

  it("converts a probe() that THROWS synchronously into an Err", async () => {
    const tokens = contractBreakingProvider((): never => { throw new Error("sync blow-up"); });
    const result = await healthCheckWithTimeout(tokens, 1_000);
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error).toContain("outside its Result contract");
  });

  it("does not leak the provider's own message into the health-check error", async () => {
    // The rejection reason is deliberately NOT interpolated: a provider is free
    // to put a credential in its error, and this string reaches an unauthenticated
    // readiness endpoint.
    const tokens = contractBreakingProvider(() =>
      Promise.reject(new Error("client_secret=super-secret-value")),
    );
    const result = await healthCheckWithTimeout(tokens, 1_000);
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error).not.toContain("super-secret-value");
  });

  it("returns ok when the mint resolves within the deadline", async () => {
    const fetch: FetchLike = async () => jsonResponse(200, { access_token: "tok-1", expires_in: 3600 });
    const tokens = createTokenProvider({ auth: baseConfig(fetch).auth, fetch });
    const result = await healthCheckWithTimeout(tokens, 1_000);
    expect(isOk(result)).toBe(true);
  });

  it("timeout aborts a signal-aware probe and cannot populate the request cache", async () => {
    let aborted = false;
    let calls = 0;
    const fetch: FetchLike = (_url, init) => {
      calls += 1;
      if (calls > 1) {
        return Promise.resolve(jsonResponse(200, { access_token: "fresh-token", expires_in: 3600 }));
      }
      return new Promise<FetchResponseLike>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    };
    const tokens = createTokenProvider({ auth: baseConfig(fetch).auth, fetch });

    const timedOut = await healthCheckWithTimeout(tokens, 5);
    expect(isErr(timedOut)).toBe(true);
    expect(aborted).toBe(true);

    const requestToken = await tokens.get();
    expect(isOk(requestToken)).toBe(true);
    expect(calls).toBe(2);
  });

  it("settles by the hard deadline when an already-pending mint and the probe both ignore abort", async () => {
    let releaseRequestMint: (response: FetchResponseLike) => void = () => {};
    const requestMint = new Promise<FetchResponseLike>((resolve) => {
      releaseRequestMint = resolve;
    });
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls += 1;
      if (calls === 1) return requestMint;
      return new Promise<FetchResponseLike>(() => {});
    };
    const tokens = createTokenProvider({ auth: baseConfig(fetch).auth, fetch });
    const pendingRequest = tokens.get();
    await Promise.resolve();

    const started = Date.now();
    const result = await healthCheckWithTimeout(tokens, 10);
    expect(Date.now() - started).toBeLessThan(250);
    expect(isErr(result)).toBe(true);
    expect(calls).toBe(2);

    releaseRequestMint(jsonResponse(200, { access_token: "request-token", expires_in: 3600 }));
    expect(isOk(await pendingRequest)).toBe(true);
  });

  it("a late signal-ignoring probe cannot replace an existing cached request token", async () => {
    let releaseProbe: (response: FetchResponseLike) => void = () => {};
    const probe = new Promise<FetchResponseLike>((resolve) => {
      releaseProbe = resolve;
    });
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(200, { access_token: "steady-token", expires_in: 3600 })
        : probe;
    };
    const tokens = createTokenProvider({ auth: baseConfig(fetch).auth, fetch, now: () => 0 });
    const steady = await tokens.get();
    expect(steady.ok && String(steady.value)).toBe("steady-token");

    const result = await healthCheckWithTimeout(tokens, 5);
    expect(isErr(result)).toBe(true);
    releaseProbe(jsonResponse(200, { access_token: "late-probe-token", expires_in: 3600 }));
    await Promise.resolve();

    const stillSteady = await tokens.get();
    expect(stillSteady.ok && String(stillSteady.value)).toBe("steady-token");
    expect(calls).toBe(2);
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
