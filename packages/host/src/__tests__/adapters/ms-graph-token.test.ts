import { describe, expect, test } from "bun:test";
import { createMsGraphTokenProvider } from "../../adapters/ms-graph-token.js";
import type { TokenFetch, TokenEndpointResponse } from "../../adapters/ms-graph-token.js";

/**
 * The client-credentials token provider (adapters/ms-graph-token.ts): caching,
 * refresh-lead, single-flight, and — load-bearing for secret hygiene — that
 * the client secret NEVER appears in an error message.
 */

const SECRET = "super-secret-client-value";

interface IssuedToken {
  readonly accessToken: string;
  readonly expiresInSec?: number;
}

const makeFakeEndpoint = (
  issue: () => IssuedToken | { status: number },
) => {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
  let n = 0;
  const fetchImpl: TokenFetch = async (url, init) => {
    calls.push({ url, init: { method: init.method, headers: { ...init.headers }, body: init.body } });
    const result = issue();
    if ("status" in result) {
      const res: TokenEndpointResponse = { status: result.status, json: async () => ({ error: "boom" }) };
      return res;
    }
    n += 1;
    const res: TokenEndpointResponse = {
      status: 200,
      json: async () => ({
        access_token: result.accessToken,
        ...(result.expiresInSec !== undefined ? { expires_in: result.expiresInSec } : {}),
        token_type: "Bearer",
      }),
    };
    return res;
  };
  return { fetchImpl, calls };
};

const makeClock = () => {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
};

const baseConfig = {
  tenantId: "tenant-1",
  clientId: "client-1",
  clientSecret: SECRET,
};

