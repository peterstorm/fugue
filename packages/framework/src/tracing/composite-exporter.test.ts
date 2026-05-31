import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fc from "fast-check";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { CompositeSpanExporter } from "./composite-exporter.js";
import { setFrameworkLogger, __resetFrameworkLogger, type FrameworkLogger } from "../logger.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Minimal span stand-in; the composite never inspects span shape. */
const fakeSpan = (id: string): ReadableSpan => ({ name: id }) as unknown as ReadableSpan;

type Behavior =
  | { kind: "success" }
  | { kind: "result-failed"; message?: string }
  | { kind: "throw"; message?: string };

/** Fake child exporter that records calls and behaves per the given Behavior. */
class FakeExporter implements SpanExporter {
  exportCalls: ReadableSpan[][] = [];
  shutdownCalls = 0;
  forceFlushCalls = 0;
  constructor(
    private readonly behavior: Behavior = { kind: "success" },
    private readonly opts: {
      readonly rejectShutdown?: boolean;
      readonly rejectFlush?: boolean;
      readonly async?: boolean;
    } = {},
  ) {}

  export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
    this.exportCalls.push(spans);
    const fire = () => {
      switch (this.behavior.kind) {
        case "success":
          cb({ code: ExportResultCode.SUCCESS });
          break;
        case "result-failed":
          cb({
            code: ExportResultCode.FAILED,
            error: new Error(this.behavior.message ?? "child failed"),
          });
          break;
        case "throw":
          throw new Error(this.behavior.message ?? "child threw");
      }
    };
    if (this.opts.async && this.behavior.kind !== "throw") {
      // Defer the callback to exercise the concurrent-settle path.
      queueMicrotask(fire);
    } else {
      fire();
    }
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls++;
    if (this.opts.rejectShutdown) throw new Error("shutdown boom");
  }

  async forceFlush(): Promise<void> {
    this.forceFlushCalls++;
    if (this.opts.rejectFlush) throw new Error("flush boom");
  }
}

const exportOnce = (exp: SpanExporter, spans: ReadableSpan[]): Promise<ExportResult> =>
  new Promise((resolve) => exp.export(spans, resolve));

// Recording logger so warn-spam assertions can be made without console noise.
let warnings: string[] = [];
let errors: string[] = [];
const recordingLogger: FrameworkLogger = {
  debug: () => {},
  info: () => {},
  warn: (msg) => {
    warnings.push(msg);
  },
  error: (msg) => {
    errors.push(msg);
  },
};

beforeEach(() => {
  warnings = [];
  errors = [];
  setFrameworkLogger(recordingLogger);
});

