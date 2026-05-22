/**
 * Tests for signal handler registration and lifecycle.
 *
 * Tests SIGTERM/SIGINT → onShutdown, double-signal → force exit,
 * and uncaught exceptions → exit(1).
 *
 * Strategy: We mock process.exit to capture exit calls without
 * actually terminating the test runner. Signals are emitted directly
 * via process.emit().
 */

import { describe, it, expect, afterEach, beforeEach, mock } from "bun:test";
import { registerSignalHandlers } from "../../lifecycle/signals.js";
import type { SignalHandlerHandle } from "../../lifecycle/signals.js";
import type { LogPort } from "../../ports.js";

// ── Test Logger ────────────────────────────────────────────────────────────

const createTestLogger = (): { logger: LogPort; logs: Array<{ level: string; msg: string; data?: Record<string, unknown> }> } => {
  const logs: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
  const logger: LogPort = {
    info: (msg, data) => { logs.push({ level: "info", msg, data }); },
    warn: (msg, data) => { logs.push({ level: "warn", msg, data }); },
    error: (msg, data) => { logs.push({ level: "error", msg, data }); },
  };
  return { logger, logs };
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("registerSignalHandlers", () => {
  let handle: SignalHandlerHandle | null = null;
  const originalExit = process.exit;
  let exitCalls: number[] = [];

  beforeEach(() => {
    exitCalls = [];
    // @ts-expect-error — mocking process.exit for testing
    process.exit = (code?: number) => { exitCalls.push(code ?? 0); };
  });

  afterEach(() => {
    if (handle) {
      handle.unregister();
      handle = null;
    }
    process.exit = originalExit;
  });

  it("returns a handle with unregister function", () => {
    const { logger } = createTestLogger();
    handle = registerSignalHandlers({
      onShutdown: async () => {},
      logger,
    });

    expect(handle).toBeDefined();
    expect(typeof handle.unregister).toBe("function");
  });

  it("unregister removes all listeners without error", () => {
    const { logger } = createTestLogger();
    handle = registerSignalHandlers({
      onShutdown: async () => {},
      logger,
    });

    handle.unregister();
    handle = null;
  });

  it("SIGTERM calls onShutdown", async () => {
    const { logger, logs } = createTestLogger();
    let shutdownCalled = false;
    handle = registerSignalHandlers({
      onShutdown: async () => { shutdownCalled = true; },
      logger,
    });

    process.emit("SIGTERM");
    // Allow async onShutdown to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(shutdownCalled).toBe(true);
    expect(logs.some(l => l.msg.includes("SIGTERM"))).toBe(true);
  });

  it("SIGINT calls onShutdown", async () => {
    const { logger } = createTestLogger();
    let shutdownCalled = false;
    handle = registerSignalHandlers({
      onShutdown: async () => { shutdownCalled = true; },
      logger,
    });

    process.emit("SIGINT");
    await new Promise((r) => setTimeout(r, 10));

    expect(shutdownCalled).toBe(true);
  });

  it("successful shutdown exits with code 0", async () => {
    const { logger } = createTestLogger();
    handle = registerSignalHandlers({
      onShutdown: async () => {},
      logger,
    });

    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 10));

    expect(exitCalls).toContain(0);
  });

  it("INVARIANT: double-SIGTERM forces immediate exit with code 1", async () => {
    const { logger, logs } = createTestLogger();
    handle = registerSignalHandlers({
      onShutdown: async () => {
        // Simulate slow shutdown — doesn't resolve before second signal
        await new Promise((r) => setTimeout(r, 100));
      },
      logger,
    });

    // First signal starts shutdown
    process.emit("SIGTERM");
    // Second signal before first completes
    await new Promise((r) => setTimeout(r, 5));
    process.emit("SIGTERM");

    await new Promise((r) => setTimeout(r, 10));

    // Should have force-exited with code 1
    expect(exitCalls).toContain(1);
    expect(logs.some(l => l.msg.includes("again") || l.msg.includes("forcing"))).toBe(true);
  });

  it("onShutdown throwing exits with code 1", async () => {
    const { logger, logs } = createTestLogger();
    handle = registerSignalHandlers({
      onShutdown: async () => { throw new Error("shutdown failed"); },
      logger,
    });

    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 10));

    expect(exitCalls).toContain(1);
    expect(logs.some(l => l.level === "error" && l.msg.includes("shutdown"))).toBe(true);
  });

  it("INVARIANT: uncaught exception exits with code 1", async () => {
    const { logger, logs } = createTestLogger();
    handle = registerSignalHandlers({
      onShutdown: async () => {},
      logger,
    });

    // Emit uncaughtException event directly
    process.emit("uncaughtException", new Error("boom"));
    await new Promise((r) => setTimeout(r, 5));

    expect(exitCalls).toContain(1);
    expect(logs.some(l => l.level === "error" && l.msg.includes("Uncaught exception"))).toBe(true);
  });

  it("INVARIANT: unhandled rejection exits with code 1", async () => {
    const { logger, logs } = createTestLogger();
    handle = registerSignalHandlers({
      onShutdown: async () => {},
      logger,
    });

    // Emit unhandledRejection event directly
    process.emit("unhandledRejection", new Error("rejected"), Promise.resolve());
    await new Promise((r) => setTimeout(r, 5));

    expect(exitCalls).toContain(1);
    expect(logs.some(l => l.level === "error" && l.msg.includes("Unhandled promise rejection"))).toBe(true);
  });

  it("can register and unregister multiple times without leaks", () => {
    const { logger } = createTestLogger();

    for (let i = 0; i < 5; i++) {
      const h = registerSignalHandlers({
        onShutdown: async () => {},
        logger,
      });
      h.unregister();
    }
  });
});
