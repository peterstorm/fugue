/**
 * Unit tests for the authenticated REST client (`createAuthedHttpClient`) and
 * the in-memory fake (`createFakeAuthedHttpCapability`).
 *
 * Every test injects a fake `fetch` seam and a fake `TokenProvider` — no
 * network, no mocking framework. Covers: URL construction (baseUrl + path);
 * header composition (Authorization Bearer + defaultHeaders + per-call); body
 * JSON-stringification + Zod validation of the response; the `401` →
 * invalidate + re-mint + single retry path; error classification (transient
 * network/408/429/5xx vs non-retriable parse/other 4xx); and that no exception
 * escapes any method.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { ok, err, isOk, isErr, nodeId, type FrameworkError, type Result } from "@fuguejs/framework";
import {
  createAuthedHttpClient,
  buildUrl,
  type AuthedHttpCapability,
  type AuthedRequestOpts,
  type AuthedBodyRequestOpts,
} from "../client.js";
import { createFakeAuthedHttpCapability, shapedRoute } from "../index.js";
import type { FetchLike, FetchResponseLike, TokenProvider, BearerToken } from "../auth.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

const jsonResponse = (status: number, payload: unknown): FetchResponseLike => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: `status ${status}`,
  text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
  json: async () => payload,
});

const recordingFetch = (
  respond: (call: number, req: CapturedRequest) => FetchResponseLike | Promise<FetchResponseLike>,
): { fetch: FetchLike; calls: CapturedRequest[] } => {
  const calls: CapturedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    const req: CapturedRequest = { url, method: init.method, headers: init.headers, body: init.body };
    const n = calls.length;
    calls.push(req);
    return respond(n, req);
  };
  return { fetch, calls };
};

/** A token provider whose tokens follow a queue; records invalidate() calls. */
const fakeTokens = (tokens: string[]): TokenProvider & { invalidations: number } => {
  let i = 0;
  const state = {
    invalidations: 0,
    get: async (): Promise<Result<BearerToken, FrameworkError>> => {
      const t = tokens[Math.min(i, tokens.length - 1)];
      return ok(t as BearerToken);
    },
    probe: async () => ok(undefined),
    invalidate: (): void => {
      state.invalidations += 1;
      i += 1;
    },
  };
  return state;
};

const config = {
  baseUrl: "https://api.example.com",
  defaultHeaders: { Accept: "application/json", "X-Tenant": "acme" },
  timeoutMs: 5_000,
};

const PayloadSchema = z.object({ id: z.string(), name: z.string() });

const makeClient = (fetch: FetchLike, tokens: TokenProvider): AuthedHttpCapability =>
  createAuthedHttpClient({ config, tokens, fetch });

// ---------------------------------------------------------------------------
// buildUrl (pure)
// ---------------------------------------------------------------------------

describe("buildUrl", () => {
  it("joins base + relative path", () => {
    expect(buildUrl("https://api.example.com", "/customers/1")).toBe("https://api.example.com/customers/1");
  });
  it("tolerates trailing slash on base and missing leading slash on path", () => {
    expect(buildUrl("https://api.example.com/", "customers/1")).toBe("https://api.example.com/customers/1");
  });
  it("passes through an absolute URL unchanged", () => {
    expect(buildUrl("https://api.example.com", "https://other.example.com/x")).toBe("https://other.example.com/x");
  });
});

// ---------------------------------------------------------------------------
// Verb request construction
// ---------------------------------------------------------------------------

