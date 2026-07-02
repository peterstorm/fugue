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
 * `Object.freeze` typed as identity: runtime immutability without changing
 * assignability (`Readonly<T>` / `readonly T[]` would break consumers that
 * expect the mutable-typed `FieldSpec` shape — the freeze is a runtime guard,
 * invisible to the type checker on purpose).
 */
const freeze = <T>(value: T): T => Object.freeze(value) as T;

/**
 * The `confidence` output field codegen injects on every LLM node — and the
 * exact shape an EXPLICITLY declared `confidence` field must carry. Shaped
 * like a `FieldSpec` structurally; this module cannot import that type (the
 * shared layer is import-free), so `authored-codegen` assigns it where a
 * `FieldSpec` is expected. Deep-frozen: it is an exported singleton guarding
 * a declared byte-for-byte invariant, so a mutation anywhere would silently
 * corrupt every consumer — freeze makes that a loud TypeError instead.
 */
export const CONFIDENCE_FIELD = freeze({
  name: "confidence",
  type: freeze({ kind: "enum" as const, values: freeze([...CONFIDENCE_BUCKET]) }),
});
