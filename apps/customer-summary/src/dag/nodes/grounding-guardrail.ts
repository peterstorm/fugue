import { z } from "zod";
import { createGuardrailNode } from "@fuguejs/framework";
import type { GuardrailResult } from "@fuguejs/framework";
import { validateGrounding } from "../../validation/grounding.js";
import { SynthesisOutputSchema } from "../../schemas/summary.js";
import type { SynthesisOutput } from "../../schemas/summary.js";
import { CrmRecordSchema } from "../../schemas/crm.js";
import type { CrmRecord } from "../../schemas/crm.js";

/**
 * Input shape: receives outputs from both synthesize and fetch-crm nodes.
 */
interface GroundingInput {
  readonly "synthesize": SynthesisOutput | undefined;
  readonly "fetch-crm": { readonly customer: CrmRecord | null };
}

const InputSchema = z.object({
  "synthesize": SynthesisOutputSchema.optional(),
  "fetch-crm": z.object({ customer: CrmRecordSchema.nullable() }),
});

const GuardrailCheckSchema = z.object({
  dimension: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});

const OutputSchema: z.ZodType<GuardrailResult<SynthesisOutput>> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("skipped"),
    value: z.undefined(),
    passed: z.literal(true),
    warnings: z.array(z.string()),
    checks: z.array(GuardrailCheckSchema),
  }),
  z.object({
    kind: z.literal("validated"),
    value: SynthesisOutputSchema,
    passed: z.boolean(),
    warnings: z.array(z.string()),
    checks: z.array(GuardrailCheckSchema),
  }),
]);

/**
 * Grounding guardrail node.
 *
 * Validates that the LLM synthesis output is grounded in source conversation data.
 * Checks: topic grounding, sentiment consistency, conversation count accuracy.
 *
 * Always passes data through — attaches warnings when grounding fails.
 * The executor sets the span to ERROR status so failures are visible in MLflow.
 */
export const createGroundingGuardrailNode = () =>
  createGuardrailNode<GroundingInput, SynthesisOutput>({
    id: "grounding-guardrail",
    inputSchema: InputSchema as z.ZodType<GroundingInput>,
    outputSchema: OutputSchema,
    validate: (input): GuardrailResult<SynthesisOutput> => {
      const synthesis = input["synthesize"];
      const customer = input["fetch-crm"]?.customer;

      if (!synthesis) {
        // Non-ok branch (not_found, no_history, etc.) — nothing to validate
        return {
          kind: "skipped",
          value: undefined,
          passed: true,
          warnings: [],
          checks: [{ dimension: "source_data", passed: true, detail: "No synthesis output to validate (non-ok branch)" }],
        };
      }

      if (!customer) {
        return {
          kind: "validated",
          value: synthesis,
          passed: true,
          warnings: [],
          checks: [{ dimension: "source_data", passed: true, detail: "No customer data to validate against" }],
        };
      }

      const grounding = validateGrounding(synthesis, customer);

      return {
        kind: "validated",
        value: synthesis,
        passed: grounding.allPassed,
        warnings: [...grounding.warnings],
        checks: [...grounding.checks],
      };
    },
  });
