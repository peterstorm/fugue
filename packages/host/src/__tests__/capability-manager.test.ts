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
import { ok, err, isOk, isErr } from "@fugue/framework";
import type { CapabilityHandle } from "@fugue/framework";
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
  name: name as any,
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
        makeHandle("cache", { dependsOn: ["db"] as any }),
        makeHandle("db"),
        makeHandle("http"),
      ];
      const result = topoSortHandles(handles);
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        const names = result.value.map((h) => h.name);
        const dbIndex = names.indexOf("db" as any);
        const cacheIndex = names.indexOf("cache" as any);
        expect(dbIndex).toBeLessThan(cacheIndex);
      }
    });

    it("handles chain dependencies (a → b → c)", () => {
      const handles = [
        makeHandle("a", { dependsOn: ["b"] as any }),
        makeHandle("b", { dependsOn: ["c"] as any }),
        makeHandle("c"),
      ];
      const result = topoSortHandles(handles);
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        const names = result.value.map((h) => h.name);
        expect(names.indexOf("c" as any)).toBeLessThan(names.indexOf("b" as any));
        expect(names.indexOf("b" as any)).toBeLessThan(names.indexOf("a" as any));
      }
    });

    it("detects cycles", () => {
      const handles = [
        makeHandle("a", { dependsOn: ["b"] as any }),
        makeHandle("b", { dependsOn: ["a"] as any }),
      ];
      const result = topoSortHandles(handles);
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.kind).toBe("internal-invariant-violated");
        expect(result.error.message).toContain("cycle");
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

    it("stops on first failure", async () => {
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
        expect(result.error.message).toContain("boom");
        expect(result.error.message).toContain("b");
      }
    });

    it("skips handles without connect()", async () => {
      const handles = [makeHandle("a"), makeHandle("b")];
      const logger = { info: () => {}, error: () => {} };
      const result = await connectAll(handles, logger);
      expect(isOk(result)).toBe(true);
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

    it("continues on failure (best-effort)", async () => {
      const order: string[] = [];
      const handles = [
        makeHandle("a", { close: async () => { order.push("a"); } }),
        makeHandle("b", { close: async () => { throw new Error("oops"); } }),
        makeHandle("c", { close: async () => { order.push("c"); } }),
      ];
      const logger = { info: () => {}, warn: () => {} };
      await closeAll(handles, logger);
      // "b" fails but "a" and "c" still close (reversed: c, b-fail, a)
      expect(order).toEqual(["c", "a"]);
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
        makeHandle("a", { client: clientA as any }),
        makeHandle("b", { client: clientB as any }),
      ];
      const result = extractClients(handles);
      expect(result).toEqual({ a: clientA, b: clientB });
    });

    it("empty handles → empty record", () => {
      expect(extractClients([])).toEqual({});
    });
  });
});
