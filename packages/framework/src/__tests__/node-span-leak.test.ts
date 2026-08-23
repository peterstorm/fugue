import { describe, expect, test, afterEach } from "bun:test";
import { setFrameworkTracer, __resetFrameworkTracer } from "../tracing/global-tracer.js";
import { withTracedNodeSpan } from "../dag-runtime/node-span.js";
import { err, ok } from "../types/result.js";
import { __resetFrameworkLogger, setFrameworkLogger } from "../logger.js";
import { UNPRINTABLE_ERROR } from "../types/safe-error.js";
import { resourceName } from "../types/freshness.js";

/**
 * Wave 1.1 regression test. Before the fix, `withTracedNodeSpan` did
 * `const result = await fn()` with no `try/catch` around `fn()` itself —
 * under `OBSERVER_STRICT=1` (or any other re-thrown failure inside the
 * node), `span.end()` never ran and the OTel pipeline leaked spans.
 *
 * This test runs `withTracedNodeSpan` with an `fn()` that throws and asserts
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

describe("withTracedNodeSpan span leak under thrown fn (Wave 1.1)", () => {
  afterEach(() => {
    __resetFrameworkTracer();
    __resetFrameworkLogger();
  });

  test("span.end() runs even when fn() throws", async () => {
    const recorded: RecordedSpan[] = [];
    setFrameworkTracer(makeFakeTracer(recorded) as unknown as Parameters<typeof setFrameworkTracer>[0]);

    const { result } = await withTracedNodeSpan("n1", "transform", { in: 1 }, null, { kind: "none" }, async () => {
      throw new Error("observer-strict rethrow");
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.message).toBe("observer-strict rethrow");
      }
    }
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.ended).toBe(true);
    expect(recorded[0]?.status?.code).toBe(2); // ERROR
  });

  test("hostile thrown values and throwing message/stack getters become node-crash data", async () => {
    const recorded: RecordedSpan[] = [];
    setFrameworkTracer(makeFakeTracer(recorded) as unknown as Parameters<typeof setFrameworkTracer>[0]);

    const hostile = Object.defineProperties({}, {
      message: { get: () => { throw new Error("message unavailable"); } },
      stack: { get: () => { throw new Error("stack unavailable"); } },
      toString: { value: () => "hostile node failure" },
    });
    const { result } = await withTracedNodeSpan(
      "n1",
      "transform",
      null,
      null,
      { kind: "none" },
      async () => { throw hostile; },
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.message).toBe("hostile node failure");
      expect("stack" in result.error).toBe(false);
    }
    expect(recorded[0]?.ended).toBe(true);
    expect(recorded[0]?.status?.message).toBe("hostile node failure");
  });

  test("secondary span and logger failures cannot replace a hostile node failure", async () => {
    let statusAttempts = 0;
    let endAttempts = 0;
    setFrameworkLogger({
      debug: () => { throw new Error("logger down"); },
      info: () => { throw new Error("logger down"); },
      warn: () => { throw new Error("logger down"); },
      error: () => { throw new Error("logger down"); },
    });
    setFrameworkTracer({
      startActiveSpan(_name: string, _opts: unknown, fn: (span: unknown) => unknown) {
        return fn({
          addEvent() {},
          setStatus() {
            statusAttempts += 1;
            throw new Error("status down");
          },
          end() {
            endAttempts += 1;
            throw new Error("end down");
          },
        });
      },
    } as unknown as Parameters<typeof setFrameworkTracer>[0]);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    const { result } = await withTracedNodeSpan(
      "n1",
      "transform",
      null,
      null,
      { kind: "none" },
      async () => { throw revoked.proxy; },
    );

    expect(statusAttempts).toBe(1);
    expect(endAttempts).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.message).toBe(UNPRINTABLE_ERROR);
    }
  });

  test("cyclic payloads and throwing content filters cannot prevent or replace execution", async () => {
    const recorded: RecordedSpan[] = [];
    setFrameworkTracer(makeFakeTracer(recorded) as unknown as Parameters<typeof setFrameworkTracer>[0]);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let calls = 0;

    const first = await withTracedNodeSpan(
      "n1",
      "transform",
      cyclic,
      (value) => value,
      { kind: "none" },
      async () => { calls += 1; return ok(cyclic); },
    );
    const second = await withTracedNodeSpan(
      "n2",
      "transform",
      { safe: true },
      () => { throw new Error("filter down"); },
      { kind: "none" },
      async () => { calls += 1; return ok({ done: true }); },
    );

    expect(first.result).toEqual(ok(cyclic));
    expect(second.result).toEqual(ok({ done: true }));
    expect(calls).toBe(2);
    expect(recorded.every((span) => span.ended)).toBe(true);
  });

  test("hostile span methods cannot replace successful or failed node Results", async () => {
    let endAttempts = 0;
    setFrameworkTracer({
      startActiveSpan(_name: string, _opts: unknown, fn: (span: unknown) => unknown) {
        return fn({
          addEvent() { throw new Error("event down"); },
          setStatus() { throw new Error("status down"); },
          setAttribute() { throw new Error("attribute down"); },
          end() { endAttempts += 1; throw new Error("end down"); },
        });
      },
    } as unknown as Parameters<typeof setFrameworkTracer>[0]);
    const modeled = err({ kind: "aborted" as const, reason: "modeled" });

    const success = await withTracedNodeSpan(
      "n1", "transform", null, null, { kind: "none" }, async () => ok("done"),
    );
    const failure = await withTracedNodeSpan(
      "n2", "transform", null, null, { kind: "none" }, async () => modeled,
    );

    expect(success.result).toEqual(ok("done"));
    expect(failure.result).toEqual(modeled);
    expect(endAttempts).toBe(2);
  });

  test("idempotency extractor failures stay modeled when diagnostics are hostile", async () => {
    setFrameworkLogger({
      debug: () => { throw new Error("logger down"); },
      info: () => { throw new Error("logger down"); },
      warn: () => { throw new Error("logger down"); },
      error: () => { throw new Error("logger down"); },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    const { result } = await withTracedNodeSpan(
      "n1",
      "transform",
      null,
      null,
      {
        kind: "writes",
        resource: resourceName("document"),
        idempotencyKey: () => { throw revoked.proxy; },
      },
      async () => ok("must not run"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.retriability).toBe("non-retriable");
      expect(result.error.message).toContain(UNPRINTABLE_ERROR);
    }
  });

  test("span.end() runs on the normal (non-throwing) path", async () => {
    const recorded: RecordedSpan[] = [];
    setFrameworkTracer(makeFakeTracer(recorded) as unknown as Parameters<typeof setFrameworkTracer>[0]);

    const { result } = await withTracedNodeSpan("n1", "transform", { in: 1 }, null, { kind: "none" }, async () =>
      ok({ out: 2 }),
    );
    expect(result.ok).toBe(true);
    expect(recorded[0]?.ended).toBe(true);
  });
});
