// The `map` node — runtime-width fan-out (F1 PR-B, D1).
//
// D1 is the decision everything here follows from: a map node is ONE node in
// the outer graph. It occupies one `NodeId` in `waves`, `activeNodeIds` and
// `outputs`; its output is the single gathered value a typed reducer produced.
// Per-index execution of the child sub-DAG happens INSIDE the node, against
// `runDag`.
//
// The consequence worth stating, because it is why this file exists at all
// instead of a change to the scheduler: wave scheduling needs no change.
// `wave-execution.ts` and `wave-resolution.ts` are untouched, `DagTopology`
// stays compile-time immutable, `ctx.outputs` keeps its one-output-per-NodeId
// shape, and `defineDag` can still validate reachability and else-totality at
// module load — because the node set is still known then.
//
// The rejected alternative was materializing N nodes into the wave at runtime.
// It reads natural (the fan really is N things) and it breaks, in order: the
// topology's immutability, the outputs map's shape, `activeNodeIds` set
// semantics, the static `nodes` record, and boot-time validation. It converts
// the framework's central invariant into a runtime concern to buy notation.

import type { z } from "zod";
import type { NodeDef, TypedNodeContext } from "../types/node.js";
import type { DagDef } from "../types/dag.js";
import type { Result } from "../types/result.js";
import { err } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { frameworkError } from "../types/error-factories.js";
import { safeErrorMessage } from "../types/safe-error.js";
import { nodeId as brandNodeId } from "../types/ids.js";
import { resourceName } from "../types/witness.js";
import type { NodeId } from "../types/ids.js";
import { maxWidth as brandMaxWidth, resolveMappedItems, widthFrom as brandWidthFrom } from "../types/map-width.js";
import { mapIndex } from "../types/map-index.js";
import { compositeNodeKey } from "../checkpoint/composite-node-key.js";
import { runDag } from "../executor/run-dag.js";
// Imported for the `checkpointer` CapabilityRegistry augmentation it carries:
// without this the `requires: ["checkpointer"]` below would not type-check.
import "../checkpoint/capability.js";

/**
 * The capabilities a map node always declares. `checkpointer` is not optional:
 * it is what makes a partial fan resumable (FR-F1-006/007), and a map node
 * wired without one would silently re-run every completed index after a crash
 * — the exact degradation this feature exists to prevent, and one that no test
 * short of a real crash would notice.
 */
const MAP_REQUIRES = ["checkpointer"] as const;

export interface MapNodeConfig<I, ChildOut, O> {
  readonly id: string;
  /** Schema of the UPSTREAM value this node receives — the one carrying `widthFrom`. */
  readonly inputSchema: z.ZodType<I>;
  /** Schema of the GATHERED output the reducer produces. */
  readonly outputSchema: z.ZodType<O>;
  /**
   * Field on the input holding the array to fan over. A single JS identifier —
   * the same closed register as `AuthoredDag`'s `when: { field, equals }`, not
   * a path and not an expression language (design constraint 4). Rejected at
   * module load if it is not one.
   */
  readonly widthFrom: string;
  /**
   * Author-declared maximum width. Rejected at module load if missing or
   * non-positive (FR-F1-002). This is the number that makes the node's
   * worst-case spend statically knowable before the run starts, which is what
   * lets F3's admission reason about a fan rather than discover it.
   */
  readonly maxWidth: number;
  /** The child sub-DAG applied once per item. */
  readonly child: DagDef;
  /**
   * Schema each child run's output is validated against before it reaches the
   * reducer. A resumed index's stored output goes through this too: a deploy
   * may have tightened the schema since the checkpoint was written, and a
   * replayed value that no longer parses must fail rather than be gathered.
   */
  readonly childOutputSchema: z.ZodType<ChildOut>;
  /**
   * Typed reducer over the per-index outputs, in ASCENDING INDEX ORDER —
   * always, whether an index ran now or was replayed from a checkpoint. A
   * reducer that is order-sensitive (a concatenation, a ranked pick) therefore
   * produces the same answer on a resumed run as on a fresh one.
   *
   * Receives an EMPTY array when the width is 0 (FR-F1-004). That is a legal
   * outcome, not a crash: "nothing matched" is the common real result of a
   * scoping node, and the reducer is where its meaning is decided.
   */
  readonly reduce: (results: readonly ChildOut[]) => Result<O, FrameworkError>;
}

