/**
 * Tests for the Graph transport (adapters/fetch-graph-http.ts).
 *
 * Invariants under test:
 *   - AD-4 — Graph's own bearer GET/POST transport over absolute URLs, distinct
 *     from the shared form-POST `HttpPost`. Implements the existing `GraphHttp` port.
 *   - FR-002 — a live transport for downstream Graph calls.
 *   - NFR-020 — a settled response surfaces as typed `{ status, json }`; a
 *     transport fault PROPAGATES for `runGraph`'s typed mapping.
 *
 * `fetch` is INJECTED with a recording fake — NO live network.
 */

import { describe, it, expect } from "bun:test";
import { createFetchGraphHttp, type GraphFetchLike } from "../fetch-graph-http.js";
import type { GraphHttp } from "../graph-capability.js";

const recordingFetch = (
  script: { status: number; body: string } | (() => never),
) => {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const fetchImpl: GraphFetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (typeof script === "function") return script();
    return { status: script.status, text: async () => script.body };
  };
  return { fetchImpl, calls };
};

describe("createFetchGraphHttp — bearer GET (AD-4 / FR-002)", () => {
  it("implements the GraphHttp port", () => {
    const { fetchImpl } = recordingFetch({ status: 200, body: "{}" });
    const http: GraphHttp = createFetchGraphHttp(fetchImpl);
    expect(typeof http.request).toBe("function");
  });

  it("presents the bearer and targets the absolute URL on a GET (no body)", async () => {
    const { fetchImpl, calls } = recordingFetch({
      status: 200,
      body: JSON.stringify({ displayName: "Marketing" }),
    });
    const http = createFetchGraphHttp(fetchImpl);

    const res = await http.request({
      method: "GET",
      url: "https://graph.microsoft.com/v1.0/sites/site-1",
      bearer: "app-only-token",
    });

    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://graph.microsoft.com/v1.0/sites/site-1");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.Authorization).toBe("Bearer app-only-token");
    expect(calls[0]?.body).toBeUndefined();
    expect(res.status).toBe(200);
    expect(res.json.displayName).toBe("Marketing");
  });
});

describe("createFetchGraphHttp — bearer POST with JSON body", () => {
  it("presents the bearer, JSON-encodes the body, sets the JSON content-type", async () => {
    const { fetchImpl, calls } = recordingFetch({ status: 202, body: "" });
    const http = createFetchGraphHttp(fetchImpl);

    const envelope = { message: { subject: "hi", body: { contentType: "Text", content: "hello" } } };
    const res = await http.request({
      method: "POST",
      url: "https://graph.microsoft.com/v1.0/users/me@x/sendMail",
      bearer: "tok-2",
      body: envelope,
    });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://graph.microsoft.com/v1.0/users/me@x/sendMail");
    expect(calls[0]?.headers.Authorization).toBe("Bearer tok-2");
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.body).toBe(JSON.stringify(envelope));
    expect(res.status).toBe(202);
    expect(res.json).toEqual({}); // empty 202 body collapses to {}
  });

  it("a POST without a body sends no body and no JSON content-type", async () => {
    const { fetchImpl, calls } = recordingFetch({ status: 200, body: "{}" });
    const http = createFetchGraphHttp(fetchImpl);
    await http.request({ method: "POST", url: "https://graph.microsoft.com/v1.0/x", bearer: "t" });
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers["Content-Type"]).toBeUndefined();
  });
});

describe("createFetchGraphHttp — response mapping (NFR-020)", () => {
  it("a 4xx Graph error body surfaces as { status, json } (caller maps to downstream-denied)", async () => {
    const { fetchImpl } = recordingFetch({
      status: 403,
      body: JSON.stringify({ error: { code: "Authorization_RequestDenied", message: "Access denied" } }),
    });
    const res = await createFetchGraphHttp(fetchImpl).request({
      method: "GET",
      url: "https://graph.microsoft.com/v1.0/sites/forbidden",
      bearer: "t",
    });
    expect(res.status).toBe(403);
    expect((res.json.error as Record<string, unknown>).message).toBe("Access denied");
  });

  it("a non-JSON body surfaces with json={} so the caller classifies by status", async () => {
    const { fetchImpl } = recordingFetch({ status: 500, body: "Internal Server Error" });
    const res = await createFetchGraphHttp(fetchImpl).request({
      method: "GET",
      url: "https://graph.microsoft.com/v1.0/x",
      bearer: "t",
    });
    expect(res.status).toBe(500);
    expect(res.json).toEqual({});
  });
});

describe("createFetchGraphHttp — transport-unreachable propagates (NFR-020)", () => {
  it("a transport-level reject PROPAGATES (runGraph maps it to infra-unreachable)", async () => {
    const { fetchImpl } = recordingFetch(() => {
      throw new TypeError("fetch failed");
    });
    const http = createFetchGraphHttp(fetchImpl);
    await expect(
      http.request({ method: "GET", url: "https://graph.microsoft.com/v1.0/x", bearer: "t" }),
    ).rejects.toThrow(/fetch failed/);
  });
});
