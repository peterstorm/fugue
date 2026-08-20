/**
 * Unit tests for the generic token provider (`createTokenProvider`).
 *
 * Every test injects a fake `fetch` seam — no network, no mocking framework.
 * Covers: the grant body + Basic auth header sent on mint; cache reuse (N
 * `get()` calls → one mint); single-flight (concurrent callers → exactly one
 * in-flight mint); `invalidate()` forcing a re-mint; expiry-driven re-mint; and
 * error mapping (network/5xx transient vs 4xx/parse non-retriable). No method
 * throws and the token is never surfaced in an error.
 */

import { describe, it, expect } from "bun:test";
import { isOk, isErr } from "@fuguejs/framework";
import { createTokenProvider, type FetchLike, type FetchResponseLike, type AuthConfig } from "../auth.js";

// ---------------------------------------------------------------------------
// Fake fetch helpers
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
  text: async () => JSON.stringify(payload),
  json: async () => payload,
});

/** A fetch seam that records every call and replies with the queued response. */
const recordingFetch = (
  respond: (call: number) => FetchResponseLike | Promise<FetchResponseLike>,
): { fetch: FetchLike; calls: CapturedRequest[] } => {
  const calls: CapturedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    const n = calls.length;
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    return respond(n);
  };
  return { fetch, calls };
};

const baseAuth: AuthConfig = {
  tokenUrl: "https://auth.example.com/oauth/token",
  grantType: "operator_password",
  params: { brand_key: "acme" },
  credentials: { username: "operator", password: "s3cret" },
};

describe("createTokenProvider — mint request shape", () => {
  it("POSTs an x-www-form-urlencoded grant body with grant_type, credentials, and params", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { access_token: "tok-1", expires_in: 3600 }));
    const provider = createTokenProvider({ auth: baseAuth, fetch });

    const result = await provider.get();
    expect(isOk(result)).toBe(true);
    if (result.ok) expect(String(result.value)).toBe("tok-1");

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://auth.example.com/oauth/token");
    expect(call.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

    const params = new URLSearchParams(call.body);
    expect(params.get("grant_type")).toBe("operator_password");
    expect(params.get("username")).toBe("operator");
    expect(params.get("password")).toBe("s3cret");
    expect(params.get("brand_key")).toBe("acme");
  });

  it("loops credentials.extra fields into the urlencoded grant body", async () => {
    // An optional second factor (e.g. a device id) rides in `credentials.extra`
    // and must surface as its own urlencoded field alongside username/password.
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { access_token: "tok-1", expires_in: 3600 }));
    const provider = createTokenProvider({
      auth: { ...baseAuth, credentials: { ...baseAuth.credentials!, extra: { device_id: "abc" } } },
      fetch,
    });

    await provider.get();
    const params = new URLSearchParams(calls[0]!.body);
    expect(params.get("username")).toBe("operator");
    expect(params.get("device_id")).toBe("abc");
  });

  it("sets an HTTP Basic Authorization header when basicAuth is configured", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { access_token: "tok-1" }));
    const provider = createTokenProvider({
      auth: { ...baseAuth, basicAuth: { username: "client-id", password: "client-secret" } },
      fetch,
    });

    await provider.get();
    const auth = calls[0]!.headers.Authorization;
    expect(auth).toBeDefined();
    expect(auth!.startsWith("Basic ")).toBe(true);
    const decoded = Buffer.from(auth!.slice("Basic ".length), "base64").toString("utf8");
    expect(decoded).toBe("client-id:client-secret");
  });

  it("omits the Authorization header when basicAuth is absent", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { access_token: "tok-1" }));
    const provider = createTokenProvider({ auth: baseAuth, fetch });
    await provider.get();
    expect(calls[0]!.headers.Authorization).toBeUndefined();
  });

  it("client_credentials grant: omits username/password entirely, authenticates via Basic + params", async () => {
    // A two-legged client_credentials grant carries NO resource-owner
    // credentials — the body must be exactly `grant_type=client_credentials`
    // plus the static params (a compliant token endpoint rejects an empty
    // `username=`/`password=`). The client authenticates via the Basic header.
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { access_token: "cc-tok", expires_in: 1800 }));
    const provider = createTokenProvider({
      auth: {
        tokenUrl: "https://auth.example.com/oauth/token",
        grantType: "client_credentials",
        params: { brand_key: "oister", operator: "toolbox" },
        basicAuth: { username: "toolbox", password: "s3cret" },
        // credentials intentionally omitted
      },
      fetch,
    });

    const result = await provider.get();
    expect(isOk(result)).toBe(true);

    const call = calls[0]!;
    const params = new URLSearchParams(call.body);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("brand_key")).toBe("oister");
    expect(params.get("operator")).toBe("toolbox");
    // The decisive invariant: no resource-owner fields are present at all.
    expect(params.has("username")).toBe(false);
    expect(params.has("password")).toBe(false);
    // ...and the client authenticates via HTTP Basic.
    const authz = call.headers.Authorization;
    expect(authz?.startsWith("Basic ")).toBe(true);
    expect(Buffer.from(authz!.slice(6), "base64").toString("utf8")).toBe("toolbox:s3cret");
  });
});

