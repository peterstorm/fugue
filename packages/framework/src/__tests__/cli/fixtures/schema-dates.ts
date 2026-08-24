// Fixture: a registration `inputSchema` containing `z.date()` + `z.void()` —
// types that `zodToJsonSchema` USED TO throw on ("Date cannot be represented
// in JSON Schema"). With `unrepresentable: "any"` (peterstorm/fugue#36) they
// now render as open schemas, so describe must ship the schema with an EMPTY
// warnings array — pins the positive case (no false alarm on date columns).

import { z } from "zod";
import {
  defineLinearDag,
  createFetchNode,
  createTransformNode,
  ok,
} from "../../../index.js";

const fetchUser = createFetchNode({
  id: "fetch-user",
  inputSchema: z.object({ userId: z.string() }),
  outputSchema: z.object({ name: z.string() }),
  fetch: async (input) => ok({ name: `user-${input.userId}` }),
});

const summarize = createTransformNode({
  id: "summarize",
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ summary: z.string() }),
  transform: (input) => ok({ summary: input.name }),
});

const dag = defineLinearDag({
  id: "schema-dates-fixture",
  nodes: [fetchUser, summarize],
});

export default {
  dag,
  inputSchema: z.object({ userId: z.string(), at: z.date(), note: z.void() }),
  meta: { description: "Schema-dates fixture DAG", version: "1.0.0" },
};