describe("createMsGraphTokenProvider — request shape", () => {
  test("POSTs client_credentials form to the tenant's v2.0 endpoint with the Graph scope", async () => {
    const ep = makeFakeEndpoint(() => ({ accessToken: "tok-1", expiresInSec: 3600 }));
    const get = createMsGraphTokenProvider({ ...baseConfig, fetchImpl: ep.fetchImpl });
    await expect(get()).resolves.toBe("tok-1");
    expect(ep.calls).toHaveLength(1);
    expect(ep.calls[0].url).toBe("https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
    expect(ep.calls[0].init.method).toBe("POST");
    expect(ep.calls[0].init.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(ep.calls[0].init.body);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("client-1");
    expect(body.get("client_secret")).toBe(SECRET);
    expect(body.get("scope")).toBe("https://graph.microsoft.com/.default");
  });

  test("honours a custom tokenUrl and scope", async () => {
    const ep = makeFakeEndpoint(() => ({ accessToken: "tok-1", expiresInSec: 3600 }));
    const get = createMsGraphTokenProvider({
      ...baseConfig,
      tokenUrl: "https://login.microsoftonline.us/tenant-1/oauth2/v2.0/token",
      scope: "https://graph.microsoft.us/.default",
      fetchImpl: ep.fetchImpl,
    });
    await get();
    expect(ep.calls[0].url).toBe("https://login.microsoftonline.us/tenant-1/oauth2/v2.0/token");
    expect(new URLSearchParams(ep.calls[0].init.body).get("scope")).toBe("https://graph.microsoft.us/.default");
  });
});

describe("createMsGraphTokenProvider — caching", () => {
  test("a second call within the expiry window issues no new request", async () => {
    const ep = makeFakeEndpoint(() => ({ accessToken: "tok-1", expiresInSec: 3600 }));
    const clock = makeClock();
    const get = createMsGraphTokenProvider({ ...baseConfig, fetchImpl: ep.fetchImpl, now: clock.now });
    expect(await get()).toBe("tok-1");
    clock.advance(3_500_000); // 50 min in; refresh lead is 60 s
    expect(await get()).toBe("tok-1");
    expect(ep.calls).toHaveLength(1);
  });

  test("refreshes exactly when the refresh lead is reached (boundary)", async () => {
    let n = 0;
    const ep = makeFakeEndpoint(() => ({ accessToken: `tok-${++n}`, expiresInSec: 3600 }));
    const clock = makeClock();
    const get = createMsGraphTokenProvider({ ...baseConfig, fetchImpl: ep.fetchImpl, now: clock.now });
    expect(await get()).toBe("tok-1"); // issued at t0, expires t0 + 3 600 000
    clock.advance(3_539_999); // now + 60 000 lead < expiry → still cached
    expect(await get()).toBe("tok-1");
    expect(ep.calls).toHaveLength(1);
    clock.advance(1); // now + lead == expiry → NOT < → refresh
    expect(await get()).toBe("tok-2");
    expect(ep.calls).toHaveLength(2);
  });

  test("a failed refresh retries on the next call and recovers (no permanent failure state)", async () => {
    let fail = false;
    const ep = makeFakeEndpoint(() => (fail ? { status: 400 } : { accessToken: "tok-1", expiresInSec: 3600 }));
    const clock = makeClock();
    const get = createMsGraphTokenProvider({ ...baseConfig, fetchImpl: ep.fetchImpl, now: clock.now });
    expect(await get()).toBe("tok-1");
    clock.advance(3_540_000); // inside the 60 s refresh lead
    fail = true;
    await expect(get()).rejects.toThrow(/400/);
    fail = false;
    expect(await get()).toBe("tok-1");
    expect(ep.calls).toHaveLength(3); // initial + failed refresh + successful retry
  });

  test("missing expires_in falls back to a 1 h lifetime (still cached)", async () => {
    const ep = makeFakeEndpoint(() => ({ accessToken: "tok-1" }));
    const clock = makeClock();
    const get = createMsGraphTokenProvider({ ...baseConfig, fetchImpl: ep.fetchImpl, now: clock.now });
    expect(await get()).toBe("tok-1");
    clock.advance(3_400_000); // 56m40s in; the refresh lead starts at 59m
    expect(await get()).toBe("tok-1");
    expect(ep.calls).toHaveLength(1);
  });
});

describe("createMsGraphTokenProvider — concurrency", () => {
  test("N concurrent callers share ONE in-flight token request (single-flight)", async () => {
    let resolveFetch: (r: TokenEndpointResponse) => void = () => {};
    const calls: number[] = [];
    const fetchImpl: TokenFetch = async () => {
      calls.push(1);
      return new Promise<TokenEndpointResponse>((resolve) => {
        resolveFetch = resolve;
      });
    };
    const get = createMsGraphTokenProvider({ ...baseConfig, fetchImpl });
    const results = Promise.all([get(), get(), get(), get()]);
    // Let the first caller fire the request; the others must join it.
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(1);
    resolveFetch({
      status: 200,
      json: async () => ({ access_token: "tok-1", expires_in: 3600 }),
    });
    await expect(results).resolves.toEqual(["tok-1", "tok-1", "tok-1", "tok-1"]);
    expect(calls).toHaveLength(1);
  });

  test("a failed in-flight request clears the guard so the next call retries", async () => {
    let fail = true;
    const ep = makeFakeEndpoint(() => (fail ? { status: 500 } : { accessToken: "tok-1", expiresInSec: 3600 }));
    const get = createMsGraphTokenProvider({ ...baseConfig, fetchImpl: ep.fetchImpl });
    await expect(get()).rejects.toThrow(/500/);
    fail = false;
    expect(await get()).toBe("tok-1");
    expect(ep.calls).toHaveLength(2);
  });
});

describe("createMsGraphTokenProvider — secret hygiene & failure mapping", () => {
  test("non-200 → error carries endpoint host + status, NEVER the client secret", async () => {
    const ep = makeFakeEndpoint(() => ({ status: 401 }));
    const get = createMsGraphTokenProvider({ ...baseConfig, fetchImpl: ep.fetchImpl });
    let error: unknown;
    try {
      await get();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("401");
    expect(message).toContain("login.microsoftonline.com");
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("client-1");
  });

  test("network failure → error names the endpoint host, not the secret", async () => {
    const fetchImpl: TokenFetch = async () => {
      throw new Error("fetch failed: connect ECONNREFUSED");
    };
    const get = createMsGraphTokenProvider({ ...baseConfig, fetchImpl });
    let error: unknown;
    try {
      await get();
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toContain("login.microsoftonline.com");
    expect((error as Error).message).toContain("ECONNREFUSED");
    expect((error as Error).message).not.toContain(SECRET);
  });

  test("200 with no access_token → loud failure (never an empty token)", async () => {
    const fetchImpl: TokenFetch = async () => ({
      status: 200,
      json: async () => ({ error: "invalid_scope" }),
    });
    const get = createMsGraphTokenProvider({ ...baseConfig, fetchImpl });
    await expect(get()).rejects.toThrow(/no access_token/);
  });
});
