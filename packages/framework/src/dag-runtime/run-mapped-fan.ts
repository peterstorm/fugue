import type { MapNodeDef } from "../types/dag.js";
import type { TypedNodeContext } from "../types/node.js";
import type { FreshnessExecutionEpoch } from "../types/witness.js";
import type { Result } from "../types/result.js";
import { err } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { frameworkError } from "../types/error-factories.js";
import { safeErrorMessage } from "../types/safe-error.js";
import { resolveMappedItems } from "../types/map-width.js";
import { mapIndex } from "../types/map-index.js";
import { compositeNodeKey } from "../shared/composite-node-key.js";
import type { ExecuteMappedChild } from "./execution-scope.js";

/** Sequential durable fan shell. Child retry/finalization stays in the one kernel. */
export const runMappedFan = async (
  node: MapNodeDef,
  input: unknown,
  ctx: TypedNodeContext<readonly ["checkpointer"]>,
  executionEpoch: FreshnessExecutionEpoch,
  executeChild: ExecuteMappedChild,
  now: () => number,
): Promise<Result<unknown, FrameworkError>> => {
  if (ctx.signal?.aborted) return err({ kind: "aborted", reason: "signal" });
  const { id, mapping } = node;
  const resolved = resolveMappedItems(id, input, mapping.widthFrom, mapping.maxWidth);
  if (!resolved.ok) return resolved;
  const { items, width } = resolved.value;
  // A failed load never means an empty checkpoint: that would repeat effects.
  const loaded = await ctx.checkpointer.load(ctx.runId);
  if (!loaded.ok) return loaded;
  // Refuse all corruption: an opaque digest cannot prove a dropped completion
  // belongs to another map/epoch. Backend warning-and-drop is not a safe miss.
  if (loaded.value !== null && loaded.value.corruptNodeAddresses.length > 0) {
    return err(frameworkError.checkpointCorrupt(ctx.runId,
      `mapped fan cannot safely replay a checkpoint with corrupt entries: ${JSON.stringify(loaded.value.corruptNodeAddresses)}`, id));
  }
  const stored = loaded.value?.nodes ?? {};
  if (loaded.value === null) {
    const seeded = await ctx.checkpointer.setMeta(ctx.runId, {
      dagId: ctx.dagId, startedAt: new Date(now()), nodeCount: width,
    });
    if (!seeded.ok) return seeded;
  }

  const gathered: unknown[] = [];
  for (const [i, item] of items.entries()) {
    if (ctx.signal?.aborted) return err({ kind: "aborted", reason: "signal" });
    const scope = Object.freeze({ mapNodeId: id, index: mapIndex(i), executionEpoch });
    // Reads and writes use the SAME current parent generation. Retry keeps it;
    // reroute advances it durably before this dispatch (never an input hash).
    const address = { index: scope.index, attempt: scope.executionEpoch };
    const key = compositeNodeKey(id, address);
    const hit = Object.hasOwn(stored, key) ? stored[key] : undefined;
    if (hit !== undefined) {
      const replayed = mapping.childOutputSchema.safeParse(hit.output);
      if (!replayed.success) return err(frameworkError.validation(id,
        `checkpoint replay rejected for fan index ${i}: ${replayed.error.message}`));
      gathered.push(replayed.data);
      continue;
    }
    const child = await executeChild(item, scope);
    if (!child.ok) return child;
    const parsed = mapping.childOutputSchema.safeParse(child.value);
    if (!parsed.success) return err(frameworkError.validation(id,
      `fan index ${i} produced an output the child schema rejects: ${parsed.error.message}`));
    // Foreground child finalization and this save both finish before index i+1.
    const saved = await ctx.checkpointer.saveNode(ctx.runId,
      { nodeId: id, output: parsed.data, completedAt: new Date(now()) }, address);
    if (!saved.ok) return saved;
    gathered.push(parsed.data);
  }
  // Also gate the empty/final-index path. An operation may complete while its
  // signal is being cancelled: preserve its save, but never report a new fan
  // success or start more child work under that cancelled slice.
  if (ctx.signal?.aborted) return err({ kind: "aborted", reason: "signal" });
  try {
    return mapping.reduce(gathered);
  } catch (cause) {
    return err(frameworkError.nodeCrash(id, `map reducer threw: ${safeErrorMessage(cause)}`, {
      retriability: "non-retriable",
    }));
  }
};