describe("createAuthedHttpClient — request construction", () => {
  it("rejects a cross-origin absolute URL before reading a token or calling fetch", async () => {
    let tokenReads = 0;
    let fetchCalls = 0;
    const tokens: TokenProvider = {
      get: async () => {
        tokenReads += 1;
        return ok("managed-secret" as BearerToken);
      },
      probe: async () => ok(undefined),
      invalidate: () => {},
    };
    const fetch: FetchLike = async () => {
      fetchCalls += 1;
      return jsonResponse(200, { id: "1", name: "leaked" });
    };

    const result = await makeClient(fetch, tokens).get("https://attacker.example/steal", { schema: PayloadSchema });

    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error.kind).toBe("node-crash");
    expect(tokenReads).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it("accepts a same-origin absolute URL", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { id: "1", name: "Alice" }));
    const result = await makeClient(fetch, fakeTokens(["tok-1"])).get(
      "https://api.example.com/customers/1",
      { schema: PayloadSchema },
    );

    expect(isOk(result)).toBe(true);
    expect(calls[0]?.url).toBe("https://api.example.com/customers/1");
  });

  it("GET builds baseUrl+path and injects the bearer token + default headers", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { id: "1", name: "Alice" }));
    const client = makeClient(fetch, fakeTokens(["tok-1"]));

    const result = await client.get("/customers/1", { schema: PayloadSchema });
    expect(isOk(result)).toBe(true);
    if (result.ok) expect(result.value.name).toBe("Alice");

    const call = calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url).toBe("https://api.example.com/customers/1");
    expect(call.headers.Authorization).toBe("Bearer tok-1");
    expect(call.headers.Accept).toBe("application/json");
    expect(call.headers["X-Tenant"]).toBe("acme");
    expect(call.body).toBeUndefined();
  });

  it("per-call headers override defaults; Authorization is always the managed token", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { id: "1", name: "Alice" }));
    const client = makeClient(fetch, fakeTokens(["tok-1"]));

    await client.get("/customers/1", {
      schema: PayloadSchema,
      headers: { "X-Tenant": "override", Authorization: "Bearer attacker" },
    });

    const call = calls[0]!;
    expect(call.headers["X-Tenant"]).toBe("override");
    // The managed token wins — a caller cannot smuggle a different bearer.
    expect(call.headers.Authorization).toBe("Bearer tok-1");
  });

  it("POST JSON-stringifies the body, sets Content-Type, and validates the response", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { id: "9", name: "Created" }));
    const client = makeClient(fetch, fakeTokens(["tok-1"]));

    const result = await client.post("/customers", { schema: PayloadSchema, body: { name: "Created" } });
    expect(isOk(result)).toBe(true);
    if (result.ok) expect(result.value.id).toBe("9");

    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(call.body).toBe(JSON.stringify({ name: "Created" }));
  });

  it("PUT / PATCH / DELETE build the correct method and URL", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { id: "1", name: "X" }));
    const client = makeClient(fetch, fakeTokens(["tok-1"]));

    await client.put("/customers/1", { schema: PayloadSchema, body: { name: "X" } });
    await client.patch("/customers/1", { schema: PayloadSchema, body: { name: "X" } });
    await client.delete("/customers/1", { schema: PayloadSchema });

    expect(calls.map((c) => c.method)).toEqual(["PUT", "PATCH", "DELETE"]);
    for (const c of calls) expect(c.url).toBe("https://api.example.com/customers/1");
    expect(calls[2]!.body).toBeUndefined();
  });

  it("returns node-crash when the response fails schema validation", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(200, { id: 1, name: "Alice" })); // id should be string
    const client = makeClient(fetch, fakeTokens(["tok-1"]));
    const result = await client.get("/customers/1", { schema: PayloadSchema });
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error.kind).toBe("node-crash");
  });

  it("rejects cyclic and BigInt request bodies as non-retriable payload errors without fetching", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { id: "1", name: "unused" }));
    const client = makeClient(fetch, fakeTokens(["tok-1"]));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    for (const body of [cyclic, { amount: 1n }]) {
      const result = await client.post("/customers", { schema: PayloadSchema, body });
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.kind).toBe("node-crash");
        if (result.error.kind === "node-crash") {
          expect(result.error.message).toContain("not JSON-serializable");
          expect(result.error.retriability).toBe("non-retriable");
        }
      }
    }
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 401 → invalidate + re-mint + single retry
// ---------------------------------------------------------------------------

