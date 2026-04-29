import { z } from "zod";
import { createTransformNode, ok } from "@ai-summary/framework";
import type { Result, FrameworkError } from "@ai-summary/framework";
import { SummaryResponseSchema } from "../../schemas/response.js";
import type { SummaryResponse } from "../../schemas/response.js";
import { SynthesisOutputSchema } from "../../schemas/summary.js";
import type { SynthesisOutput } from "../../schemas/summary.js";
import type { ExtractionResult } from "./extract-features.js";

// The assemble node receives the synthesize node output.
// But it also needs the extraction result to know the branch.
// Since the DAG wires deps as [synthesize], and synthesize's input was the extraction result,
// we need both. The simplest approach: dep on both extract-features and synthesize.
const InputSchema = z.object({
  "extract-features": z.any(),
  "synthesize": z.any(),
});

interface AssembleInput {
  readonly "extract-features": ExtractionResult;
  readonly "synthesize": SynthesisOutput | undefined;
}

export const createAssembleResponseNode = (customerId: string) =>
  createTransformNode<AssembleInput, SummaryResponse>({
    id: "assemble-response",
    inputSchema: InputSchema as z.ZodType<AssembleInput>,
    outputSchema: SummaryResponseSchema as z.ZodType<SummaryResponse>,
    deps: ["extract-features", "synthesize"],
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
          const synthesis = input["synthesize"] as SynthesisOutput;
          return ok({ status: "ok" as const, customerId, summary: synthesis });
        }
      }
    },
  });
