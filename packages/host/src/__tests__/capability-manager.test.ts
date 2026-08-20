/**
 * Unit tests for capability-manager domain module.
 *
 * Tests:
 * - Topological sort of handles with dependsOn
 * - Cycle detection
 * - Connect sequencing (dependencies first)
 * - Close sequencing (reverse order)
 * - Health check aggregation
 * - extractClients utility
 */

import { describe, it, expect } from "bun:test";
import { ok, err, isOk, isErr } from "@fuguejs/framework";
import type { Capability, CapabilityHandle } from "@fuguejs/framework";
import {
  topoSortHandles,
  connectAll,
  closeAll,
  checkHealth,
  extractClients,
} from "../domain/capability-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeHandle = (
  name: string,
  overrides: Partial<CapabilityHandle> = {},
): CapabilityHandle => ({
  name: name as Capability,
  client: { __name: name },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("capability-manager", () => {
  describe("topoSortHandles", () => {
    it("handles with no dependencies preserve insertion order", () => {
      const handles = [makeHandle("a"), makeHandle("b"), makeHandle("c")];
      const result = topoSortHandles(handles);
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value.map((h) => h.name)).toEqual(["a", "b", "c"]);
      }
    });

    it("respects dependsOn ordering", () => {
      const handles = [
        makeHandle("cache", { dependsOn: ["db" as Capability] }),
        makeHandle("db"),
        makeHandle("http"),
      ];
      const result = topoSortHandles(handles);
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        const names = result.value.map((h) => h.name);
        const dbIndex = names.indexOf("db" as Capability);
        const cacheIndex = names.indexOf("cache" as Capability);
        expect(dbIndex).toBeLessThan(cacheIndex);
      }
    });

    it("handles chain dependencies (a → b → c)", () => {
      const handles = [
        makeHandle("a", { dependsOn: ["b" as Capability] }),
        makeHandle("b", { dependsOn: ["c" as Capability] }),
        makeHandle("c"),
      ];
      const result = topoSortHandles(handles);
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        const names = result.value.map((h) => h.name);
        expect(names.indexOf("c" as Capability)).toBeLessThan(names.indexOf("b" as Capability));
        expect(names.indexOf("b" as Capability)).toBeLessThan(names.indexOf("a" as Capability));
      }
    });

    it("detects cycles", () => {
      const handles = [
        makeHandle("a", { dependsOn: ["b" as Capability] }),
        makeHandle("b", { dependsOn: ["a" as Capability] }),
      ];
      const result = topoSortHandles(handles);
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.kind).toBe("internal-invariant-violated");
        expect(result.error.message).toContain("cycle");
      }
    });

    it("rejects a dependsOn entry with no registered handle", () => {
      const handles = [makeHandle("cache", { dependsOn: ["db" as Capability] })];
      const result = topoSortHandles(handles);
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.kind).toBe("internal-invariant-violated");
        expect(result.error.message).toContain("'cache' depends on 'db'");
        expect(result.error.context).toEqual({ capability: "cache", missingDependency: "db" });
      }
    });

    it("rejects duplicate capability names", () => {
      const handles = [makeHandle("db"), makeHandle("db")];
      const result = topoSortHandles(handles);
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.kind).toBe("internal-invariant-violated");
        expect(result.error.message).toContain("Duplicate capability handle for 'db'");
      }
    });

    it("rejects a handle with a null client — loud at boot, not a phantom missing-capability at run time", () => {
      const handles = [makeHandle("db", { client: null as never })];
      const result = topoSortHandles(handles);
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.kind).toBe("internal-invariant-violated");
        expect(result.error.message).toContain("'db' has a null client");
        expect(result.error.context).toEqual({ capability: "db" });
      }
    });

    it("rejects a handle with an undefined client", () => {
      const handles = [makeHandle("db", { client: undefined as never })];
      const result = topoSortHandles(handles);
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.kind).toBe("internal-invariant-violated");
        expect(result.error.message).toContain("null client");
      }
    });

    it("empty handles array → Ok([])", () => {
      const result = topoSortHandles([]);
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });
  });

  describe("connectAll", () => {
    it("calls connect() in order", async () => {
      const order: string[] = [];
      const handles = [
        makeHandle("a", { connect: async () => { order.push("a"); } }),
        makeHandle("b", { connect: async () => { order.push("b"); } }),
      ];
      const logger = { info: () => {}, error: () => {} };
      const result = await connectAll(handles, logger);
      expect(isOk(result)).toBe(true);
      expect(order).toEqual(["a", "b"]);
    });

    it("stops on first failure and reports the connected prefix", async () => {
      const order: string[] = [];
      const handles = [
        makeHandle("a", { connect: async () => { order.push("a"); } }),
        makeHandle("b", { connect: async () => { throw new Error("boom"); } }),
        makeHandle("c", { connect: async () => { order.push("c"); } }),
      ];
      const logger = { info: () => {}, error: () => {} };
      const result = await connectAll(handles, logger);
      expect(isErr(result)).toBe(true);
      expect(order).toEqual(["a"]); // "c" never reached
      if (!result.ok) {
        expect(result.error.error.message).toContain("boom");
        expect(result.error.error.message).toContain("b");
        // The connected prefix is what the caller must close on aborted boot.
        expect(result.error.connected.map((h) => h.name)).toEqual(["a"]);
      }
    });

    it("skips handles without connect()", async () => {
      const handles = [makeHandle("a"), makeHandle("b")];
      const logger = { info: () => {}, error: () => {} };
      const result = await connectAll(handles, logger);
      expect(isOk(result)).toBe(true);
    });

    it("closes the failing handle itself — adapters construct pools at factory time", async () => {
      let failingClosed = false;
      const handles = [
        makeHandle("a", { connect: async () => {} }),
        makeHandle("b", {
          connect: async () => { throw new Error("boom"); },
          close: async () => { failingClosed = true; },
        }),
      ];
      const logger = { info: () => {}, error: () => {} };
      const result = await connectAll(handles, logger);
      expect(isErr(result)).toBe(true);
      // The failing handle is NOT in the connected prefix (the caller closes
      // that), so connectAll must close it directly or its pool leaks.
      expect(failingClosed).toBe(true);
      if (!result.ok) {
        expect(result.error.connected.map((h) => h.name)).toEqual(["a"]);
      }
    });

    it("a throwing error logger cannot mask the connect failure or skip failing-handle cleanup", async () => {
      let failingClosed = false;
      const handles = [
        makeHandle("b", {
          connect: async () => { throw new Error("connect-boom"); },
          close: async () => { failingClosed = true; },
        }),
      ];
      const logger = {
        info: () => {},
        error: () => { throw new Error("logger transport down"); },
      };

      const result = await connectAll(handles, logger);

      expect(isErr(result)).toBe(true);
      expect(failingClosed).toBe(true);
      if (!result.ok) expect(result.error.error.message).toContain("connect-boom");
    });

    it("a close failure on the failing handle never masks the connect error", async () => {
      const errorLogs: string[] = [];
      const handles = [
        makeHandle("b", {
          connect: async () => { throw new Error("connect-boom"); },
          close: async () => { throw new Error("close-boom"); },
        }),
      ];
      const logger = { info: () => {}, error: (msg: string) => { errorLogs.push(msg); } };
      const result = await connectAll(handles, logger);
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        // The surfaced error is the connect failure, not the close failure.
        expect(result.error.error.message).toContain("connect-boom");
      }
      // The close failure is logged, not swallowed.
      expect(errorLogs.some((m) => m.includes("failed to close after connect failure"))).toBe(true);
    });
  });

  describe("closeAll", () => {
    it("calls close() in reverse order", async () => {
      const order: string[] = [];
      const handles = [
        makeHandle("a", { close: async () => { order.push("a"); } }),
        makeHandle("b", { close: async () => { order.push("b"); } }),
        makeHandle("c", { close: async () => { order.push("c"); } }),
      ];
      const logger = { info: () => {}, warn: () => {} };
      await closeAll(handles, logger);
      expect(order).toEqual(["c", "b", "a"]);
    });

    it("continues on failure (best-effort) and returns the failures", async () => {
      const order: string[] = [];
      const handles = [
        makeHandle("a", { close: async () => { order.push("a"); } }),
        makeHandle("b", { close: async () => { throw new Error("oops"); } }),
        makeHandle("c", { close: async () => { order.push("c"); } }),
      ];
      const logger = { info: () => {}, warn: () => {} };
      const failures = await closeAll(handles, logger);
      // "b" fails but "a" and "c" still close (reversed: c, b-fail, a)
      expect(order).toEqual(["c", "a"]);
      expect(failures).toEqual([{ name: "b", error: "oops" }]);
    });

    it("clean close returns no failures", async () => {
      const handles = [makeHandle("a", { close: async () => {} })];
      const logger = { info: () => {}, warn: () => {} };
      const failures = await closeAll(handles, logger);
      expect(failures).toEqual([]);
    });

    it("a throwing info logger cannot stop remaining successful closes", async () => {
      const order: string[] = [];
      const handles = [
        makeHandle("a", { close: async () => { order.push("a"); } }),
        makeHandle("b", { close: async () => { order.push("b"); } }),
      ];
      const logger = {
        info: () => { throw new Error("logger transport down"); },
        warn: () => { throw new Error("logger transport down"); },
      };

      await expect(closeAll(handles, logger)).resolves.toEqual([]);
      expect(order).toEqual(["b", "a"]);
    });

    it("a throwing warn logger cannot mask a close failure or stop later closes", async () => {
      const order: string[] = [];
      const hostile = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(hostile, "message", { get: () => { throw new Error("message getter"); } });
      Object.defineProperty(hostile, "toString", { value: () => { throw new Error("toString"); } });
      const handles = [
        makeHandle("a", { close: async () => { order.push("a"); } }),
        makeHandle("b", { close: async () => { throw hostile; } }),
        makeHandle("c", { close: async () => { order.push("c"); } }),
      ];
      const logger = {
        info: () => {},
        warn: () => { throw new Error("logger transport down"); },
      };

      const failures = await closeAll(handles, logger);

      expect(order).toEqual(["c", "a"]);
      expect(failures).toEqual([{ name: "b", error: "[object Object]" }]);
    });
  });

  describe("checkHealth", () => {
    it("all healthy → overall healthy", async () => {
      const handles = [
        makeHandle("a", { healthCheck: async () => ok(undefined) }),
        makeHandle("b", { healthCheck: async () => ok(undefined) }),
      ];
      const report = await checkHealth(handles);
      expect(report.overall).toBe("healthy");
      expect(report.capabilities).toHaveLength(2);
    });

    it("one unhealthy → overall degraded", async () => {
      const handles = [
        makeHandle("a", { healthCheck: async () => ok(undefined) }),
        makeHandle("b", { healthCheck: async () => err("connection refused") }),
      ];
      const report = await checkHealth(handles);
      expect(report.overall).toBe("degraded");
      const unhealthy = report.capabilities.find((c) => c.status === "unhealthy");
      expect(unhealthy).toBeDefined();
      if (unhealthy?.status === "unhealthy") {
        expect(unhealthy.reason).toBe("connection refused");
      }
    });

    it("handles without healthCheck → no-check status", async () => {
      const handles = [makeHandle("a")];
      const report = await checkHealth(handles);
      expect(report.overall).toBe("healthy");
      expect(report.capabilities[0]?.status).toBe("no-check");
    });

    it("healthCheck that throws → unhealthy", async () => {
      const handles = [
        makeHandle("a", { healthCheck: async () => { throw new Error("timeout"); } }),
      ];
      const report = await checkHealth(handles);
      expect(report.overall).toBe("degraded");
    });
  });

  describe("extractClients", () => {
    it("builds a record of capability name → client", () => {
      const clientA = { foo: "bar" };
      const clientB = { baz: 42 };
      const handles = [
        makeHandle("a", { client: clientA as never }),
        makeHandle("b", { client: clientB as never }),
      ];
      const result = extractClients(handles);
      expect(result).toEqual({ a: clientA, b: clientB });
    });

    it("empty handles → empty record", () => {
      expect(extractClients([])).toEqual({});
    });

    it("throws on duplicate handle names (defence-in-depth past topoSort)", () => {
      // topoSortHandles rejects duplicates at boot, so this branch is only
      // reachable if a future caller bypasses it — it must fail loudly here
      // rather than silently drop a handle (last-writer-wins).
      const handles = [
        makeHandle("db", { client: { a: 1 } as never }),
        makeHandle("db", { client: { b: 2 } as never }),
      ];
      expect(() => extractClients(handles)).toThrow(/duplicate capability handle name 'db'/);
    });
  });
});
