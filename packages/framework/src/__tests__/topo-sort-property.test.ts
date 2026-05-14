// Wave 6 §6.9: topoSort ordering property test.
//
// Generates 50 random DAGs with a known topological order, asserts that
// every edge (u, v) emitted in the input has wave(u) ≤ wave(v) in the
// output. Also stress-tests that the union of all waves equals the node
// set (no nodes dropped, no extras invented) and waves are non-empty.

import { describe, it, expect } from "bun:test";
import { N } from "./_id-helpers.js";
import { z } from "zod";
import { ok } from "../types/result.js";
import { topoSort } from "../shared/topo.js";
import { defineDagFromArray } from "../executor/define-dag.js";
import { createTransformNode } from "../nodes/transform.js";

// ---------------------------------------------------------------------------
// Deterministic PRNG (LCG) — failures reproduce on the same seed
// ---------------------------------------------------------------------------

const lcg = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
};

// ---------------------------------------------------------------------------
// Generate a random DAG by assigning each node a "level" 0..L-1 and only
// adding edges from lower-level to higher-level nodes. Guarantees acyclic.
// ---------------------------------------------------------------------------

interface RandomDag {
  readonly nodeIds: readonly string[];
  readonly edges: readonly { from: string; to: string }[];
  /** levels[i] = topological-level for nodeIds[i] (acyclicity witness) */
  readonly levels: readonly number[];
}

const genRandomDag = (rng: () => number): RandomDag => {
  const n = 3 + Math.floor(rng() * 10); // 3..12 nodes
  const maxLevel = 1 + Math.floor(rng() * 4); // 1..4 levels
  const nodeIds = Array.from({ length: n }, (_, i) => `n${i}`);
  const levels = nodeIds.map(() => Math.floor(rng() * (maxLevel + 1)));
  const edges: { from: string; to: string }[] = [];
  const edgeSet = new Set<string>();

  // For each pair (i, j) with levels[i] < levels[j], add edge with prob 0.3.
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if ((levels[i] ?? 0) < (levels[j] ?? 0) && rng() < 0.3) {
        const key = `${nodeIds[i]}->${nodeIds[j]}`;
        if (!edgeSet.has(key)) {
          edges.push({ from: nodeIds[i]!, to: nodeIds[j]! });
          edgeSet.add(key);
        }
      }
    }
  }

  return { nodeIds, edges, levels };
};

const buildDagDef = (shape: RandomDag) => {
  const nodes = shape.nodeIds.map((id) =>
    createTransformNode({
      // @ts-expect-error — branded ID test fixture
      id,
      inputSchema: z.any(),
      outputSchema: z.any(),
      transform: (i) => ok(i),
    }),
  );
  return defineDagFromArray({
    id: `gen-${shape.nodeIds.length}`,
    nodes,
    edges: shape.edges.map((e) => ({ from: e.from, to: e.to })),
  });
};

// ---------------------------------------------------------------------------
// Property: in the topo-sort output, every input edge (u, v) has
// wave(u) <= wave(v). Also: all nodes appear exactly once, no extras, every
// wave is non-empty.
// ---------------------------------------------------------------------------

describe("§6.9 — topoSort ordering property", () => {
  it("every edge (u,v) has wave(u) ≤ wave(v) across 50 random DAGs", () => {
    const rng = lcg(0xFEED_FACE);
    const RUNS = 50;
    const violations: { seed: number; shape: RandomDag; reason: string }[] = [];

    for (let i = 0; i < RUNS; i++) {
      const shape = genRandomDag(rng);
      const dag = buildDagDef(shape);
      const result = topoSort(dag);

      if (!result.ok) {
        violations.push({ seed: i, shape, reason: `topoSort failed: ${JSON.stringify(result.error)}` });
        continue;
      }
      const waves = result.value;

      // Build node id -> wave index
      const waveOf = new Map<string, number>();
      waves.forEach((wave, idx) => {
        for (const id of wave) waveOf.set(id, idx);
      });

      // Every node appears exactly once
      const flat = waves.flat();
      if (new Set(flat).size !== flat.length) {
        violations.push({ seed: i, shape, reason: "node appears in multiple waves" });
        continue;
      }
      if (flat.length !== shape.nodeIds.length) {
        violations.push({ seed: i, shape, reason: `wave node count ${flat.length} ≠ DAG node count ${shape.nodeIds.length}` });
        continue;
      }
      if (waves.some((w) => w.length === 0)) {
        violations.push({ seed: i, shape, reason: "empty wave emitted" });
        continue;
      }

      // Every edge respects ordering
      for (const e of shape.edges) {
        const from = waveOf.get(e.from);
        const to = waveOf.get(e.to);
        if (from === undefined || to === undefined) {
          violations.push({ seed: i, shape, reason: `edge endpoint missing from waves: ${e.from} -> ${e.to}` });
          break;
        }
        if (from >= to) {
          violations.push({
            seed: i,
            shape,
            reason: `edge ${e.from}(wave=${from}) -> ${e.to}(wave=${to}) violates strict less-than ordering`,
          });
          break;
        }
      }
    }

    if (violations.length > 0) {
      const sample = violations[0]!;
      throw new Error(
        `topoSort property violated in ${violations.length}/${RUNS} runs. First violation seed=${sample.seed}: ${sample.reason}. Shape: ${JSON.stringify({ ids: sample.shape.nodeIds, edges: sample.shape.edges, levels: sample.shape.levels })}`,
      );
    }
  });

  it("isolated nodes go in the first wave", () => {
    const dag = defineDagFromArray({
      id: "isolated",
      nodes: [
        createTransformNode({ id: N("A"), inputSchema: z.any(), outputSchema: z.any(), transform: (i) => ok(i) }),
        createTransformNode({ id: N("B"), inputSchema: z.any(), outputSchema: z.any(), transform: (i) => ok(i) }),
      ],
      edges: [],
    });
    const result = topoSort(dag);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      // @ts-expect-error — branded ID test fixture
      expect(new Set(result.value[0])).toEqual(new Set(["A", "B"]));
    }
  });

  it("diamond shape: A→B,A→C,B→D,C→D gives waves [[A],[B,C],[D]]", () => {
    const dag = defineDagFromArray({
      id: "diamond",
      nodes: ["A", "B", "C", "D"].map((id) =>
        // @ts-expect-error — branded ID test fixture
        createTransformNode({ id, inputSchema: z.any(), outputSchema: z.any(), transform: (i) => ok(i) }),
      ),
      edges: [
        { from: "A", to: "B" },
        { from: "A", to: "C" },
        { from: "B", to: "D" },
        { from: "C", to: "D" },
      ],
    });
    const result = topoSort(dag);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]).toEqual([N("A")]);
      // @ts-expect-error — branded ID test fixture
      expect(new Set(result.value[1])).toEqual(new Set(["B", "C"]));
      expect(result.value[2]).toEqual([N("D")]);
    }
  });
});
