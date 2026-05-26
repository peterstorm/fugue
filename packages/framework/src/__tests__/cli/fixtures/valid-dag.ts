// Fixture: a structurally valid DAG with a fetch → transform pipeline.
// Used by lint/describe CLI tests as the happy-path case.

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
  outputSchema: z.object({ name: z.string(), email: z.string() }),
  fetch: async (input) =>
    ok({ name: `user-${input.userId}`, email: `${input.userId}@example.com` }),
});

const summarize = createTransformNode({
  id: "summarize",
  inputSchema: z.object({ name: z.string(), email: z.string() }),
  outputSchema: z.object({ summary: z.string() }),
  transform: (input) => ok({ summary: `${input.name} <${input.email}>` }),
});

const dag = defineLinearDag({
  id: "valid-fixture",
  nodes: [fetchUser, summarize],
});

export default {
  dag,
  inputSchema: z.object({ userId: z.string() }),
  meta: { description: "Valid fixture DAG", version: "1.0.0" },
};
