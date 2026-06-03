/**
 * Unit tests for capability tracing (withTracedCapability).
 *
 * Tests:
 * - Wraps async methods in spans
 * - Passes through non-function properties
 * - Sets error status on Result.Err
 * - Records exceptions on thrown errors
 * - Extracts custom attributes
 * - Does not interfere with return values
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { ok, err } from "../types/result.js";
import { withTracedCapability } from "../tracing/capability-tracing.js";
import type { CapabilityHandle } from "../types/capability-handle.js";

// We use `as any` for CapabilityHandle in these tests because we're testing
// the proxy behavior generically, not specific capability type compliance.
type AnyHandle = CapabilityHandle<any>;

// ---------------------------------------------------------------------------
// In-memory span collector (mimics OTel API)
// ---------------------------------------------------------------------------

interface CollectedSpan {
  name: string;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  exceptions: unknown[];
  ended: boolean;
}

let collectedSpans: CollectedSpan[] = [];

// We can't easily mock @opentelemetry/api's global tracer in a unit test.
// Instead, test the proxy behavior directly — verify method calls are
// intercepted, return values are preserved, and errors are handled.
// The OTel span creation is an integration concern tested separately.

describe("withTracedCapability", () => {
  describe("proxy behavior", () => {
    it("preserves return values from async methods", async () => {
      const handle: AnyHandle = {
        name: "test" as any,
        client: {
          fetchData: async (id: string) => ok({ id, name: "Alice" }),
        },
      };

      const traced = withTracedCapability(handle);
      const result = await (traced.client as any).fetchData("123");
      expect(result).toEqual(ok({ id: "123", name: "Alice" }));
    });

    it("preserves error Result return values", async () => {
      const handle: AnyHandle = {
        name: "db" as any,
        client: {
          query: async () => err({ kind: "transient", nodeId: "n" as any, message: "timeout" }),
        },
      };

      const traced = withTracedCapability(handle);
      const result = await (traced.client as any).query("SELECT 1");
      expect(result.ok).toBe(false);
      expect(result.error.kind).toBe("transient");
    });

    it("re-throws exceptions from methods", async () => {
      const handle: AnyHandle = {
        name: "http" as any,
        client: {
          get: async () => { throw new Error("network failure"); },
        },
      };

      const traced = withTracedCapability(handle);
      await expect((traced.client as any).get("/foo")).rejects.toThrow("network failure");
    });

    it("non-function properties pass through unchanged", () => {
      const handle: AnyHandle = {
        name: "cache" as any,
        client: {
          version: "1.2.3",
          maxSize: 100,
          get: async () => ok(null),
        },
      };

      const traced = withTracedCapability(handle);
      expect((traced.client as any).version).toBe("1.2.3");
      expect((traced.client as any).maxSize).toBe(100);
    });

    it("preserves handle metadata (name, connect, close)", () => {
      let connected = false;
      const handle: AnyHandle = {
        name: "db" as any,
        client: { query: async () => ok([]) },
        connect: async () => { connected = true; },
        close: async () => {},
        healthCheck: async () => ok(undefined),
      };

      const traced = withTracedCapability(handle);
      expect(traced.name).toBe("db");
      expect(traced.connect).toBeDefined();
      expect(traced.close).toBeDefined();
      expect(traced.healthCheck).toBeDefined();
    });

    it("connect/close are preserved from original handle", async () => {
      let connected = false;
      let closed = false;
      const handle: AnyHandle = {
        name: "db" as any,
        client: { query: async () => ok([]) },
        connect: async () => { connected = true; },
        close: async () => { closed = true; },
      };

      const traced = withTracedCapability(handle);
      await traced.connect?.();
      expect(connected).toBe(true);
      await traced.close?.();
      expect(closed).toBe(true);
    });
  });

  describe("extractAttributes option", () => {
    it("calls extractAttributes with method name and args", async () => {
      const extracted: Array<{ method: string; args: unknown[] }> = [];
      const handle: AnyHandle = {
        name: "db" as any,
        client: {
          query: async (sql: string, params: unknown[]) => ok([]),
        },
      };

      const traced = withTracedCapability(handle, {
        extractAttributes: (method, args) => {
          extracted.push({ method, args: [...args] });
          return { "db.sql": String(args[0]) };
        },
      });

      await (traced.client as any).query("SELECT * FROM users", [1, 2]);
      expect(extracted).toHaveLength(1);
      expect(extracted[0]?.method).toBe("query");
      expect(extracted[0]?.args[0]).toBe("SELECT * FROM users");
    });

    it("extractAttributes errors don't crash the call", async () => {
      const handle: AnyHandle = {
        name: "db" as any,
        client: {
          query: async () => ok([{ id: 1 }]),
        },
      };

      const traced = withTracedCapability(handle, {
        extractAttributes: () => { throw new Error("oops"); },
      });

      // Should still return the result despite attribute extraction failure
      const result = await (traced.client as any).query("SELECT 1");
      expect(result).toEqual(ok([{ id: 1 }]));
    });
  });
});
