// Fixture: a *manual* defineDag that is edge-for-edge a linear chain. It is
// structurally valid (ok: true), but the B3 advisory (`shape-helper-hint`) must
// ride alongside in runLint's result, suggesting defineLinearDag. No provenance
// is set (manual defineDag), so the hint fires.

import { z } from "zod";
import {
  defineDag,
  createSourceNode,
  createTransformNode,
  ok,
} from "../../../index.js";

const start = createSourceNode({
  id: "start",
  outputSchema: z.object({ n: z.number() }),
  fetch: async () => ok({ n: 1 }),
});

const finish = createTransformNode({
  id: "finish",
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ doubled: z.number() }),
  transform: (input) => ok({ doubled: input.n * 2 }),
});

const dag = defineDag({
  id: "manual-linear-advisory",
  nodes: { start, finish },
  edges: [{ from: "start", to: "finish" }],
  outputNodeId: "finish",
});

export default {
  dag,
  inputSchema: z.void(),
  meta: { description: "Manual linear chain — shape-helper-hint fixture", version: "1.0.0" },
};
