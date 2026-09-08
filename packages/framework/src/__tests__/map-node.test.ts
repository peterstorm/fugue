// F1 PR-B — the `map` node: runtime-width fan-out (D1, FR-F1-001/004/006/007/011).
//
// The width-parsing arms are pinned in `map-width.test.ts`; what these tests
// own is the FAN — that a map node stays one node in the outer graph, that each
// index gets its own durable address, and that a resumed run does not pay for
// work it already did.
//
// The failure this file exists to catch is not a crash. It is a fan that
// silently re-executes completed indices after a resume: correct output, double
// the money, and nothing in a normal test run notices.

import { describe, it, expect } from "bun:test";
import { z } from "zod";

import { defineDag, runDag } from "../executor/index.js";
import { makeNodeContext } from "../shared/index.js";
import { InMemoryCheckpointer } from "../checkpoint/checkpointer.js";
import { compositeNodeKey } from "../shared/composite-node-key.js";
import { createMapNode } from "../nodes/map.js";
import { createTransformNode } from "../nodes/transform.js";
import { withHumanReview } from "../nodes/human-review.js";
import { ok, err } from "../types/result.js";
import { mapIndex } from "../types/map-index.js";
import { DAG_INPUT, dagId, nodeId, runId as makeRunId } from "../types/ids.js";
import type { Checkpointer } from "../checkpoint/checkpointer.js";
import type { DagDef, MapNodeDef } from "../types/dag.js";
import type { NodeContext } from "../types/node.js";

const runFan = <I, C, O>(node: MapNodeDef<I, C, O>, input: I, ctx: NodeContext) =>
  runDag<I, O>(defineDag({ id: "outer", nodes: { fan: node },
    edges: [{ from: DAG_INPUT, to: "fan" }], outputNodeId: "fan" }), input, ctx);

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The child sub-DAG: one pure node that doubles its item, recording each call. */
const childDag = (calls: unknown[]) =>
  defineDag({
    id: "child",
    nodes: {
      double: createTransformNode({
        id: "double",
        inputSchema: z.number(),
        outputSchema: z.number(),
        transform: (n) => {
          calls.push(n);
          return ok(n * 2);
        },
      }),
    },
    edges: [{ from: DAG_INPUT, to: "double" }],
    outputNodeId: "double",
  });

const ctxWith = (checkpointer: Checkpointer, runIdStr = "run-fan") =>
  makeNodeContext({
    runId: runIdStr,
    dagId: "outer",
    capabilities: { checkpointer },
  });

/** A map definition, always exercised through real root preparation/dispatch. */
const fanNode = (
  calls: unknown[],
  over: {
    readonly maxWidth?: number;
    readonly child?: DagDef;
    readonly widthFrom?: string;
  } = {},
) =>
  createMapNode({
    id: "fan",
    inputSchema: z.object({ items: z.array(z.number()) }),
    outputSchema: z.array(z.number()),
    widthFrom: over.widthFrom ?? "items",
    maxWidth: over.maxWidth ?? 25,
    child: over.child ?? childDag(calls),
    childOutputSchema: z.number(),
    reduce: (results) => ok([...results]),
  });

/**
 * The D1 topology: a scoping node that DECIDES the width at run time, feeding
 * the fan. One authored node set, whatever `n` turns out to be — which is the
 * whole claim D1 makes, so both of its tests build the same graph.
 */
const scopeThenFan = () =>
  defineDag({
    id: "outer",
    nodes: {
      scope: createTransformNode({
        id: "scope",
        inputSchema: z.object({ n: z.number() }),
        outputSchema: z.object({ items: z.array(z.number()) }),
        transform: ({ n }) => ok({ items: Array.from({ length: n }, (_, i) => i + 1) }),
      }),
      fan: fanNode([]),
    },
    edges: [
      { from: DAG_INPUT, to: "scope" },
      { from: "scope", to: "fan" },
    ],
    outputNodeId: "fan",
  });

const FAN = nodeId("fan");
const RUN = makeRunId("run-fan");

// ── The fan ─────────────────────────────────────────────────────────────────