describe("createAuthedHttpClient — 401 retry", () => {
  it("on 401 it invalidates, re-mints, and retries once, then succeeds", async () => {
    const { fetch, calls } = recordingFetch((n) =>
      n === 0 ? jsonResponse(401, "expired") : jsonResponse(200, { id: "1", name: "Alice" }),
    );
    const tokens = fakeTokens(["stale-token", "fresh-token"]);
    const client = makeClient(fetch, tokens);

    const result = await client.get("/customers/1", { schema: PayloadSchema });
    expect(isOk(result)).toBe(true);
    if (result.ok) expect(result.value.name).toBe("Alice");

    expect(tokens.invalidations).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.Authorization).toBe("Bearer stale-token");
    expect(calls[1]!.headers.Authorization).toBe("Bearer fresh-token");
  });

  it("retries exactly once: a second consecutive 401 is a non-retriable auth failure", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(401, "still expired"));
    const tokens = fakeTokens(["t1", "t2"]);
    const client = makeClient(fetch, tokens);

    const result = await client.get("/customers/1?api_key=query-secret", { schema: PayloadSchema });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect(JSON.stringify(result.error)).not.toContain("query-secret");
      expect(JSON.stringify(result.error)).toContain("https://api.example.com/customers/1");
    }

    expect(tokens.invalidations).toBe(1); // invalidated once, retried once, then gave up
    expect(calls).toHaveLength(2);
  });

  it("the retried POST resends the original body", async () => {
    const { fetch, calls } = recordingFetch((n) =>
      n === 0 ? jsonResponse(401, "expired") : jsonResponse(200, { id: "1", name: "Bob" }),
    );
    const client = makeClient(fetch, fakeTokens(["t1", "t2"]));

    await client.post("/customers", { schema: PayloadSchema, body: { name: "Bob" } });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toBe(JSON.stringify({ name: "Bob" }));
    expect(calls[1]!.body).toBe(JSON.stringify({ name: "Bob" }));
  });

  it("short-circuits to the token error when minting fails (no request sent)", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { id: "1", name: "Alice" }));
    const failingTokens: TokenProvider = {
      get: async () => err({ kind: "transient", nodeId: nodeId("test"), message: "auth down" }),
      probe: async () => ok(undefined),
      invalidate: () => {},
    };
    const client = makeClient(fetch, failingTokens);
    const result = await client.get("/customers/1", { schema: PayloadSchema });
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error.kind).toBe("transient");
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Error mapping (no exception escapes)
// ---------------------------------------------------------------------------

