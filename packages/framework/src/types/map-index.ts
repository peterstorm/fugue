// `MapIndex` — a child instance's position within a `map` node's fan (F1 PR-B).
//
// This lives in its own leaf module — importing `safe-error.js` and nothing
// else — for the same reason `checkpoint-address.ts` does. `types/node.ts`
// needs the type for `CheckpointWriter.write`'s index parameter, and
// `map-width.ts` (which needs `errors.ts` and `error-factories.ts` for its
// typed refusals) transitively imports `node.ts` through them. Keeping the
// brand here breaks that cycle: the index is one whole concern, and it is the
// half of the map surface that a leaf consumer actually needs.

import { safeDiagnosticRender } from "./safe-error.js";

declare const __mapIndexBrand: unique symbol;

/**
 * A child instance's position within a fan: a non-negative safe integer.
 *
 * Branded because this number becomes part of a DURABLE checkpoint address. An
 * unbranded index reaching a key builder as `NaN`, `-1`, or `1.5` would mint an
 * address that no resume can ever match — the entry is written, the resume
 * looks for a different key, and the only symptom is an index that silently
 * re-executes forever. The brand puts that rejection at the one construction
 * site instead of at every builder.
 */
export type MapIndex = number & { readonly [__mapIndexBrand]: void };

/** Option-returning gateway to {@link MapIndex}. */
export const asMapIndex = (raw: number): MapIndex | undefined =>
  // `typeof` first: `>=` coerces, so a guard leading with the comparison would
  // admit a forged `"3"` (or consult a hostile `valueOf`) as a durable address
  // component.
  typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? (raw as MapIndex) : undefined;

/**
 * Throwing gateway to {@link MapIndex}. The fan driver derives indices from its
 * own loop counter, so a rejection here is a framework bug, not caller data —
 * which is exactly why it throws rather than returning a `Result` no caller
 * could act on.
 */
export const mapIndex = (raw: number): MapIndex => {
  const parsed = asMapIndex(raw);
  if (parsed === undefined) {
    throw new Error(
      `mapIndex: expected a non-negative safe integer, got ${safeDiagnosticRender(raw)}`,
    );
  }
  return parsed;
};
