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

import type { Witness } from "./freshness.js";

export type SideEffectKind = "none" | "reads" | "writes" | "external-call";

export type SideEffectProfile =
  | { readonly kind: "none"; readonly resource?: undefined }
  | {
      readonly kind: "reads";
      readonly resource: string;
      /**
       * Extract a freshness witness from the node's output after successful
       * execution. When absent, freshness tracking is silently skipped.
       *
       * Example: `(output) => ({ kind: "version", resource: "postgres:orders:123", value: String(output.xmin) })`
       */
      readonly extractWitness?: (output: unknown) => Witness;
    }
  | {
      readonly kind: "writes";
      readonly resource: string;
      readonly idempotencyKey?: (input: unknown) => string;
      /**
       * Declare which witness this write is conditioned on. Called with the
       * node's assembled input before execution.
       */
      readonly extractConditionedOn?: (input: unknown) => Witness;
      /**
       * Extract the new witness after a successful write. Captures the new
       * resource version that resulted from the mutation.
       */
      readonly extractNewWitness?: (output: unknown) => Witness;
    }
  | {
      readonly kind: "external-call";
      readonly resource: string;
      readonly idempotencyKey?: (input: unknown) => string;
    };