describe("createMapNode — the fan (FR-F1-001)", () => {
  it("applies the child sub-DAG over every item and gathers through the reducer", async () => {
    const calls: unknown[] = [];
    const cp = new InMemoryCheckpointer();
    const result = await runFan(fanNode(calls), { items: [1, 2, 3] }, ctxWith(cp));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a gathered output");
    expect(result.value).toEqual([2, 4, 6]);
    expect(calls).toEqual([1, 2, 3]);
  });

  it("hands the reducer results in ASCENDING INDEX order", async () => {
    // An order-sensitive reducer (a concatenation, a ranked pick) must produce
    // the same answer on a resumed run as on a fresh one, so index order is
    // part of the contract rather than an artefact of the loop.
    const cp = new InMemoryCheckpointer();
    const node = createMapNode({
      id: "fan",
      inputSchema: z.object({ items: z.array(z.string()) }),
      outputSchema: z.string(),
      widthFrom: "items",
      maxWidth: 10,
      child: defineDag({
        id: "child",
        nodes: {
          echo: createTransformNode({
            id: "echo",
            inputSchema: z.string(),
            outputSchema: z.string(),
            transform: (s) => ok(s),
          }),
        },
        edges: [{ from: DAG_INPUT, to: "echo" }],
        outputNodeId: "echo",
      }),
      childOutputSchema: z.string(),
      reduce: (rs) => ok(rs.join("-")),
    });

    const result = await runFan(node, { items: ["a", "b", "c"] }, ctxWith(cp));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("a-b-c");
  });

  // FR-F1-004. Zero is legal, and the reducer decides what it means.
  it("a width of 0 runs no child and hands the reducer an empty array", async () => {
    const calls: unknown[] = [];
    const cp = new InMemoryCheckpointer();
    const result = await runFan(fanNode(calls), { items: [] }, ctxWith(cp));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("refuses an over-wide fan WITHOUT running a single child", async () => {
    // Fail closed means fail before spending. If the refusal happened after the
    // loop, an over-wide fan would cost the full amount and then decline to
    // return the answer — the worst of both.
    const calls: unknown[] = [];
    const cp = new InMemoryCheckpointer();
    const result = await runFan(fanNode(calls, { maxWidth: 2 }), { items: [1, 2, 3] }, ctxWith(cp));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("map-width-exceeded");
    expect(calls).toEqual([]);
  });

  it("propagates a child failure and stops the fan there", async () => {
    const attempted: unknown[] = [];
    const failing = defineDag({
      id: "child",
      nodes: {
        boom: createTransformNode({
          id: "boom",
          inputSchema: z.number(),
          outputSchema: z.number(),
          transform: (n) => {
            attempted.push(n);
            return n === 2 ? err({ kind: "rejected", nodeId: nodeId("boom"), reason: "no" }) : ok(n);
          },
        }),
      },
      edges: [{ from: DAG_INPUT, to: "boom" }],
      outputNodeId: "boom",
    });
    const node = fanNode([], { child: failing });

    const result = await runFan(node, { items: [1, 2, 3] }, ctxWith(new InMemoryCheckpointer()));
    expect(result.ok).toBe(false);
    // Index 3 never ran: a fan that kept going past a failure would spend the
    // remaining budget producing a result the caller is not going to get.
    expect(attempted).toEqual([1, 2]);
  });

  it("converts a throwing reducer into a typed refusal, never a raw throw", async () => {
    // The reducer is caller code on a path whose contract is
    // `Result<_, FrameworkError>`.
    const node = createMapNode({
      id: "fan",
      inputSchema: z.object({ items: z.array(z.number()) }),
      outputSchema: z.array(z.number()),
      widthFrom: "items",
      maxWidth: 25,
      child: childDag([]),
      childOutputSchema: z.number(),
      reduce: () => {
        throw new Error("reducer exploded");
      },
    });

    const result = await runFan(node, { items: [1] }, ctxWith(new InMemoryCheckpointer()));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.message).toContain("map reducer threw");
        expect(result.error.retriability).toBe("non-retriable");
      }
    }
  });
});

// ── Durable addressing and resume ───────────────────────────────────────────