describe("createAuthedHttpClient — error mapping", () => {
  it("5xx → transient without reflecting an echoed bearer token", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(503, "server echoed managed-secret"));
    const client = makeClient(fetch, fakeTokens(["managed-secret"]));
    const result = await client.get("/x", { schema: PayloadSchema });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      if (result.error.kind === "transient") expect(result.error.httpStatus).toBe(503);
      expect(JSON.stringify(result.error)).not.toContain("managed-secret");
    }
  });

  it("4xx (non-401) → non-retriable node-crash", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(422, "unprocessable"));
    const client = makeClient(fetch, fakeTokens(["t1"]));
    const result = await client.get("/x", { schema: PayloadSchema });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") expect(result.error.retriability).toBe("non-retriable");
    }
  });

  it("a network throw → secret-free transient (no exception escapes)", async () => {
    const fetch: FetchLike = async (_url, init) => {
      throw new Error(`transport reflected ${init.headers.Authorization}`);
    };
    const client = makeClient(fetch, fakeTokens(["managed-secret"]));
    const result = await client.get("/x", { schema: PayloadSchema });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      expect(JSON.stringify(result.error)).not.toContain("managed-secret");
    }
  });

  it("invalid JSON body → non-retriable node-crash", async () => {
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "<html>",
      json: async () => { throw new SyntaxError("Unexpected token <"); },
    });
    const client = makeClient(fetch, fakeTokens(["t1"]));
    const result = await client.get("/x", { schema: PayloadSchema });
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error.kind).toBe("node-crash");
  });

  it("no method ever throws — even a malformed fetch seam yields a Result", async () => {
    const fetch: FetchLike = async () => { throw "not-an-error-object"; };
    const client = makeClient(fetch, fakeTokens(["t1"]));
    for (const op of [
      () => client.get("/x", { schema: PayloadSchema }),
      () => client.post("/x", { schema: PayloadSchema, body: {} }),
      () => client.put("/x", { schema: PayloadSchema, body: {} }),
      () => client.patch("/x", { schema: PayloadSchema, body: {} }),
      () => client.delete("/x", { schema: PayloadSchema }),
    ]) {
      const result = await op();
      expect(isErr(result)).toBe(true);
    }
  });

  it("contains hostile request-option accessors in a secret-free Result", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { id: "1", name: "unused" }));
    const client = makeClient(fetch, fakeTokens(["managed-secret"]));

    const common = Object.defineProperty(
      { schema: PayloadSchema },
      "headers",
      { get: () => { throw new Error("header getter leaked managed-secret"); } },
    ) as AuthedRequestOpts<z.output<typeof PayloadSchema>>;
    const commonResult = await client.get("/x", common);

    const body = Object.defineProperty(
      { schema: PayloadSchema },
      "body",
      { get: () => { throw new Error("body getter leaked managed-secret"); } },
    ) as AuthedBodyRequestOpts<z.output<typeof PayloadSchema>>;
    const bodyResult = await client.post("/x", body);

    for (const result of [commonResult, bodyResult]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("node-crash");
        expect(JSON.stringify(result.error)).not.toContain("managed-secret");
      }
    }
    expect(calls).toHaveLength(0);
  });

  it("normalizes a rejecting initial token lookup into a secret-free Result", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { id: "1", name: "unused" }));
    const tokens: TokenProvider = {
      get: async () => { throw new Error("provider leaked s3cret"); },
      probe: async () => ok(undefined),
      invalidate: () => {},
    };
    const result = await makeClient(fetch, tokens).get("/x", { schema: PayloadSchema });

    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.message).not.toContain("s3cret");
      }
    }
    expect(calls).toHaveLength(0);
  });

  it("normalizes rejecting refresh lookup and throwing invalidation into Results", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(401, "expired"));
    let gets = 0;
    const rejectingRefresh: TokenProvider = {
      get: async () => {
        gets += 1;
        if (gets === 1) return ok("stale" as BearerToken);
        throw new Error("refresh rejected");
      },
      probe: async () => ok(undefined),
      invalidate: () => {},
    };
    const refreshResult = await makeClient(fetch, rejectingRefresh).get("/x", { schema: PayloadSchema });
    expect(isErr(refreshResult)).toBe(true);
    if (!refreshResult.ok) expect(refreshResult.error.kind).toBe("node-crash");
    expect(calls).toHaveLength(1);

    const throwingInvalidate: TokenProvider = {
      get: async () => ok("stale" as BearerToken),
      probe: async () => ok(undefined),
      invalidate: () => { throw new Error("invalidate rejected"); },
    };
    const invalidationResult = await makeClient(fetch, throwingInvalidate).get("/x", { schema: PayloadSchema });
    expect(isErr(invalidationResult)).toBe(true);
    if (!invalidationResult.ok) expect(invalidationResult.error.kind).toBe("node-crash");
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Retriability classification: 429 / 408 / timeout / cancellation
// ---------------------------------------------------------------------------

