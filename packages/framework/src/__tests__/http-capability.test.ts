/**
 * Unit tests for the built-in HTTP capability implementation.
 *
 * Tests the real `createHttpCapability` against a local Bun.serve() server.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { z } from "zod";
import { createHttpCapability } from "../http/http-capability.js";
import { isOk, isErr } from "../types/result.js";

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/users/123" && req.method === "GET") {
        return Response.json({ id: "123", name: "Alice" });
      }
      if (url.pathname === "/orders" && req.method === "POST") {
        return Response.json({ orderId: "ord-1", status: "created" });
      }
      if (url.pathname === "/slow" && req.method === "GET") {
        return new Promise((resolve) =>
          setTimeout(() => resolve(Response.json({ done: true })), 2000),
        );
      }
      if (url.pathname === "/error" && req.method === "GET") {
        return new Response("Internal Server Error", { status: 500 });
      }
      if (url.pathname === "/invalid-json" && req.method === "GET") {
        return Response.json({ unexpected: "shape" });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
});

describe("createHttpCapability (real HTTP)", () => {
  it("GET with schema validation", async () => {
    const http = createHttpCapability({ baseUrl }).client;
    const UserSchema = z.object({ id: z.string(), name: z.string() });
    const result = await http.get("/users/123", { schema: UserSchema });
    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ id: "123", name: "Alice" });
    }
  });

  it("POST with body", async () => {
    const http = createHttpCapability({ baseUrl }).client;
    const OrderSchema = z.object({ orderId: z.string(), status: z.string() });
    const result = await http.post("/orders", { items: [1, 2] }, { schema: OrderSchema });
    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ orderId: "ord-1", status: "created" });
    }
  });

  it("returns transient error on HTTP 500", async () => {
    const http = createHttpCapability({ baseUrl }).client;
    const result = await http.get("/error", { schema: z.any() });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      expect(result.error.kind === "transient" && result.error.message).toContain("500");
    }
  });

  it("returns node-crash on schema validation failure", async () => {
    const http = createHttpCapability({ baseUrl }).client;
    const StrictSchema = z.object({ id: z.string(), name: z.string() });
    // /invalid-json returns { unexpected: "shape" } which doesn't match
    const result = await http.get("/invalid-json", { schema: StrictSchema });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
    }
  });

  it("respects timeout", async () => {
    const http = createHttpCapability({ baseUrl, timeoutMs: 50 }).client;
    const result = await http.get("/slow", { schema: z.any() });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      expect(result.error.kind === "transient" && result.error.message).toContain("timed out");
    }
  });

  it("respects per-request timeout override", async () => {
    const http = createHttpCapability({ baseUrl, timeoutMs: 5000 }).client;
    const result = await http.get("/slow", { schema: z.any(), timeoutMs: 50 });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
    }
  });

  it("applies default headers", async () => {
    // The server doesn't check headers, but we can verify no crash
    const http = createHttpCapability({
      baseUrl,
      defaultHeaders: { "Authorization": "Bearer test-token" },
    }).client;
    const result = await http.get("/users/123", { schema: z.object({ id: z.string(), name: z.string() }) });
    expect(isOk(result)).toBe(true);
  });

  it("handles absolute URLs (ignores baseUrl)", async () => {
    const http = createHttpCapability({ baseUrl: "http://should-not-use.invalid" }).client;
    const result = await http.get(`${baseUrl}/users/123`, {
      schema: z.object({ id: z.string(), name: z.string() }),
    });
    expect(isOk(result)).toBe(true);
  });

  it("supports abort signal", async () => {
    const http = createHttpCapability({ baseUrl }).client;
    const controller = new AbortController();
    controller.abort();
    const result = await http.get("/users/123", {
      schema: z.any(),
      signal: controller.signal,
    });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("aborted");
    }
  });
});