/**
 * The stored checkpoint address for one child index of a map node.
 *
 * ADR-0075's composite codec, used for exactly the case its Context paragraph
 * names ("indexed fan-out … without one save overwriting another"). Every
 * backend honors it since F1 PR-A, so this addressing works on Redis and
 * in-memory, not only on the file backend.
 */
const indexKey = (node: NodeId, index: number): string =>
  compositeNodeKey(node, { index: mapIndex(index) });

/**
 * FR-F1-011 / D7 — a node carrying `humanReview` inside a mapped sub-DAG is
 * rejected at module load.
 *
 * The check lives HERE rather than in `validateDagShape` because this is where
 * the child sub-DAG is visible: the child lives in this constructor's closure,
 * and surfacing it on `NodeDef` purely so a later validator could re-find it
 * would widen the node type for every node in the framework to serve one kind.
 * Construction happens at module scope, so the rejection is at import either
 * way — strictly earlier, in fact, than the DAG the node is later placed in.
 *
 * The structural reason it is rejected rather than supported, per D7:
 * `HumanGatePayload` carries a single `nodeId` and a `pendingReviews: NodeId[]`,
 * neither of which has an index dimension — so "index 12 of the mapped review
 * node is awaiting a human" has no representation. That payload is shared
 * verbatim by all three gate phases, so widening it is not a local change.
 *
 * Two consequences argue against doing it in v1 even if it were local. Partial-
 * fan park semantics are undefined (does 13..24 keep running, or does the whole
 * fan halt on its slowest human?), and either choice changes how resume
 * reconstructs the fan. And it silently voids ADR-0074: `maxQueuedRuns` bounds
 * RUNS, so one run with a 75-wide parked fan is one run against the limit but
 * 75 outstanding human decisions — precisely the failure that limit was written
 * to fix.
 *
 * Forbidding this is removable in one additive change once fan semantics have
 * been exercised for real. Shipping a half-specified per-index gate is not:
 * parked runs are durable and long-lived, so a wrong address shape means
 * migrating runs a human is mid-decision on, days later. Checkpoint addresses
 * can be migrated quietly; pending human decisions cannot.
 */
const rejectHumanReviewInChild = (mapNodeId: NodeId, child: DagDef): void => {
  const gated = child.nodes.filter((n) => n.humanReview !== undefined).map((n) => n.id);
  if (gated.length === 0) return;
  throw new Error(
    `createMapNode('${mapNodeId}'): child sub-DAG '${child.id}' declares humanReview on ` +
      `${gated.map((n) => `'${n}'`).join(", ")}, which a mapped sub-DAG cannot express — ` +
      "a human gate carries no index dimension, so 'index N is awaiting a human' has no " +
      "representation (F1 D7 / FR-F1-011). Fan, GATHER, then put one humanReview node on the " +
      "gathered array: one prompt, one decision, N items.",
  );
};

/**
 * Create a map node: apply a child sub-DAG over a runtime-resolved array and
 * gather the per-index outputs through a typed reducer (FR-F1-001).
 *
 * Author-time rejections happen HERE, at module load, by construction: the
 * branded `widthFrom`/`maxWidth` gateways throw on a bad field reference or a
 * non-positive bound (FR-F1-002), so a malformed map node cannot be built at
 * all rather than failing on its first wide run.
 */
