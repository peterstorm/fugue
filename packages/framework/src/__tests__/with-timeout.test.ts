import { describe, test, expect } from "bun:test";
import { createTimeoutSignal } from "../llm/with-timeout.js";

describe("createTimeoutSignal", () => {
  test("signal is not aborted initially", () => {
    const t = createTimeoutSignal(5000);
    expect(t.signal.aborted).toBe(false);
    expect(t.timedOut()).toBe(false);
    t.cleanup();
  });

  test("timedOut() returns true after timeout fires", async () => {
    const t = createTimeoutSignal(10);
    await new Promise((r) => setTimeout(r, 30));
    expect(t.timedOut()).toBe(true);
    expect(t.signal.aborted).toBe(true);
    t.cleanup();
  });

  test("cleanup() clears the timer (no abort after cleanup)", async () => {
    const t = createTimeoutSignal(20);
    t.cleanup();
    await new Promise((r) => setTimeout(r, 40));
    expect(t.timedOut()).toBe(false);
    expect(t.signal.aborted).toBe(false);
  });

  test("caller signal abort propagates to combined signal", () => {
    const caller = new AbortController();
    const t = createTimeoutSignal(5000, caller.signal);
    expect(t.signal.aborted).toBe(false);

    caller.abort();
    expect(t.signal.aborted).toBe(true);
    expect(t.timedOut()).toBe(false); // caller aborted, not timeout
    t.cleanup();
  });

  test("already-aborted caller signal aborts immediately", () => {
    const caller = new AbortController();
    caller.abort();
    const t = createTimeoutSignal(5000, caller.signal);
    expect(t.signal.aborted).toBe(true);
    expect(t.timedOut()).toBe(false);
    t.cleanup();
  });

  test("cleanup removes event listener from caller signal", () => {
    const caller = new AbortController();
    const t = createTimeoutSignal(5000, caller.signal);
    t.cleanup();
    // After cleanup, caller abort should NOT propagate
    caller.abort();
    expect(t.signal.aborted).toBe(false);
  });

  test("works without caller signal", async () => {
    const t = createTimeoutSignal(10);
    await new Promise((r) => setTimeout(r, 30));
    expect(t.timedOut()).toBe(true);
    t.cleanup();
  });

  test("timeout aborts with correct timing", async () => {
    const start = Date.now();
    const t = createTimeoutSignal(50);

    await new Promise<void>((resolve) => {
      t.signal.addEventListener("abort", () => resolve(), { once: true });
    });

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // allow some jitter
    expect(elapsed).toBeLessThan(200);
    expect(t.timedOut()).toBe(true);
    t.cleanup();
  });
});
