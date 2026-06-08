/**
 * Side-effects taxonomy for node declarations.
 *
 * Every node declares its side-effect profile via `sideEffects` on `NodeDef`.
 * The discriminated union enforces that `resource` is mandatory when
 * `kind !== "none"` at the type level.
 *
 * Freshness witness extractors (Phase 3) are colocated on the variant where
 * they apply: `extractWitness` on `reads`, `extractConditionedOn` and
 * `extractNewWitness` on `writes`. This prevents mis-pairing at the type
 * level (e.g. `extractWitness` on a `writes` node is a type error).
 *
 * Closures (`idempotencyKey`, freshness extractors) are safe here because
 * `SideEffectProfile` appears on in-process observer events (`ObserverEvent`),
 * never on the serialized durable event log (`DagEvent`). The
 * `DagMachineContextPersisted` shape excludes `NodeDef` entirely.
 */

import type { Witness, WitnessValue, ResourceName } from "./freshness.js";

export type SideEffectKind = "none" | "reads" | "writes" | "external-call";

export type SideEffectProfile<I = unknown, O = unknown> =
  | { readonly kind: "none"; readonly resource?: never }
  | {
      readonly kind: "reads";
      readonly resource: ResourceName;
      /**
       * Extract a freshness witness value from the node's output after
       * successful execution. Returns only `(kind, value)` — the framework
       * stamps this node's `resource`, so the witness can never name a
       * different resource than the profile. When absent, freshness tracking
       * is silently skipped.
       *
       * Example: `(output) => witnessValue("version", String(output.xmin))`
       */
      readonly extractWitness?: (output: O) => WitnessValue;
    }
  | {
      readonly kind: "writes";
      readonly resource: ResourceName;
      readonly idempotencyKey?: (input: I) => string;
      /**
       * Declare which witness this write is conditioned on. Called with the
       * node's assembled input before execution. Returns a full `Witness`
       * (including `resource`) because a write may be conditioned on a
       * *different* resource it read upstream — that resource is a genuine
       * free variable the author must name.
       */
      readonly extractConditionedOn?: (input: I) => Witness;
      /**
       * Extract the new witness value after a successful write. Returns only
       * `(kind, value)`; the framework stamps this node's `resource` (a write
       * always produces the new version of the resource it writes).
       *
       * Example: `(output) => witnessValue("version", String(output.newXmin))`
       */
      readonly extractNewWitness?: (output: O) => WitnessValue;
    }
  | {
      readonly kind: "external-call";
      readonly resource: ResourceName;
      readonly idempotencyKey?: (input: I) => string;
    };
