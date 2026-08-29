import { afterEach, describe, test, expect } from "bun:test";
import type { RunId, DagId } from "../types/ids.js";
import { beginRunTelemetry, closeRootSpan, startRunSpan } from "../dag-runtime/run-telemetry.js";
import { __resetFrameworkTracer, setFrameworkTracer } from "../tracing/global-tracer.js";
import { __resetFrameworkLogger, setFrameworkLogger } from "../logger.js";
import type { NodeContext } from "../types/node.js";
import type { DagDef } from "../types/dag.js";
import type { Observer } from "../observer/observer.js";
import type { ObserverEvent } from "../types/events.js";

/**
 * Wave 1.3 regression — `beginRunTelemetry` previously dispatched `run-start`
 * BEFORE capturing the `emitRunEnd` closure. An observer that threw on
 * `run-start` would propagate the error out of `beginRunTelemetry`, the
 * caller never received the closure, and the run terminated without a
 * `run-end` event. Observers expecting balanced start/end pairs were broken.
 *
 * Fix: closure is captured first; the dispatch is wrapped in a try/catch that
 * logs and continues. The closure is always returned.
 */
describe("run telemetry remains secondary to DAG execution", () => {
  afterEach(() => {
    __resetFrameworkTracer();
    __resetFrameworkLogger();
  });

  const makeCtx = (observer: Observer): NodeContext => ({
    runId: "run-1" as RunId,
    dagId: "dag-1" as DagId,
    observer,
    tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
    judgeLlm: null,
    cache: null,
    prompts: null,
    llm: null, http: null, clock: null, budget: null,
    logger: { warn: () => {}, error: () => {} },
  });

  const dag = { id: "dag-1" } as unknown as DagDef;

  test("returns emitRunEnd even when observer throws on run-start", () => {
    const throwing: Observer = {
      observe(event: ObserverEvent) {
        if (event.type === "run-start") throw new Error("boom on run-start");
      },
    };

    // Must not throw — beginRunTelemetry swallows the run-start failure and
    // returns the closure regardless.
    const { emitRunEnd } = beginRunTelemetry(makeCtx(throwing), dag, {});
    expect(typeof emitRunEnd).toBe("function");

    // Calling emitRunEnd still works.
    emitRunEnd("ok");
  });

  test("returns emitRunEnd when both run-start dispatch and failure logging throw", () => {
    const seen: ObserverEvent["type"][] = [];
    const observer: Observer = {
      observe(event) {
        seen.push(event.type);
        if (event.type === "run-start") throw new Error("observer down");
      },
    };
    setFrameworkLogger({
      debug() { throw new Error("debug logger down"); },
      info() { throw new Error("info logger down"); },
      warn() { throw new Error("warn logger down"); },
      error() { throw new Error("error logger down"); },
    });

    const { emitRunEnd } = beginRunTelemetry(makeCtx(observer), dag, {});
    expect(() => emitRunEnd("ok")).not.toThrow();
    expect(seen).toEqual(["run-start", "run-end"]);
  });

  test("emitRunEnd dispatches run-end even after run-start throw", () => {
    const seen: Array<"run-start" | "run-end"> = [];
    const observer: Observer = {
      observe(event: ObserverEvent) {
        if (event.type === "run-start") {
          seen.push("run-start");
          throw new Error("nope");
        }
        if (event.type === "run-end") {
          seen.push("run-end");
        }
      },
    };

    const { emitRunEnd } = beginRunTelemetry(makeCtx(observer), dag, {});
    emitRunEnd("ok");

    // Both events were attempted in order — the observer saw the throw on
    // run-start and STILL received run-end afterwards.
    expect(seen).toEqual(["run-start", "run-end"]);
  });

  test("non-throwing observer sees normal run-start → run-end", () => {
    const events: ObserverEvent[] = [];
    const observer: Observer = {
      observe(event: ObserverEvent) {
        events.push(event);
      },
    };

    const { emitRunEnd } = beginRunTelemetry(makeCtx(observer), dag, {});
    emitRunEnd("ok");

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("run-start");
    expect(events[1]?.type).toBe("run-end");
  });

  test("a root tracer setup throw falls back to exactly-once DAG execution", async () => {
    setFrameworkTracer({
      startActiveSpan() {
        throw new Error("root tracer down");
      },
    } as unknown as Parameters<typeof setFrameworkTracer>[0]);
    let calls = 0;

    const result = await startRunSpan(dag, makeCtx({ observe() {} }), async (span) => {
      calls += 1;
      closeRootSpan(span, { kind: "ok" });
      return "authoritative";
    });

    expect(calls).toBe(1);
    expect(result).toBe("authoritative");
  });

  test("a root tracer throw after callback invocation does not execute the DAG twice", async () => {
    const span = {
      addEvent() {},
      setStatus() {},
      end() {},
    };
    setFrameworkTracer({
      startActiveSpan(_name: string, _opts: unknown, fn: (activeSpan: unknown) => unknown) {
        fn(span);
        throw new Error("root tracer failed after callback");
      },
    } as unknown as Parameters<typeof setFrameworkTracer>[0]);
    let calls = 0;

    const result = await startRunSpan(dag, makeCtx({ observe() {} }), async (rootSpan) => {
      calls += 1;
      closeRootSpan(rootSpan, { kind: "ok" });
      return "authoritative";
    });

    expect(calls).toBe(1);
    expect(result).toBe("authoritative");
  });

  test("hostile root span operations cannot replace the DAG outcome or block end", async () => {
    let eventAttempts = 0;
    let statusAttempts = 0;
    let endAttempts = 0;
    setFrameworkTracer({
      startActiveSpan(_name: string, _opts: unknown, fn: (span: unknown) => unknown) {
        return fn({
          addEvent() { eventAttempts += 1; throw new Error("event down"); },
          setStatus() { statusAttempts += 1; throw new Error("status down"); },
          end() { endAttempts += 1; throw new Error("end down"); },
        });
      },
    } as unknown as Parameters<typeof setFrameworkTracer>[0]);

    const result = await startRunSpan(dag, makeCtx({ observe() {} }), async (span) => {
      closeRootSpan(span, { kind: "error", error: new Error("primary") });
      return "authoritative";
    });

    expect(result).toBe("authoritative");
    expect(eventAttempts).toBe(2);
    expect(statusAttempts).toBe(1);
    expect(endAttempts).toBe(1);
  });

  test("root outcome serialization failure still attempts span end", async () => {
    let endAttempts = 0;
    setFrameworkTracer({
      startActiveSpan(_name: string, _opts: unknown, fn: (span: unknown) => unknown) {
        return fn({
          addEvent() {},
          setStatus() {},
          end() { endAttempts += 1; },
        });
      },
    } as unknown as Parameters<typeof setFrameworkTracer>[0]);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const result = await startRunSpan(dag, makeCtx({ observe() {} }), async (span) => {
      closeRootSpan(span, { kind: "error", error: cyclic });
      return "authoritative";
    });

    expect(result).toBe("authoritative");
    expect(endAttempts).toBe(1);
  });
});
