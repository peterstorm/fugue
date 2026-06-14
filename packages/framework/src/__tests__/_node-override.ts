// Shared test helper for the `makeNode`-style fixtures that build a `NodeDef`
// from a `Partial<NodeDef>` of overrides.
//
// Since `NodeHumanReviewConfig.prompt` is a branded `NonEmptyString`, a fixture
// can't spread a raw `{ humanReview: { prompt: "…" } }` override straight into a
// `NodeDef`. `NodeOverride` relaxes that single field back to a raw string at
// the call boundary, and `brandedOverride` re-brands it (throwing on a blank
// prompt — a bad fixture should fail loudly) before it reaches the node. The
// production gateway (`withHumanReview`) does the same parse for real authors;
// these fixtures deliberately bypass it to construct minimal nodes for the
// runtime/state-machine tests.

import type { NodeDef } from "../types/node.js";
import { nonEmptyString } from "../types/non-empty-string.js";

/** A `Partial<NodeDef>` override with the `humanReview` prompt relaxed to a raw string. */
export type NodeOverride = Partial<Omit<NodeDef<unknown, unknown>, "humanReview">> & {
  readonly humanReview?: { readonly prompt: string };
};

/** Re-brand a `NodeOverride`'s raw human-review prompt into the stored `NonEmptyString` form. */
export const brandedOverride = (o: NodeOverride): Partial<NodeDef<unknown, unknown>> => {
  const { humanReview, ...rest } = o;
  return humanReview
    ? { ...rest, humanReview: { prompt: nonEmptyString(humanReview.prompt) } }
    : rest;
};
