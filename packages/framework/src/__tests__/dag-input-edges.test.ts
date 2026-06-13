// C0/C1/C2 — $input edges, source nodes, defineSources, and the clock
// capability. Covers the 0.2.0 "clean break": no node implicitly receives the
// DAG input; the request flows only over DAG_INPUT edges; roots are source
// nodes; and a node may read the wall clock via the `clock` capability.

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { ok } from "../types/result.js";
import { DAG_INPUT, isDagInput } from "../types/ids.js";
import { createTransformNode } from "../nodes/transform.js";
import { createSourceNode } from "../nodes/fetch.js";
import { defineDag } from "../executor/define-dag.js";
import { defineSources } from "../executor/define-sources.js";
import { runDag } from "../executor/run-dag.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import { fixedClock } from "../types/clock.js";
import { buildDescribedDag } from "../describe/build-described-dag.js";

const Req = z.object({ region: z.string(), minScore: z.number() });
const ctx = () => makeNodeContext({ runId: "r1", dagId: "d1" });

describe("DAG_INPUT constant", () => {
  it("is the reserved '$input' source, recognised by isDagInput and outside the node-id grammar", () => {
    expect(DAG_INPUT).toBe("$input" as typeof DAG_INPUT);
    expect(isDagInput("$input")).toBe(true);
    expect(isDagInput("fetch-weights")).toBe(false);
  });
});

describe("C0 — source nodes & root-expects-input", () => {
  it("createSourceNode marks isSource and runs from ctx with no input", async () => {
    const src = createSourceNode({
      id: "fetch-thing",
      outputSchema: z.object({ n: z.number() }),
      fetch: async () => ok({ n: 7 }),
    });
    expect(src.isSource).toBe(true);

    const dag = defineDag({
      id: "single-source",
      nodes: { "fetch-thing": src },
      edges: [],
      outputNodeId: "fetch-thing",
    });
    const res = await runDag<unknown, { n: number }>(dag, undefined, ctx());
    expect(res).toEqual({ ok: true, value: { n: 7 } });
  });

  it("rejects a non-source root with root-expects-input", () => {
    const root = createTransformNode({
      id: "root",
      inputSchema: Req,
      outputSchema: Req,
      transform: (r) => ok(r),
    });
    expect(() =>
      defineDag({ id: "bad-root", nodes: { root }, edges: [], outputNodeId: "root" }),
    ).toThrow(/root-expects-input|no incoming edges but is not a source/);
  });

  it("rejects a source node that has an incoming edge with source-has-incoming", () => {
    const src = createSourceNode({
      id: "src",
      outputSchema: z.object({ n: z.number() }),
      fetch: async () => ok({ n: 1 }),
    });
    const sink = createTransformNode({
      id: "sink",
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ n: z.number() }),
      transform: (x) => ok(x),
    });
    // Feed $input INTO the source — illegal: a source consumes nothing.
    expect(() =>
      defineDag({
        id: "src-with-incoming",
        nodes: { src, sink },
        edges: [
          { from: DAG_INPUT, to: "src" },
          { from: "src", to: "sink" },
        ],
        outputNodeId: "sink",
      }),
    ).toThrow(/source-has-incoming|consumes no input/);
  });

  it("rejects $input as an edge target (invalid-dag-input-edge)", () => {
    const a = createTransformNode({ id: "a", inputSchema: Req, outputSchema: Req, transform: (r) => ok(r) });
    expect(() =>
      defineDag({
        id: "input-as-target",
        nodes: { a },
        // @ts-expect-error — $input is never a legal `to`
        edges: [{ from: "a", to: DAG_INPUT }],
      }),
    ).toThrow(/cannot be an edge target/);
  });

  it("rejects a conditional $input edge (invalid-dag-input-edge)", () => {
    const a = createTransformNode({ id: "a", inputSchema: Req, outputSchema: Req, transform: (r) => ok(r) });
    const b = createTransformNode({ id: "b", inputSchema: Req, outputSchema: Req, transform: (r) => ok(r) });
    expect(() =>
      defineDag({
        id: "conditional-input",
        nodes: { a, b },
        edges: [
          // @ts-expect-error — $input edges may not carry routing predicates
          { from: DAG_INPUT, to: "a", when: { label: "x", version: 1, check: () => true } },
          { from: DAG_INPUT, to: "b" },
        ],
      }),
    ).toThrow(/must be unconditional/);
  });
});

describe("C0 — $input edge delivers the request end-to-end", () => {
  it("a single $input edge feeds the bare request to a node", async () => {
    const consume = createTransformNode({
      id: "consume",
      inputSchema: Req,
      outputSchema: z.object({ region: z.string() }),
      transform: (r) => ok({ region: r.region }),
    });
    const dag = defineDag({
      id: "input-bare",
      nodes: { consume },
      edges: [{ from: DAG_INPUT, to: "consume" }],
      outputNodeId: "consume",
    });
    const res = await runDag<z.infer<typeof Req>, { region: string }>(
      dag,
      { region: "dk", minScore: 5 },
      ctx(),
    );
    expect(res).toEqual({ ok: true, value: { region: "dk" } });
  });

  it("a fan-in receives the request in its '$input' slot alongside other sources", async () => {
    const src = createSourceNode({
      id: "fetch-x",
      outputSchema: z.object({ x: z.number() }),
      fetch: async () => ok({ x: 10 }),
    });
    const Assemble = z.object({ "fetch-x": z.object({ x: z.number() }), $input: Req });
    const assemble = createTransformNode({
      id: "assemble",
      inputSchema: Assemble,
      outputSchema: z.object({ total: z.number(), region: z.string() }),
      transform: (input) =>
        ok({ total: input["fetch-x"].x + input.$input.minScore, region: input.$input.region }),
    });
    const dag = defineDag({
      id: "fan-in-input",
      nodes: { "fetch-x": src, assemble },
      edges: [
        { from: "fetch-x", to: "assemble" },
        { from: DAG_INPUT, to: "assemble" },
      ],
      outputNodeId: "assemble",
    });
    const res = await runDag<z.infer<typeof Req>, { total: number; region: string }>(
      dag,
      { region: "se", minScore: 3 },
      ctx(),
    );
    expect(res).toEqual({ ok: true, value: { total: 13, region: "se" } });
  });
});

