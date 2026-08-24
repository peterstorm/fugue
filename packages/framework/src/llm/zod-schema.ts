import { z } from "zod";
import { logFrameworkWithoutThrowing } from "../logger.js";

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
  // `unrepresentable: "any"` — zod 4's default ("throw") makes `z.toJSONSchema`
  // throw on `z.date()` (and z.map / z.set / z.void / an undefined literal) at
  // ANY nesting depth ("Date cannot be represented in JSON Schema"). That turns
  // a renderable object schema into "unverifiable" in `renderObjectSchema`
  // (a real fan-in-key mismatch would then defer to the runtime Zod parse)
  // and hard-fails the LLM structured-output path below. Mapping unrepresentable
  // types to `{}` (any) keeps the render total: a `z.date()` column renders as
  // an open schema instead of throwing (peterstorm/fugue#36, related item).
  const { $schema: _, ...json } = z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<string, unknown>;
  return json;
};

/**
 * Render a value to its JSON Schema **iff** it is an introspectable Zod *object*
 * schema; `null` otherwise — `z.unknown()`, a union, an effect, a value that
 * isn't a Zod schema at all, or one `zodToJsonSchema` can't render. The single
 * introspection path shared by `objectSchemaKeys` and `objectSchemaRequiredKeys`
 * so they can never disagree on what counts as an object schema.
 *
 * The `null`-on-failure bias is intentional: callers treat it as "can't verify,
 * skip" rather than risk a false positive (an introspection failure and a
 * deliberately non-object schema are indistinguishable here).
 */
const renderObjectSchema = (schema: unknown): Record<string, unknown> | null => {
  if (
    schema === null ||
    typeof schema !== "object" ||
    typeof (schema as { parse?: unknown }).parse !== "function"
  ) {
    return null;
  }
  let json: Record<string, unknown>;
  try {
    json = zodToJsonSchema(schema as z.ZodType<unknown>);
  } catch (e) {
    // A throw here is indistinguishable from a deliberately non-object schema
    // (both → null → "can't verify, skip"). That bias is intentional (no false
    // positives), but a render failure on a *real* object schema would silently
    // defer a genuine fan-in-key-mismatch to the runtime Zod parse. Log at debug
    // so a future zodToJsonSchema regression is diagnosable instead of invisible.
    logFrameworkWithoutThrowing(
      "debug",
      "renderObjectSchema: schema introspection threw, treating as unverifiable",
      { error: e instanceof Error ? e.message : String(e) },
    );
    return null;
  }
  if (json.type !== "object") return null;
  return json;
};

/**
 * Top-level property names of a Zod **object** schema (required *and* optional),
 * or `null` when the schema isn't an introspectable object. Callers treat `null`
 * as "can't verify the keys" and skip key-equality checks. Centralised so the
 * fan-in lint check and `defineSources` share one introspection path instead of
 * two copies that could drift.
 */
export const objectSchemaKeys = (schema: unknown): readonly string[] | null => {
  const json = renderObjectSchema(schema);
  if (json === null) return null;
  const props = json.properties;
  if (props === null || typeof props !== "object") return null;
  return Object.keys(props as Record<string, unknown>);
};

/**
 * The **required** top-level property names of a Zod object schema — the subset
 * of `objectSchemaKeys` that JSON Schema marks `required`. `[]` for an object
 * with no required keys; `null` when the schema isn't an introspectable object
 * (same unverifiable bias as `objectSchemaKeys`). Used to enforce that a
 * `"$input"` fan-in key is *required* (the DAG request is always delivered, so
 * an optional `$input` has no defined meaning) rather than optional.
 */
export const objectSchemaRequiredKeys = (schema: unknown): readonly string[] | null => {
  const json = renderObjectSchema(schema);
  if (json === null) return null;
  const required = json.required;
  if (required === undefined) return []; // object schema, no required keys
  if (!Array.isArray(required)) return null;
  return required.filter((k): k is string => typeof k === "string");
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
