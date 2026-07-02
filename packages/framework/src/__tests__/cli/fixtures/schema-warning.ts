// Fixture: a structurally valid DAG whose registration `inputSchema` cannot
// be rendered to JSON Schema (`z.void()` throws in `zodToJsonSchema`). Used
// to pin `runDescribe`'s non-fatal warning channel: ok result, `inputSchema:
// null`, the failure carried on `warnings` and echoed to stderr.

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
  id: "schema-warning-fixture",
  nodes: [fetchUser, summarize],
});

export default {
  dag,
  // Deliberately unserializable: JSON Schema has no representation for void.
  inputSchema: z.void(),
  meta: { description: "Schema-warning fixture DAG", version: "1.0.0" },
};
