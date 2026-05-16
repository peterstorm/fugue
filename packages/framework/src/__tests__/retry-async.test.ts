import { describe, it, expect } from "bun:test";
import { retryAsync } from "../shared/retry-async.js";

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
});
