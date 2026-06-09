import { resourceName, witness, mkWitness, RN } from "./_freshness-helpers.js";
import { describe, it, expect } from "bun:test";
import { emitHumanIntervention } from "../dag-runtime/human-emission.js";
import { RecordingObserver } from "../observer/observer.js";
import { nodeId, runId, dagId } from "../types/ids.js";
import { confidence } from "../types/confidence.js";
import type { NodeDef } from "../types/node.js";
import type { HumanAction } from "../dag-runtime/types.js";
import type { HumanInterventionEvent } from "../types/events.js";
import { z } from "zod";
import { ok } from "../types/result.js";

const NID = nodeId("test-node");
const RID = runId("run-1");
const DID = dagId("dag-1");

const makeNodeDef = (overrides?: Partial<NodeDef<unknown, unknown>>): NodeDef<unknown, unknown> => ({
  id: NID,
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  requires: [] as const,
  run: async () => ok(null),
  sideEffects: { kind: "writes", resource: RN("postgres:orders") },
  confidence: { mode: "none" },
  ...overrides,
});

const makeCtx = (observer: RecordingObserver) => ({
  runId: RID,
  dagId: DID,
  logger: { warn: () => {}, error: () => {} },
  tracer: { startActiveSpan: (_n: string, _o: unknown, fn: (s: unknown) => unknown) => fn({ setAttribute: () => {}, addEvent: () => {}, setStatus: () => {}, end: () => {} }) } as unknown,
  observer,
  cache: null,
  llm: null, http: null,
  prompts: null,
  judgeLlm: null,
});

describe("emitHumanIntervention", () => {
  it("emits approve action", () => {
    const obs = new RecordingObserver();
    const nodeMap = new Map([[NID, makeNodeDef()]]);
    const action: HumanAction = { kind: "approve", actor: "alice" };

    emitHumanIntervention(
      { nodeId: NID, output: { x: 1 } },
      action, nodeMap, makeCtx(obs) as any, DID, Date.now, Date.now() - 500, [],
    );

    const events = obs.events.filter((e) => e.type === "human-intervention") as HumanInterventionEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]!.action.kind).toBe("approve");
    expect(events[0]!.actor).toBe("alice");
    expect(events[0]!.context.nodeSideEffects).toBe("writes");
  });

  it("emits approve-with-edit with JSON patch diff", () => {
    const obs = new RecordingObserver();
    const nodeMap = new Map([[NID, makeNodeDef()]]);
    const action: HumanAction = { kind: "approve-with-edit", newOutput: { x: 2 } };

    emitHumanIntervention(
      { nodeId: NID, output: { x: 1 } },
      action, nodeMap, makeCtx(obs) as any, DID, Date.now, Date.now(), [],
    );

    const evt = obs.events.find((e) => e.type === "human-intervention") as HumanInterventionEvent;
    expect(evt.action.kind).toBe("approve-with-edit");
    if (evt.action.kind === "approve-with-edit") {
      expect(evt.action.originalOutput).toEqual({ x: 1 });
      expect(evt.action.replacedOutput).toEqual({ x: 2 });
      expect(evt.action.diff.length).toBeGreaterThan(0);
    }
  });

  it("emits reject action with reason", () => {
    const obs = new RecordingObserver();
    const nodeMap = new Map([[NID, makeNodeDef()]]);
    const action: HumanAction = { kind: "reject", reason: "looks wrong" };

    emitHumanIntervention(
      { nodeId: NID, output: {} },
      action, nodeMap, makeCtx(obs) as any, DID, Date.now, Date.now(), [],
    );

    const evt = obs.events.find((e) => e.type === "human-intervention") as HumanInterventionEvent;
    expect(evt.action.kind).toBe("reject");
    if (evt.action.kind === "reject") {
      expect(evt.action.reason).toBe("looks wrong");
    }
  });

  it("emits reroute action with target", () => {
    const obs = new RecordingObserver();
    const targetNid = nodeId("other-node");
    const nodeMap = new Map([[NID, makeNodeDef()]]);
    const action: HumanAction = { kind: "reroute", targetNodeId: targetNid, reason: "try again" };

    emitHumanIntervention(
      { nodeId: NID, output: {} },
      action, nodeMap, makeCtx(obs) as any, DID, Date.now, Date.now(), [],
    );

    const evt = obs.events.find((e) => e.type === "human-intervention") as HumanInterventionEvent;
    expect(evt.action.kind).toBe("reroute");
    if (evt.action.kind === "reroute") {
      expect(evt.action.targetNodeId).toBe(targetNid);
    }
  });

  it("extracts confidence when mode is value", () => {
    const obs = new RecordingObserver();
    const nodeDef = makeNodeDef({
      confidence: {
        mode: "value",
        extract: () => confidence("high", "logprob", 0.92),
      },
    });
    const nodeMap = new Map([[NID, nodeDef]]);

    emitHumanIntervention(
      { nodeId: NID, output: {} },
      { kind: "approve" }, nodeMap, makeCtx(obs) as any, DID, Date.now, Date.now(), [],
    );

    const evt = obs.events.find((e) => e.type === "human-intervention") as HumanInterventionEvent;
    expect(evt.context.nodeConfidence).toEqual(confidence("high", "logprob", 0.92));
  });

  it("fail-closed: returns Err and emits node-error when confidence.extract throws", () => {
    const obs = new RecordingObserver();
    const nodeDef = makeNodeDef({
      confidence: {
        mode: "value",
        extract: () => { throw new Error("boom"); },
      },
    });
    const nodeMap = new Map([[NID, nodeDef]]);

    const result = emitHumanIntervention(
      { nodeId: NID, output: {} },
      { kind: "approve" }, nodeMap, makeCtx(obs) as any, DID, Date.now, Date.now(), [],
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("non-retriable");
        expect(result.error.message).toContain("confidence.extract failed");
      }
    }
    const errEvt = obs.events.find((e) => e.type === "node-error");
    expect(errEvt).toBeDefined();
    const intervention = obs.events.find((e) => e.type === "human-intervention");
    expect(intervention).toBeUndefined();
  });

  it("fail-closed: returns Err when nodeDef is missing (framework-bug guard)", () => {
    const obs = new RecordingObserver();
    const nodeMap = new Map<any, any>(); // empty — node not found

    const result = emitHumanIntervention(
      { nodeId: NID, output: {} },
      { kind: "approve" }, nodeMap, makeCtx(obs) as any, DID, Date.now, Date.now(), [],
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("non-retriable");
        expect(result.error.message).toContain("missing from nodeMap");
      }
    }
    const intervention = obs.events.find((e) => e.type === "human-intervention");
    expect(intervention).toBeUndefined();
  });

  it("includes priorWitnesses in context", () => {
    const obs = new RecordingObserver();
    const nodeMap = new Map([[NID, makeNodeDef()]]);
    const witnesses = [
      witness("version", RN("pg:orders"), "42"),
    ];

    emitHumanIntervention(
      { nodeId: NID, output: {} },
      { kind: "approve" }, nodeMap, makeCtx(obs) as any, DID, Date.now, Date.now(), witnesses,
    );

    const evt = obs.events.find((e) => e.type === "human-intervention") as HumanInterventionEvent;
    expect(evt.context.priorWitnesses).toHaveLength(1);
    expect(evt.context.priorWitnesses[0]!.resource).toBe(RN("pg:orders"));
  });
});
