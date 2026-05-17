import { describe, test, expect } from "bun:test";
import { classifyLlmError, isAbort, isRateLimit, isTimeoutError } from "../llm/llm-errors.js";
import { N } from "./_id-helpers.js";

const nodeId = N("test-node");

describe("isAbort", () => {
  test("returns true for AbortError", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(isAbort(e)).toBe(true);
  });

  test("returns false for generic Error", () => {
    expect(isAbort(new Error("nope"))).toBe(false);
  });

  test("returns false for non-Error", () => {
    expect(isAbort("not an error")).toBe(false);
    expect(isAbort(null)).toBe(false);
    expect(isAbort(undefined)).toBe(false);
  });
});

describe("isRateLimit", () => {
  test("returns true for status 429", () => {
    const e = Object.assign(new Error("rate limited"), { status: 429 });
    expect(isRateLimit(e)).toBe(true);
  });

  test("returns true for plain object with status 429", () => {
    expect(isRateLimit({ status: 429 })).toBe(true);
  });

  test("returns false for other status codes", () => {
    expect(isRateLimit({ status: 500 })).toBe(false);
    expect(isRateLimit({ status: 200 })).toBe(false);
  });

  test("returns false for missing status", () => {
    expect(isRateLimit(new Error("no status"))).toBe(false);
    expect(isRateLimit({})).toBe(false);
  });
});

describe("isTimeoutError", () => {
  test("returns true when Error.cause is 'timeout'", () => {
    const e = new Error("timed out", { cause: "timeout" });
    expect(isTimeoutError(e)).toBe(true);
  });

  test("returns false when cause is something else", () => {
    const e = new Error("nope", { cause: "other" });
    expect(isTimeoutError(e)).toBe(false);
  });

  test("returns false for non-Error", () => {
    expect(isTimeoutError("timeout")).toBe(false);
  });
});

describe("classifyLlmError", () => {
  test("timeout-induced abort → transient with timeout message", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    const result = classifyLlmError(e, nodeId, {
      timedOut: true,
      callerAborted: false,
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      if (result.error.kind === "transient") {
        expect(result.error.message).toContain("5000ms");
        expect(result.error.nodeId).toBe(nodeId);
      }
    }
  });

  test("timeout via Error.cause → transient", () => {
    const e = new Error("request timed out", { cause: "timeout" });
    const result = classifyLlmError(e, nodeId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      if (result.error.kind === "transient") {
        expect(result.error.message).toBe("request timed out");
      }
    }
  });

  test("caller abort → aborted", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    const result = classifyLlmError(e, nodeId, { callerAborted: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("aborted");
    }
  });

  test("rate limit (429) → transient", () => {
    const e = Object.assign(new Error("Too Many Requests"), { status: 429 });
    const result = classifyLlmError(e, nodeId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      if (result.error.kind === "transient") {
        expect(result.error.message).toBe("Too Many Requests");
      }
    }
  });

  test("generic error → node-crash retriable", () => {
    const e = new Error("something broke");
    const result = classifyLlmError(e, nodeId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("retriable");
        expect(result.error.message).toBe("something broke");
        expect(result.error.nodeId).toBe(nodeId);
      }
    }
  });

  test("non-Error value → node-crash with stringified message", () => {
    const result = classifyLlmError("string error", nodeId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.message).toBe("string error");
        expect(result.error.stack).toBeUndefined();
      }
    }
  });

  test("isAbortOverride predicate triggers abort detection", () => {
    // Simulate Anthropic's APIUserAbortError (name != "AbortError")
    const e = new Error("user aborted");
    e.name = "APIUserAbortError";
    const result = classifyLlmError(e, nodeId, {
      timedOut: true,
      callerAborted: false,
      timeoutMs: 120_000,
      isAbortOverride: (err) => err instanceof Error && err.name === "APIUserAbortError",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
    }
  });

  test("isAbortOverride with caller abort → aborted (not transient)", () => {
    const e = new Error("user aborted");
    e.name = "APIUserAbortError";
    const result = classifyLlmError(e, nodeId, {
      timedOut: false,
      callerAborted: true,
      isAbortOverride: (err) => err instanceof Error && err.name === "APIUserAbortError",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("aborted");
    }
  });

  test("timeout without abort error falls through to generic crash", () => {
    // timedOut is true but the error is NOT an AbortError (shouldn't happen in practice)
    const e = new Error("connection reset");
    const result = classifyLlmError(e, nodeId, { timedOut: true, callerAborted: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Not an abort, so falls through to generic crash
      expect(result.error.kind).toBe("node-crash");
    }
  });
});