/** A child whose `export` returns void and never invokes its callback. */
class HangingExporter implements SpanExporter {
  exportCalls = 0;
  export(_spans: ReadableSpan[], _cb: (r: ExportResult) => void): void {
    this.exportCalls++;
    // Intentionally never fires the callback (simulates a hung backend).
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Constructor invariants
// ---------------------------------------------------------------------------

describe("CompositeSpanExporter — construction", () => {
  it("rejects an empty children list at compile time (non-empty tuple invariant)", () => {
    // The constructor param is `readonly [SpanExporter, ...SpanExporter[]]`,
    // so passing `[]` is a genuine type error. `@ts-expect-error` is verified
    // by `tsc` (`bun run typecheck`): if the empty call ever compiles again,
    // typecheck fails on an unused-directive error. We never construct here —
    // a throwing closure would execute at runtime; this asserts only the type.
    const construct = (): CompositeSpanExporter =>
      // @ts-expect-error — empty tuple is a compile error; non-empty invariant lives in the type
      new CompositeSpanExporter([]);
    expect(typeof construct).toBe("function");
  });

  it("throws on an empty children list at runtime (defense-in-depth via the dynamic boundary)", () => {
    // The dynamic-config boundary funnels a wide `readonly SpanExporter[]`
    // through an audited cast; this simulates `[]` slipping through it. The
    // constructor's runtime guard must still fail fast.
    const empty = [] as unknown as readonly [SpanExporter, ...SpanExporter[]];
    expect(() => new CompositeSpanExporter(empty)).toThrow(/at least one child/i);
  });

  it("accepts one or more children", () => {
    expect(() => new CompositeSpanExporter([new FakeExporter()])).not.toThrow();
    expect(
      () => new CompositeSpanExporter([new FakeExporter(), new FakeExporter()]),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

describe("CompositeSpanExporter — fan-out", () => {
  it("delivers the same span instances to every child exactly once", async () => {
    const a = new FakeExporter();
    const b = new FakeExporter();
    const c = new FakeExporter();
    const composite = new CompositeSpanExporter([a, b, c]);
    const spans = [fakeSpan("s1"), fakeSpan("s2")];

    await exportOnce(composite, spans);

    for (const child of [a, b, c]) {
      expect(child.exportCalls.length).toBe(1);
      // Same identities (FR-011): the exact array contents are forwarded.
      expect(child.exportCalls[0]).toBe(spans);
    }
  });

  it("aggregate is SUCCESS when all children succeed", async () => {
    const composite = new CompositeSpanExporter([
      new FakeExporter(),
      new FakeExporter(),
    ]);
    const result = await exportOnce(composite, [fakeSpan("s")]);
    expect(result.code).toBe(ExportResultCode.SUCCESS);
  });
});

// ---------------------------------------------------------------------------
// Fault isolation
// ---------------------------------------------------------------------------

describe("CompositeSpanExporter — fault isolation", () => {
  it("one child throwing does not stop others; aggregate is SUCCESS", async () => {
    const bad = new FakeExporter({ kind: "throw" });
    const good = new FakeExporter();
    const composite = new CompositeSpanExporter([bad, good]);

    const result = await exportOnce(composite, [fakeSpan("s")]);

    expect(good.exportCalls.length).toBe(1);
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(composite.childFailureCounts).toEqual([
      { index: 0, failures: 1 },
      { index: 1, failures: 0 },
    ]);
  });

  it("one child returning FAILED does not stop others; aggregate is SUCCESS", async () => {
    const bad = new FakeExporter({ kind: "result-failed" });
    const good = new FakeExporter();
    const composite = new CompositeSpanExporter([bad, good]);

    const result = await exportOnce(composite, [fakeSpan("s")]);

    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(composite.childFailureCounts[0]!.failures).toBe(1);
  });

  it("aggregate is FAILED with aggregated error only when EVERY child fails", async () => {
    const composite = new CompositeSpanExporter([
      new FakeExporter({ kind: "throw", message: "boom-a" }),
      new FakeExporter({ kind: "result-failed", message: "boom-b" }),
    ]);

    const result = await exportOnce(composite, [fakeSpan("s")]);

    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error!.message).toContain("boom-a");
    expect(result.error!.message).toContain("boom-b");
    expect(composite.childFailureCounts).toEqual([
      { index: 0, failures: 1 },
      { index: 1, failures: 1 },
    ]);
  });

  it("accumulates per-child failure counts across repeated exports", async () => {
    const bad = new FakeExporter({ kind: "result-failed" });
    const good = new FakeExporter();
    const composite = new CompositeSpanExporter([bad, good]);

    await exportOnce(composite, [fakeSpan("s")]);
    await exportOnce(composite, [fakeSpan("s")]);
    await exportOnce(composite, [fakeSpan("s")]);

    expect(composite.childFailureCounts[0]!.failures).toBe(3);
    expect(composite.childFailureCounts[1]!.failures).toBe(0);
  });

  it("rate-limits failure logging at true powers of ten (1, 10, 100)", async () => {
    const bad = new FakeExporter({ kind: "result-failed" });
    const composite = new CompositeSpanExporter([bad, new FakeExporter()]);
    for (let i = 0; i < 100; i++) await exportOnce(composite, [fakeSpan("s")]);
    // Logs ONLY at true powers of ten — occurrences 1, 10, 100 — so a broken
    // backend can't flood the logs. With 100 failures that's exactly 3 warns
    // (far fewer than 100), and the first is at occurrence 1.
    expect(warnings.length).toBe(3);
    expect(warnings[0]).toContain("occurrence 1");
    expect(warnings[1]).toContain("occurrence 10");
    expect(warnings[2]).toContain("occurrence 100");
    // No log at a non-power-of-ten milestone like 20.
    expect(warnings.some((w) => w.includes("occurrence 20"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Settle deadline — hanging children must not wedge export() (FR-025/SC-009)
// ---------------------------------------------------------------------------

describe("CompositeSpanExporter — settle deadline", () => {
  it("a single child that never fires its callback settles as FAILED within the deadline", async () => {
    const hang = new HangingExporter();
    // 20ms injected deadline so the test is fast (not 30s).
    const composite = new CompositeSpanExporter([hang], 20);

    const result = await exportOnce(composite, [fakeSpan("s")]);

    expect(hang.exportCalls).toBe(1);
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error!.message).toMatch(/did not settle/i);
    // The timed-out child is counted as a failure.
    expect(composite.childFailureCounts[0]!.failures).toBe(1);
  });

  it("one hanging child of two still finalizes once the other settles; hanging child counted as failure", async () => {
    const hang = new HangingExporter();
    const good = new FakeExporter();
    const composite = new CompositeSpanExporter([hang, good], 20);

    const result = await exportOnce(composite, [fakeSpan("s")]);

    // The good child succeeded ⇒ aggregate SUCCESS; finalize did not wait
    // indefinitely on the hanging child — but the hanging child IS counted.
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(good.exportCalls.length).toBe(1);
    expect(composite.childFailureCounts).toEqual([
      { index: 0, failures: 1 },
      { index: 1, failures: 0 },
    ]);
  });

  it("all children hanging ⇒ aggregate FAILED (outage surfaces, not a wedge)", async () => {
    const composite = new CompositeSpanExporter(
      [new HangingExporter(), new HangingExporter()],
      20,
    );
    const result = await exportOnce(composite, [fakeSpan("s")]);
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(composite.childFailureCounts).toEqual([
      { index: 0, failures: 1 },
      { index: 1, failures: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Fire-once latch — double callback, late callback, throw-after-success
// ---------------------------------------------------------------------------

describe("CompositeSpanExporter — fire-once latch", () => {
  it("a child invoking its callback twice settles the composite exactly once", async () => {
    let resolveCount = 0;
    // Child that fires SUCCESS twice synchronously.
    const doubleFire: SpanExporter = {
      export: (_s, cb) => {
        cb({ code: ExportResultCode.SUCCESS });
        cb({ code: ExportResultCode.SUCCESS });
      },
      shutdown: async () => {},
      forceFlush: async () => {},
    };
    const good = new FakeExporter();
    const composite = new CompositeSpanExporter([doubleFire, good], 50);

    await new Promise<void>((resolve) =>
      composite.export([fakeSpan("s")], () => {
        resolveCount++;
        resolve();
      }),
    );
    // Give any erroneous second settle a microtask/macrotask window to surface.
    await new Promise((r) => setTimeout(r, 5));

    expect(resolveCount).toBe(1);
    // The double-firing child must not inflate its failure counter.
    expect(composite.childFailureCounts[0]!.failures).toBe(0);
  });

  it("a child that throws AFTER firing a successful callback is swallowed (no double-count)", async () => {
    const throwAfterSuccess: SpanExporter = {
      export: (_s, cb) => {
        cb({ code: ExportResultCode.SUCCESS });
        throw new Error("late throw after success");
      },
      shutdown: async () => {},
      forceFlush: async () => {},
    };
    const composite = new CompositeSpanExporter([throwAfterSuccess], 50);

    const result = await exportOnce(composite, [fakeSpan("s")]);

    expect(result.code).toBe(ExportResultCode.SUCCESS);
    // The post-success throw is swallowed by the latch — not counted.
    expect(composite.childFailureCounts[0]!.failures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Async/deferred concurrent-settle path (exercises FakeExporter opts.async)
// ---------------------------------------------------------------------------

describe("CompositeSpanExporter — async concurrent settle", () => {
  it("mixed sync + async children resolve to a single SUCCESS", async () => {
    const sync = new FakeExporter({ kind: "success" });
    const asyncOk = new FakeExporter({ kind: "success" }, { async: true });
    const composite = new CompositeSpanExporter([sync, asyncOk], 100);

    const result = await exportOnce(composite, [fakeSpan("s")]);

    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(sync.exportCalls.length).toBe(1);
    expect(asyncOk.exportCalls.length).toBe(1);
  });

  it("mixed async-fail + async-success resolves once to SUCCESS", async () => {
    const asyncFail = new FakeExporter({ kind: "result-failed" }, { async: true });
    const asyncOk = new FakeExporter({ kind: "success" }, { async: true });
    const composite = new CompositeSpanExporter([asyncFail, asyncOk], 100);

    const result = await exportOnce(composite, [fakeSpan("s")]);

    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(composite.childFailureCounts[0]!.failures).toBe(1);
    expect(composite.childFailureCounts[1]!.failures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// shutdown / forceFlush
// ---------------------------------------------------------------------------

describe("CompositeSpanExporter — lifecycle", () => {
  it("shutdown fans out to all children and never rejects", async () => {
    const a = new FakeExporter();
    const b = new FakeExporter({ kind: "success" }, { rejectShutdown: true });
    const composite = new CompositeSpanExporter([a, b]);

    await expect(composite.shutdown()).resolves.toBeUndefined();
    expect(a.shutdownCalls).toBe(1);
    expect(b.shutdownCalls).toBe(1);
    expect(warnings.some((w) => w.includes("shutdown"))).toBe(true);
  });

  it("forceFlush fans out to all children and never rejects", async () => {
    const a = new FakeExporter();
    const b = new FakeExporter({ kind: "success" }, { rejectFlush: true });
    const composite = new CompositeSpanExporter([a, b]);

    await expect(composite.forceFlush()).resolves.toBeUndefined();
    expect(a.forceFlushCalls).toBe(1);
    expect(b.forceFlushCalls).toBe(1);
    expect(warnings.some((w) => w.includes("forceFlush"))).toBe(true);
  });

  it("forceFlush total outage (all children reject) still resolves AND logs error-level", async () => {
    const a = new FakeExporter({ kind: "success" }, { rejectFlush: true });
    const b = new FakeExporter({ kind: "success" }, { rejectFlush: true });
    const composite = new CompositeSpanExporter([a, b]);

    await expect(composite.forceFlush()).resolves.toBeUndefined();
    // Per-child warns plus a single aggregated error naming the total outage.
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("ALL 2");
    expect(errors[0]).toContain("forceFlush");
    expect(errors[0]).toContain("flush boom");
  });

  it("shutdown total outage (all children reject) still resolves AND logs error-level", async () => {
    const a = new FakeExporter({ kind: "success" }, { rejectShutdown: true });
    const b = new FakeExporter({ kind: "success" }, { rejectShutdown: true });
    const composite = new CompositeSpanExporter([a, b]);

    await expect(composite.shutdown()).resolves.toBeUndefined();
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("ALL 2");
    expect(errors[0]).toContain("shutdown");
  });

  it("partial failure (1 of 2 rejects) logs per-child warn only, no error-level aggregate", async () => {
    const a = new FakeExporter();
    const b = new FakeExporter({ kind: "success" }, { rejectFlush: true });
    const composite = new CompositeSpanExporter([a, b]);

    await expect(composite.forceFlush()).resolves.toBeUndefined();
    expect(warnings.some((w) => w.includes("forceFlush"))).toBe(true);
    expect(errors.length).toBe(0);
  });

  it("tolerates children without shutdown/forceFlush methods", async () => {
    const bare: SpanExporter = {
      export: (_s, cb) => cb({ code: ExportResultCode.SUCCESS }),
      shutdown: async () => {},
    };
    // Strip forceFlush to simulate a minimal exporter.
    const composite = new CompositeSpanExporter([bare]);
    await expect(composite.forceFlush()).resolves.toBeUndefined();
    await expect(composite.shutdown()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Property tests (fast-check)
// ---------------------------------------------------------------------------

describe("CompositeSpanExporter — properties", () => {
  // fast-check's `minLength: 1` guarantees a non-empty array at runtime but
  // types it as the wide `T[]`. This helper re-narrows to the non-empty tuple
  // the constructor requires, with a runtime assertion so the narrowing can
  // never silently lie if a generator ever produces `[]`.
  const nonEmpty = <T>(xs: readonly T[]): readonly [T, ...T[]] => {
    if (xs.length === 0) throw new Error("expected a non-empty generated array");
    return xs as readonly [T, ...T[]];
  };

  // Generate a non-empty list of child behaviors (success vs fail).
  const behaviorArb: fc.Arbitrary<Behavior> = fc.oneof(
    fc.constant<Behavior>({ kind: "success" }),
    fc.constant<Behavior>({ kind: "result-failed" }),
    fc.constant<Behavior>({ kind: "throw" }),
  );

  it("result is SUCCESS iff at least one child succeeds; every child exported once", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(behaviorArb, { minLength: 1, maxLength: 8 }),
        async (behaviors) => {
          const children = behaviors.map((b) => new FakeExporter(b));
          const composite = new CompositeSpanExporter(nonEmpty(children));
          const spans = [fakeSpan("s")];

          const result = await exportOnce(composite, spans);

          const anySuccess = behaviors.some((b) => b.kind === "success");
          expect(result.code).toBe(
            anySuccess ? ExportResultCode.SUCCESS : ExportResultCode.FAILED,
          );
          // Every child's export invoked exactly once (fan-out completeness).
          for (const child of children) {
            expect(child.exportCalls.length).toBe(1);
          }
          // When all failed, an aggregated error is present.
          if (!anySuccess) {
            expect(result.error).toBeInstanceOf(Error);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("failure counters equal the number of failing children per export", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(behaviorArb, { minLength: 1, maxLength: 8 }),
        async (behaviors) => {
          const children = behaviors.map((b) => new FakeExporter(b));
          const composite = new CompositeSpanExporter(nonEmpty(children));
          await exportOnce(composite, [fakeSpan("s")]);

          const counts = composite.childFailureCounts;
          behaviors.forEach((b, i) => {
            const expected = b.kind === "success" ? 0 : 1;
            expect(counts[i]!.failures).toBe(expected);
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  it("shutdown/forceFlush never reject regardless of child rejection pattern", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
        async (rejectFlags) => {
          const children = rejectFlags.map(
            (r) => new FakeExporter({ kind: "success" }, { rejectShutdown: r, rejectFlush: r }),
          );
          const composite = new CompositeSpanExporter(nonEmpty(children));
          await expect(composite.forceFlush()).resolves.toBeUndefined();
          await expect(composite.shutdown()).resolves.toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});

afterEach(() => {
  __resetFrameworkLogger();
});
