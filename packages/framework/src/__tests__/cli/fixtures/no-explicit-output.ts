// Fixture: a valid DAG that omits `outputNodeId`. Exercises the
// `outputNodeId: null` / `outputSchema: null` contract that LLM tooling
// consumes from `fugue describe`.

import { z } from "zod";
import {
  defineDag,
  createFetchNode,
  DAG_INPUT,
  ok,
} from "../../../index.js";

const fetchUser = createFetchNode({
  id: "fetch-user",
  inputSchema: z.object({ userId: z.string() }),
  outputSchema: z.object({ name: z.string() }),
  fetch: async (input) => ok({ name: `u-${input.userId}` }),
});

const dag = defineDag({
  id: "no-explicit-output",
  nodes: { "fetch-user": fetchUser },
  // The request reaches the (only) node via a DAG_INPUT edge (C0); roots no
  // longer receive input implicitly.
  edges: [{ from: DAG_INPUT, to: "fetch-user" }],
  // outputNodeId deliberately omitted — describe should surface null.
});

export default {
  dag,
  inputSchema: z.object({ userId: z.string() }),
  meta: { description: "DAG with no explicit output", version: "1.0.0" },
};