describe("C1 — defineSources", () => {
  const W = z.object({ w: z.number() });
  const C = z.object({ c: z.number() });
  const fetchW = createSourceNode({ id: "fetch-w", outputSchema: W, fetch: async () => ok({ w: 2 }) });
  const fetchC = createSourceNode({ id: "fetch-c", outputSchema: C, fetch: async () => ok({ c: 5 }) });

  const ScoreFanIn = z.object({ "fetch-w": W, "fetch-c": C });
  const Scored = z.object({ score: z.number() });
  const score = createTransformNode({
    id: "score",
    inputSchema: ScoreFanIn,
    outputSchema: Scored,
    transform: (i) => ok({ score: i["fetch-w"].w * i["fetch-c"].c }),
  });

  it("wires N sources → join, with no $input edge when the join declares none", () => {
    const dag = defineSources({ id: "sources-no-request", sources: [fetchW, fetchC], join: score });
    expect(dag.provenance).toBe("sources");
    const fromInput = dag.edges.filter((e) => isDagInput(e.from));
    expect(fromInput).toHaveLength(0); // join schema declares no "$input" key
    expect(dag.outputNodeId as string).toBe("score");
  });

  it("adds a $input edge to assemble when (and only when) it declares the '$input' key, and runs", async () => {
    const Assemble = z.object({ score: Scored, $input: Req });
    const assemble = createTransformNode({
      id: "assemble",
      inputSchema: Assemble,
      outputSchema: z.object({ region: z.string(), score: z.number() }),
      transform: (i) => ok({ region: i.$input.region, score: i.score.score }),
    });
    const dag = defineSources({
      id: "lead-scoring",
      sources: [fetchW, fetchC],
      join: score,
      assemble,
    });
    // $input edge added to assemble (declares "$input"), not to join (doesn't).
    expect(dag.edges.filter((e) => isDagInput(e.from)).map((e) => e.to as string)).toEqual(["assemble"]);
    expect(dag.outputNodeId as string).toBe("assemble");

    const res = await runDag<z.infer<typeof Req>, { region: string; score: number }>(
      dag,
      { region: "dk", minScore: 0 },
      ctx(),
    );
    expect(res).toEqual({ ok: true, value: { region: "dk", score: 10 } });
  });

  it("rejects a non-source passed as a source with a teaching error", () => {
    const notASource = createTransformNode({
      id: "fetch-w",
      inputSchema: W,
      outputSchema: W,
      transform: (x) => ok(x),
    });
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately wrong
      defineSources({ id: "bad", sources: [notASource as any], join: score }),
    ).toThrow(/not a source node|createFetchNode WITHOUT an inputSchema|createSourceNode/i);
  });
});

describe("C2 — clock capability", () => {
  const clockNode = createSourceNode({
    id: "stamp",
    outputSchema: z.object({ at: z.string() }),
    requires: ["clock"] as const,
    fetch: async (c) => ok({ at: c.clock.now().toISOString() }),
  });
  const dag = defineDag({
    id: "clock-dag",
    nodes: { stamp: clockNode },
    edges: [],
    outputNodeId: "stamp",
  });

  it("reads the injected clock (fixed in tests for determinism)", async () => {
    const at = new Date("2026-06-12T08:00:00.000Z");
    const c = makeNodeContext({ runId: "r", dagId: "clock-dag", clock: fixedClock(at) });
    const res = await runDag<unknown, { at: string }>(dag, undefined, c);
    expect(res).toEqual({ ok: true, value: { at: "2026-06-12T08:00:00.000Z" } });
  });

  it("fails closed with missing-capability when no clock is wired", async () => {
    const res = await runDag<unknown, { at: string }>(dag, undefined, ctx());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe("missing-capability");
      if (res.error.kind === "missing-capability") {
        expect(res.error.missing[0]).toEqual({ nodeId: "stamp" as never, capability: "clock" });
      }
    }
  });
});

describe("C0 — describe renders the $input edge", () => {
  it("surfaces a { from: '$input' } edge so request flow is visible in the graph", () => {
    const consume = createTransformNode({
      id: "consume",
      inputSchema: Req,
      outputSchema: Req,
      transform: (r) => ok(r),
    });
    const dag = defineDag({
      id: "describe-input",
      nodes: { consume },
      edges: [{ from: DAG_INPUT, to: "consume" }],
      outputNodeId: "consume",
    });
    const described = buildDescribedDag({ dag, route: "/x", description: "", version: "1.0.0" });
    expect(described.ok).toBe(true);
    if (described.ok) {
      expect(described.value.edges).toContainEqual({
        from: "$input",
        to: "consume",
        kind: "unconditional",
      });
      // $input adds no wave; the single node sorts to wave 0.
      expect(described.value.waves).toEqual([["consume"]]);
    }
  });
});