describe("createMapNode — per-index durability (FR-F1-006/007)", () => {
  it("checkpoints each index under a DISTINCT composite address", async () => {
    const cp = new InMemoryCheckpointer();
    await runFan(fanNode([]), { items: [1, 2, 3] }, ctxWith(cp));

    const loaded = await cp.load(RUN);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok || loaded.value === null) throw new Error("expected stored fan entries");

    const keys = [0, 1, 2].map((i) => compositeNodeKey(FAN, { index: mapIndex(i) }));
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(loaded.value.nodes[key]).toBeDefined();
    // The canonical key stays EMPTY: a fan must not also write the node's own
    // bare address, or the last index would masquerade as the node's output.
    expect(loaded.value.nodes[FAN]).toBeUndefined();
  });

  it("each stored entry names the real node, not the composite key", async () => {
    // ADR-0075: the KEY is the address, `nodeId` is the node's identity.
    const cp = new InMemoryCheckpointer();
    await runFan(fanNode([]), { items: [7] }, ctxWith(cp));
    const loaded = await cp.load(RUN);
    if (!loaded.ok || loaded.value === null) throw new Error("expected entries");
    expect(loaded.value.nodes[compositeNodeKey(FAN, { index: mapIndex(0) })]?.nodeId).toBe(FAN);
  });

  // THE test this feature exists for.
  it("a resumed fan re-runs ONLY the indices with no durable entry", async () => {
    const cp = new InMemoryCheckpointer();

    // First attempt: fail at index 2, so 0 and 1 land durably.
    const firstCalls: unknown[] = [];
    const flaky = defineDag({
      id: "child",
      nodes: {
        step: createTransformNode({
          id: "step",
          inputSchema: z.number(),
          outputSchema: z.number(),
          transform: (n) => {
            firstCalls.push(n);
            return n === 30 ? err({ kind: "rejected", nodeId: nodeId("step"), reason: "boom" }) : ok(n * 2);
          },
        }),
      },
      edges: [{ from: DAG_INPUT, to: "step" }],
      outputNodeId: "step",
    });
    const firstNode = fanNode([], { child: flaky });

    const first = await runFan(firstNode, { items: [10, 20, 30, 40] }, ctxWith(cp));
    expect(first.ok).toBe(false);
    expect(firstCalls).toEqual([10, 20, 30]);

    // Second attempt: the SAME run id, a healthy child, and a fresh call log.
    const secondCalls: unknown[] = [];
    const second = await runFan(fanNode(secondCalls), { items: [10, 20, 30, 40] }, ctxWith(cp));

    expect(second.ok).toBe(true);
    // 10 and 20 were durable and are replayed; only 30 and 40 actually run.
    // Without per-index addressing this list would be all four again — the
    // silent double-spend the index dimension exists to prevent.
    expect(secondCalls).toEqual([30, 40]);
    if (second.ok) expect(second.value).toEqual([20, 40, 60, 80]);
  });

  it("a replayed index still passes the CURRENT child schema", async () => {
    // A deploy may have tightened `childOutputSchema` since the checkpoint was
    // written. Gathering a stored value that no longer parses would launder
    // stale data into a fresh result.
    const cp = new InMemoryCheckpointer();
    await cp.setMeta(RUN, { dagId: dagId("outer"), startedAt: new Date(), nodeCount: 1 });
    await cp.saveNode(
      RUN,
      { nodeId: FAN, output: "not a number", completedAt: new Date() },
      { index: mapIndex(0) },
    );

    const result = await runFan(fanNode([]), { items: [1] }, ctxWith(cp));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      if (result.error.kind === "validation") {
        expect(result.error.message).toContain("checkpoint replay rejected");
        expect(result.error.message).toContain("index 0");
      }
    }
  });

  it("fails closed when the checkpoint READ fails — it does not assume nothing is done", async () => {
    // Treating a degraded read as "nothing is durable" would re-run the whole
    // fan and double its cost, every time, while looking perfectly healthy.
    const failingRead: Checkpointer = {
      load: async () => err({ kind: "cache-error", operation: "load", message: "redis down" }),
      saveNode: async () => ok(undefined),
      setMeta: async () => ok(undefined),
    };
    const calls: unknown[] = [];
    const result = await runFan(fanNode(calls), { items: [1, 2] }, ctxWith(failingRead));

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, error: {
      kind: "retry-exhausted", rootErrorKind: "cache-error", nodeId: FAN,
    } });
    expect(calls).toEqual([]);
  });

  it("surfaces a checkpoint WRITE failure instead of continuing the fan", async () => {
    // A fan that kept going past a failed save would look successful and then
    // resume from zero — the failure would only appear as cost, later.
    const failingWrite: Checkpointer = {
      load: async () => ok(null),
      setMeta: async () => ok(undefined),
      saveNode: async () => err({ kind: "cache-error", operation: "saveNode", message: "disk full" }),
    };
    const calls: unknown[] = [];
    const result = await runFan(fanNode(calls), { items: [1, 2, 3] }, ctxWith(failingWrite));

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, error: {
      kind: "retry-exhausted", rootErrorKind: "cache-error", nodeId: FAN,
    } });
    // Stopped at the first index rather than running all three.
    expect(calls).toEqual([1]);
  });

  it("does NOT re-seed checkpoint meta when the run already has a record", async () => {
    // Round-23 pr-test-analyzer-4. The guard's stated intent is "an outer run
    // that already established the record keeps its own" — previously covered
    // only by accident, via a test that happened to pre-seed. A map node that
    // overwrote the run's meta would reset `nodeCount`/`startedAt` for every
    // other consumer of that record.
    const cp = new InMemoryCheckpointer();
    const startedAt = new Date("2020-01-01T00:00:00Z");
    await cp.setMeta(RUN, { dagId: dagId("outer"), startedAt, nodeCount: 99 });

    const result = await runFan(fanNode([]), { items: [1, 2] }, ctxWith(cp));
    expect(result.ok).toBe(true);

    const loaded = await cp.load(RUN);
    if (!loaded.ok || loaded.value === null) throw new Error("expected the seeded meta to survive");
    expect(loaded.value.meta.nodeCount).toBe(99);
    expect(loaded.value.meta.startedAt.toISOString()).toBe(startedAt.toISOString());
  });

  it("seeds meta itself when the run has none, so the fan's entries are visible on resume", async () => {
    // The other side of the same guard. Without a meta record the Redis backend
    // short-circuits `load` before reading the nodes hash, so the fan's entries
    // would be written and then be invisible to the resume that needs them.
    const cp = new InMemoryCheckpointer();
    const result = await runFan(fanNode([]), { items: [1, 2, 3] }, ctxWith(cp));
    expect(result.ok).toBe(true);

    const loaded = await cp.load(RUN);
    if (!loaded.ok || loaded.value === null) throw new Error("expected the fan to seed meta");
    expect(loaded.value.meta.nodeCount).toBe(3);
  });
});

