// Runtime-width fan-out: the width value type and its parser (F1 PR-B, D2).
//
// Pure, no I/O, no imports from the runtime. A map node's width is read from
// an upstream node's output at run time and is therefore untrusted data: this
// module is the single place that turns it into a value the fan can be driven
// from, or a typed refusal.
//
// Parse, don't validate. `resolveMappedItems` does not answer "is this width
// OK?" — it returns the ITEMS, already proven to be an array whose length is
// within the author's declared bound. A caller holding a `MappedItems` cannot
// then fan over something else, and there is no second place where the bound
// could be checked differently.
//
// The three arms are the whole contract (FR-F1-003/004/005):
//   - not an array            → `map-width-invalid`, fail closed
//   - length > maxWidth       → `map-width-exceeded`, fail closed, NEVER truncated
//   - length === 0            → SUCCESS with an empty fan (not an error)
//
// Zero deserves its own sentence because it is the arm most likely to be
// "fixed" into a crash by someone reading the other two: "nothing matched" is
// the common real outcome of a scoping node, and a map over it legally
// produces the reducer's empty case.
//
// Truncation is deliberately unrepresentable. A `maxWidth` overrun cannot
// return a shortened array from here, because a truncated fan yields a
// plausible, wrong, CHEAPER answer — the worst failure available, since
// nothing downstream can tell it apart from a correct one.

import type { FrameworkError } from "./errors.js";
import type { NodeId } from "./ids.js";
import type { Result } from "./result.js";
import { err, ok } from "./result.js";
import { frameworkError } from "./error-factories.js";
import { safeDiagnosticRender } from "./safe-error.js";

// `MapIndex` is defined in its own leaf module (see that file for why) and
// re-exported here so the map surface reads as one thing to a consumer.
export type { MapIndex } from "./map-index.js";
export { asMapIndex, mapIndex } from "./map-index.js";

/**
 * A JS identifier, matching the closed authored surface's field register
 * (`cli/authored.ts`'s `when: { field, equals }` uses the same rule). A map's
 * `widthFrom` names ONE key on the upstream output — it is a field reference,
 * not a path and not an expression language (design constraint 4).
 */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

declare const __widthFromBrand: unique symbol;
declare const __maxWidthBrand: unique symbol;

/**
 * The upstream output field a map node reads its items from. Branded, so a
 * bare string cannot reach `resolveMappedItems` — the identifier rule is
 * enforced once, at construction, rather than at each read.
 */
export type WidthFrom = string & { readonly [__widthFromBrand]: void };

/**
 * An author-declared maximum fan width: a positive safe integer. Branded
 * because this number is what makes worst-case spend for the node statically
 * knowable (design constraint 2) — a `0` or a `NaN` reaching the runtime would
 * silently make that guarantee vacuous rather than loudly wrong.
 *
 * Positive, not non-negative: a `maxWidth` of 0 declares a node that can never
 * legally do anything, which is an authoring mistake rather than a
 * configuration. (A resolved WIDTH of 0 is legal — see `resolveMappedItems`.)
 */
export type MaxWidth = number & { readonly [__maxWidthBrand]: void };

/** Option-returning gateway to {@link WidthFrom}. `undefined` ⇒ not an identifier. */
export const asWidthFrom = (raw: string): WidthFrom | undefined => {
  // `__proto__` is excluded for the same reason the authored schema excludes
  // it: reading it off an object literal reaches the prototype setter rather
  // than a data field, so a map keyed on it would fan over something that was
  // never in the upstream output.
  if (raw === "__proto__") return undefined;
  return IDENT.test(raw) ? (raw as WidthFrom) : undefined;
};

/**
 * Throwing gateway to {@link WidthFrom} — for authoring call sites where a bad
 * field name is a programmer error caught at module load, mirroring
 * `nodeId`/`dagId`.
 */
export const widthFrom = (raw: string): WidthFrom => {
  const parsed = asWidthFrom(raw);
  if (parsed === undefined) {
    throw new Error(
      `widthFrom: '${raw}' is not a valid field reference — it must be a JS identifier (and not '__proto__')`,
    );
  }
  return parsed;
};

/** Option-returning gateway to {@link MaxWidth}. `undefined` ⇒ not a positive safe integer. */
export const asMaxWidth = (raw: number): MaxWidth | undefined =>
  // `typeof` first for the same reason `isNonNegativeSafeInteger` leads with
  // it in the checkpoint codec: the guard must reject before any comparison
  // applies numeric coercion to a forged value.
  typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? (raw as MaxWidth) : undefined;

/**
 * Throwing gateway to {@link MaxWidth} — the `defineDag`/`createMapNode` path,
 * where a missing or non-positive maximum is rejected at module load
 * (FR-F1-002) rather than discovered on the first wide run.
 */
export const maxWidth = (raw: number): MaxWidth => {
  const parsed = asMaxWidth(raw);
  if (parsed === undefined) {
    throw new Error(
      `maxWidth: expected a positive safe integer, got ${safeDiagnosticRender(raw)}`,
    );
  }
  return parsed;
};

/**
 * An array proven to be within its map node's declared bound, together with
 * the width that bound admitted.
 *
 * `width` is `items.length` and is carried anyway, so the fan driver and every
 * projection (telemetry, the renderer's `×n`) read ONE number rather than each
 * re-deriving it from a possibly-different array.
 */
export interface MappedItems {
  readonly items: readonly unknown[];
  readonly width: number;
}

/**
 * Read a map node's items off the upstream output and prove them within bound.
 *
 * `upstream` is untrusted: it is whatever the previous node returned. Every
 * access below is written to survive a hostile value — a `null` prototype, a
 * throwing getter, a non-object — with a typed refusal rather than a raw throw,
 * because this runs inside a node's `run` whose contract is
 * `Result<_, FrameworkError>`.
 */
export const resolveMappedItems = (
  nodeId: NodeId,
  upstream: unknown,
  from: WidthFrom,
  max: MaxWidth,
): Result<MappedItems, FrameworkError> => {
  if (typeof upstream !== "object" || upstream === null) {
    return err(frameworkError.mapWidthInvalid(nodeId, from, safeDiagnosticRender(upstream)));
  }

  // A getter on the upstream output can throw. That is a caller-data fault,
  // not a node crash, so it becomes the same typed refusal as a wrong type
  // rather than escaping as a raw exception.
  let field: unknown;
  try {
    field = (upstream as Record<string, unknown>)[from];
  } catch (error) {
    return err(
      frameworkError.mapWidthInvalid(
        nodeId,
        from,
        `reading the field threw: ${safeDiagnosticRender(error)}`,
      ),
    );
  }

  if (!Array.isArray(field)) {
    return err(frameworkError.mapWidthInvalid(nodeId, from, safeDiagnosticRender(field)));
  }

  const width = field.length;
  if (width > max) {
    return err(frameworkError.mapWidthExceeded(nodeId, width, max));
  }

  // Copied, not aliased. The caller holds a value it can fan over N times
  // without the upstream output mutating the list underneath it between
  // indices — the fan's width and its items must be the same facts at index 0
  // and at index N-1.
  return ok({ items: [...field], width });
};