describe("createTokenProvider — caching & invalidation", () => {
  it("reuses the cached token: N get() calls mint exactly once", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { access_token: "tok-1", expires_in: 3600 }));
    const provider = createTokenProvider({ auth: baseAuth, fetch });

    const a = await provider.get();
    const b = await provider.get();
    const c = await provider.get();

    expect(calls).toHaveLength(1);
    expect(a.ok && String(a.value)).toBe("tok-1");
    expect(b.ok && String(b.value)).toBe("tok-1");
    expect(c.ok && String(c.value)).toBe("tok-1");
  });

  it("invalidate() forces a re-mint on the next get()", async () => {
    let n = 0;
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { access_token: `tok-${++n}`, expires_in: 3600 }));
    const provider = createTokenProvider({ auth: baseAuth, fetch });

    const first = await provider.get();
    expect(first.ok && String(first.value)).toBe("tok-1");

    provider.invalidate();
    const second = await provider.get();
    expect(second.ok && String(second.value)).toBe("tok-2");
    expect(calls).toHaveLength(2);
  });

  it("re-mints once the cached token has expired (clock seam)", async () => {
    let clock = 1_000_000;
    let n = 0;
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { access_token: `tok-${++n}`, expires_in: 60 }));
    const provider = createTokenProvider({ auth: baseAuth, fetch, now: () => clock });

    const first = await provider.get();
    expect(first.ok && String(first.value)).toBe("tok-1");
    expect(calls).toHaveLength(1);

    // Within validity window (minus 30s skew): still cached.
    clock += 20_000;
    const cached = await provider.get();
    expect(cached.ok && String(cached.value)).toBe("tok-1");
    expect(calls).toHaveLength(1);

    // Past expiry: re-mint.
    clock += 60_000;
    const refreshed = await provider.get();
    expect(refreshed.ok && String(refreshed.value)).toBe("tok-2");
    expect(calls).toHaveLength(2);
  });

  it("treats a token without expires_in as non-expiring within boot scope", async () => {
    let clock = 0;
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { access_token: "eternal" }));
    const provider = createTokenProvider({ auth: baseAuth, fetch, now: () => clock });

    await provider.get();
    clock += 100 * 24 * 60 * 60 * 1000; // 100 days later
    const later = await provider.get();
    expect(later.ok && String(later.value)).toBe("eternal");
    expect(calls).toHaveLength(1);
  });

  it("probe always mints without reading or populating the request cache", async () => {
    let mint = 0;
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(200, { access_token: `tok-${++mint}`, expires_in: 3600 }),
    );
    const provider = createTokenProvider({ auth: baseAuth, fetch, now: () => 0 });

    const first = await provider.get();
    const probe = await provider.probe();
    const cached = await provider.get();

    expect(first.ok && String(first.value)).toBe("tok-1");
    expect(isOk(probe)).toBe(true);
    expect(cached.ok && String(cached.value)).toBe("tok-1");
    expect(calls).toHaveLength(2);
  });
});

describe("createTokenProvider — single-flight", () => {
  it("a burst of concurrent get() calls mints exactly one token", async () => {
    let resolveMint: (r: FetchResponseLike) => void = () => {};
    const gate = new Promise<FetchResponseLike>((res) => { resolveMint = res; });

    let mintStarted = 0;
    const fetch: FetchLike = async () => {
      mintStarted += 1;
      return gate; // all callers park on the same gated mint
    };
    const provider = createTokenProvider({ auth: baseAuth, fetch });

    const pending = Promise.all([provider.get(), provider.get(), provider.get(), provider.get()]);
    // Let the microtask queue drain so every caller has entered get().
    await Promise.resolve();
    expect(mintStarted).toBe(1);

    resolveMint(jsonResponse(200, { access_token: "tok-1", expires_in: 3600 }));
    const results = await pending;

    expect(mintStarted).toBe(1);
    for (const r of results) expect(r.ok && String(r.value)).toBe("tok-1");
  });

  it("after the in-flight mint settles, a later expiry can mint again", async () => {
    let clock = 0;
    let n = 0;
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { access_token: `tok-${++n}`, expires_in: 60 }));
    const provider = createTokenProvider({ auth: baseAuth, fetch, now: () => clock });

    await Promise.all([provider.get(), provider.get()]);
    expect(calls).toHaveLength(1);

    clock += 120_000;
    await Promise.all([provider.get(), provider.get()]);
    expect(calls).toHaveLength(2);
  });
});

