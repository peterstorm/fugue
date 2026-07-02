// Closed authoring vocabulary for the AuthoredDag pipeline (deterministic-core
// convergence, Phase B).
//
// The framework's bucketed-confidence channel appears in three places that
// MUST agree byte-for-byte: the authoring schema's explicit-`confidence`
// check (`authored.ts`), the output field codegen injects on every LLM node
// (`authored-codegen.ts`), and the compose system prompt the LLM drafts
// against (`compose.ts`). This module is the single source of truth they all
// consume.
//
// Pure data, no imports — like `identifiers.ts`, this sits at the import-free
// shared layer: `authored.ts` / `authored-codegen.ts` / `compose.ts` all
// depend on it, never the reverse.

/**
 * The ordered bucketed-confidence enum values. Order matters: codegen emits
 * `z.enum([...])` in this order, and an explicitly authored `confidence`
 * field must match it exactly (see the superRefine in `authored.ts`).
 */
export const CONFIDENCE_BUCKET = ["high", "medium", "low"] as const;

/**
 * The `confidence` output field codegen injects on every LLM node — and the
 * exact shape an EXPLICITLY declared `confidence` field must carry. Shaped
 * like a `FieldSpec` structurally; this module cannot import that type (the
 * shared layer is import-free), so `authored-codegen` assigns it where a
 * `FieldSpec` is expected.
 */
export const CONFIDENCE_FIELD = {
  name: "confidence",
  type: { kind: "enum" as const, values: [...CONFIDENCE_BUCKET] },
};
