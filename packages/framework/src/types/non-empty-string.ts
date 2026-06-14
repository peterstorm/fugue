// `NonEmptyString` — a string proven to carry at least one non-whitespace
// character.
//
// Hard-branded newtype over `string`, mirroring the id brands in `ids.ts`. A
// plain `string` does NOT satisfy this type at compile time — `""` (and any
// all-whitespace string) is unrepresentable by construction. The sole gateway
// is {@link asNonEmptyString}, which normalizes blank → `undefined` at the
// parse boundary so callers thread the brand downstream WITHOUT re-checking
// (parse-don't-validate).
//
// At runtime the value is still a plain string; the brand is erased by
// TypeScript. It exists to push the "non-blank" invariant — e.g. an Application
// Insights connection string that must carry an ingestion endpoint — into the
// type rather than relying on a runtime guard at each consumer.

declare const __nonEmptyStringBrand: unique symbol;

/** A string proven non-blank (≥1 non-whitespace character). See module docs. */
export type NonEmptyString = string & { readonly [__nonEmptyStringBrand]: void };

/**
 * Smart constructor: the sole gateway to a {@link NonEmptyString}. Returns the
 * ORIGINAL (untrimmed) string when it contains at least one non-whitespace
 * character, else `undefined`. Returning the untrimmed original preserves
 * byte-for-byte the value the caller supplied — trimming is used only to decide
 * presence, never to rewrite the payload.
 */
export const asNonEmptyString = (s: string): NonEmptyString | undefined =>
  s.trim() !== "" ? (s as NonEmptyString) : undefined;

/**
 * Throwing smart constructor — the gateway for callers that treat a blank value
 * as a programmer error rather than an absent option (mirrors `nodeId`/`dagId`
 * in `ids.js`, which throw, alongside the Option-returning `asNonEmptyString`).
 * Returns the ORIGINAL (untrimmed) string; throws if it is empty or all
 * whitespace. Prefer this when the non-blank invariant is a precondition the
 * caller is asserting, not a value it is parsing-or-skipping.
 */
export const nonEmptyString = (s: string): NonEmptyString => {
  const parsed = asNonEmptyString(s);
  if (parsed === undefined) {
    throw new Error("nonEmptyString: value must contain at least one non-whitespace character");
  }
  return parsed;
};
