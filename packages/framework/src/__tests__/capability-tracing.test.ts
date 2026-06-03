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
 * - Real OTel span behavior (names, attributes, status, end) via
 *   BasicTracerProvider + InMemorySpanExporter — no mocking
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ok, err } from "../types/result.js";
import { withTracedCapability } from "../tracing/capability-tracing.js";
import type { CapabilityHandle } from "../types/capability-handle.js";

// We use `as any` for CapabilityHandle in these tests because we're testing
// the proxy behavior generically, not specific capability type compliance.
type AnyHandle = CapabilityHandle<any>;

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
      const handle: AnyHandle = {
        name: "db" as any,
        client: { query: async () => ok([]) },
        connect: async () => {},
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

  // -------------------------------------------------------------------------
  // Real OTel span behavior — BasicTracerProvider + InMemorySpanExporter.
  // No mocking: spans are exported in-memory and asserted directly.
  // -------------------------------------------------------------------------
  describe("OTel span behavior (InMemorySpanExporter)", () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    // Injected tracer — independent of the global registry, so these tests
    // are immune to other test files registering a global provider first.
    const tracer = provider.getTracer("capability-tracing-test");

    beforeEach(() => {
      exporter.reset();
    });

    afterAll(async () => {
      await provider.shutdown();
    });

    it("creates a '{capability}.{method}' span with capability attributes, ended OK on success", async () => {
      const handle: AnyHandle = {
        name: "db" as any,
        client: { query: async () => ok([{ id: 1 }]) },
      };

      await (withTracedCapability(handle, { tracer }).client as any).query("SELECT 1");

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.name).toBe("db.query");
      expect(span.attributes["fugue.capability.name"]).toBe("db");
      expect(span.attributes["fugue.capability.method"]).toBe("query");
      expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    });

    it("marks the span errored with error_kind on a Result.Err", async () => {
      const handle: AnyHandle = {
        name: "db" as any,
        client: { query: async () => err({ kind: "transient", nodeId: "n" as any, message: "timeout" }) },
      };

      await (withTracedCapability(handle, { tracer }).client as any).query("SELECT 1");

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe("transient");
      expect(span.attributes["fugue.capability.error_kind"]).toBe("transient");
    });

    it("records the exception and ends the span when the method throws", async () => {
      const handle: AnyHandle = {
        name: "http" as any,
        client: { get: async () => { throw new Error("network failure"); } },
      };

      await expect((withTracedCapability(handle, { tracer }).client as any).get("/x")).rejects.toThrow("network failure");

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.events.some((e) => e.name === "exception")).toBe(true);
      expect(span.ended).toBe(true);
    });

    it("errors the span for a synchronous Result.Err return", async () => {
      const handle: AnyHandle = {
        name: "cache" as any,
        client: { peek: () => err({ kind: "cache-error", operation: "peek", message: "cold" }) },
      };

      (withTracedCapability(handle, { tracer }).client as any).peek("key");

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
      expect(spans[0]!.attributes["fugue.capability.error_kind"]).toBe("cache-error");
    });

    it("custom extractAttributes land on the span; extraction failure becomes a span event", async () => {
      const okHandle: AnyHandle = {
        name: "db" as any,
        client: { query: async () => ok([]) },
      };

      await (withTracedCapability(okHandle, {
        tracer,
        extractAttributes: (_method, args) => ({ "db.sql": String(args[0]) }),
      }).client as any).query("SELECT 1");

      await (withTracedCapability(okHandle, {
        tracer,
        extractAttributes: () => { throw new Error("extractor bug"); },
      }).client as any).query("SELECT 2");

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(2);
      expect(spans[0]!.attributes["db.sql"]).toBe("SELECT 1");
      const failureEvents = spans[1]!.events.filter(
        (e) => e.name === "fugue.capability.attribute_extraction_failed",
      );
      expect(failureEvents).toHaveLength(1);
      expect(failureEvents[0]!.attributes?.message).toBe("extractor bug");
    });

    it("extraction failure becomes a span event on the synchronous return path too", () => {
      const handle: AnyHandle = {
        name: "cache" as any,
        client: { peek: () => ok("warm") },
      };

      const result = (withTracedCapability(handle, {
        tracer,
        extractAttributes: () => { throw new Error("sync extractor bug"); },
      }).client as any).peek("key");

      // The call itself is unaffected by the extractor failure.
      expect(result).toEqual(ok("warm"));

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const failureEvents = spans[0]!.events.filter(
        (e) => e.name === "fugue.capability.attribute_extraction_failed",
      );
      expect(failureEvents).toHaveLength(1);
      expect(failureEvents[0]!.attributes?.message).toBe("sync extractor bug");
      expect(spans[0]!.ended).toBe(true);
    });

    it("ends exactly one span per call across success, Result.Err, and throw paths", async () => {
      const handle: AnyHandle = {
        name: "db" as any,
        client: {
          good: async () => ok(1),
          bad: async () => err({ kind: "transient", nodeId: "n" as any, message: "x" }),
          boom: async () => { throw new Error("boom"); },
        },
      };
      const traced = withTracedCapability(handle, { tracer }).client as any;

      await traced.good();
      await traced.bad();
      await expect(traced.boom()).rejects.toThrow("boom");

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(3);
      expect(spans.every((s) => s.ended)).toBe(true);
    });
  });
});
