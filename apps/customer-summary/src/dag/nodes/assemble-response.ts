import { z } from "zod";
import { createTransformNode, ok } from "@fuguejs/framework";
import { match } from "ts-pattern";
import type { Result, FrameworkError, GuardrailResult } from "@fuguejs/framework";
import { SummaryResponseSchema } from "../../schemas/response.js";
import type { SummaryResponse } from "../../schemas/response.js";
import { SynthesisOutputSchema } from "../../schemas/summary.js";
import type { SynthesisOutput } from "../../schemas/summary.js";
import type { ExtractionResult } from "./extract-features.js";

const GuardrailCheckSchema = z.object({
  dimension: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});

const GuardrailResultSchema = z.discriminatedUnion("kind", [
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
  z.object({
    kind: z.literal("failed"),
    passed: z.literal(false),
    error: z.string(),
    warnings: z.array(z.string()),
    checks: z.array(GuardrailCheckSchema),
  }),
]);

const InputSchema = z.object({
  $input: z.object({ customerId: z.string().min(1) }),
  "extract-features": z.object({ branch: z.string() }).passthrough(),
  "grounding-guardrail": GuardrailResultSchema.optional(),
});

interface AssembleInput {
  readonly $input: { readonly customerId: string };
  readonly "extract-features": ExtractionResult;
  readonly "grounding-guardrail": GuardrailResult<SynthesisOutput> | undefined;
}

export const createAssembleResponseNode = () =>
  createTransformNode<AssembleInput, SummaryResponse>({
    id: "assemble-response",
    inputSchema: InputSchema as z.ZodType<AssembleInput>,
    outputSchema: SummaryResponseSchema as z.ZodType<SummaryResponse>,
    transform: (input): Result<SummaryResponse, FrameworkError> => {
      const customerId = input.$input.customerId;
      const extraction = input["extract-features"];

      return match(extraction)
        .with({ branch: "not_found" }, () =>
          ok({ status: "not_found" as const, customerId, message: "Customer not found" }),
        )
        .with({ branch: "no_history" }, () =>
          ok({ status: "no_history" as const, customerId, message: "No conversation history" }),
        )
        .with({ branch: "insufficient_data" }, () =>
          ok({ status: "insufficient_data" as const, customerId, message: "Insufficient data for analysis" }),
        )
        .with({ branch: "ok" }, () => {
          const guardrail = input["grounding-guardrail"];
          if (guardrail === undefined || guardrail.kind === "skipped" || guardrail.kind === "failed") {
            // Guardrail output missing, skipped, or failed — degrade gracefully.
            // The transform is pure; diagnostics belong to the observer shell.
            return ok({ status: "degraded" as const, customerId, message: "Guardrail data unavailable" });
          }
          const synthesis = guardrail.value;

          const groundingWarnings = guardrail.passed
            ? undefined
            : guardrail.checks
                .filter((c) => !c.passed)
                .map((c) => ({ dimension: c.dimension, detail: c.detail }));

          return ok({
            status: "ok" as const,
            customerId,
            summary: synthesis,
            groundingWarnings,
          });
        })
        .exhaustive();
    },
  });
