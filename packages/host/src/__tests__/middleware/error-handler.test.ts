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
      const base = { message: "invalid", path: [] };
      const malformedIssues = [
        [null],
        [{ code: "custom", message: "missing path" }],
        [{ code: "custom", message: "bad path", path: {} }],
        [{ code: "not-a-zod-code", message: "bad code", path: [] }],
        [{ ...base, code: "invalid_type" }],
        [{ ...base, code: "too_big", origin: "number" }],
        [{ ...base, code: "too_small", minimum: 1 }],
        [{ ...base, code: "invalid_format" }],
        [{ ...base, code: "invalid_format", format: "regex" }],
        [{ ...base, code: "invalid_format", format: "starts_with" }],
        [{ ...base, code: "invalid_format", format: "ends_with" }],
        [{ ...base, code: "invalid_format", format: "includes" }],
        [{ ...base, code: "invalid_format", format: "regex", pattern: 42 }],
        [{ ...base, code: "invalid_format", format: "starts_with", prefix: 42 }],
        [{ ...base, code: "invalid_format", format: "ends_with", suffix: 42 }],
        [{ ...base, code: "invalid_format", format: "includes", includes: 42 }],
        [{ ...base, code: "not_multiple_of" }],
        [{ ...base, code: "unrecognized_keys", keys: ["ok", 1] }],
        [{ ...base, code: "invalid_union", errors: [[{ ...base, code: "too_big" }]] }],
        [{ ...base, code: "invalid_key", origin: "record" }],
        [{ ...base, code: "invalid_element", origin: "set", issues: [] }],
        [{ ...base, code: "invalid_value", values: [{}] }],
        [{ ...base, code: "custom", params: [] }],
      ];
      for (const issues of malformedIssues) {
        expect(parseHostError({ kind: "validation-failed", path: "/dag", issues }))
          .toBeUndefined();
        expect(parseHostError({ kind: "input-validation-failed", dagId: "dag", issues }))
          .toBeUndefined();
      }
    });

    it("accepts every canonical Zod issue discriminant and specialized format payload", () => {
      const custom = {
        code: "custom",
        message: "custom failed",
        path: [],
        params: { threshold: 3n },
      };
      const issues = [
        { code: "invalid_type", message: "type", path: ["value"], expected: "string" },
        { code: "too_big", message: "big", path: ["value"], origin: "bigint", maximum: 10n, inclusive: true },
        { code: "too_small", message: "small", path: ["value"], origin: "bigint", minimum: 1n, exact: false },
        { code: "invalid_format", message: "email", path: ["email"], format: "email" },
        { code: "invalid_format", message: "regex", path: [], format: "regex", pattern: "^[a-z]+$" },
        { code: "invalid_format", message: "prefix", path: [], format: "starts_with", prefix: "pre" },
        { code: "invalid_format", message: "suffix", path: [], format: "ends_with", suffix: "post" },
        { code: "invalid_format", message: "includes", path: [], format: "includes", includes: "middle" },
        { code: "not_multiple_of", message: "multiple", path: [], divisor: 3 },
        { code: "unrecognized_keys", message: "keys", path: [], keys: ["extra"] },
        { code: "invalid_union", message: "union", path: [], errors: [[custom]] },
        { code: "invalid_key", message: "key", path: [], origin: "record", issues: [custom] },
        { code: "invalid_element", message: "element", path: [], origin: "map", key: 2n, issues: [custom] },
        { code: "invalid_value", message: "literal", path: [], values: [1n, "one", true, null] },
        custom,
      ];

      const parsed = parseHostError({
        kind: "validation-failed",
        path: "/dag",
        issues,
      });

      expect(parsed?.kind).toBe("validation-failed");
      if (parsed?.kind !== "validation-failed") return;
      expect(parsed.issues.map((issue) => issue.code)).toEqual([
        "invalid_type",
        "too_big",
        "too_small",
        "invalid_format",
        "invalid_format",
        "invalid_format",
        "invalid_format",
        "invalid_format",
        "not_multiple_of",
        "unrecognized_keys",
        "invalid_union",
        "invalid_key",
        "invalid_element",
        "invalid_value",
        "custom",
      ]);
      expect(Object.isFrozen(parsed.issues)).toBe(true);
      expect(Object.isFrozen(parsed.issues[10])).toBe(true);
      const parsedCustom = parsed.issues.at(-1);
      expect(parsedCustom?.code).toBe("custom");
      if (parsedCustom?.code === "custom") {
        expect(Object.isFrozen(parsedCustom.params)).toBe(true);
        expect(parsedCustom.params?.threshold).toBe(3n);
      }
    });

    it("preserves bigint Zod issues internally and returns immutable JSON-safe 400 details", async () => {
      const issues = [
        { code: "too_small", message: "minimum", path: ["minimum"], origin: "bigint", minimum: 1n },
        { code: "too_big", message: "maximum", path: ["maximum"], origin: "bigint", maximum: 99n },
        { code: "invalid_value", message: "literal", path: ["literal"], values: [7n, 8n] },
      ];
      const hostErr = {
        kind: "input-validation-failed",
        dagId: "bigint-dag",
        issues,
      };
      const parsed = parseHostError(hostErr);
      expect(parsed?.kind).toBe("input-validation-failed");
      if (parsed?.kind !== "input-validation-failed") return;
      expect((parsed.issues[0] as { minimum: unknown }).minimum).toBe(1n);
      expect((parsed.issues[1] as { maximum: unknown }).maximum).toBe(99n);
      expect(Object.isFrozen(parsed.issues)).toBe(true);

      const { logger } = createTestLogger();
      const app = createApp(logger, () => {
        throw Object.assign(new Error("bigint validation"), hostErr);
      });
      const res = await app.request("/throw");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({
        ok: false,
        error: "input-validation-failed",
        details: {
          issues: [
            { code: "too_small", minimum: "1" },
            { code: "too_big", maximum: "99" },
            { code: "invalid_value", values: ["7", "8"] },
          ],
        },
      });
    });

    it("parses canonical recursively nested Zod issues into one frozen snapshot", () => {
      const nested = {
        code: "invalid_union",
        message: "union failed",
        path: ["payload"],
        errors: [[{
          code: "invalid_key",
          message: "key failed",
          path: [],
          origin: "record",
          issues: [{
            code: "invalid_element",
            message: "element failed",
            path: [0],
            origin: "map",
            key: "customer-id",
            issues: [{
              code: "too_big",
              message: "too large",
              path: ["amount"],
              origin: "number",
              maximum: 10,
              inclusive: true,
            }],
          }],
        }]],
      };

      const parsed = parseHostError({
        kind: "validation-failed",
        path: "/dag",
        issues: [nested],
      });

      expect(parsed?.kind).toBe("validation-failed");
      if (parsed?.kind !== "validation-failed") return;
      const union = parsed.issues[0] as Extract<(typeof parsed.issues)[number], { code: "invalid_union" }>;
      expect(union.errors[0]?.[0]?.code).toBe("invalid_key");
      expect(Object.isFrozen(union)).toBe(true);
      expect(Object.isFrozen(union.errors)).toBe(true);
      expect(Object.isFrozen(union.errors[0])).toBe(true);
      expect(Object.isFrozen(union.errors[0]?.[0])).toBe(true);
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
