// Example: a node requiring the built-in `http` capability.
//
// `http` ships with the framework, so no adapter wiring is needed — declaring
// `requires: ["http"] as const` makes `ctx.http` available and non-null inside
// `run`. Responses are validated against the Zod schema you pass.
//
// Run `fugue capabilities` to see every built-in capability name.

import { z } from "zod";
import { defineLinearDag, createFetchNode } from "@fuguejs/framework";
import type { Result, FrameworkError } from "@fuguejs/framework";
import type { DagRegistration } from "@fuguejs/host/contract";

const InputSchema = z.object({ userId: z.string() });
const UserSchema = z.object({ id: z.string(), name: z.string() });

const fetchUser = createFetchNode({
  id: "fetch-user",
  inputSchema: InputSchema,
  outputSchema: UserSchema,
  requires: ["http"] as const, // ← built-in capability; ctx.http is non-null below
  fetch: async (
    input,
    ctx,
  ): Promise<Result<z.infer<typeof UserSchema>, FrameworkError>> =>
    // The capability validates the response body against UserSchema and never
    // throws — it returns Result, so propagate the error path directly.
    ctx.http.get(`https://api.example.com/users/${input.userId}`, {
      schema: UserSchema,
      timeoutMs: 5_000,
    }),
});

const dag = defineLinearDag({
  id: "http-fetch-user",
  nodes: [fetchUser],
});

const registration: DagRegistration = {
  dag,
  inputSchema: InputSchema,
  meta: { description: "Capability (built-in): fetch a user over HTTP with a schema-validated response.", version: "1.0.0" },
};

export default registration;
