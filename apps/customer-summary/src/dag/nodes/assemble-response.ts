import { z } from "zod";
import { createTransformNode, ok } from "@ai-summary/framework";
import type { Result, FrameworkError, GuardrailResult } from "@ai-summary/framework";
import { SummaryResponseSchema } from "../../schemas/response.js";
import type { SummaryResponse } from "../../schemas/response.js";
import { SynthesisOutputSchema } from "../../schemas/summary.js";
import type { SynthesisOutput } from "../../schemas/summary.js";
import type { ExtractionResult } from "./extract-features.js";

const InputSchema = z.object({
  "extract-features": z.object({ branch: z.string() }).passthrough(),
  "grounding-guardrail": z.object({
    kind: z.enum(["skipped", "validated"]),
    value: SynthesisOutputSchema.optional(),
    passed: z.boolean(),
    warnings: z.array(z.string()),
    checks: z.array(z.object({ dimension: z.string(), passed: z.boolean(), detail: z.string() })),
  }).optional(),
});

interface AssembleInput {
  readonly "extract-features": ExtractionResult;
  readonly "grounding-guardrail": GuardrailResult<SynthesisOutput> | undefined;
}

export const createAssembleResponseNode = (customerId: string) =>
  createTransformNode<AssembleInput, SummaryResponse>({
    id: "assemble-response",
    inputSchema: InputSchema as z.ZodType<AssembleInput>,
    outputSchema: SummaryResponseSchema as z.ZodType<SummaryResponse>,
    transform: (input): Result<SummaryResponse, FrameworkError> => {
      const extraction = input["extract-features"];

      switch (extraction.branch) {
        case "not_found":
          return ok({ status: "not_found" as const, customerId, message: "Customer not found" });
        case "no_history":
          return ok({ status: "no_history" as const, customerId, message: "No conversation history" });
        case "insufficient_data":
          return ok({ status: "insufficient_data" as const, customerId, message: "Insufficient data for analysis" });
        case "ok": {
          const guardrail = input["grounding-guardrail"];
          if (guardrail === undefined || guardrail.kind === "skipped" || guardrail.kind === "failed") {
            // Guardrail output missing, skipped, or failed — degrade gracefully
            console.warn(`[assemble-response] guardrail ${guardrail?.kind ?? "missing"} for customer ${customerId}`);
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
        }
        default: {
          const _exhaustive: never = extraction;
          return ok({ status: "degraded" as const, customerId, message: `Unknown extraction branch: ${(extraction as any).branch}` });
        }
      }
    },
  });
