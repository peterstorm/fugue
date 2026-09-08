// Input assembly at the actual node-dispatch seam: 0/1/many required sources
// and optional sources. A plain child-dispatch fake refuses unexpected maps.
import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { N, D } from "./_id-helpers.js";
import { runNodeShared } from "../dag-runtime/run-node.js";
import { ok } from "../types/result.js";
import type { NodeDef } from "../types/node.js";
import type { NodeId } from "../types/ids.js";
import { makeNodeContext } from "../shared/index.js";
import { validateCapabilities } from "../shared/capabilities.js";
import { ordinaryExecution } from "./_execution-scope.js";

const echoNode: NodeDef<unknown, unknown> = {
  id: N("echo"), kind: "transform", inputSchema: z.unknown(), outputSchema: z.unknown(),
  requires: [], sideEffects: { kind: "none" }, confidence: { mode: "none" },
  run: async input => ok(input),
};
const validated = validateCapabilities({ nodes: [echoNode] }, makeNodeContext({ runId: "test-run", dagId: "test-dag" }));
if (!validated.ok) throw new Error("echo context must validate");
const ctx = validated.value;

const cases: readonly Readonly<{
  name: string;
  required: readonly string[];
  optional: readonly string[];
  outputs: readonly (readonly [string, unknown])[];
  expected: unknown;
}>[] = [
  { name: "0 required, 0 optional → undefined (source node)", required: [], optional: [], outputs: [], expected: undefined },
  { name: "1 required → bare upstream value", required: ["upstream"], optional: [], outputs: [["upstream", { x: 42 }]], expected: { x: 42 } },
  { name: "2 required → keyed object", required: ["a", "b"], optional: [], outputs: [["a", "valueA"], ["b", "valueB"]], expected: { a: "valueA", b: "valueB" } },
  { name: "optional present → all keys", required: ["r"], optional: ["opt"], outputs: [["r", "reqVal"], ["opt", "optVal"]], expected: { r: "reqVal", opt: "optVal" } },
  { name: "optional absent → undefined value", required: ["r"], optional: ["missing"], outputs: [["r", "reqVal"]], expected: { r: "reqVal", missing: undefined } },
  { name: "mixed required and optional", required: ["a", "b"], optional: ["c"], outputs: [["a", 1], ["b", 2]], expected: { a: 1, b: 2, c: undefined } },
];

describe("runNodeShared input assembly", () => {
  for (const test of cases) it(test.name, async () => {
    const outputs = new Map<NodeId, unknown>(test.outputs.map(([id, value]) => [N(id), value]));
    const { result } = await runNodeShared(echoNode, ctx, D("d"), outputs,
      { required: test.required, optional: test.optional }, ordinaryExecution);
    expect(result).toEqual(ok(test.expected));
  });
});
