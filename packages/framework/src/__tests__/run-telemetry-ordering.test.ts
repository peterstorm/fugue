import { describe, test, expect } from "bun:test";
import type { RunId, DagId } from "../types/ids.js";
import { beginRunTelemetry } from "../dag-runtime/run-telemetry.js";
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
describe("beginRunTelemetry — balanced start/end on observer throw (Wave 1.3)", () => {
  const makeCtx = (observer: Observer): NodeContext => ({
    runId: "run-1" as RunId,
    dagId: "dag-1" as DagId,
    observer,
    tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
    judgeLlm: null,
    cache: null,
    prompts: null,
    llm: null, http: null, clock: null,
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
});
