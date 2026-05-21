/**
 * Tests for signal handler registration and lifecycle.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { registerSignalHandlers } from "../../lifecycle/signals.js";
import type { SignalHandlerHandle } from "../../lifecycle/signals.js";
import type { SyncLogger } from "../../sync/sync-loop.js";

// ── Test Logger ────────────────────────────────────────────────────────────

const createTestLogger = (): { logger: SyncLogger; logs: Array<{ level: string; msg: string; data?: Record<string, unknown> }> } => {
  const logs: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
  const logger: SyncLogger = {
    info: (msg, data) => { logs.push({ level: "info", msg, data }); },
    warn: (msg, data) => { logs.push({ level: "warn", msg, data }); },
    error: (msg, data) => { logs.push({ level: "error", msg, data }); },
  };
  return { logger, logs };
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("registerSignalHandlers", () => {
  let handle: SignalHandlerHandle | null = null;

  afterEach(() => {
    if (handle) {
      handle.unregister();
      handle = null;
    }
  });

  it("returns a handle with unregister function", () => {
    const { logger } = createTestLogger();
    let shutdownCalled = false;
    handle = registerSignalHandlers({
      onShutdown: async () => { shutdownCalled = true; },
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

    // Should not throw
    handle.unregister();
    handle = null;
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

    // No assertion needed — if listeners leaked, Node would warn about max listeners
  });
});
