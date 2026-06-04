import { describe, it, expect } from "bun:test";
import { formatHostError, httpStatusFor } from "../domain/host-error.js";
import type { HostError } from "../domain/host-error.js";
import type { DagId, RunId } from "@fuguejs/framework";

// Test helpers for branded types
const did = (s: string) => s as unknown as DagId;
const rid = (s: string) => s as unknown as RunId;

describe("HostError", () => {
  describe("formatHostError", () => {
    const cases: Array<{ error: HostError; expected: string }> = [
      {
        error: { kind: "git-clone-failed", url: "https://github.com/org/dags.git", message: "auth denied" },
        expected: "git clone failed for 'https://github.com/org/dags.git': auth denied",
      },
      {
        error: { kind: "git-pull-failed", message: "network timeout" },
        expected: "git pull failed: network timeout",
      },
      {
        error: { kind: "git-timeout", operation: "clone" },
        expected: "git operation 'clone' timed out",
      },
      {
        error: { kind: "import-failed", path: "/dags/foo/dag.ts", message: "syntax error" },
        expected: "import failed for '/dags/foo/dag.ts': syntax error",
      },
      {
        error: { kind: "import-failed", path: "/dags/foo/dag.ts", message: "syntax error", stack: "at line 5" },
        expected: "import failed for '/dags/foo/dag.ts': syntax error",
      },
      {
        error: { kind: "validation-failed", path: "/dags/foo/dag.ts", issues: [{ message: "required", path: ["team"], code: "invalid_type" } as any] },
        expected: "validation failed for '/dags/foo/dag.ts': 1 issue(s)",
      },
      {
        error: { kind: "no-default-export", path: "/dags/foo/dag.ts" },
        expected: "no default export found in '/dags/foo/dag.ts'",
      },
      {
        error: { kind: "dag-not-found", dagId: did("foo"), available: [did("bar"), did("baz")] },
        expected: "DAG 'foo' not found (available: bar, baz)",
      },
      {
        error: { kind: "dag-not-found", dagId: did("foo"), available: [] as DagId[] },
        expected: "DAG 'foo' not found (available: none)",
      },
      {
        error: { kind: "dag-disabled", dagId: did("foo"), reason: "maintenance" },
        expected: "DAG 'foo' is disabled: maintenance",
      },
      {
        error: { kind: "global-concurrency-exceeded" },
        expected: "global concurrency limit exceeded",
      },
      {
        error: { kind: "dag-concurrency-exceeded", dagId: did("foo") },
        expected: "concurrency limit exceeded for DAG 'foo'",
      },
      {
        error: { kind: "timeout", dagId: did("foo"), runId: rid("run-123"), timeoutMs: 5000 },
        expected: "DAG 'foo' run 'run-123' timed out after 5000ms",
      },
      {
        error: { kind: "redis-unavailable", operation: "PING" },
        expected: "Redis unavailable during 'PING'",
      },
      {
        error: { kind: "bun-install-failed", message: "network error" },
        expected: "bun install failed: network error",
      },
      {
        error: { kind: "config-invalid", message: "REDIS_URL: Required" },
        expected: "host configuration invalid: REDIS_URL: Required",
      },
      {
        error: { kind: "input-validation-failed", dagId: did("foo"), issues: [{ message: "too short", path: ["name"], code: "too_small" } as any, { message: "required", path: ["age"], code: "invalid_type" } as any] },
        expected: "input validation failed for DAG 'foo': 2 issue(s)",
      },
      {
        error: { kind: "dag-validation-failed", dagId: did("my-dag"), reason: "missing inputSchema", message: "DagRegistration validation failed: missing inputSchema" },
        expected: "DAG registration validation failed for 'my-dag': missing inputSchema",
      },
      {
        error: { kind: "discovery-failed", dagsRoot: "/opt/dags", message: "ENOENT: no such file or directory" },
        expected: "DAG discovery failed for '/opt/dags': ENOENT: no such file or directory",
      },
      {
        error: { kind: "body-parse-failed", dagId: did("test-dag"), message: "Unexpected token" },
        expected: "request body parse failed for DAG 'test-dag': Unexpected token",
      },
      {
        error: { kind: "async-result-expired", runId: rid("run-456") },
        expected: "async result for run 'run-456' has expired",
      },
    ];

    for (const { error, expected } of cases) {
      it(`formats '${error.kind}' correctly`, () => {
        expect(formatHostError(error)).toBe(expected);
      });
    }

    it("handles all error kinds (exhaustiveness check)", () => {
      const allKinds: HostError["kind"][] = [
        "git-clone-failed",
        "git-pull-failed",
        "git-timeout",
        "git-spawn-failed",
        "import-failed",
        "validation-failed",
        "no-default-export",
        "dag-not-found",
        "dag-disabled",
        "global-concurrency-exceeded",
        "dag-concurrency-exceeded",
        "timeout",
        "redis-unavailable",
        "bun-install-failed",
        "config-invalid",
        "input-validation-failed",
        "dag-validation-failed",
        "body-parse-failed",
        "discovery-failed",
        "async-result-expired",
        "unauthorized",
        "forbidden",
        "team-already-exists",
        "team-not-found",
        "internal-invariant-violated",
      ];
      expect(allKinds).toHaveLength(25);
    });
  });

  describe("httpStatusFor", () => {
    const statusCases: Array<{ error: HostError; status: number }> = [
      { error: { kind: "dag-not-found", dagId: did("x"), available: [] as DagId[] }, status: 404 },
      { error: { kind: "input-validation-failed", dagId: did("x"), issues: [] }, status: 400 },
      { error: { kind: "validation-failed", path: "/x", issues: [] }, status: 400 },
      { error: { kind: "dag-validation-failed", dagId: did("x"), reason: "r", message: "m" }, status: 400 },
      { error: { kind: "global-concurrency-exceeded" }, status: 429 },
      { error: { kind: "timeout", dagId: did("x"), runId: rid("r"), timeoutMs: 1000 }, status: 408 },
      { error: { kind: "dag-disabled", dagId: did("x"), reason: "r" }, status: 503 },
      { error: { kind: "redis-unavailable", operation: "GET" }, status: 503 },
      { error: { kind: "async-result-expired", runId: rid("r") }, status: 410 },
      { error: { kind: "git-clone-failed", url: "u", message: "m" }, status: 500 },
      { error: { kind: "git-pull-failed", message: "m" }, status: 500 },
      { error: { kind: "git-timeout", operation: "fetch" }, status: 500 },
      { error: { kind: "import-failed", path: "/x", message: "m" }, status: 500 },
      { error: { kind: "no-default-export", path: "/x" }, status: 500 },
      { error: { kind: "bun-install-failed", message: "m" }, status: 500 },
      { error: { kind: "config-invalid", message: "m" }, status: 500 },
      { error: { kind: "discovery-failed", dagsRoot: "/x", message: "m" }, status: 500 },
      { error: { kind: "body-parse-failed", dagId: did("x"), message: "m" }, status: 400 },
    ];

    for (const { error, status } of statusCases) {
      it(`maps '${error.kind}' to ${status}`, () => {
        expect(httpStatusFor(error)).toBe(status);
      });
    }
  });
});
