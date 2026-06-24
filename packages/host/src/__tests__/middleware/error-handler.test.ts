/**
 * Tests for error-handler middleware — all 4 dispatch paths.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createErrorHandler } from "../../http/middleware/error-handler.js";
import type { ErrorHandlerLogger } from "../../http/middleware/error-handler.js";
import type { HostError } from "../../domain/host-error.js";

// ── Test Logger ────────────────────────────────────────────────────────────

const createTestLogger = () => {
  const logs: Array<{ msg: string; data?: Record<string, unknown> }> = [];
  const logger: ErrorHandlerLogger = {
    error: (msg, data) => { logs.push({ msg, data }); },
  };
  return { logger, logs };
};

// ── Test App Factory ───────────────────────────────────────────────────────

const createApp = (
  logger: ErrorHandlerLogger,
  throwFn: () => never,
) => {
  const app = new Hono();
  app.onError(createErrorHandler(logger));
  app.get("/throw", () => { throwFn(); });
  return app;
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("error-handler middleware", () => {
  describe("Path 1: Direct HostError thrown", () => {
    it("maps to structured response with correct status", async () => {
      const { logger } = createTestLogger();
      const hostErr: HostError = {
        kind: "dag-not-found",
        dagId: "my-dag" as any,
        available: [],
      };
      // Hono requires Error instances. Wrap with cause pattern (production path).
      const app = createApp(logger, () => { throw Object.assign(new Error("dag-not-found"), hostErr); });

      const res = await app.request("/throw");
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("dag-not-found");
    });

    it("includes details for input-validation-failed", async () => {
      const { logger } = createTestLogger();
      const hostErr: HostError = {
        kind: "input-validation-failed",
        dagId: "test" as any,
        issues: [{ message: "required", path: ["name"], code: "custom" } as any],
      };
      const app = createApp(logger, () => { throw Object.assign(new Error("validation"), hostErr); });

      const res = await app.request("/throw");
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.details).toBeDefined();
      expect(body.details.issues).toHaveLength(1);
    });
  });

  describe("Path 2: Error with HostError as .cause", () => {
    it("unwraps cause and maps to correct status", async () => {
      const { logger } = createTestLogger();
      const hostErr: HostError = {
        kind: "dag-concurrency-exceeded",
        dagId: "slow-dag" as any,
      };
      const wrapped = new Error("DAG execution failed", { cause: hostErr });
      const app = createApp(logger, () => { throw wrapped; });

      const res = await app.request("/throw");
      expect(res.status).toBe(429);

      const body = await res.json();
      expect(body.error).toBe("dag-concurrency-exceeded");
    });

    it("includes Retry-After header for concurrency errors", async () => {
      const { logger } = createTestLogger();
      const hostErr: HostError = {
        kind: "global-concurrency-exceeded",
      };
      const wrapped = new Error("limit hit", { cause: hostErr });
      const app = createApp(logger, () => { throw wrapped; });

      const res = await app.request("/throw");
      expect(res.headers.get("Retry-After")).toBe("5");
    });
  });

  describe("Path 3: Error with frameworkErrorKind", () => {
    it("returns 500 with the framework error kind", async () => {
      const { logger, logs } = createTestLogger();
      const err = Object.assign(new Error("node execution failed"), {
        frameworkErrorKind: "node-execution-error",
      });
      const app = createApp(logger, () => { throw err; });

      const res = await app.request("/throw");
      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.error).toBe("node-execution-error");
      // Message is sanitized to kind-based template (not raw thrown.message)
      expect(body.message).toBe("Framework error: node-execution-error");

      // Must be logged
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].msg).toBe("Framework error in request handler");
      expect(logs[0].data?.kind).toBe("node-execution-error");
    });
  });

  describe("Path 1b: >=500 HostError — generic body, full server-side log (info-disclosure)", () => {
    it("internal-invariant-violated → 500 with generic message, no details, no leaked internals; logs full detail", async () => {
      const { logger, logs } = createTestLogger();
      const hostErr: HostError = {
        kind: "internal-invariant-violated",
        message: "secret internal detail",
        context: { forged: "forged-tenant-id-xyz" },
      };
      const app = createApp(logger, () => { throw Object.assign(new Error("invariant"), hostErr); });

      const res = await app.request("/throw");

      // (1) status is the expected 5xx
      expect(res.status).toBe(500);

      const raw = await res.text();
      const body = JSON.parse(raw);

      // (2) generic client message, NO details field
      expect(body.ok).toBe(false);
      expect(body.error).toBe("internal-invariant-violated");
      expect(body.message).toBe("An unexpected error occurred");
      expect(body.details).toBeUndefined();

      // (3) serialized body must NOT contain raw message/context text
      expect(raw).not.toContain("secret internal detail");
      expect(raw).not.toContain("forged-tenant-id-xyz");

      // (4) logger.error WAS called with the full detail + context server-side
      expect(logs.length).toBe(1);
      expect(logs[0].msg).toBe("Host error in request handler");
      expect(logs[0].data?.kind).toBe("internal-invariant-violated");
      expect(logs[0].data?.detail).toContain("secret internal detail");
      expect(logs[0].data?.context).toEqual({ forged: "forged-tenant-id-xyz" });
    });

    it("worker-unavailable → 503 with generic message, no details, Retry-After preserved; logs full detail", async () => {
      const { logger, logs } = createTestLogger();
      const hostErr: HostError = {
        kind: "worker-unavailable",
        tenant: "acme-secret-tenant" as any,
      };
      const wrapped = new Error("worker down", { cause: hostErr });
      const app = createApp(logger, () => { throw wrapped; });

      const res = await app.request("/throw");

      // (1) status is the expected 5xx
      expect(res.status).toBe(503);

      const raw = await res.text();
      const body = JSON.parse(raw);

      // (2) generic client message, NO details field (so the tenant id is not echoed)
      expect(body.message).toBe("An unexpected error occurred");
      expect(body.details).toBeUndefined();

      // (3) serialized body must NOT leak the tenant id carried by the error
      expect(raw).not.toContain("acme-secret-tenant");

      // Retry-After is safe to advertise on the 503 path and must be preserved.
      expect(res.headers.get("Retry-After")).toBe("5");

      // (4) full detail (incl. tenant) logged server-side only
      expect(logs.length).toBe(1);
      expect(logs[0].msg).toBe("Host error in request handler");
      expect(logs[0].data?.kind).toBe("worker-unavailable");
      expect(logs[0].data?.detail).toContain("acme-secret-tenant");
    });
  });

  describe("Path 4: Generic unhandled Error", () => {
    it("returns 500 with sanitized message (never leaks internals)", async () => {
      const { logger, logs } = createTestLogger();
      const app = createApp(logger, () => { throw new Error("unexpected null"); });

      const res = await app.request("/throw");
      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("internal-error");
      // SECURITY: message must NOT contain the thrown error's internal details
      expect(body.message).toBe("An unexpected error occurred");
      expect(body.message).not.toContain("unexpected null");
    });

    it("logs full error details server-side (not in response)", async () => {
      const { logger, logs } = createTestLogger();
      const app = createApp(logger, () => { throw new Error("oops"); });

      await app.request("/throw");

      expect(logs.length).toBe(1);
      expect(logs[0].msg).toBe("Unhandled error in request handler");
      expect(logs[0].data?.error).toBe("oops");
      expect(logs[0].data?.stack).toBeDefined();
    });

    it("logs cause chain when present", async () => {
      const { logger, logs } = createTestLogger();
      const cause = new Error("root cause");
      const wrapped = new Error("wrapper", { cause });
      const app = createApp(logger, () => { throw wrapped; });

      await app.request("/throw");

      expect(logs[0].data?.causeMessage).toBe("root cause");
      expect(logs[0].data?.causeStack).toBeDefined();
    });
  });
});
