import { z } from "zod";
import { SynthesisOutputSchema } from "./summary.js";

// The wire shape of a `GuardrailResult<SynthesisOutput>`, one schema per arm.
// The grounding guardrail emits `skipped | validated`; the assembler also has to
// parse `failed` (an upstream guardrail failure), so each arm is exported alone
// and each node composes the union it actually receives.

export const GuardrailCheckSchema = z.object({
  dimension: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});

export const GuardrailSkippedSchema = z.object({
  kind: z.literal("skipped"),
  value: z.undefined(),
  passed: z.literal(true),
  warnings: z.array(z.string()),
  checks: z.array(GuardrailCheckSchema),
});

export const GuardrailValidatedSchema = z.object({
  kind: z.literal("validated"),
  value: SynthesisOutputSchema,
  passed: z.boolean(),
  warnings: z.array(z.string()),
  checks: z.array(GuardrailCheckSchema),
});

export const GuardrailFailedSchema = z.object({
  kind: z.literal("failed"),
  passed: z.literal(false),
  error: z.string(),
  warnings: z.array(z.string()),
  checks: z.array(GuardrailCheckSchema),
});
