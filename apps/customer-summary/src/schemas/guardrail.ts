import { z } from "zod";
import type { GuardrailSkipped, GuardrailValidated, GuardrailResult } from "@fuguejs/framework";
import { SynthesisOutputSchema } from "./summary.js";
import type { SynthesisOutput } from "./summary.js";

// The wire shape of a `GuardrailResult<SynthesisOutput>`, one schema per arm.
// The framework's guardrail wrapper emits `skipped | validated | failed`
// (failed when validate() throws). The assembler's `failed` arm is a
// DEFENSIVE path for guardrails that can fail — this app's grounding
// guardrail emits only `skipped | validated`, and each node composes the
// union it actually receives while the assembler keeps the arm its wrapper
// can emit.
//
// Each arm is checked against its framework type (`satisfies`, not a plain
// `z.ZodType<...>` annotation — the annotation would erase the discriminant
// metadata `z.discriminatedUnion` needs from the arm schemas), so a schema
// that drifts from `GuardrailResult` fails to compile. `GuardrailFailed` is
// not re-exported from the framework barrel; the failed arm is spelled as its
// `GuardrailResult` member instead.

const GuardrailCheckSchema = z.object({
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
}) satisfies z.ZodType<GuardrailSkipped>;

export const GuardrailValidatedSchema = z.object({
  kind: z.literal("validated"),
  value: SynthesisOutputSchema,
  passed: z.boolean(),
  warnings: z.array(z.string()),
  checks: z.array(GuardrailCheckSchema),
}) satisfies z.ZodType<GuardrailValidated<SynthesisOutput>>;

export const GuardrailFailedSchema = z.object({
  kind: z.literal("failed"),
  passed: z.literal(false),
  error: z.string(),
  warnings: z.array(z.string()),
  checks: z.array(GuardrailCheckSchema),
}) satisfies z.ZodType<Extract<GuardrailResult<SynthesisOutput>, { kind: "failed" }>>;
