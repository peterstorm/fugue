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

/**
 * Pure recursive transform: adds `additionalProperties: false` to all
 * object-type schemas. Required by Azure OpenAI structured output (strict
 * mode). Returns a new object — the input is never mutated.
 *
 * Handles:
 * - Top-level and nested object schemas (`type: "object"` + `properties`)
 * - Array `items`
 * - Composition keywords (`anyOf`, `oneOf`, `allOf`) — Zod v4 renders
 *   `z.union`, `z.discriminatedUnion`, `z.optional` as these.
 * - Shared definitions (`$defs`, `definitions`)
 */
export function withAdditionalPropertiesFalse(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema };
  if (result.type === "object" && result.properties) {
    result.additionalProperties = false;
    result.properties = Object.fromEntries(
      Object.entries(result.properties as Record<string, Record<string, unknown>>)
        .map(([k, v]) => [k, v && typeof v === "object" ? withAdditionalPropertiesFalse(v) : v]),
    );
  }
  if (result.items && typeof result.items === "object") {
    result.items = withAdditionalPropertiesFalse(result.items as Record<string, unknown>);
  }
  // Handle composition keywords (anyOf, oneOf, allOf) — Zod v4 renders
  // z.union, z.discriminatedUnion, z.optional as these.
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(result[key])) {
      result[key] = (result[key] as Record<string, unknown>[]).map(withAdditionalPropertiesFalse);
    }
  }
  // Handle $defs / definitions (shared schema references)
  for (const key of ["$defs", "definitions"] as const) {
    if (result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = Object.fromEntries(
        Object.entries(result[key] as Record<string, Record<string, unknown>>)
          .map(([k, v]) => [k, v && typeof v === "object" ? withAdditionalPropertiesFalse(v) : v]),
      );
    }
  }
  return result;
}
