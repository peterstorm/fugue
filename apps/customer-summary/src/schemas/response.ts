import { z } from "zod";
import { SynthesisOutputSchema } from "./summary.js";

export const GroundingWarningSchema = z.object({
  dimension: z.string(),
  detail: z.string(),
});

export const SummaryResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    customerId: z.string(),
    summary: SynthesisOutputSchema,
    groundingWarnings: z.array(GroundingWarningSchema).optional(),
  }),
  z.object({ status: z.literal("degraded"), customerId: z.string(), message: z.string() }),
  z.object({ status: z.literal("not_found"), customerId: z.string(), message: z.string() }),
  z.object({ status: z.literal("no_history"), customerId: z.string(), message: z.string() }),
  z.object({ status: z.literal("insufficient_data"), customerId: z.string(), message: z.string() }),
]);

export type SummaryResponse = z.infer<typeof SummaryResponseSchema>;