// ── The capability gate ─────────────────────────────────────────────────────

describe("createMapNode — the checkpointer capability is not optional", () => {
  it("declares checkpointer in requires, so a run without one fails at the gate", async () => {
    // Round-23 pr-test-analyzer-3. Plan §12 states the fail-closed guarantee:
    // "A run without one fails at the capability gate before any node runs."
    // `MAP_REQUIRES` is that guarantee's whole enforcement mechanism, and
    // nothing asserted it. A map node wired without a Checkpointer would
    // otherwise silently re-run every completed index after a crash.
    const calls: unknown[] = [];
    const node = fanNode(calls);
    expect(node.requires).toEqual(["checkpointer"]);

    const dag = defineDag({
      id: "outer",
      nodes: { fan: node },
      edges: [{ from: DAG_INPUT, to: "fan" }],
      outputNodeId: "fan",
    });

    // A context with NO capabilities wired.
    const bare = makeNodeContext({ runId: "run-nocap", dagId: "outer" });
    const result = await runDag<unknown, unknown>(dag, { items: [1, 2] }, bare);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("missing-capability");
    // Before any node ran: the fan must not have started and then discovered
    // it had nowhere to record itself.
    expect(calls).toEqual([]);
  });
});

// ── Author-time rejections ──────────────────────────────────────────────────

