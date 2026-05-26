// Fixture: another DAG with an edge endpoint that doesn't reference a known
// node. Identical in shape to invalid-edge-typo.ts but a separate file so
// each fixture is imported only once per test run — Bun caches broken module
// records by resolved path even across query-string variants.

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
  id: "invalid-edge-fixture-2",
  nodes: [a, b],
  edges: [{ from: "a", to: "c" }],
  outputNodeId: "b",
});

export default {
  dag,
  inputSchema: z.object({ x: z.number() }),
};
