import { describe, test, expect } from "bun:test";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { NoopObserver } from "../observer/observer.js";
import { beginRunTelemetry } from "../dag-runtime/run-telemetry.js";
import type { NodeContext } from "../types/node.js";
import type { DagDef } from "../types/dag.js";
import type { Observer } from "../observer/observer.js";
import type { RunStartEvent, RunEndEvent } from "../types/events.js";
import { N, R, D, nodeMap, nodeSet } from "./_id-helpers.js";

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
    llm: null,
    logger: { warn: () => {}, error: () => {} },
  });

  const dag = { id: "dag-1" } as unknown as DagDef;

  test("returns emitRunEnd even when observer.onRunStart throws", () => {
    const throwing = new NoopObserver();
    throwing.onRunStart = () => {
      throw new Error("boom on run-start");
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
      onRunStart: () => {
        seen.push("run-start");
        throw new Error("nope");
      },
      onRunEnd: () => {
        seen.push("run-end");
      },
      onNodeStart: () => {},
      onNodeEnd: () => {},
      onNodeSkipped: () => {},
      onNodeError: () => {},
      onSubSpan: () => {},
      onRouteDecided: () => {},
      onNodePruned: () => {},
      onWitnessCaptured: () => {},
      onWriteAttempted: () => {},
      onFreshnessViolation: () => {},
      onHumanIntervention: () => {},
    };

    const { emitRunEnd } = beginRunTelemetry(makeCtx(observer), dag, {});
    emitRunEnd("ok");

    // Both events were attempted in order — the observer saw the throw on
    // run-start and STILL received run-end afterwards.
    expect(seen).toEqual(["run-start", "run-end"]);
  });

  test("non-throwing observer sees normal run-start → run-end", () => {
    const events: Array<RunStartEvent | RunEndEvent> = [];
    const observer = new NoopObserver();
    observer.onRunStart = (e) => events.push(e);
    observer.onRunEnd = (e) => events.push(e);

    const { emitRunEnd } = beginRunTelemetry(makeCtx(observer), dag, {});
    emitRunEnd("ok");

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("run-start");
    expect(events[1]?.type).toBe("run-end");
  });
});