describe("createAuthedHttpClient — retriability classification", () => {
  it("429 (rate-limit) → transient with httpStatus (retriable)", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(429, "slow down"));
    const client = makeClient(fetch, fakeTokens(["t1"]));
    const result = await client.get("/x", { schema: PayloadSchema });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      if (result.error.kind === "transient") expect(result.error.httpStatus).toBe(429);
    }
  });

  it("408 (request timeout) → transient with httpStatus (retriable)", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(408, "too slow"));
    const client = makeClient(fetch, fakeTokens(["t1"]));
    const result = await client.get("/x", { schema: PayloadSchema });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      if (result.error.kind === "transient") expect(result.error.httpStatus).toBe(408);
    }
  });

  it("our own timeout → transient, via a signal-respecting fake fetch", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    const client = createAuthedHttpClient({
      config: { ...config, timeoutMs: 5 },
      tokens: fakeTokens(["t1"]),
      fetch,
    });
    const result = await client.get("/slow?api_key=query-secret", { schema: PayloadSchema });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      expect(JSON.stringify(result.error)).not.toContain("query-secret");
      expect(JSON.stringify(result.error)).toContain("https://api.example.com/slow");
    }
  });

  it("a non-timeout AbortError (cancellation) → non-retriable node-crash", async () => {
    // No client timeout; the fetch rejects with a foreign AbortError.
    const fetch: FetchLike = async () => {
      const e = new Error("operation cancelled");
      e.name = "AbortError";
      throw e;
    };
    const client = createAuthedHttpClient({
      config: { baseUrl: config.baseUrl }, // no timeoutMs
      tokens: fakeTokens(["t1"]),
      fetch,
    });
    const result = await client.get("/x?api_key=query-secret", { schema: PayloadSchema });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") expect(result.error.retriability).toBe("non-retriable");
      expect(JSON.stringify(result.error)).not.toContain("query-secret");
      expect(JSON.stringify(result.error)).toContain("https://api.example.com/x");
    }
  });
});

// ---------------------------------------------------------------------------
// 401 retry across all verbs (not just GET/POST)
// ---------------------------------------------------------------------------

describe("createAuthedHttpClient — 401 retry across verbs", () => {
  it("PUT: 401 → invalidate + re-mint + single retry, then succeeds", async () => {
    const { fetch, calls } = recordingFetch((n) =>
      n === 0 ? jsonResponse(401, "expired") : jsonResponse(200, { id: "1", name: "Put" }),
    );
    const tokens = fakeTokens(["stale", "fresh"]);
    const client = makeClient(fetch, tokens);
    const result = await client.put("/customers/1", { schema: PayloadSchema, body: { name: "Put" } });
    expect(isOk(result)).toBe(true);
    expect(tokens.invalidations).toBe(1);
    expect(calls.map((c) => c.headers.Authorization)).toEqual(["Bearer stale", "Bearer fresh"]);
    // The retried PUT resends the original body.
    expect(calls[1]!.body).toBe(JSON.stringify({ name: "Put" }));
  });

  it("PATCH: 401 → invalidate + re-mint + single retry, then succeeds", async () => {
    const { fetch, calls } = recordingFetch((n) =>
      n === 0 ? jsonResponse(401, "expired") : jsonResponse(200, { id: "1", name: "Patch" }),
    );
    const tokens = fakeTokens(["stale", "fresh"]);
    const client = makeClient(fetch, tokens);
    const result = await client.patch("/customers/1", { schema: PayloadSchema, body: { name: "Patch" } });
    expect(isOk(result)).toBe(true);
    expect(tokens.invalidations).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("DELETE (no body): 401 → invalidate + re-mint + single retry, then succeeds", async () => {
    const { fetch, calls } = recordingFetch((n) =>
      n === 0 ? jsonResponse(401, "expired") : jsonResponse(200, { id: "1", name: "Gone" }),
    );
    const tokens = fakeTokens(["stale", "fresh"]);
    const client = makeClient(fetch, tokens);
    const result = await client.delete("/customers/1", { schema: PayloadSchema });
    expect(isOk(result)).toBe(true);
    expect(tokens.invalidations).toBe(1);
    expect(calls).toHaveLength(2);
    // No body on either attempt — the no-body verb never serializes a payload.
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[1]!.body).toBeUndefined();
    expect(calls[1]!.headers.Authorization).toBe("Bearer fresh");
  });
});

// ---------------------------------------------------------------------------
// Content-Type override + case collision
// ---------------------------------------------------------------------------

describe("createAuthedHttpClient — Content-Type handling", () => {
  it("honors a contentType override on a body verb", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { id: "1", name: "X" }));
    const client = makeClient(fetch, fakeTokens(["t1"]));
    await client.post("/x", { schema: PayloadSchema, body: { a: 1 }, contentType: "application/merge-patch+json" });
    expect(calls[0]!.headers["Content-Type"]).toBe("application/merge-patch+json");
  });

  it("a lowercase content-type header override is honored once (no double-set)", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { id: "1", name: "X" }));
    const client = makeClient(fetch, fakeTokens(["t1"]));
    await client.post("/x", {
      schema: PayloadSchema,
      body: { a: 1 },
      headers: { "content-type": "application/vnd.custom+json" },
    });
    const h = calls[0]!.headers;
    // The caller's lowercase header wins; the client does NOT also inject a
    // canonical "Content-Type" default (the case-collision guard works).
    expect(h["content-type"]).toBe("application/vnd.custom+json");
    expect(h["Content-Type"]).toBeUndefined();
  });

  it("never serializes the grant password into an error", async () => {
    // A schema mismatch produces a node-crash; assert no stray secret leaks.
    const { fetch } = recordingFetch(() => jsonResponse(200, { id: 1, name: "bad" }));
    const client = makeClient(fetch, fakeTokens(["s3cret"]));
    const result = await client.get("/x", { schema: PayloadSchema });
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(JSON.stringify(result.error)).not.toContain("s3cret");
  });
});

