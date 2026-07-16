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
// Pure data, no RUNTIME imports — like `identifiers.ts`, this sits at the
// import-free shared layer: `authored.ts` / `authored-codegen.ts` /
// `compose.ts` all depend on it, never the reverse. (The one `import type`
// below is erased at compile time, so the layering holds at runtime; it
// exists so `CONFIDENCE_FIELD` is `satisfies`-checked against the real
// `FieldSpec` at its definition site instead of being merely structurally
// assumed by its consumers.)

import type { FieldSpec } from "./authored.js";

/**
 * The ordered bucketed-confidence enum values. Order matters: codegen emits
 * `z.enum([...])` in this order, and an explicitly authored `confidence`
 * field must match it exactly (see the superRefine in `authored.ts`).
 */
export const CONFIDENCE_BUCKET = ["high", "medium", "low"] as const;

/**
 * The `confidence` output field codegen injects on every LLM node — and the
 * exact shape an EXPLICITLY declared `confidence` field must carry. The
 * `satisfies FieldSpec` (const-preserving — the inferred literal type is
 * kept) makes a `FieldSpec` change flag HERE, at the definition site, rather
 * than at whichever consumer happens to assign it first. Deep-frozen: it is
 * an exported singleton guarding a declared byte-for-byte invariant, so a
 * mutation anywhere would silently corrupt every consumer — freeze makes
 * that a loud TypeError instead. Plain `Object.freeze` (no identity cast):
 * `FieldSpec`'s arrays are ReadonlyArray in the schema-inferred type, so the
 * frozen readonly shapes are directly assignable.
 */
export const CONFIDENCE_FIELD = Object.freeze({
  name: "confidence",
  type: Object.freeze({ kind: "enum" as const, values: Object.freeze([...CONFIDENCE_BUCKET]) }),
}) satisfies FieldSpec;
