import { z } from "zod";

/**
 * Convert a Zod schema to a JSON Schema object suitable for LLM API calls.
 * Strips the `$schema` meta-key that Zod v4 emits.
 *
 * The `ZodType<any>` parameter type is required because Zod v4's
 * `toJSONSchema` expects `ZodType<any>` but our schemas are `ZodType<T>`.
 * The covariance is sound — we only read the schema structure, never write
 * through it. Centralising the cast here keeps the LLM clients clean.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const zodToJsonSchema = (schema: z.ZodType<any>): Record<string, unknown> => {
  const { $schema: _, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return json;
};