// ---------------------------------------------------------------------------
// Fake capability
// ---------------------------------------------------------------------------

describe("createFakeAuthedHttpCapability", () => {
  const fake = createFakeAuthedHttpCapability({
    "GET /customers/123": { id: "123", name: "Alice" },
    "POST /orders": shapedRoute({ body: { id: "ord-1", name: "Order" } }),
    "GET /customers/999": shapedRoute({ status: 404, body: "Not Found" }),
    "GET /flaky": shapedRoute({ status: 503, body: "down" }),
    "GET /rate-limited": shapedRoute({ status: 429, body: "slow down" }),
    "GET /timed-out": shapedRoute({ status: 408, body: "too slow" }),
  });
  const client = fake.client;

  it("has name 'authedHttp'", () => {
    expect(fake.name).toBe("authedHttp");
  });

  it("returns the canned body validated against the schema", async () => {
    const result = await client.get("/customers/123", { schema: PayloadSchema });
    expect(isOk(result)).toBe(true);
    if (result.ok) expect(result.value.name).toBe("Alice");
  });

  it("resolves a shaped { body } route for POST", async () => {
    const result = await client.post("/orders", { schema: PayloadSchema, body: { name: "Order" } });
    expect(isOk(result)).toBe(true);
    if (result.ok) expect(result.value.id).toBe("ord-1");
  });

  it("an unmatched route → transient error", async () => {
    const result = await client.get("/nope", { schema: PayloadSchema });
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error.kind).toBe("transient");
  });

  it("a 4xx status route → non-retriable node-crash", async () => {
    const result = await client.get("/customers/999", { schema: PayloadSchema });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") expect(result.error.retriability).toBe("non-retriable");
    }
  });

  it.each(["/flaky", "/rate-limited", "/timed-out"])(
    "a retriable production status route (%s) → transient",
    async (path) => {
      const result = await client.get(path, { schema: PayloadSchema });
      expect(isErr(result)).toBe(true);
      if (!result.ok) expect(result.error.kind).toBe("transient");
    },
  );

  it("matchBody mismatch fails the route so a wrong payload surfaces", async () => {
    const fakeWithAssertion = createFakeAuthedHttpCapability({
      "POST /events": shapedRoute({
        body: { id: "e1", name: "ok" },
        matchBody: (b: unknown) => (b as { type?: string }).type === "click",
      }),
    });
    const wrong = await fakeWithAssertion.client.post("/events", { schema: PayloadSchema, body: { type: "scroll" } });
    expect(isErr(wrong)).toBe(true);

    const right = await fakeWithAssertion.client.post("/events", { schema: PayloadSchema, body: { type: "click" } });
    expect(isOk(right)).toBe(true);
  });
});