export const createMapNode = <I, ChildOut, O>(
  config: MapNodeConfig<I, ChildOut, O>,
): NodeDef<I, O, FrameworkError, typeof MAP_REQUIRES> & { readonly id: NodeId } => {
  // Parsed once, at construction. Everything downstream holds branded values,
  // so there is no second place where the bound could be interpreted
  // differently — and an author error surfaces at import, not at run time.
  const id = brandNodeId(config.id);
  const from = brandWidthFrom(config.widthFrom);
  const max = brandMaxWidth(config.maxWidth);
  rejectHumanReviewInChild(id, config.child);

  return {
    id,
    kind: "map",
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    requires: MAP_REQUIRES,
    // `writes`, not `reads`. The node calls `saveNode` and `setMeta`, both of
    // which mutate durable state, and `node.ts` defines `reads` as reading
    // external state WITHOUT mutation. The distinction is load-bearing rather
    // than descriptive: `side-effects.ts` admits `idempotencyKey` and the
    // write-freshness extractors only on the `writes`/`external-call` arms, and
    // `node-span.ts` gates its idempotency handling on those kinds — so
    // labelling a mutating node `reads` silently excluded it from that
    // handling and misreported it to every consumer of the profile (freshness
    // contracts, operator dashboards, routing safety analysis).
    sideEffects: { kind: "writes", resource: resourceName("checkpoint:fan") },
    confidence: { mode: "none" },
    run: async (
      input: I,
      ctx: TypedNodeContext<typeof MAP_REQUIRES>,
    ): Promise<Result<O, FrameworkError>> => {
      const resolved = resolveMappedItems(id, input, from, max);
      if (!resolved.ok) return resolved;
      const { items, width } = resolved.value;

      // Which indices are already durable. A `load` failure is NOT treated as
      // "nothing is done": that would silently re-run a fan whose entries
      // exist, doubling spend on every degraded read. It fails closed.
      const loaded = await ctx.checkpointer.load(ctx.runId);
      if (!loaded.ok) return loaded;
      const stored = loaded.value?.nodes ?? {};

      // A run with no meta record yet has nowhere to hang node entries on the
      // Redis backend (its `load` short-circuits before reading the hash), so
      // the fan's own entries would be written and then be invisible on
      // resume. Seeded once, only when absent, so an outer run that already
      // established the record keeps its own.
      if (loaded.value === null) {
        const seeded = await ctx.checkpointer.setMeta(ctx.runId, {
          dagId: ctx.dagId,
          startedAt: new Date(),
          // The parsed `width`, not a re-derived `items.length`. They are equal
          // by construction, and reading the one the bound was checked against
          // means there is no second number that could ever disagree with it.
          nodeCount: width,
        });
        if (!seeded.ok) return seeded;
      }

      const gathered: ChildOut[] = [];
      for (const [index, item] of items.entries()) {
        // Sequential, deliberately, for this PR. Two properties depend on it:
        // a run that hits its F3 ceiling mid-fan stops at a KNOWN index rather
        // than at whichever of N in-flight children lost the race, and the
        // reducer's input order is the index order on a resumed run as well as
        // a fresh one. Bounded concurrency is additive later — it changes
        // neither the address space nor the reducer's contract.
        const key = indexKey(id, index);
        const hit = Object.prototype.hasOwnProperty.call(stored, key)
          ? stored[key]
          : undefined;

        if (hit !== undefined) {
          // FR-F1-007: a completed index is not re-executed. Its stored output
          // is re-validated first — a deploy may have tightened
          // `childOutputSchema` since the checkpoint was written, and gathering
          // a value that no longer parses would launder stale data into a fresh
          // result.
          const replayed = config.childOutputSchema.safeParse(hit.output);
          if (!replayed.success) {
            return err(
              frameworkError.validation(
                id,
                `checkpoint replay rejected for fan index ${index}: ${replayed.error.message}`,
              ),
            );
          }
          gathered.push(replayed.data);
          continue;
        }

        const childResult = await runDag<unknown, unknown>(config.child, item, ctx);
        if (!childResult.ok) return childResult;

        const parsed = config.childOutputSchema.safeParse(childResult.value);
        if (!parsed.success) {
          return err(
            frameworkError.validation(
              id,
              `fan index ${index} produced an output the child schema rejects: ${parsed.error.message}`,
            ),
          );
        }

        // Written BEFORE the next index runs, so a crash mid-fan leaves every
        // completed index durable. Writing them all at the end would make the
        // whole feature vacuous: the fan would resume from zero.
        const saved = await ctx.checkpointer.saveNode(
          ctx.runId,
          { nodeId: id, output: parsed.data, completedAt: new Date() },
          { index: mapIndex(index) },
        );
        if (!saved.ok) return saved;

        gathered.push(parsed.data);
      }

      // The reducer is caller code and may throw. A throw here would escape a
      // `run` whose contract is `Result<_, FrameworkError>`, so it is converted
      // at this boundary like any other untrusted seam.
      try {
        return config.reduce(gathered);
      } catch (error) {
        return err(
          frameworkError.nodeCrash(id, `map reducer threw: ${safeErrorMessage(error)}`, {
            retriability: "non-retriable",
          }),
        );
      }
    },
  };
};
