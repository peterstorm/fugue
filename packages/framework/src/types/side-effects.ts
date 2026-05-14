/**
 * Side-effects taxonomy for node declarations.
 *
 * Every node declares its side-effect profile via `sideEffects` on `NodeDef`.
 * The discriminated union enforces that `resource` is mandatory when
 * `kind !== "none"` at the type level. `idempotencyKey` is a callback because
 * the input type at definition site is generic `I` — invoked at run time
 * inside `withNodeSpan`.
 */

export type SideEffectKind = "none" | "reads" | "writes" | "external-call";

export type SideEffectProfile =
  | { readonly kind: "none"; readonly resource?: undefined }
  | { readonly kind: "reads"; readonly resource: string }
  | {
      readonly kind: "writes";
      readonly resource: string;
      readonly idempotencyKey?: (input: unknown) => string;
    }
  | {
      readonly kind: "external-call";
      readonly resource: string;
      readonly idempotencyKey?: (input: unknown) => string;
    };
