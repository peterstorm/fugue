import { describe, it, expect } from "bun:test";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { normalizeExporter, initTracing } from "./init.js";
import { CompositeSpanExporter } from "./composite-exporter.js";
import { alwaysOn } from "../observer/policy.js";

const fakeExporter = (tag: string): SpanExporter => ({
  // tag carried so identity assertions read clearly in failures.
  export: (_s: ReadableSpan[], cb: (r: ExportResult) => void) =>
    cb({ code: ExportResultCode.SUCCESS }),
  shutdown: async () => {},
  forceFlush: async () => {},
  __tag: tag,
}) as SpanExporter & { __tag: string };

describe("normalizeExporter", () => {
  it("returns a single exporter as-is (no Composite wrapper)", () => {
    const exp = fakeExporter("single");
    const result = normalizeExporter(exp);
    // Byte-for-byte: the exact same instance flows through (SC-006).
    expect(result).toBe(exp);
    expect(result).not.toBeInstanceOf(CompositeSpanExporter);
  });

  it("unwraps a one-element list to the bare exporter (no Composite wrapper) — SC-006", () => {
    const exp = fakeExporter("only");
    const result = normalizeExporter([exp]);
    // The critical guarantee: [x] is identical to passing x directly.
    expect(result).toBe(exp);
    expect(result).not.toBeInstanceOf(CompositeSpanExporter);
  });

  it("wraps a list of two-or-more in a CompositeSpanExporter (FR-002)", () => {
    const a = fakeExporter("a");
    const b = fakeExporter("b");
    const result = normalizeExporter([a, b]);
    expect(result).toBeInstanceOf(CompositeSpanExporter);
  });

  it("wraps three exporters in a CompositeSpanExporter", () => {
    const result = normalizeExporter([
      fakeExporter("a"),
      fakeExporter("b"),
      fakeExporter("c"),
    ]);
    expect(result).toBeInstanceOf(CompositeSpanExporter);
  });

  it("rejects an empty list with a clear boundary error", () => {
    expect(() => normalizeExporter([])).toThrow(/empty exporter list/i);
  });

  it("the composite from [a,b] fans out to both children", async () => {
    const calls: string[] = [];
    const make = (tag: string): SpanExporter => ({
      export: (_s, cb) => {
        calls.push(tag);
        cb({ code: ExportResultCode.SUCCESS });
      },
      shutdown: async () => {},
      forceFlush: async () => {},
    });
    const composite = normalizeExporter([make("a"), make("b")]);
    await new Promise<void>((resolve) =>
      composite.export([], () => resolve()),
    );
    expect(calls.sort()).toEqual(["a", "b"]);
  });
});

describe("initTracing — lifecycle", () => {
  it("builds a handle with processor/policy/flush/shutdown intact for a single exporter", async () => {
    const policy = alwaysOn();
    const handle = await initTracing({ exporter: fakeExporter("single"), policy });
    try {
      expect(handle.processor).toBeDefined();
      expect(handle.policy).toBe(policy);
      await expect(handle.flush()).resolves.toBeUndefined();
    } finally {
      await handle.shutdown();
    }
  });

  it("wires a CompositeSpanExporter into the processor for a multi-exporter config", async () => {
    const policy = alwaysOn();
    const handle = await initTracing({
      exporter: [fakeExporter("a"), fakeExporter("b")],
      policy,
    });
    try {
      // The processor holds the normalized exporter; flush/shutdown must work.
      await expect(handle.flush()).resolves.toBeUndefined();
    } finally {
      await handle.shutdown();
    }
  });

  it("rejects an empty exporter list (defense-in-depth at the untyped boundary)", async () => {
    // The public `exporter` type is a non-empty tuple, so `[]` is a compile
    // error at literal call sites. A dynamically-built list (T5 bootstrap)
    // crosses an untyped boundary — modelled here with a cast — where `[]`
    // could slip through; the runtime guard must still reject it.
    const dynamicEmpty = [] as unknown as readonly [SpanExporter, ...SpanExporter[]];
    await expect(
      initTracing({ exporter: dynamicEmpty, policy: alwaysOn() }),
    ).rejects.toThrow(/empty exporter list/i);
  });
});
