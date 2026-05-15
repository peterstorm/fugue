import { describe, it, expect } from "bun:test";
import { formatFrameworkError } from "../types/errors.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId, RunId } from "../types/ids.js";
import { N, R } from "./_id-helpers.js";

/**
 * Every FrameworkError.kind gets a human-readable format string —
 * no raw JSON.stringify in the output.
 */
describe("formatFrameworkError", () => {
  const cases: Array<{ name: string; error: FrameworkError; contains: string[] }> = [
    {
      name: "validation",
      error: { kind: "validation", nodeId: N("n1"), message: "field missing" },
      contains: ["field missing", "n1"],
    },
    {
      name: "missing-default-edge",
      error: { kind: "missing-default-edge", nodeId: N("router") },
      contains: ["router", "default edge"],
    },
    {
      name: "output-unreachable-under-routing",
      error: { kind: "output-unreachable-under-routing", outputNodeId: N("out"), missedFromNode: N("mid") },
      contains: ["out", "mid", "reachable"],
    },
    {
      name: "duplicate-edge",
      error: { kind: "duplicate-edge", fromNodeId: N("a"), toNodeId: N("b") },
      contains: ["a", "b", "duplicate"],
    },
    {
      name: "predicate-malformed",
      error: { kind: "predicate-malformed", nodeId: N("r"), message: "check threw" },
      contains: ["check threw", "r"],
    },
    {
      name: "cycle-detected",
      error: { kind: "cycle-detected", nodeIds: [N("a"), N("b"), N("a")] },
      contains: ["cycle", "a", "b"],
    },
    {
      name: "retry-exhausted",
      error: { kind: "retry-exhausted", nodeId: N("llm"), attempts: 3, lastError: "timeout", rootErrorKind: "transient" },
      contains: ["llm", "3", "transient", "timeout"],
    },
    {
      name: "node-crash",
      error: { kind: "node-crash", nodeId: N("x"), message: "null ref", retriability: "non-retriable" },
      contains: ["x", "crashed", "null ref", "non-retriable"],
    },
    {
      name: "aborted",
      error: { kind: "aborted", reason: "user cancel" },
      contains: ["aborted", "user cancel"],
    },
    {
      name: "rejected",
      error: { kind: "rejected", nodeId: N("review"), reason: "policy" },
      contains: ["review", "rejected", "policy"],
    },
    {
      name: "transient",
      error: { kind: "transient", nodeId: N("api"), message: "rate limited" },
      contains: ["api", "transient", "rate limited"],
    },
    {
      name: "prompt-not-found",
      error: { kind: "prompt-not-found", promptName: "summarize", reason: "not registered" },
      contains: ["summarize", "not found"],
    },
    {
      name: "cache-error",
      error: { kind: "cache-error", operation: "GET", message: "connection refused" },
      contains: ["cache", "GET", "connection refused"],
    },
    {
      name: "invalid-reroute",
      error: { kind: "invalid-reroute", targetNodeId: N("ghost"), message: "not in DAG" },
      contains: ["ghost", "reroute", "not in DAG"],
    },
    {
      name: "checkpoint-missing",
      error: { kind: "checkpoint-missing", runId: R("run-1") },
      contains: ["checkpoint", "missing", "run-1"],
    },
    {
      name: "checkpoint-expired",
      error: { kind: "checkpoint-expired", runId: R("run-2"), expiredAt: new Date("2025-01-01T00:00:00Z") },
      contains: ["checkpoint", "expired", "run-2", "2025"],
    },
    {
      name: "checkpoint-corrupt",
      error: { kind: "checkpoint-corrupt", runId: R("run-3"), message: "bad JSON" },
      contains: ["checkpoint", "corrupt", "run-3", "bad JSON"],
    },
    {
      name: "checkpoint-corrupt with nodeId",
      error: { kind: "checkpoint-corrupt", runId: R("run-3"), nodeId: N("n"), message: "bad" },
      contains: ["node 'n'"],
    },
    {
      name: "checkpoint-version-mismatch",
      error: { kind: "checkpoint-version-mismatch", runId: R("run-4"), expected: "v2", actual: "v1" },
      contains: ["version mismatch", "run-4", "v2", "v1"],
    },
    {
      name: "checkpoint-version-mismatch (actual undefined)",
      error: { kind: "checkpoint-version-mismatch", runId: R("run-5"), expected: "v2", actual: undefined },
      contains: ["undefined"],
    },
    {
      name: "checkpoint-write-failed",
      error: { kind: "checkpoint-write-failed", runId: R("run-6"), nodeId: N("ck"), message: "disk full" },
      contains: ["write failed", "run-6", "ck", "disk full"],
    },
    {
      name: "missing-capability",
      error: { kind: "missing-capability", nodeId: N("llm-node"), capability: "llm", missing: [{ nodeId: N("llm-node"), capability: "llm" }] },
      contains: ["missing capabilities", "llm", "llm-node"],
    },
  ];

  for (const { name, error, contains } of cases) {
    it(`${name}: human-readable, not raw JSON`, () => {
      const result = formatFrameworkError(error);
      expect(result.length).toBeGreaterThan(0);
      // Must not be raw JSON (the old behavior)
      expect(result.startsWith("{")).toBe(false);
      for (const substr of contains) {
        expect(result).toContain(substr);
      }
    });
  }
});
