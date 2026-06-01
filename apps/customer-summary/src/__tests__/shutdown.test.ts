import { describe, test, expect } from "bun:test";
import { runGracefulShutdown, type ShutdownHandles } from "../shutdown.js";
import type { AppLogger } from "../logger.js";

// Silent recording logger — captures warns so we can assert a failing step is
// surfaced (not swallowed) while the rest still run.
const recordingLogger = () => {
  const warns: string[] = [];
  const log: AppLogger = {
    debug: () => {},
    info: () => {},
    warn: (msg) => { warns.push(msg); },
    error: () => {},
  };
  return { log, warns };
};

// Build handles whose steps each push their name into `order` when invoked, so
// we can assert WHICH steps ran and in what sequence. `throwAt` makes the named
// step reject; the orchestration must still run the remaining steps.
const handlesRecording = (order: string[], throwAt?: string): ShutdownHandles => {
  const step = (name: string) => async () => {
    order.push(name);
    if (throwAt === name) throw new Error(`${name}-boom`);
  };
  return {
    tracing: { flush: step("flush"), shutdown: step("trace-shutdown") },
    observer: { close: () => { order.push("close"); if (throwAt === "close") throw new Error("close-boom"); } },
    foundrySink: { flush: step("sink-flush") },
    redis: { disconnect: step("redis-disconnect") },
  };
};

const ALL_STEPS = ["flush", "trace-shutdown", "close", "sink-flush", "redis-disconnect"];

describe("runGracefulShutdown — per-step fault isolation (shutdown wedge)", () => {
  test("happy path runs every step in order", async () => {
    const order: string[] = [];
    const { log } = recordingLogger();
    await runGracefulShutdown(handlesRecording(order), log);
    expect(order).toEqual(ALL_STEPS);
  });

  // A failure at EACH step must not strand the steps after it.
  for (const failing of ALL_STEPS) {
    test(`a throwing "${failing}" still runs every later step (and warns)`, async () => {
      const order: string[] = [];
      const { log, warns } = recordingLogger();
      await runGracefulShutdown(handlesRecording(order, failing), log);
      // Every step is still attempted, including the one that throws.
      expect(order).toEqual(ALL_STEPS);
      // The failure is observable, never silent.
      expect(warns.length).toBeGreaterThan(0);
    });
  }

  test("never rejects even when every step throws", async () => {
    const order: string[] = [];
    const { log, warns } = recordingLogger();
    const boom = () => async () => { throw new Error("boom"); };
    const handles: ShutdownHandles = {
      tracing: { flush: boom(), shutdown: boom() },
      observer: { close: () => { throw new Error("close-boom"); } },
      foundrySink: { flush: boom() },
      redis: { disconnect: boom() },
    };
    await expect(runGracefulShutdown(handles, log)).resolves.toBeUndefined();
    expect(warns.length).toBe(5); // one per failing step
    void order;
  });
});

describe("runGracefulShutdown — absent handles", () => {
  test("null tracing/sink/redis and a no-op observer are all skipped cleanly", async () => {
    const { log, warns } = recordingLogger();
    const handles: ShutdownHandles = {
      tracing: null,
      observer: {}, // NoopObserver default — no close / no Symbol.dispose
      foundrySink: null,
      redis: null,
    };
    await expect(runGracefulShutdown(handles, log)).resolves.toBeUndefined();
    expect(warns).toEqual([]); // nothing ran, nothing failed
  });

  test("observer disposed via Symbol.dispose when close() is absent", async () => {
    const { log } = recordingLogger();
    let disposed = false;
    const handles: ShutdownHandles = {
      tracing: null,
      observer: { [Symbol.dispose]: () => { disposed = true; } },
      foundrySink: null,
      redis: null,
    };
    await runGracefulShutdown(handles, log);
    expect(disposed).toBe(true);
  });

  test("close() is preferred over Symbol.dispose when both are present", async () => {
    const { log } = recordingLogger();
    const calls: string[] = [];
    const handles: ShutdownHandles = {
      tracing: null,
      observer: {
        close: () => { calls.push("close"); },
        [Symbol.dispose]: () => { calls.push("dispose"); },
      },
      foundrySink: null,
      redis: null,
    };
    await runGracefulShutdown(handles, log);
    expect(calls).toEqual(["close"]);
  });
});