describe("createTokenProvider — error mapping (no throw escapes)", () => {
  it("a network failure maps to transient", async () => {
    const fetch: FetchLike = async () => { throw new Error("ECONNREFUSED"); };
    const provider = createTokenProvider({ auth: baseAuth, fetch });
    const result = await provider.get();
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error.kind).toBe("transient");
  });

  it("maps throwing and non-finite mint clocks to deterministic non-retriable Results", async () => {
    const fetch: FetchLike = async () =>
      jsonResponse(200, { access_token: "tok", expires_in: 60 });
    const clocks: Array<() => number> = [
      () => { throw new Error("clock exploded"); },
      () => Number.NaN,
      () => Number.POSITIVE_INFINITY,
    ];

    for (const now of clocks) {
      const result = await createTokenProvider({ auth: baseAuth, fetch, now }).get();
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.kind).toBe("node-crash");
        if (result.error.kind === "node-crash") {
          expect(result.error.message).toContain("clock");
          expect(result.error.retriability).toBe("non-retriable");
        }
      }
    }
  });

  it("returns a clock error from cached freshness checks instead of rejecting or re-minting", async () => {
    let reads = 0;
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(200, { access_token: "tok", expires_in: 60 }),
    );
    const provider = createTokenProvider({
      auth: baseAuth,
      fetch,
      now: () => {
        reads += 1;
        if (reads === 1) return 0;
        throw new Error("cached clock exploded");
      },
    });

    expect(isOk(await provider.get())).toBe(true);
    const cached = await provider.get();
    expect(isErr(cached)).toBe(true);
    if (!cached.ok) expect(cached.error.kind).toBe("node-crash");
    expect(calls).toHaveLength(1);
  });

  it("rejects a non-finite computed expiry instead of poisoning the cache", async () => {
    const fetch: FetchLike = async () =>
      jsonResponse(200, { access_token: "tok", expires_in: Number.MAX_VALUE });
    const result = await createTokenProvider({ auth: baseAuth, fetch, now: () => 0 }).get();

    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.message).toContain("computed token expiry");
      }
    }
  });

  it("a 5xx maps to transient with httpStatus", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(503, { error: "down" }));
    const provider = createTokenProvider({ auth: baseAuth, fetch });
    const result = await provider.get();
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      if (result.error.kind === "transient") expect(result.error.httpStatus).toBe(503);
    }
  });

  it("a 4xx maps to non-retriable node-crash and never leaks the body", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(401, { error: "invalid_grant", hint: "s3cret-leaked" }));
    const provider = createTokenProvider({ auth: baseAuth, fetch });
    const result = await provider.get();
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("non-retriable");
        expect(result.error.message).not.toContain("s3cret-leaked");
      }
    }
  });

  it("a missing access_token maps to non-retriable node-crash", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(200, { token_type: "bearer" }));
    const provider = createTokenProvider({ auth: baseAuth, fetch });
    const result = await provider.get();
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error.kind).toBe("node-crash");
  });

  it("invalid JSON maps to non-retriable node-crash and never leaks the parse-error body", async () => {
    // V8/Bun JSON parse errors echo a snippet of the offending body; if the body
    // embedded a token, a naive `e.message` passthrough would leak it. Simulate
    // exactly that: a SyntaxError whose text carries a credential-like fragment.
    const badResponse: FetchResponseLike = {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "{not json: access_token=s3cret-in-parse-error",
      json: async () => {
        throw new SyntaxError('Unexpected token in JSON: "access_token=s3cret-in-parse-error"');
      },
    };
    const fetch: FetchLike = async () => badResponse;
    const provider = createTokenProvider({ auth: baseAuth, fetch });
    const result = await provider.get();
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.message).not.toContain("s3cret-in-parse-error");
      }
    }
  });

  it("a schema-mismatch token body never leaks field VALUES into the error (paths only)", async () => {
    // Valid JSON that fails TokenResponseSchema: access_token is the wrong type
    // and its (secret-bearing) value must not reach the error — only the path.
    const { fetch } = recordingFetch(() =>
      jsonResponse(200, { access_token: { leaked: "s3cret-token-value" }, token_type: "bearer" }),
    );
    const provider = createTokenProvider({ auth: baseAuth, fetch });
    const result = await provider.get();
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.message).not.toContain("s3cret-token-value");
        // The diagnostic still names which field was wrong.
        expect(result.error.message).toContain("access_token");
      }
    }
  });

  it("a failed mint does not poison the cache: the next get() retries", async () => {
    let attempt = 0;
    const fetch: FetchLike = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient blip");
      return jsonResponse(200, { access_token: "tok-after-retry", expires_in: 3600 });
    };
    const provider = createTokenProvider({ auth: baseAuth, fetch });

    const firstResult = await provider.get();
    expect(isErr(firstResult)).toBe(true);

    const secondResult = await provider.get();
    expect(isOk(secondResult)).toBe(true);
    if (secondResult.ok) expect(String(secondResult.value)).toBe("tok-after-retry");
  });

  it("never surfaces the grant password inside a serialized error", async () => {
    // A 4xx echoes a body that embeds the secret; the mapped error must not.
    const { fetch } = recordingFetch(() =>
      jsonResponse(400, { error: "invalid_grant", echoed_password: "s3cret" }),
    );
    const provider = createTokenProvider({ auth: baseAuth, fetch });
    const result = await provider.get();
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(JSON.stringify(result.error)).not.toContain("s3cret");
    }
  });

  it("a 429 (rate-limit) maps to transient with httpStatus (retriable)", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(429, { error: "slow down" }));
    const provider = createTokenProvider({ auth: baseAuth, fetch });
    const result = await provider.get();
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      if (result.error.kind === "transient") expect(result.error.httpStatus).toBe(429);
    }
  });

  it("a 408 (request timeout) maps to transient with httpStatus (retriable)", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(408, { error: "too slow" }));
    const provider = createTokenProvider({ auth: baseAuth, fetch });
    const result = await provider.get();
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      if (result.error.kind === "transient") expect(result.error.httpStatus).toBe(408);
    }
  });

  it("our own timeout → transient, via a signal-respecting fake fetch", async () => {
    // A fetch that NEVER resolves on its own but rejects with an AbortError when
    // the (timeout-driven) signal fires — exercises the real timeout path.
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    const provider = createTokenProvider({ auth: baseAuth, fetch, defaultTimeoutMs: 5 });
    const result = await provider.get();
    expect(isErr(result)).toBe(true);
    // Our timeout abort sets signal.reason = Error("timeout") → transient.
    if (!result.ok) expect(result.error.kind).toBe("transient");
  });

  it("a non-timeout external AbortError → non-retriable node-crash (cancellation)", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    // No timeout configured — the only abort is the external one we fire.
    const provider = createTokenProvider({ auth: baseAuth, fetch });
    const external = new AbortController();
    const pending = provider.get(external.signal);
    external.abort(); // caller cancels — NOT a timeout
    const result = await pending;
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") expect(result.error.retriability).toBe("non-retriable");
    }
  });

  it("invalidate() during an in-flight mint is not overwritten by the resolving mint", async () => {
    // Gate the first mint so invalidate() can land while it is in flight.
    let release: (r: FetchResponseLike) => void = () => {};
    const gate = new Promise<FetchResponseLike>((res) => { release = res; });
    let n = 0;
    const fetch: FetchLike = async () => {
      n += 1;
      return n === 1 ? gate : jsonResponse(200, { access_token: "tok-2", expires_in: 3600 });
    };
    const provider = createTokenProvider({ auth: baseAuth, fetch });

    const firstGet = provider.get();
    await Promise.resolve(); // let the mint start
    // Caller drops the token mid-flight.
    provider.invalidate();
    // The in-flight mint now resolves with tok-1 — it MUST NOT repopulate cache.
    release(jsonResponse(200, { access_token: "tok-1", expires_in: 3600 }));
    await firstGet;

    // The next get() must re-mint (tok-2), not serve the resurrected tok-1.
    const next = await provider.get();
    expect(next.ok && String(next.value)).toBe("tok-2");
  });

  it("never surfaces the bearer token inside an error message", async () => {
    // The mint succeeds but a later failure path must not echo the token.
    const { fetch } = recordingFetch((n) =>
      n === 0
        ? jsonResponse(200, { access_token: "super-secret-token", expires_in: 60 })
        : jsonResponse(500, { error: "boom" }),
    );
    let clock = 0;
    const provider = createTokenProvider({ auth: baseAuth, fetch, now: () => clock });
    await provider.get();
    clock += 120_000;
    const result = await provider.get();
    if (!result.ok) {
      const serialized = JSON.stringify(result.error);
      expect(serialized).not.toContain("super-secret-token");
    }
  });
});
