// The `checkpointer` capability (F1 PR-B).
//
// Registered through ADR-0051's module-augmentation extension point rather
// than added to `BaseNodeContext` as an eighth built-in, for a structural
// reason: `types/node.ts` cannot import `Checkpointer` without creating an
// import cycle. `types/errors.ts` imports `Capability` from `types/node.ts`,
// and `checkpoint/checkpointer.ts` imports `types/errors.ts`, so a built-in
// field here would close the loop that `module-graph-acyclic.test.ts` guards.
// Augmenting from this side keeps every edge pointing the way it already
// points — `checkpoint/` → `types/`, never back.
//
// It is a genuine capability by `architecture.md`'s test, not a seam invented
// for symmetry: durable checkpoint storage is real I/O at a boundary, the port
// already has three adapters (file, in-memory, Redis) plus a shared contract
// suite, and a node holding it can be tested against the in-memory one with no
// mocking framework.
//
// WHY a map node needs it. ADR-0075's composite address exists for exactly
// this consumer — its Context paragraph says so: "Indexed fan-out, nested DAG
// namespaces, and repeated attempts need multiple durable outputs for the same
// node without one save overwriting another." F1 PR-A then made every backend
// honor that address. A map node is the first caller to actually use it: it
// saves each child index under `{ index }` and, on resume, re-runs only the
// indices with no durable entry (FR-F1-006/007). Without a capability the fan
// would have no readable per-index store, because the host's sibling
// `CheckpointWriter` is write-only — nothing reads those keys back.

import type { Checkpointer } from "./checkpointer.js";

declare module "../types/node.js" {
  interface CapabilityRegistry {
    /**
     * Durable, composite-addressable checkpoint storage. Distinct from the
     * write-only `ctx.checkpointWriter`: this port can be READ
     * (`load`), which is what makes partial-fan resume expressible.
     */
    readonly checkpointer: Checkpointer;
  }
}

// A module with only `declare module` and type imports emits nothing and can be
// elided by the bundler, taking the augmentation with it. This runtime constant
// gives the module a value export so the augmentation survives into consumers,
// and names the capability once for code that needs the string.
export const CHECKPOINTER_CAPABILITY = "checkpointer" as const;
