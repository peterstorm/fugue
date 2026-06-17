/**
 * Tests for the shared form-POST transport (adapters/fetch-http-post.ts).
 *
 * Invariants under test:
 *   - AD-2 — the transport implements the existing `HttpPost` port (the one both
 *     Keycloak and Entra take), POSTing `application/x-www-form-urlencoded`.
 *   - FR-002 — a live transport for OAuth form-POST exchanges.
 *   - NFR-020 — a settled HTTP response (any status, any body) surfaces as a typed
 *     `{ status, json }` (never thrown); a transport-level fault PROPAGATES so the
 *     per-egress caller maps it to `infra-unreachable`.
 *
 * `fetch` is INJECTED with a recording fake — NO live network, NO global mock.
 */

import { describe, it, expect } from "bun:test";
import { createFetchHttpPost, type FetchLike } from "../fetch-http-post.js";
import type { HttpPost } from "../fetch-http-post.js";

/** A recording fake `fetch` returning a scripted status + body (or throwing). */
const recordingFetch = (
  script: { status: number; body: string } | (() => never),
) => {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (typeof script === "function") return script();
    return { status: script.status, text: async () => script.body };
  };
  return { fetchImpl, calls };
};

describe("createFetchHttpPost — form-POST request shape (AD-2 / FR-002)", () => {
  it("implements the HttpPost port (assignable to the exchange's injected type)", () => {
    const { fetchImpl } = recordingFetch({ status: 200, body: "{}" });
    const http: HttpPost = createFetchHttpPost(fetchImpl);
    expect(typeof http.post).toBe("function");
  });

  it("POSTs the URL-encoded body with the form content-type", async () => {
    const { fetchImpl, calls } = recordingFetch({
      status: 200,
      body: JSON.stringify({ access_token: "tok", expires_in: 3600 }),
    });
    const http = createFetchHttpPost(fetchImpl);

    const body = "grant_type=client_credentials&client_id=fugue-agents";
    await http.post("https://login.example/token", body);

    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://login.example/token");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(calls[0]?.body).toBe(body);
  });
});

describe("createFetchHttpPost — response mapping surfaces status + json (NFR-020)", () => {
  it("a 200 JSON body surfaces as { status, json }", async () => {
    const { fetchImpl } = recordingFetch({
      status: 200,
      body: JSON.stringify({ access_token: "app-only", expires_in: 1234 }),
    });
    const res = await createFetchHttpPost(fetchImpl).post("https://x/token", "a=b");
    expect(res.status).toBe(200);
    expect(res.json.access_token).toBe("app-only");
    expect(res.json.expires_in).toBe(1234);
  });

  it("a 4xx denial body surfaces (the caller classifies by status, not a throw)", async () => {
    const { fetchImpl } = recordingFetch({
      status: 401,
      body: JSON.stringify({ error: "invalid_client", error_description: "rejected" }),
    });
    const res = await createFetchHttpPost(fetchImpl).post("https://x/token", "a=b");
    expect(res.status).toBe(401);
    expect(res.json.error).toBe("invalid_client");
    expect(res.json.error_description).toBe("rejected");
  });

  it("a non-JSON body (e.g. an HTML 502 page) surfaces with json={} so the caller maps by status", async () => {
    const { fetchImpl } = recordingFetch({ status: 502, body: "<html>Bad Gateway</html>" });
    const res = await createFetchHttpPost(fetchImpl).post("https://x/token", "a=b");
    expect(res.status).toBe(502);
    expect(res.json).toEqual({});
  });

  it("an empty body surfaces with json={}", async () => {
    const { fetchImpl } = recordingFetch({ status: 503, body: "" });
    const res = await createFetchHttpPost(fetchImpl).post("https://x/token", "a=b");
    expect(res.status).toBe(503);
    expect(res.json).toEqual({});
  });

  it("a JSON array/scalar body collapses to json={} (only objects are surfaced)", async () => {
    const { fetchImpl } = recordingFetch({ status: 200, body: "[1,2,3]" });
    const res = await createFetchHttpPost(fetchImpl).post("https://x/token", "a=b");
    expect(res.json).toEqual({});
  });
});

describe("createFetchHttpPost — transport-unreachable propagates (NFR-020)", () => {
  it("a transport-level reject PROPAGATES (the caller's try/catch maps to infra-unreachable)", async () => {
    const { fetchImpl } = recordingFetch(() => {
      throw new TypeError("fetch failed");
    });
    const http = createFetchHttpPost(fetchImpl);
    await expect(http.post("https://unreachable/token", "a=b")).rejects.toThrow(/fetch failed/);
  });

  it("the propagated reject is NOT swallowed into a fake 200 (no silent success)", async () => {
    const { fetchImpl } = recordingFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    let resolved = false;
    try {
      await createFetchHttpPost(fetchImpl).post("https://x/token", "a=b");
      resolved = true;
    } catch {
      /* expected */
    }
    expect(resolved).toBe(false);
  });
});
