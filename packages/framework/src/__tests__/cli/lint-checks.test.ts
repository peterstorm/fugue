// B1 (fan-in-key-mismatch) + B3 (shape-helper-hint) — the structural lint
// checks layered on top of `defineDag`'s topology validation.

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { ok } from "../../types/result.js";
import { createFetchNode } from "../../nodes/fetch.js";
import { createTransformNode } from "../../nodes/transform.js";
import { defineDag } from "../../executor/define-dag.js";
import { defineLinearDag } from "../../executor/define-linear-dag.js";
import { defineDiamond } from "../../executor/define-diamond.js";
import { analyzeDag } from "../../cli/lint-checks.js";

const A = z.object({ a: z.number() });
const B = z.object({ b: z.number() });

const fetchA = createFetchNode({
  id: "fetch-a",
  inputSchema: z.unknown(),
  outputSchema: A,
  fetch: async () => ok({ a: 1 }),
});
const fetchB = createFetchNode({
  id: "fetch-b",
  inputSchema: z.unknown(),
  outputSchema: B,
  fetch: async () => ok({ b: 2 }),
});

const Out = z.object({ sum: z.number() });
const makeJoin = (schema: z.ZodType<unknown>) =>
  createTransformNode({
    id: "join",
    inputSchema: schema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test join ignores shape
    outputSchema: Out,
    transform: () => ok({ sum: 3 }),
  });

describe("B1 — fan-in-key-mismatch", () => {
  it("flags a fan-in node whose object keys don't match the incoming sources", () => {
    const join = makeJoin(z.object({ "fetch-a": A, "fetch-bee": B })); // typo
    const dag = defineDag({
      id: "b1-typo",
      nodes: { "fetch-a": fetchA, "fetch-b": fetchB, join },
      edges: [
        { from: "fetch-a", to: "join" },
        { from: "fetch-b", to: "join" },
      ],
      outputNodeId: "join",
    });
    const { errors } = analyzeDag(dag);
    expect(errors.length).toBe(1);
    const e = errors[0]!;
    expect(e.kind).toBe("fan-in-key-mismatch");
    if (e.kind === "fan-in-key-mismatch") {
      expect(e.nodeId).toBe("join");
      expect(e.missingKeys).toEqual(["fetch-b"]); // incoming with no key
      expect(e.extraKeys).toEqual(["fetch-bee"]); // key with no incoming
    }
  });

  it("passes when keys equal the incoming source ids", () => {
    const join = makeJoin(z.object({ "fetch-a": A, "fetch-b": B }));
    const dag = defineDag({
      id: "b1-ok",
      nodes: { "fetch-a": fetchA, "fetch-b": fetchB, join },
      edges: [
        { from: "fetch-a", to: "join" },
        { from: "fetch-b", to: "join" },
      ],
      outputNodeId: "join",
    });
    expect(analyzeDag(dag).errors).toEqual([]);
  });

  it("skips non-object input schemas (can't introspect → no false positive)", () => {
    const join = makeJoin(z.unknown());
    const dag = defineDag({
      id: "b1-unknown",
      nodes: { "fetch-a": fetchA, "fetch-b": fetchB, join },
      edges: [
        { from: "fetch-a", to: "join" },
        { from: "fetch-b", to: "join" },
      ],
      outputNodeId: "join",
    });
    expect(analyzeDag(dag).errors).toEqual([]);
  });
});

describe("B3 — shape-helper-hint", () => {
  const n = (id: string, input: z.ZodType<unknown>, output: z.ZodType<unknown>) =>
    createTransformNode({ id, inputSchema: input, outputSchema: output, transform: () => ok({}) });

  it("suggests defineLinearDag for a manual chain", () => {
    const dag = defineDag({
      id: "manual-chain",
      nodes: {
        s: n("s", z.unknown(), A),
        m: n("m", A, B),
        e: n("e", B, Out),
      },
      edges: [
        { from: "s", to: "m" },
        { from: "m", to: "e" },
      ],
      outputNodeId: "e",
    });
    const { advisories } = analyzeDag(dag);
    expect(advisories.map((a) => a.helper)).toEqual(["defineLinearDag"]);
  });

  it("suggests defineDiamond for a manual fan-out + join", () => {
    const join = makeJoin(z.object({ b1: A, b2: A }));
    const dag = defineDag({
      id: "manual-diamond",
      nodes: {
        src: n("src", z.unknown(), A),
        b1: n("b1", A, A),
        b2: n("b2", A, A),
        join,
      },
      edges: [
        { from: "src", to: "b1" },
        { from: "src", to: "b2" },
        { from: "b1", to: "join" },
        { from: "b2", to: "join" },
      ],
      outputNodeId: "join",
    });
    const { advisories } = analyzeDag(dag);
    expect(advisories.map((a) => a.helper)).toEqual(["defineDiamond"]);
  });

  it("stays silent on a DAG already built with a helper (provenance)", () => {
    const dag = defineLinearDag({
      id: "helper-chain",
      nodes: [n("s", z.unknown(), A), n("m", A, B), n("e", B, Out)],
    });
    expect(analyzeDag(dag).advisories).toEqual([]);
  });

  it("stays silent on a real diamond helper too", () => {
    const join = makeJoin(z.object({ b1: A, b2: A }));
    const dag = defineDiamond({
      id: "helper-diamond",
      source: n("src", z.unknown(), A),
      branches: [n("b1", A, A), n("b2", A, A)],
      join,
    });
    expect(analyzeDag(dag).advisories).toEqual([]);
  });

  it("stays silent on the no-helper multi-root shape", () => {
    // Two independent roots → one join: matches no single-source helper.
    const join = makeJoin(z.object({ "fetch-a": A, "fetch-b": B }));
    const dag = defineDag({
      id: "multi-root",
      nodes: { "fetch-a": fetchA, "fetch-b": fetchB, join },
      edges: [
        { from: "fetch-a", to: "join" },
        { from: "fetch-b", to: "join" },
      ],
      outputNodeId: "join",
    });
    expect(analyzeDag(dag).advisories).toEqual([]);
  });
});
