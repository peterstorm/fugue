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
        kind: "concurrency-exceeded",
        scope: "dag",
        dagId: "slow-dag" as any,
      };
      const wrapped = new Error("DAG execution failed", { cause: hostErr });
      const app = createApp(logger, () => { throw wrapped; });

      const res = await app.request("/throw");
      expect(res.status).toBe(429);

      const body = await res.json();
      expect(body.error).toBe("concurrency-exceeded");
    });

    it("includes Retry-After header for concurrency errors", async () => {
      const { logger } = createTestLogger();
      const hostErr: HostError = {
        kind: "concurrency-exceeded",
        scope: "global",
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
      expect(body.message).toBe("node execution failed");

      // Must be logged
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].msg).toBe("Framework error in request handler");
      expect(logs[0].data?.kind).toBe("node-execution-error");
    });
  });

  describe("Path 4: Generic unhandled Error", () => {
    it("returns 500 with internal-error", async () => {
      const { logger, logs } = createTestLogger();
      const app = createApp(logger, () => { throw new Error("unexpected null"); });

      const res = await app.request("/throw");
      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("internal-error");
      expect(body.message).toBe("unexpected null");
    });

    it("logs error with stack trace", async () => {
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
