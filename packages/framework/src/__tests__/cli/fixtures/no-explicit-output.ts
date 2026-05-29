// Fixture: a valid DAG that omits `outputNodeId`. Exercises the
// `outputNodeId: null` / `outputSchema: null` contract that LLM tooling
// consumes from `fugue describe`.

import { z } from "zod";
import {
  defineDag,
  createFetchNode,
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
  edges: [],
  // outputNodeId deliberately omitted — describe should surface null.
});

export default {
  dag,
  inputSchema: z.object({ userId: z.string() }),
  meta: { description: "DAG with no explicit output", version: "1.0.0" },
};