describe("createMapNode — rejected at module load", () => {
  // FR-F1-002.
  for (const [label, bad] of [
    ["zero", 0],
    ["negative", -5],
    ["fractional", 2.5],
    ["NaN", Number.NaN],
  ] as const) {
    it(`rejects a ${label} maxWidth at construction`, () => {
      expect(() => fanNode([], { maxWidth: bad })).toThrow("positive safe integer");
    });
  }

  it("rejects a widthFrom that is not a plain field reference", () => {
    expect(() => fanNode([], { widthFrom: "payload.items" })).toThrow("field reference");
  });

  // FR-F1-011 / D7 — the one the plan singles out.
  it("rejects humanReview inside the child sub-DAG, naming the gather-then-review alternative", () => {
    const gatedChild = defineDag({
      id: "child",
      nodes: {
        review: withHumanReview(
          createTransformNode({
            id: "review",
            inputSchema: z.number(),
            outputSchema: z.number(),
            transform: (n) => ok(n),
          }),
          { prompt: "approve?" },
        ),
      },
      edges: [{ from: DAG_INPUT, to: "review" }],
      outputNodeId: "review",
    });

    let thrown: Error | undefined;
    try {
      createMapNode({
        id: "fan",
        inputSchema: z.object({ items: z.array(z.number()) }),
        outputSchema: z.array(z.number()),
        widthFrom: "items",
        maxWidth: 5,
        child: gatedChild,
        childOutputSchema: z.number(),
        reduce: (rs) => ok([...rs]),
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeDefined();
    // Names the offending node, so the author knows WHICH one to move...
    expect(thrown?.message).toContain("'review'");
    // ...and names the alternative, so the error is actionable rather than a
    // wall. D7 rests on this being a redirection, not a refusal.
    expect(thrown?.message).toContain("gathered array");
    expect(thrown?.message).toContain("FR-F1-011");
  });

  it("accepts a child with no humanReview", () => {
    expect(() => fanNode([])).not.toThrow();
  });
});

// ── The declared side-effect profile ────────────────────────────────────────

describe("createMapNode — the side-effect profile", () => {
  // A map node calls `saveNode` and `setMeta`; both MUTATE durable state, which
  // is what `types/node.ts` defines `"writes"` as and explicitly excludes from
  // `"reads"` ("without mutation"). Round 23 corrected this from `"reads"` and
  // nothing pinned it, so a revert passed the whole suite.
  //
  // The mislabel is structural, not cosmetic: `side-effects.ts`'s union admits
  // `idempotencyKey` and the write-freshness extractors ONLY on the
  // `writes`/`external-call` arms, and `node-span.ts` gates its idempotency-key
  // handling on those kinds — so `"reads"` silently excludes a state-mutating
  // node from idempotency handling and misreports it to freshness contracts,
  // operator dashboards and routing-safety analysis alike.
  it("declares `writes` over the fan's checkpoint resource, not `reads`", () => {
    const node = fanNode([]);
    expect(node.sideEffects?.kind).toBe("writes");
    // Compared as a plain string: `ResourceName` is branded, and re-branding
    // the literal here would assert only that the same constructor was called
    // twice rather than what it produced.
    expect(String(node.sideEffects?.resource)).toBe("checkpoint:fan");
  });

  it("declares the checkpointer capability, which is what makes a partial fan resumable", () => {
    // The gate that refuses a host wiring no `checkpointer` before any node
    // runs — the reason `packages/host` grows a readable checkpointer at all.
    expect(fanNode([]).requires).toEqual(["checkpointer"]);
  });
});

// ── D1: the map node stays ONE node in the outer graph ──────────────────────

describe("createMapNode — D1: one node in the outer graph", () => {
  it("runs inside an ordinary DAG, occupying a single node id with a single output", async () => {
    const cp = new InMemoryCheckpointer();
    const result = await runDag<unknown, readonly number[]>(
      scopeThenFan(),
      { n: 4 },
      ctxWith(cp, "run-outer"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([2, 4, 6, 8]);
  });

  it("a width decided at run time needs no change to the authored node set", async () => {
    // The whole point of D1: 3 and then 5 are different widths of the SAME
    // compiled DAG. If the fan were materialised into waves, this would require
    // two different topologies.
    const cp = new InMemoryCheckpointer();
    const dag = scopeThenFan();

    const three = await runDag<unknown, readonly number[]>(dag, { n: 3 }, ctxWith(cp, "run-a"));
    const five = await runDag<unknown, readonly number[]>(dag, { n: 5 }, ctxWith(cp, "run-b"));

    expect(three.ok && five.ok).toBe(true);
    if (three.ok) expect(three.value).toHaveLength(3);
    if (five.ok) expect(five.value).toHaveLength(5);
  });
});
