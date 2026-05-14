// Replay determinism for conditional edges (ADR 0015 + ADR 0016).
//
// Predicates are pure data, so replay is deterministic by construction: the
// only way to introduce non-determinism would be a stateful evaluator, which
// is what this property test exercises by generating random predicates and
// random outputs.

import { NoopObserver } from "../observer/observer.js";
import { N, R, D, nodeMap, nodeSet } from "./_id-helpers.js";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { compileDagToMachine } from "../dag-runtime/machine.js";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { createInMemoryJob } from "../queue/in-memory-job.js";
import { replayEvents } from "../state-machine/replay.js";
import { defineDag } from "../executor/define-dag.js";
import type { DagDef } from "../types/dag.js";
import type {
  DagPhase,
  DagEvent,
  DagMachineContext,
} from "../dag-runtime/types.js";
import type { NodeDef, NodeContext } from "../types/node.js";
import { ok } from "../types/result.js";

const noop = async () => ok(undefined as unknown);

const makeNode = (
  id: string,
  overrides: Partial<NodeDef<unknown, unknown>> = {},
): NodeDef<unknown, unknown> => ({
  // @ts-expect-error — branded ID test fixture
  id,
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: noop as any,
  requires: [],
  ...overrides,
});

const makeCtx = (): NodeContext => ({
  runId: "r" as RunId,
  dagId: "d" as DagId,
  observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null,
  logger: { warn: () => {}, error: () => {} },
});

const makeDag = (kind: "yes" | "no"): DagDef =>
  defineDag({
    id: "replay-conditional",
    nodes: {
      router: makeNode("router", { run: async () => ok({ kind }) }),
      yes: makeNode("yes", {
        inputSchema: z.object({ router: z.any().optional() }),
        run: async () => ok("Y"),
      }),
      no: makeNode("no", { inputSchema: z.any(), run: async () => ok("N") }),
      merge: makeNode("merge", {
        inputSchema: z.object({
          yes: z.string().optional(),
          no: z.string().optional(),
        }),
        run: async (input: any) => ok(input.yes ?? input.no ?? "neither"),
      }),
    },
    edges: [
      { from: "router", to: "yes", when: { kind: "yes" } as any },
      { from: "router", to: "no", kind: "default" },
      { from: "yes", to: "merge" },
      { from: "no", to: "merge" },
    ],
    outputNodeId: "merge",
    defaultRetryLimit: 0,
  });

const runReplayCheck = async (dag: DagDef): Promise<void> => {
  const compiled = compileDagToMachine(dag, null);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  const { machine, initialState, initialContext } = compiled.value;

  const recorded: DagEvent[] = [];
  const job = createInMemoryJob<DagPhase, DagMachineContext>({
    state: initialState,
    context: initialContext,
  });
  const liveResult = await runDagStateful(dag, null, makeCtx(), {
    jobLike: job,
    onTrace: (t) => {
      if (t.event !== undefined) recorded.push(t.event);
    },
  });
  expect(liveResult.ok).toBe(true);

  const liveData = job.data;
  const replayed = replayEvents<DagPhase, DagEvent, DagMachineContext>(
    recorded,
    machine,
    { state: initialState, context: initialContext },
  );

  expect(replayed.state).toEqual(liveData.state);
  expect([...replayed.context.outputs.entries()].sort()).toEqual(
    [...liveData.context.outputs.entries()].sort(),
  );
  expect([...replayed.context.activeNodeIds].sort()).toEqual(
    [...liveData.context.activeNodeIds].sort(),
  );
};

describe("conditional edges — replay determinism", () => {
  for (const kind of ["yes", "no"] as const) {
    it(`replay reproduces live state for branch '${kind}'`, async () => {
      await runReplayCheck(makeDag(kind));
    });
  }

  it("replay reproduces live state across randomized predicates + outputs", async () => {
    // Simple property test: 32 random DAG instances, each with random
    // routing values and a random output kind. Predicates are pure data so
    // the system-level invariant — live and replay produce identical state
    // — holds by construction.
    const choices = ["alpha", "beta", "gamma", "delta", "epsilon"] as const;
    for (let i = 0; i < 32; i++) {
      const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
      const predicateKind = pick(choices);
      const outputKind = pick(choices);
      const dag = defineDag({
        id: `rand-${i}`,
        nodes: {
          router: makeNode("router", { run: async () => ok({ kind: outputKind }) }),
          a: makeNode("a", {
            inputSchema: z.object({ router: z.any().optional() }),
            run: async () => ok("A"),
          }),
          b: makeNode("b", {
            inputSchema: z.any(),
            run: async () => ok("B"),
          }),
        },
        edges: [
          { from: "router", to: "a", when: { kind: predicateKind } as any },
          { from: "router", to: "b", kind: "default" },
        ],
        defaultRetryLimit: 0,
      });
      await runReplayCheck(dag);
    }
  });
});
