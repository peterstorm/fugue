// Fixture: a structurally valid DAG whose registration `inputSchema` CANNOT be
// rendered to JSON Schema — it contains a non-schema value in its shape
// (a hostile schema: the user-facing bug class). Pins `runDescribe`'s
// non-fatal warning channel: ok result, `inputSchema: null`, the failure
// carried on `warnings` and echoed to stderr.
//
// (The former trigger was `z.void()`, which `zodToJsonSchema` threw on.
// `unrepresentable: "any"` — peterstorm/fugue#36 — now renders ALL standard
// unrepresentable types (z.date / z.void / z.map / z.set / z.custom /
// z.function / transforms) as open schemas, so only genuinely
// non-introspectable shapes reach this channel. The positive case is pinned
// by the sibling `schema-dates.ts` fixture.)

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
  // Deliberately non-introspectable: a plain string where a Zod schema belongs.
  inputSchema: z.object({ userId: "not-a-schema" as unknown as z.ZodType<unknown> }),
  meta: { description: "Schema-warning fixture DAG", version: "1.0.0" },
};
