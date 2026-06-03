/**
 * Unit tests for the built-in HTTP capability implementation.
 *
 * Tests the real `createHttpCapability` against a local Bun.serve() server.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { z } from "zod";
import { createHttpCapability, createFakeHttpCapability } from "../http/http-capability.js";
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
      // Echoes the request body, verb, and Content-Type back so tests can
      // assert the body is actually serialized and transmitted (not dropped)
      // and that the capability defaults Content-Type when a body is present.
      if (url.pathname === "/echo" && (req.method === "POST" || req.method === "PUT")) {
        return req.json().then((body) =>
          Response.json({
            method: req.method,
            received: body,
            contentType: req.headers.get("content-type"),
          }),
        );
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
      if (url.pathname === "/malformed-body" && req.method === "GET") {
        return new Response("<html>not json</html>", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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

  it("transmits the JSON body and defaults Content-Type for POST and PUT", async () => {
    const http = createHttpCapability({ baseUrl }).client;
    const EchoSchema = z.object({
      method: z.string(),
      received: z.object({ items: z.array(z.number()) }),
      contentType: z.string(),
    });

    const post = await http.post("/echo", { items: [1, 2, 3] }, { schema: EchoSchema });
    expect(isOk(post)).toBe(true);
    if (post.ok) {
      expect(post.value.method).toBe("POST");
      expect(post.value.received).toEqual({ items: [1, 2, 3] });
      expect(post.value.contentType).toBe("application/json");
    }

    const put = await http.put("/echo", { items: [9] }, { schema: EchoSchema });
    expect(isOk(put)).toBe(true);
    if (put.ok) {
      expect(put.value.method).toBe("PUT");
      expect(put.value.received).toEqual({ items: [9] });
      expect(put.value.contentType).toBe("application/json");
    }
  });

  it("returns transient error on HTTP 500 with structured httpStatus", async () => {
    const http = createHttpCapability({ baseUrl }).client;
    const result = await http.get("/error", { schema: z.any() });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      expect(result.error.kind === "transient" && result.error.message).toContain("500");
      expect(result.error.kind === "transient" && result.error.httpStatus).toBe(500);
    }
  });

  it("carries httpStatus 404 so callers can branch without string-matching", async () => {
    const http = createHttpCapability({ baseUrl }).client;
    const result = await http.get("/no-such-route", { schema: z.any() });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      expect(result.error.kind === "transient" && result.error.httpStatus).toBe(404);
    }
  });

  it("returns node-crash (not null-through-schema) when a 200 body is not valid JSON", async () => {
    const http = createHttpCapability({ baseUrl }).client;
    // A nullable schema must NOT swallow the parse failure as a null value.
    const result = await http.get("/malformed-body", { schema: z.object({ x: z.string() }).nullable() });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect(result.error.kind === "node-crash" && result.error.message).toContain("not valid JSON");
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

  it("joins a trailing-slash baseUrl with a leading-slash path (no double slash)", async () => {
    // A double slash would make the path "//users/123" and the server would 404.
    const http = createHttpCapability({ baseUrl: `${baseUrl}/` }).client;
    const result = await http.get("/users/123", {
      schema: z.object({ id: z.string(), name: z.string() }),
    });
    expect(isOk(result)).toBe(true);
  });

  it("joins a path without a leading slash (slash inserted)", async () => {
    const http = createHttpCapability({ baseUrl }).client;
    const result = await http.get("users/123", {
      schema: z.object({ id: z.string(), name: z.string() }),
    });
    expect(isOk(result)).toBe(true);
  });

  it("joins a trailing-slash baseUrl with a slash-less path", async () => {
    const http = createHttpCapability({ baseUrl: `${baseUrl}/` }).client;
    const result = await http.get("users/123", {
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

  it("aborts a mid-flight request when the signal fires", async () => {
    const http = createHttpCapability({ baseUrl }).client;
    const controller = new AbortController();
    // /slow takes 2s — abort shortly after the request is in flight.
    const pending = http.get("/slow", { schema: z.any(), signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const result = await pending;
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("aborted");
    }
  });

  it("removes its abort listener from a shared signal after completion", async () => {
    const http = createHttpCapability({ baseUrl }).client;
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const origAdd = controller.signal.addEventListener.bind(controller.signal);
    const origRemove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((...args: Parameters<typeof origAdd>) => {
      added++;
      return origAdd(...args);
    }) as typeof controller.signal.addEventListener;
    controller.signal.removeEventListener = ((...args: Parameters<typeof origRemove>) => {
      removed++;
      return origRemove(...args);
    }) as typeof controller.signal.removeEventListener;

    // Several sequential requests against the SAME long-lived signal must not
    // accumulate listeners.
    for (let i = 0; i < 3; i++) {
      const result = await http.get("/users/123", {
        schema: z.object({ id: z.string(), name: z.string() }),
        signal: controller.signal,
      });
      expect(isOk(result)).toBe(true);
    }
    expect(added).toBe(3);
    expect(removed).toBe(3);
  });
});

describe("createFakeHttpCapability", () => {
  it("returns node-crash when a fake route body fails the schema — the fake must not diverge from the real capability", async () => {
    const fakeHttp = createFakeHttpCapability({
      "GET /users/123": { id: 123, name: "Alice" }, // id is a number — schema wants string
    }).client;
    const result = await fakeHttp.get("/users/123", {
      schema: z.object({ id: z.string(), name: z.string() }),
    });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect(result.error.kind === "node-crash" && result.error.message).toContain("validation failed");
      expect(result.error.kind === "node-crash" && result.error.retriability).toBe("non-retriable");
    }
  });
});
