// F1 PR-D (T6, AD-9 / FR-051): the DAG fingerprint is STRUCTURE-ONLY.
//
// A fan's `scheduling` (child concurrency, estimator) is a run-pacing knob a
// deployer may retune at any time. If it leaked into `dagFingerprint`, every
// retune would invalidate the saved children of every in-flight fan — paid
// work stranded across a redeploy whose only change was a bigger budget
// ceiling. This file pins the opposite: for arbitrary authored scheduling
// values, and for maps authored before scheduling existed at all, the
// fingerprint is bit-identical. It only ever moves when the DAG's structure
// moves.

import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { z } from "zod";

import { dagFingerprint } from "../checkpoint/fingerprint.js";
import { defineDagFromArray } from "../executor/define-dag.js";
import { createMapNode, createCollectMapNode } from "../nodes/map.js";
import { createTransformNode } from "../nodes/transform.js";
import { DAG_INPUT, nodeId } from "../types/ids.js";
import { ok } from "../types/result.js";
import {
  FAN_ESTIMATORS,
  parseFanScheduling,
  type FanEstimator,
} from "../types/fan-scheduling.js";
import type { DagDef, DagNodeDef, MapNodeDef } from "../types/dag.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const scopeNode = () =>
  createTransformNode({
    id: "scope",
    inputSchema: z.object({ n: z.number() }),
    outputSchema: z.object({ items: z.array(z.number()) }),
    transform: ({ n }) => ok({ items: Array.from({ length: n }, (_, i) => i + 1) }),
  });

const childDag = () =>
  defineDagFromArray({
    id: "child-double-dag",
    nodes: [
      createTransformNode({
        id: "child-double",
        inputSchema: z.number(),
        outputSchema: z.number(),
        transform: (n) => ok(n * 2),
      }),
    ],
    edges: [{ from: DAG_INPUT, to: "child-double" }],
    outputNodeId: "child-double",
  });

type SchedulingOver = {
  readonly childConcurrency?: number;
  readonly estimator?: FanEstimator;
};

const mapNode = (over: SchedulingOver = {}): MapNodeDef<unknown, number, readonly number[]> =>
  createMapNode({
    id: "fan",
    inputSchema: z.object({ items: z.array(z.number()) }),
    outputSchema: z.array(z.number()),
    widthFrom: "items",
    maxWidth: 25,
    childConcurrency: over.childConcurrency,
    estimator: over.estimator,
    child: childDag(),
    childOutputSchema: z.number(),
    reduce: (results) => ok([...results]),
  });

const collectMapNode = (over: SchedulingOver = {}): MapNodeDef<unknown, number, unknown> =>
  createCollectMapNode({
    id: "collect-fan",
    inputSchema: z.object({ items: z.array(z.number()) }),
    widthFrom: "items",
    maxWidth: 25,
    childConcurrency: over.childConcurrency,
    estimator: over.estimator,
    child: childDag(),
    childOutputSchema: z.number(),
    collectedItemSchema: z.number(),
    gather: { kind: "collect", field: "results" },
  });

/** scope → map (and, for the mixed fixture, scope → both map kinds). */
const dagOf = (maps: readonly DagNodeDef[]): DagDef =>
  defineDagFromArray({
    id: "fingerprint-fixture",
    nodes: [scopeNode(), ...maps],
    edges: [
      { from: DAG_INPUT, to: "scope" },
      ...maps.map((map) => ({ from: "scope" as const, to: map.id })),
    ],
  });

/**
 * Replace the scheduling a map node carries, without re-defining the DAG.
 * `scheduling` values are minted through `parseFanScheduling`, the same smart
 * constructor the producers use — never by cast (INV-3).
 */
const withScheduling = (
  dag: DagDef,
  nodeIdStr: string,
  authored: Readonly<{ childConcurrency?: unknown; estimator?: unknown }>,
): DagDef => {
  const parsed = parseFanScheduling(nodeId(nodeIdStr), authored);
  if (!parsed.ok) throw new Error(`fixture scheduling refused: ${parsed.error.message}`);
  return {
    ...dag,
    nodes: dag.nodes.map((node) =>
      node.kind === "map" && node.id === nodeIdStr
        ? { ...node, mapping: { ...node.mapping, scheduling: parsed.value } }
        : node,
    ),
  };
};

/**
 * The pre-T6 map shape: a DagDef whose map node carries NO scheduling at all.
 * This is what `dagFingerprint` saw on every run saved before the feature
 * shipped — the fingerprint a redeployed DAG must still match for those
 * checkpoints to resume (FR-051).
 */
