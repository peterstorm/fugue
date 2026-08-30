/**
 * Tests for error-handler middleware — all 4 dispatch paths.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createErrorHandler } from "../../http/middleware/error-handler.js";
import type {
  ErrorHandlerFallback,
  ErrorHandlerLogger,
} from "../../http/middleware/error-handler.js";
import { parseHostError } from "../../domain/host-error.js";
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
  writeFallback?: ErrorHandlerFallback,
) => {
  const app = new Hono();
  app.onError(createErrorHandler(logger, writeFallback));
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

  describe("HostError runtime recognition", () => {
    const issue = { code: "custom", message: "invalid", path: ["field"] } as never;
    const validVariants: readonly HostError[] = [
      { kind: "git-clone-failed", url: "repo", message: "failed" },
      { kind: "git-pull-failed", message: "failed" },
      { kind: "git-timeout", operation: "pull" },
      { kind: "git-spawn-failed", operation: "clone", message: "failed" },
      { kind: "import-failed", path: "/dag", message: "failed", stack: "stack" },
      { kind: "validation-failed", path: "/dag", issues: [issue] },
      { kind: "no-default-export", path: "/dag" },
      { kind: "dag-not-found", dagId: "dag" as never, available: ["other" as never] },
      { kind: "dag-disabled", dagId: "dag" as never, reason: "disabled" },
      { kind: "global-concurrency-exceeded" },
      { kind: "dag-concurrency-exceeded", dagId: "dag" as never },
      { kind: "timeout", dagId: "dag" as never, runId: "run" as never, timeoutMs: 10 },
      { kind: "redis-unavailable", operation: "get" },
      { kind: "spend-ledger-unavailable", backend: "file", operation: "read", message: "failed" },
      { kind: "bun-install-failed", message: "failed" },
      { kind: "config-invalid", message: "failed" },
      { kind: "tenant-config-invalid", message: "failed" },
      { kind: "input-validation-failed", dagId: "dag" as never, issues: [issue] },
      { kind: "dag-validation-failed", dagId: "dag" as never, reason: "shape", message: "failed" },
      { kind: "body-parse-failed", dagId: "dag" as never, message: "failed" },
      { kind: "discovery-failed", dagsRoot: "/dags", message: "failed" },
      { kind: "async-result-expired", runId: "run" as never },
      { kind: "run-not-found", runId: "run" as never },
      { kind: "run-lease-lost", runId: "run" as never },
      { kind: "run-not-suspended", runId: "run" as never, status: "running" },
      { kind: "notification-failed", operation: "send" },
      { kind: "unauthorized", reason: "missing" },
      { kind: "forbidden", dagId: "dag" as never, callerTeam: "a", dagTeam: "b" },
      { kind: "team-already-exists", team: "a" },
      { kind: "team-not-found", team: "a" },
      { kind: "tenant-unknown" },
      { kind: "tenant-over-quota", tenant: "tenant" as never, retryAfterSeconds: 7 as never },
      { kind: "worker-unavailable", tenant: "tenant" as never },
      { kind: "internal-invariant-violated", message: "failed", context: { nested: { value: [1] } } },
      { kind: "fs-purge-failed", message: "failed" },
    ];

    it("parses every valid variant into a fresh deeply immutable snapshot", () => {
      for (const source of validVariants) {
        const parsed = parseHostError(source);
        expect(parsed).toBeDefined();
        expect(parsed).not.toBe(source);
        expect(parsed?.kind).toBe(source.kind);
        expect(Object.isFrozen(parsed)).toBe(true);
      }

      const parsed = parseHostError(validVariants.at(-2));
      expect(parsed?.kind).toBe("internal-invariant-violated");
      if (parsed?.kind === "internal-invariant-violated") {
        const nested = parsed.context.nested as { readonly value: readonly number[] };
        expect(Object.isFrozen(parsed.context)).toBe(true);
        expect(Object.isFrozen(nested)).toBe(true);
        expect(Object.isFrozen(nested.value)).toBe(true);
      }
    });

    it("is total for throwing getters and revoked proxies", async () => {
      const throwingGetter = Object.defineProperty({}, "kind", {
        enumerable: true,
        get: () => { throw new Error("getter trap"); },
      });
      const revoked = Proxy.revocable({ kind: "tenant-unknown" }, {});
      revoked.revoke();

      expect(parseHostError(throwingGetter)).toBeUndefined();
      expect(parseHostError(revoked.proxy)).toBeUndefined();

      for (const hostile of [throwingGetter, revoked.proxy]) {
        const { logger } = createTestLogger();
        const wrapped = new Error("wrapped hostile cause", { cause: hostile });
        const app = createApp(logger, () => { throw wrapped; });
        const res = await app.request("/throw");
        expect(res.status).toBe(500);
        expect(await res.json()).toMatchObject({ error: "internal-error" });
      }
    });

    it("snapshots each field once so later mutation and getter drift cannot change policy", () => {
      let reads = 0;
      const source = {
        kind: "tenant-config-invalid",
        get message() {
          reads += 1;
          return reads === 1 ? "first" : "drifted";
        },
      };

      const parsed = parseHostError(source);
      expect(parsed).toEqual({ kind: "tenant-config-invalid", message: "first" });
      expect(reads).toBe(1);
      expect(Object.isFrozen(parsed)).toBe(true);
    });

    it("rejects malformed issue elements for both validation variants", () => {
      const malformedIssues = [
        [null],
        [{ code: "custom", message: "missing path" }],
        [{ code: "custom", message: "bad path", path: {} }],
        [{ code: "not-a-zod-code", message: "bad code", path: [] }],
      ];
      for (const issues of malformedIssues) {
        expect(parseHostError({ kind: "validation-failed", path: "/dag", issues }))
          .toBeUndefined();
        expect(parseHostError({ kind: "input-validation-failed", dagId: "dag", issues }))
          .toBeUndefined();
      }
    });

    it("routes unknown and incomplete discriminated shapes to the generic path", async () => {
      for (const hostile of [
        { kind: "made-up-kind" },
        { kind: "dag-not-found" },
        { kind: "dag-not-found", dagId: "dag", available: { join: 42 } },
        { kind: "timeout", dagId: "dag", runId: "run", timeoutMs: Number.NaN },
        { kind: "tenant-over-quota", tenant: "acme", retryAfterSeconds: -1 },
      ]) {
        const { logger } = createTestLogger();
        const app = createApp(logger, () => {
          throw Object.assign(new Error("hostile"), hostile);
        });
        const res = await app.request("/throw");
        expect(res.status).toBe(500);
        expect(await res.json()).toMatchObject({ error: "internal-error" });
      }
    });

    it("rejects a hostile HostError-shaped cause without throwing in an exhaustive matcher", async () => {
      const { logger } = createTestLogger();
      const wrapped = new Error("wrapped", {
        cause: { kind: "validation-failed", path: "/tmp/dag", issues: null },
      });
      const app = createApp(logger, () => { throw wrapped; });

      const res = await app.request("/throw");
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ error: "internal-error" });
    });
  });

  describe("logger failure isolation", () => {
    const throwingLogger: ErrorHandlerLogger = {
      error: () => { throw new Error("logger unavailable"); },
    };

    it("preserves HostError, framework-error, and generic HTTP responses", async () => {
      const cases = [
        {
          thrown: Object.assign(new Error("host"), {
            kind: "internal-invariant-violated",
            message: "invariant",
            context: {},
          }),
          expectedError: "internal-invariant-violated",
        },
        {
          thrown: Object.assign(new Error("framework"), {
            frameworkErrorKind: "node-execution-error",
          }),
          expectedError: "node-execution-error",
        },
        { thrown: new Error("generic"), expectedError: "internal-error" },
      ] as const;

      for (const testCase of cases) {
        const app = createApp(throwingLogger, () => { throw testCase.thrown; }, () => {});
        const res = await app.request("/throw");
        expect(res.status).toBe(500);
        expect(await res.json()).toMatchObject({ error: testCase.expectedError });
      }
    });

    it("attempts a separately guarded safe fallback when the logger throws", async () => {
      const fallback: string[] = [];
      const app = createApp(
        throwingLogger,
        () => { throw new Error("generic secret"); },
        (diagnostic) => { fallback.push(diagnostic); },
      );

      const res = await app.request("/throw");
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ error: "internal-error" });
      expect(fallback).toHaveLength(1);
      expect(fallback[0]).toContain("host error-handler fallback");
      expect(fallback[0]).toContain("logger unavailable");
    });

    it("keeps the selected response authoritative when logger and fallback both throw", async () => {
      const app = createApp(
        throwingLogger,
        () => { throw new Error("generic secret"); },
        () => { throw new Error("stderr unavailable"); },
      );

      const res = await app.request("/throw");
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ error: "internal-error" });
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
