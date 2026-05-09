import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { dagFingerprint, FRAMEWORK_VERSION } from "../checkpoint/fingerprint.js";
import { createTransformNode } from "../nodes/transform.js";
import type { DagDef } from "../types/dag.js";
import { ok } from "../types/result.js";

const node = (id: string, deps: string[] = []) =>
  createTransformNode({
    id,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    deps,
    transform: (i) => ok(i),
  });

const dag = (id: string, nodes: ReturnType<typeof node>[], edges: { from: string; to: string }[] = [], outputNodeId?: string): DagDef => ({
  id,
  nodes,
  edges,
  outputNodeId,
});

describe("dagFingerprint", () => {
  it("is stable for the same DAG shape", () => {
    const a = dag("d", [node("A"), node("B", ["A"])], [{ from: "A", to: "B" }]);
    const b = dag("d", [node("A"), node("B", ["A"])], [{ from: "A", to: "B" }]);
    expect(dagFingerprint(a)).toBe(dagFingerprint(b));
  });

  it("is independent of node declaration order", () => {
    const a = dag("d", [node("A"), node("B", ["A"])], [{ from: "A", to: "B" }]);
    const b = dag("d", [node("B", ["A"]), node("A")], [{ from: "A", to: "B" }]);
    expect(dagFingerprint(a)).toBe(dagFingerprint(b));
  });

  it("changes when a node is added", () => {
    const a = dag("d", [node("A")]);
    const b = dag("d", [node("A"), node("B", ["A"])], [{ from: "A", to: "B" }]);
    expect(dagFingerprint(a)).not.toBe(dagFingerprint(b));
  });

  it("changes when a node is renamed", () => {
    const a = dag("d", [node("A"), node("B", ["A"])], [{ from: "A", to: "B" }]);
    const b = dag("d", [node("A"), node("C", ["A"])], [{ from: "A", to: "C" }]);
    expect(dagFingerprint(a)).not.toBe(dagFingerprint(b));
  });

  it("changes when deps are rewired", () => {
    const a = dag("d", [node("A"), node("B"), node("C", ["A"])], [{ from: "A", to: "C" }]);
    const b = dag("d", [node("A"), node("B"), node("C", ["B"])], [{ from: "B", to: "C" }]);
    expect(dagFingerprint(a)).not.toBe(dagFingerprint(b));
  });

  it("changes when outputNodeId changes", () => {
    const a = dag("d", [node("A"), node("B", ["A"])], [{ from: "A", to: "B" }], "A");
    const b = dag("d", [node("A"), node("B", ["A"])], [{ from: "A", to: "B" }], "B");
    expect(dagFingerprint(a)).not.toBe(dagFingerprint(b));
  });

  it("changes when DAG id changes", () => {
    const a = dag("d1", [node("A")]);
    const b = dag("d2", [node("A")]);
    expect(dagFingerprint(a)).not.toBe(dagFingerprint(b));
  });
});

describe("FRAMEWORK_VERSION", () => {
  it("is a non-empty string", () => {
    expect(typeof FRAMEWORK_VERSION).toBe("string");
    expect(FRAMEWORK_VERSION.length).toBeGreaterThan(0);
  });
});
