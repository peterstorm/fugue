// Example: a guardrail node validating upstream output via `defineDag`.
//
// A guardrail runs a *pure* validation and never blocks the pipeline — it
// emits a `GuardrailResult` (a discriminated union) that downstream nodes (or
// the caller) inspect. Use it to surface quality signals without throwing.

import { z } from "zod";
import { defineDag, createTransformNode, createGuardrailNode, ok } from "@fuguejs/framework";
import type { GuardrailResult } from "@fuguejs/framework";
import type { DagRegistration } from "@fuguejs/host/contract";

const InputSchema = z.object({ draft: z.string() });
const DraftSchema = z.object({ draft: z.string() });

const writeDraft = createTransformNode({
  id: "write-draft",
  inputSchema: InputSchema,
  outputSchema: DraftSchema,
  transform: (input) => ok({ draft: input.draft.trim() }),
});

// The guardrail's output is the GuardrailResult union. Like the framework's
// own tests, we type the schema explicitly and let `z.any()` carry the runtime
// shape — building a Zod schema for the full union by hand adds no safety here.
const GuardrailOutputSchema: z.ZodType<GuardrailResult<string>> = z.any();

const checkLength = createGuardrailNode({
  id: "check-length",
  inputSchema: DraftSchema,
  outputSchema: GuardrailOutputSchema,
  validate: (input) => {
    const passed = input.draft.length >= 10;
    return {
      kind: "validated",
      value: input.draft,
      passed,
      warnings: passed ? [] : ["draft is shorter than 10 characters"],
      checks: [{ dimension: "min-length", passed, detail: `len=${input.draft.length}` }],
    };
  },
});

const dag = defineDag({
  id: "guarded-draft",
  nodes: {
    "write-draft": writeDraft,
    "check-length": checkLength,
  },
  edges: [{ from: "write-draft", to: "check-length" }],
  outputNodeId: "check-length",
});

const registration: DagRegistration = {
  dag,
  inputSchema: InputSchema,
  meta: { description: "Guardrail: validate a draft's length without blocking the pipeline.", version: "1.0.0" },
};

export default registration;
