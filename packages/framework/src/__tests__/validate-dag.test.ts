import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ok } from "../types/result.js";
import type { DagDefInput } from "../types/dag.js";
import { DAG_INPUT, nodeId } from "../types/ids.js";
import { validateDagShape } from "../executor/validate-dag.js";
import { createTransformNode } from "../nodes/transform.js";

const mkNode = (id: string) =>
  createTransformNode({
    id,
    inputSchema: z.any(),
    outputSchema: z.any(),
    transform: (i) => ok(i),
  });

describe("validateDagShape", () => {
  it("accepts a well-formed DAG", () => {
    const dag: DagDefInput = {
      id: "ok",
      nodes: { A: mkNode("A"), B: mkNode("B") },
      edges: [{ from: DAG_INPUT, to: "A" }, { from: "A", to: "B" }],
    };
    expect(validateDagShape(dag).ok).toBe(true);
  });

  it("rejects empty nodes", () => {
    const dag: DagDefInput = { id: "empty", nodes: {}, edges: [] };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("validation");
  });

  it("rejects a source node whose inputSchema rejects `undefined` (non-unit)", () => {
    // The `NodeDef` type permits `{ isSource: true, inputSchema: <non-void> }`;
    // `createSourceNode` never produces it, but a hand-built node could. A source
    // consumes no DAG input, so its schema must accept the always-`undefined`
    // input. This guard makes the illegal pairing fail at definition time.
    const badSource = { ...mkNode("S"), isSource: true, inputSchema: z.object({ x: z.number() }) };
    const dag: DagDefInput = {
      id: "bad-source-schema",
      nodes: { S: badSource, B: mkNode("B") },
      edges: [{ from: "S", to: "B" }],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("rejects `undefined`");
    } else {
      throw new Error(`expected a validation error, got ${r.ok ? "ok" : r.error.kind}`);
    }
  });

  it("accepts a source node with a unit (z.void()) inputSchema", () => {
    const goodSource = { ...mkNode("S"), isSource: true, inputSchema: z.void() };
    const dag: DagDefInput = {
      id: "good-source-schema",
      nodes: { S: goodSource, B: mkNode("B") },
      edges: [{ from: "S", to: "B" }],
    };
    expect(validateDagShape(dag).ok).toBe(true);
  });

  it("rejects record key/node.id mismatch (the post-record-shape duplicate check)", () => {
    const dag: DagDefInput = {
      id: "dup",
      nodes: {
        A: mkNode("A"),
        B: mkNode("A"), // intentional id collision under different keys
      },
      edges: [],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("record key and node.id must match");
    }
  });

  it("rejects an edge referencing an unknown source node", () => {
    const dag: DagDefInput = {
      id: "bad-source",
      nodes: { A: mkNode("A") },
      edges: [{ from: "ghost" as never, to: "A" }],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("unknown source");
    }
  });

  it("rejects an edge referencing an unknown target node", () => {
    const dag: DagDefInput = {
      id: "bad-target",
      nodes: { A: mkNode("A") },
      edges: [{ from: "A", to: "ghost" as never }],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("unknown target");
    }
  });

  it("rejects duplicate edges between the same (from, to)", () => {
    const dag: DagDefInput = {
      id: "dup-edge",
      nodes: { A: mkNode("A"), B: mkNode("B") },
      edges: [
        { from: "A", to: "B" },
        { from: "A", to: "B" },
      ],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("duplicate-edge");
    }
  });

  it("rejects outputNodeId that does not exist", () => {
    const dag: DagDefInput = {
      id: "bad-output",
      nodes: { A: mkNode("A") },
      edges: [],
      outputNodeId: "ZZ" as never,
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("outputNodeId 'ZZ'");
    }
  });

  it("accepts diamond DAG with edges-only topology", () => {
    const dag: DagDefInput = {
      id: "diamond",
      nodes: {
        A: mkNode("A"),
        B: mkNode("B"),
        C: mkNode("C"),
        D: mkNode("D"),
      },
      edges: [
        { from: DAG_INPUT, to: "A" },
        { from: "A", to: "B" },
        { from: "A", to: "C" },
        { from: "B", to: "D" },
        { from: "C", to: "D" },
      ],
    };
    expect(validateDagShape(dag).ok).toBe(true);
  });

  it("rejects a retry.backoffMs entry that is NaN or negative", () => {
    for (const bad of [NaN, -1, Number.NEGATIVE_INFINITY]) {
      const node = { ...mkNode("A"), retry: { backoffMs: [1000, bad] as [number, ...number[]] } };
      const r = validateDagShape({
        id: "bad-backoff",
        nodes: { A: node },
        edges: [{ from: DAG_INPUT, to: "A" }],
      });
      expect(r.ok).toBe(false);
      if (!r.ok && r.error.kind === "validation") {
        expect(r.error.message).toContain("retry.backoffMs must be a non-empty ladder of finite non-negative numbers");
        expect(r.error.nodeId).toBe(nodeId("A"));
      } else {
        throw new Error(`expected a validation error for backoffMs=${String(bad)}, got ${r.ok ? "ok" : r.error.kind}`);
      }
    }
  });

  it("rejects an EMPTY retry.backoffMs ladder (no attempt-0 delay; vacuous every)", () => {
    // `[]` passes `every(...)` vacuously and the compiled `?? [1000, 2000, 4000]`
    // default never fires for `[]` — round-21 tda-1 closed the hole at the gate.
    // The tuple type makes `[]` unrepresentable for typed callers, so the
    // runtime gate is exercised through the untyped-input path (a cast): a
    // JS/JSON caller can still hand the gate `[]`.
    const node = { ...mkNode("A"), retry: { backoffMs: [] as unknown as [number, ...number[]] } };
    const r = validateDagShape({
      id: "empty-backoff",
      nodes: { A: node },
      edges: [{ from: DAG_INPUT, to: "A" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("retry.backoffMs must be a non-empty ladder");
      expect(r.error.nodeId).toBe(nodeId("A"));
    } else {
      throw new Error(`expected a validation error for the empty ladder, got ${r.ok ? "ok" : r.error.kind}`);
    }
  });

  it("rejects retryLimits/defaultRetryLimit outside the non-negative-safe-integer domain", () => {
    for (const bad of [NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      const withLimit = validateDagShape({
        id: "bad-limits",
        nodes: { A: mkNode("A") },
        edges: [{ from: DAG_INPUT, to: "A" }],
        retryLimits: { A: bad },
      });
      expect(withLimit.ok).toBe(false);
      if (!withLimit.ok && withLimit.error.kind === "validation") {
        expect(withLimit.error.message).toContain(`retryLimits['A'] must be a non-negative safe integer`);
      } else {
        throw new Error(`expected a validation error for retryLimits.A=${String(bad)}, got ${withLimit.ok ? "ok" : withLimit.error.kind}`);
      }

      const withDefault = validateDagShape({
        id: "bad-limit-default",
        nodes: { A: mkNode("A") },
        edges: [{ from: DAG_INPUT, to: "A" }],
        defaultRetryLimit: bad,
      });
      expect(withDefault.ok).toBe(false);
      if (!withDefault.ok && withDefault.error.kind === "validation") {
        expect(withDefault.error.message).toContain("defaultRetryLimit must be a non-negative safe integer");
      } else {
        throw new Error(`expected a validation error for defaultRetryLimit=${String(bad)}, got ${withDefault.ok ? "ok" : withDefault.error.kind}`);
      }
    }
  });

  it("rejects a retryLimits key that names no node in the DAG (type-design-analyzer-7)", () => {
    // `retryLimits` is a raw string-keyed record on the authoring surface and a
    // branded key type does not survive `Record<NodeId, number>` — TypeScript
    // erases it to a string index signature. So a typo can only be caught here,
    // and unchecked it silently no-ops: the node quietly runs on
    // `defaultRetryLimit ?? 0` instead of the budget its author configured.
    const r = validateDagShape({
      id: "typo-limits",
      nodes: { A: mkNode("A") },
      edges: [{ from: DAG_INPUT, to: "A" }],
      retryLimits: { Ay: 5 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("retryLimits['Ay'] names no node");
    } else {
      throw new Error(`expected a validation error for the unknown retryLimits key, got ${r.ok ? "ok" : r.error.kind}`);
    }
  });

  it("still accepts a retryLimits key that names a real node", () => {
    expect(
      validateDagShape({
        id: "good-limits",
        nodes: { A: mkNode("A"), B: mkNode("B") },
        edges: [{ from: DAG_INPUT, to: "A" }, { from: "A", to: "B" }],
        retryLimits: { A: 1, B: 2 },
      }).ok,
    ).toBe(true);
  });

  it("accepts boundary-legal retryLimits/defaultRetryLimit and single-element ladders", () => {
    const dag: DagDefInput = {
      id: "ok-retry-budgets",
      nodes: { A: { ...mkNode("A"), retry: { backoffMs: [0] } } },
      edges: [{ from: DAG_INPUT, to: "A" }],
      retryLimits: { A: 0 },
      defaultRetryLimit: 3,
    };
    expect(validateDagShape(dag).ok).toBe(true);
  });

  it("rejects a retry.jitterRatio outside [0, 1] or non-finite", () => {
    for (const bad of [-0.1, 1.1, NaN, Number.POSITIVE_INFINITY]) {
      const node = { ...mkNode("A"), retry: { jitterRatio: bad } };
      const r = validateDagShape({
        id: "bad-jitter",
        nodes: { A: node },
        edges: [{ from: DAG_INPUT, to: "A" }],
      });
      expect(r.ok).toBe(false);
      if (!r.ok && r.error.kind === "validation") {
        expect(r.error.message).toContain("retry.jitterRatio must be a finite number in [0, 1]");
      } else {
        throw new Error(`expected a validation error for jitterRatio=${String(bad)}, got ${r.ok ? "ok" : r.error.kind}`);
      }
    }
  });

  it("accepts boundary-legal retry configs and bare defaults", () => {
    const node = {
      ...mkNode("A"),
      retry: { backoffMs: [0, 1000] as [number, ...number[]], jitterRatio: 0 },
    };
    const dag: DagDefInput = {
      id: "ok-retry",
      nodes: { A: node, B: { ...mkNode("B"), retry: { backoffMs: [500], jitterRatio: 1 } } },
      edges: [{ from: DAG_INPUT, to: "A" }, { from: "A", to: "B" }],
    };
    expect(validateDagShape(dag).ok).toBe(true);
  });
});
