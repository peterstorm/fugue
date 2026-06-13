// Fixture: a *manual* defineDag with a fan-in node whose object-schema keys
// don't match its two incoming source ids. defineDag accepts it (topology is
// valid); the B1 lint check (`fan-in-key-mismatch`) must catch it via runLint.
// (defineSources would reject this at definition time — this is the manual path.)

import { z } from "zod";
import {
  defineDag,
  createSourceNode,
  createTransformNode,
  ok,
} from "../../../index.js";

const left = createSourceNode({
  id: "left",
  outputSchema: z.object({ a: z.number() }),
  fetch: async () => ok({ a: 1 }),
});

const right = createSourceNode({
  id: "right",
  outputSchema: z.object({ b: z.number() }),
  fetch: async () => ok({ b: 2 }),
});

// Incoming source ids are {left, right}, but the schema keys are {left, WRONG}.
const join = createTransformNode({
  id: "join",
  inputSchema: z.object({
    left: z.object({ a: z.number() }),
    WRONG: z.object({ b: z.number() }),
  }),
  outputSchema: z.object({ sum: z.number() }),
  transform: (input) => ok({ sum: input.left.a }),
});

const dag = defineDag({
  id: "manual-fan-in-mismatch",
  nodes: { left, right, join },
  edges: [
    { from: "left", to: "join" },
    { from: "right", to: "join" },
  ],
  outputNodeId: "join",
});

export default {
  dag,
  inputSchema: z.void(),
  meta: { description: "Manual fan-in key mismatch fixture", version: "1.0.0" },
};
