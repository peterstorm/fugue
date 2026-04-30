import { z } from "zod";
import { createTransformNode, ok } from "@ai-summary/framework";
import type { Result, FrameworkError, GuardrailResult } from "@ai-summary/framework";
import { SummaryResponseSchema } from "../../schemas/response.js";
import type { SummaryResponse } from "../../schemas/response.js";
import type { SynthesisOutput } from "../../schemas/summary.js";
import type { ExtractionResult } from "./extract-features.js";

const InputSchema = z.object({
  "extract-features": z.any(),
  "grounding-guardrail": z.any(),
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
    deps: ["extract-features", "grounding-guardrail"],
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
          const guardrail = input["grounding-guardrail"]!;
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
      }
    },
  });
