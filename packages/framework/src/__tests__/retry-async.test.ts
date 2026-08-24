import { describe, it, expect } from "bun:test";
import { retryAsync } from "../shared/retry-async.js";
import { __resetFrameworkLogger, setFrameworkLogger } from "../logger.js";

describe("retryAsync", () => {
  it("returns on first success without delay", async () => {
    let calls = 0;
    const result = await retryAsync(
      async () => { calls++; return "ok"; },
      { maxAttempts: 3, baseDelayMs: 1000, label: "test" },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries on failure and returns on eventual success", async () => {
    let calls = 0;
    const result = await retryAsync(
      async () => {
        calls++;
        if (calls < 3) throw new Error(`fail-${calls}`);
        return "ok";
      },
      { maxAttempts: 3, baseDelayMs: 1, label: "test" },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws last error when all attempts exhausted", async () => {
    let calls = 0;
    await expect(
      retryAsync(
        async () => { calls++; throw new Error(`fail-${calls}`); },
        { maxAttempts: 3, baseDelayMs: 1, label: "test" },
      ),
    ).rejects.toThrow("fail-3");
    expect(calls).toBe(3);
  });

  it("maxAttempts: 1 means no retry", async () => {
    let calls = 0;
    await expect(
      retryAsync(
        async () => { calls++; throw new Error("once"); },
        { maxAttempts: 1, baseDelayMs: 1, label: "test" },
      ),
    ).rejects.toThrow("once");
    expect(calls).toBe(1);
  });

  it("continues retrying when the diagnostic logger throws", async () => {
    let calls = 0;
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => { throw new Error("logger unavailable"); },
    });
    try {
      const result = await retryAsync(
        async () => {
          calls += 1;
          if (calls === 1) throw new Error("retryable operation failure");
          return "recovered";
        },
        { maxAttempts: 2, baseDelayMs: 0, label: "throwing-logger" },
      );
      expect(result).toBe("recovered");
      expect(calls).toBe(2);
    } finally {
      __resetFrameworkLogger();
    }
  });

  it("wraps non-Error thrown values into an Error instance", async () => {
    try {
      await retryAsync(
        async () => { throw "string-error"; },
        { maxAttempts: 2, baseDelayMs: 1, label: "non-error-test" },
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain("string-error");
      expect((e as Error).message).toContain("non-error-test");
    }
  });
});