const stripScheduling = (dag: DagDef): DagDef => ({
  ...dag,
  nodes: dag.nodes.map((node) => {
    if (node.kind !== "map") return node;
    const { scheduling: _scheduling, ...mapping } = node.mapping;
    return { ...node, mapping };
  }),
});

// ── Unit pins ───────────────────────────────────────────────────────────────

describe("dagFingerprint — structure-only (F1 PR-D, FR-051)", () => {
  it("is unchanged by every authored scheduling value", () => {
    const baseline = dagOf([mapNode()]);
    const fingerprint = dagFingerprint(baseline);
    for (const concurrency of [1, 2, 8, 1024]) {
      for (const estimator of FAN_ESTIMATORS) {
        const tuned = withScheduling(baseline, "fan", { childConcurrency: concurrency, estimator });
        expect(dagFingerprint(tuned), `${concurrency}/${estimator}`).toBe(fingerprint);
      }
    }
  });

  it("matches the fingerprint of the pre-scheduling DAG shape", () => {
    const baseline = dagOf([collectMapNode({ childConcurrency: 4, estimator: "p90" })]);
    expect(dagFingerprint(stripScheduling(baseline))).toBe(dagFingerprint(baseline));
  });

  it("is unchanged by tuning either map kind in a mixed DAG", () => {
    const mixed = dagOf([collectMapNode(), mapNode()]);
    const fingerprint = dagFingerprint(mixed);
    expect(dagFingerprint(stripScheduling(mixed))).toBe(fingerprint);
    expect(dagFingerprint(withScheduling(mixed, "collect-fan", { childConcurrency: 6, estimator: "p50" })))
      .toBe(fingerprint);
    expect(dagFingerprint(withScheduling(mixed, "fan", { childConcurrency: 3, estimator: "p95" })))
      .toBe(fingerprint);
  });

  it("still moves when the STRUCTURE moves", () => {
    const baseline = dagOf([mapNode({ childConcurrency: 4, estimator: "p90" })]);
    // The structural change: the map node is renamed. Same scheduling values —
    // ids and kinds are exactly what the fingerprint hashes, so this MUST move
    // (the contrast that makes the invariance pins above meaningful).
    const renamed = dagOf([
      createMapNode({
        id: "fan-renamed",
        inputSchema: z.object({ items: z.array(z.number()) }),
        outputSchema: z.array(z.number()),
        widthFrom: "items",
        maxWidth: 25,
        childConcurrency: 4,
        estimator: "p90",
        child: childDag(),
        childOutputSchema: z.number(),
        reduce: (results) => ok([...results]),
      }),
    ]);
    expect(dagFingerprint(renamed)).not.toBe(dagFingerprint(baseline));
  });
});

// ── Property: arbitrary scheduling never moves the fingerprint ──────────────

describe("dagFingerprint — scheduling independence (property)", () => {
  const schedulingArb = fc.record({
    childConcurrency: fc.integer({ min: 1, max: 4096 }),
    estimator: fc.constantFrom(...FAN_ESTIMATORS),
  });

  it("two arbitrary scheduling values fingerprint identically (1,000 cases)", () => {
    const baseline = dagOf([mapNode()]);
    const fingerprint = dagFingerprint(baseline);
    const plainNode = mapNode();
    fc.assert(
      fc.property(schedulingArb, schedulingArb, (left, right) => {
        const leftDag = withScheduling(baseline, "fan", left);
        const rightDag = withScheduling(baseline, "fan", right);
        expect(dagFingerprint(leftDag)).toBe(fingerprint);
        expect(dagFingerprint(rightDag)).toBe(fingerprint);
        // The parsed, branded values on a validated mapping fingerprint the
        // same as the raw authored ones — parsing normalizes, never reshapes.
        const parsed = parseFanScheduling(nodeId("fan"), left);
        if (!parsed.ok) throw new Error(`valid authored scheduling was refused: ${parsed.error.message}`);
        const parsedNode = { ...plainNode, mapping: { ...plainNode.mapping, scheduling: parsed.value } };
        const parsedDag = {
          ...baseline,
          nodes: baseline.nodes.map((node) => (node.id === "fan" ? parsedNode : node)),
        };
        expect(dagFingerprint(parsedDag)).toBe(fingerprint);
      }),
      { numRuns: 1000 },
    );
  });

  it("every arbitrary scheduling value matches the pre-scheduling shape (1,000 cases)", () => {
    const baseline = dagOf([collectMapNode()]);
    const stripped = dagFingerprint(stripScheduling(baseline));
    fc.assert(
      fc.property(schedulingArb, (authored) => {
        expect(dagFingerprint(withScheduling(baseline, "collect-fan", authored))).toBe(stripped);
      }),
      { numRuns: 1000 },
    );
  });
});
