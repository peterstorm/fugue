// Fixture: a DAG with an edge endpoint that doesn't reference a known node.
// `defineDagFromArray` throws DagDefinitionError at module import — the CLI
// must catch and report it as { kind: "dag-definition-error" }.
//
// We use defineDagFromArray here because defineDag (the record-keyed
// constructor) would catch this at edit time via the literal-id union; the
// array form is what slips runtime-only errors through.

import { z } from "zod";
import {
  defineDagFromArray,
  createTransformNode,
  ok,
} from "../../../index.js";

const a = createTransformNode({
  id: "a",
  inputSchema: z.object({ x: z.number() }),
  outputSchema: z.object({ y: z.number() }),
  transform: (input) => ok({ y: input.x + 1 }),
});

const b = createTransformNode({
  id: "b",
  inputSchema: z.object({ y: z.number() }),
  outputSchema: z.object({ z: z.number() }),
  transform: (input) => ok({ z: input.y + 1 }),
});

const dag = defineDagFromArray({
  id: "invalid-edge-fixture",
  nodes: [a, b],
  // "c" is not a node — validator should reject.
  edges: [{ from: "a", to: "c" }],
  outputNodeId: "b",
});

export default {
  dag,
  inputSchema: z.object({ x: z.number() }),
};
