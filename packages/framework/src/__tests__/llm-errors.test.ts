import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import {
  classifyLlmError,
  httpFailureToError,
  isAbort,
  isRateLimit,
  isTimeoutError,
  truncateErrorBody,
} from "../llm/llm-errors.js";
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

describe("httpFailureToError", () => {
  test("429 → transient carrying HTTP status + body", () => {
    const result = httpFailureToError(429, "rate limited", nodeId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      if (result.error.kind === "transient") {
        expect(result.error.nodeId).toBe(nodeId);
        expect(result.error.message).toBe("HTTP 429: rate limited");
        // The typed httpStatus lets consumers branch without string-matching.
        expect(result.error.httpStatus).toBe(429);
      }
    }
  });

  test("401 → node-crash NON-retriable (deterministic client error)", () => {
    const result = httpFailureToError(401, "unauthorized", nodeId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("non-retriable");
        expect(result.error.message).toBe("HTTP 401: unauthorized");
        // FIX 4: an HTTP-origin node-crash carries the typed httpStatus so
        // consumers branch on `httpStatus === 401` without string-matching.
        expect(result.error.httpStatus).toBe(401);
      }
    }
  });

  test("200 (malformed-success body) → node-crash retriable carrying HTTP 200", () => {
    const result = httpFailureToError(200, "<html>gateway</html>", nodeId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("retriable");
        expect(result.error.message).toContain("HTTP 200");
      }
    }
  });

  test("body is truncated in the message (no unbounded error payloads)", () => {
    const result = httpFailureToError(500, "x".repeat(500), nodeId);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.message).toBe(`HTTP 500: ${truncateErrorBody("x".repeat(500))}`);
      expect(result.error.message).toContain("…[truncated]");
    }
  });

  test("408/409 → transient (request timeout / conflict are transient by RFC)", () => {
    for (const status of [408, 409]) {
      const result = httpFailureToError(status, "retry me", nodeId);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("transient");
        if (result.error.kind === "transient") {
          expect(result.error.message).toBe(`HTTP ${status}: retry me`);
          expect(result.error.httpStatus).toBe(status);
        }
      }
    }
  });

  test("property: over 400–599, 408/409/429 are transient, other 4xx non-retriable, 5xx retriable", () => {
    const transientStatuses = new Set([408, 409, 429]);
    fc.assert(
      fc.property(fc.integer({ min: 400, max: 599 }), (status) => {
        const result = httpFailureToError(status, "body", nodeId);
        if (result.ok) return false;
        const e = result.error;
        if (transientStatuses.has(status)) return e.kind === "transient";
        if (status < 500) return e.kind === "node-crash" && e.retriability === "non-retriable";
        return e.kind === "node-crash" && e.retriability === "retriable";
      }),
    );
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
        // 429 classifies via the shared TRANSIENT_HTTP_STATUSES arm (the
        // former dedicated isRateLimit arm was redundant and removed) —
        // still transient, still carrying httpStatus 429 as typed data.
        expect(result.error.httpStatus).toBe(429);
      }
    }
  });

  test("duck-typed non-429 4xx (SDK error with .status) → node-crash NON-retriable", () => {
    // The same 4xx policy httpFailureToError applies on the raw-HTTP path:
    // a deterministic client error must not silently burn the retry budget.
    for (const status of [400, 401, 403, 422]) {
      const e = Object.assign(new Error(`client error ${status}`), { status });
      const result = classifyLlmError(e, nodeId);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("node-crash");
        if (result.error.kind === "node-crash") {
          expect(result.error.retriability).toBe("non-retriable");
          expect(result.error.message).toBe(`client error ${status}`);
          // FIX 4: HTTP-origin non-retriable crash carries the typed status.
          expect(result.error.httpStatus).toBe(status);
        }
      }
    }
    // …while a duck-typed 5xx stays a retriable generic crash — and, being the
    // retriable arm (not HTTP-origin non-retriable), carries NO httpStatus.
    const e5xx = Object.assign(new Error("server error"), { status: 500 });
    const result = classifyLlmError(e5xx, nodeId);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.retriability).toBe("retriable");
      expect(result.error.httpStatus).toBeUndefined();
    }
  });

  test("non-HTTP node-crash (thrown Error, no .status) omits httpStatus", () => {
    // FIX 4: the httpStatus field is present ONLY on HTTP-origin crashes;
    // a plain thrown error with no `.status` must not fabricate one.
    const result = classifyLlmError(new Error("boom"), nodeId);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.retriability).toBe("retriable");
      expect(result.error.httpStatus).toBeUndefined();
    }
  });

  test("duck-typed 408/409 → transient (matches the raw-HTTP policy)", () => {
    for (const status of [408, 409]) {
      const e = Object.assign(new Error(`transient ${status}`), { status });
      const result = classifyLlmError(e, nodeId);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("transient");
        if (result.error.kind === "transient") {
          // The SDK error's own message passes through verbatim (not a
          // synthesized one), and the typed httpStatus rides along.
          expect(result.error.message).toBe(`transient ${status}`);
          expect(result.error.httpStatus).toBe(status);
        }
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
