import { describe, expect, test, afterEach } from "bun:test";
import { setFrameworkTracer, __resetFrameworkTracer } from "../tracing/global-tracer.js";
import { withNodeSpan } from "../dag-runtime/node-span.js";
import { ok } from "../types/result.js";

/**
 * Wave 1.1 regression test. Before the fix, `withNodeSpan` did
 * `const result = await fn()` with no `try/catch` around `fn()` itself —
 * under `OBSERVER_STRICT=1` (or any other re-thrown failure inside the
 * node), `span.end()` never ran and the OTel pipeline leaked spans.
 *
 * This test runs `withNodeSpan` with an `fn()` that throws and asserts
 * the recording tracer observes a balanced start/end pair.
 */

interface RecordedSpan {
  readonly name: string;
  ended: boolean;
  status?: { code: number; message?: string };
}

const makeFakeTracer = (recorded: RecordedSpan[]) => {
  return {
    startActiveSpan(name: string, _opts: unknown, fn: (span: unknown) => unknown) {
      const entry: RecordedSpan = { name, ended: false };
      recorded.push(entry);
      const span = {
        setAttribute() { return span; },
        setAttributes() { return span; },
        addEvent() { return span; },
        end() { entry.ended = true; },
        isRecording() { return true; },
        recordException() {},
        setStatus(s: { code: number; message?: string }) { entry.status = s; return span; },
        spanContext() { return { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 }; },
        updateName() { return span; },
      };
      return fn(span);
    },
  };
};

describe("withNodeSpan span leak under thrown fn (Wave 1.1)", () => {
  afterEach(() => {
    __resetFrameworkTracer();
  });

  test("span.end() runs even when fn() throws", async () => {
    const recorded: RecordedSpan[] = [];
    setFrameworkTracer(makeFakeTracer(recorded) as unknown as Parameters<typeof setFrameworkTracer>[0]);

    await expect(
      withNodeSpan("n1", "transform", { in: 1 }, null, async () => {
        throw new Error("observer-strict rethrow");
      }),
    ).rejects.toThrow("observer-strict rethrow");

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.ended).toBe(true);
    expect(recorded[0]?.status?.code).toBe(2); // ERROR
  });

  test("span.end() runs on the normal (non-throwing) path", async () => {
    const recorded: RecordedSpan[] = [];
    setFrameworkTracer(makeFakeTracer(recorded) as unknown as Parameters<typeof setFrameworkTracer>[0]);

    const { result } = await withNodeSpan("n1", "transform", { in: 1 }, null, async () =>
      ok({ out: 2 }),
    );
    expect(result.ok).toBe(true);
    expect(recorded[0]?.ended).toBe(true);
  });
});
