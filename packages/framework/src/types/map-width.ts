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
// The three arms are the whole contract. Each carries its OWN FR, because the
// arms below are not in ascending FR order and a reader pairing them
// positionally against a "FR-F1-003/004/005" group label would mis-attribute
// all three:
//   - not an array            → `map-width-invalid`, fail closed        (FR-F1-005)
//   - length > maxWidth       → `map-width-exceeded`, fail closed,
//                               NEVER truncated                          (FR-F1-003)
//   - length === 0            → SUCCESS with an empty fan (not an error) (FR-F1-004)
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
 * ONE encoding of "a read of untrusted upstream data threw" → the module's
 * typed refusal.
 *
 * Written once on purpose. The defect this module was just fixed for was the
 * same rule applied to the field read and not to the element read below it —
 * two copies of one contract, and only one of them maintained. A single
 * conversion means a new hostile-read site cannot get a different answer.
 */
const readThrew = (
  nodeId: NodeId,
  from: WidthFrom,
  what: string,
  error: unknown,
): Result<never, FrameworkError> =>
  err(
    frameworkError.mapWidthInvalid(
      nodeId,
      from,
      `reading ${what} threw: ${safeDiagnosticRender(error)}`,
    ),
  );

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
    return readThrew(nodeId, from, "the field", error);
  }

  // IsArray itself throws on a revoked proxy, before any length/index read.
  let array: readonly unknown[];
  try {
    if (!Array.isArray(field)) {
      return err(frameworkError.mapWidthInvalid(nodeId, from, safeDiagnosticRender(field)));
    }
    array = field;
  } catch (error) {
    return readThrew(nodeId, from, "the array shape", error);
  }

  // `length` is read ONCE, into a local, and every later decision uses that
  // local. It is not a style preference: `Array.isArray` unwraps proxies, so
  // `field` can be a Proxy whose `length` returns a different number on each
  // read. The bound is enforced against this snapshot, and the copy below is
  // built to exactly this many elements — so "the length we checked" and "the
  // length we return" are the same number by construction rather than by two
  // reads agreeing.
  //
  // Inside a try for the reason the guard above does NOT cover it: `Array.isArray`
  // performs `IsArray`, which unwraps a Proxy to its target WITHOUT invoking any
  // trap. Passing that guard therefore proves the target is an array and proves
  // nothing at all about what the next property read does — a Proxy whose `get`
  // trap throws on `"length"` reaches this line having satisfied every check
  // before it. So this read gets the same typed refusal as the field read above
  // and the element reads below; the module header's promise is about EVERY
  // access, and this is the third of three.
  //
  // Typed `unknown`, not `number`, and that is the load-bearing part. A
  // `let width: number` annotation is a compile-time label over a value the
  // compiler never saw produced: `field` is only proven `Array.isArray`-true,
  // and a Proxy `get` trap returns whatever it likes. Declaring `unknown`
  // forces the read to pass the guard below before anything can compare it.
  let width: unknown;
  try {
    width = array.length;
  } catch (error) {
    return readThrew(nodeId, from, "the width", error);
  }

  // The guard the three earlier hardenings did not cover. They each closed an
  // access that could THROW or CHANGE; none established that what came back is
  // a number at all. It need not be: a `length` getter returning an object with
  // a stateful `valueOf` — one reporting 1 the first time it is coerced and 1e6
  // afterwards — passes `width > max` on the first ToPrimitive call and then
  // lengthens the "fixed-count" loop below on every iteration, because `i <
  // width` re-coerces the SAME object each time. That is the maxWidth bypass of
  // round 1 again, reached by coercion rather than by growth.
  //
  // Narrowing to a primitive here is what closes it, not merely detecting the
  // hostile case: a primitive `number` in `<` and `>` never calls `valueOf`,
  // so past this line there is no second reading of the width to disagree with
  // the one the bound was checked against. Same shape as `asMaxWidth` and
  // `asMapIndex` in this file, which lead with the identical `typeof` check.
  //
  // `mapWidthInvalid`, not `mapWidthExceeded`: a value that is not a number is
  // not a width that came out too large, it is not a width — the same refusal
  // a non-array field gets.
  if (typeof width !== "number" || !Number.isSafeInteger(width) || width < 0) {
    return err(frameworkError.mapWidthInvalid(nodeId, from, safeDiagnosticRender(width)));
  }
  if (width > max) {
    return err(frameworkError.mapWidthExceeded(nodeId, width, max));
  }

  // Copied by BOUNDED INDEX, not by spread.
  //
  // `[...field]` walks the array iterator, which re-reads `length` on every
  // step — so a `length` that grows after the check above produced a result
  // whose `items.length` exceeded the `max` that had just been enforced, while
  // `width` still reported the checked-safe number. The fan driver iterates
  // `items`, so that was a live `maxWidth` bypass: a declared max of 3 could
  // run 50 children. A fixed-count loop cannot be lengthened by anything the
  // value does afterwards.
  //
  // Inside the try for the same reason the field read above is: an index
  // getter can throw, and this function's contract is
  // `Result<_, FrameworkError>` — a raw throw here escapes the map node's
  // `run`, whose contract is the same. The module's header promises every
  // access survives a hostile value; this is one of them.
  //
  // Copied rather than aliased so a later mutation of the upstream array
  // cannot change the fan between index 0 and index N-1.
  const items: unknown[] = [];
  try {
    for (let i = 0; i < width; i++) items.push(array[i]);
  } catch (error) {
    return readThrew(nodeId, from, "an element", error);
  }

  return ok({ items, width });
};
