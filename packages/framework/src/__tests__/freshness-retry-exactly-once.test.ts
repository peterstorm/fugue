/**
 * Regression: a RETRIABLE freshness-index failure must not re-execute the side
 * effects of wave siblings that already succeeded — and must not lose the write
 * witness of the node whose bookkeeping failed.
 *
 * Both halves matter and they pull against each other. Carrying the succeeded
 * siblings forward (so their `run` is not re-invoked) is what stops a duplicate
 * charge/notification. But "this node already has an output" is NOT evidence
 * that "this node's witness was recorded" — the abort happened DURING the
 * bookkeeping. The runtime tracks the two facts separately, so a retry skips
 * re-dispatch while still completing the outstanding freshness work.
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { N, R, D, NO_SIDE_EFFECTS, NO_CONFIDENCE } from "./_id-helpers.js";
import { witness, witnessValue, RN } from "./_freshness-helpers.js";
import { InMemoryFreshnessIndex } from "../dag-runtime/freshness-check.js";
import type { FreshnessIndex } from "../dag-runtime/freshness-check.js";
import { RecordingObserver } from "../observer/observer.js";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { defineDag } from "../executor/define-dag.js";
import { DAG_INPUT } from "../types/ids.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import { ok, err } from "../types/result.js";
import type { NodeDef } from "../types/node.js";
import { type NodeOverride, brandedOverride } from "./_node-override.js";
import type { WriteAttemptedEvent } from "../types/events.js";

const makeNode = (id: string, overrides: NodeOverride = {}): NodeDef<unknown, unknown> => ({
  // @ts-expect-error — branded ID test fixture
  id,
  kind: "transform" as const,
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: async (input: unknown) => ok(input),
  requires: [] as const,
  sideEffects: NO_SIDE_EFFECTS,
  confidence: NO_CONFIDENCE,
  retry: { backoffMs: [0] },
  ...brandedOverride(overrides),
});

const writesTo = (resource: string, version: string) => ({
  kind: "writes" as const,
  resource: RN(resource),
  extractConditionedOn: () => witness("version", RN(resource), "1"),
  extractNewWitness: () => witnessValue("version", version),
});

/**
 * A freshness index that fails `findConflict` exactly once for a chosen
 * resource — the transient backend blip the retriable error models.
 */
const flakyOnce = (failFor: string): FreshnessIndex => {
  const inner = new InMemoryFreshnessIndex();
  let failed = false;
  return {
    findConflict: async (w, sinceMs) => {
      if (!failed && w.resource === RN(failFor)) {
        failed = true;
        return err({
          kind: "cache-error" as const,
          operation: "findConflict",
          message: "freshness backend unavailable",
        });
      }
      return inner.findConflict(w, sinceMs);
    },
    recordWrite: (event) => inner.recordWrite(event),
  };
};

describe("retriable freshness failure — wave retry", () => {
  test("does not re-run an already-succeeded sibling's side effect, and still records the outstanding witness", async () => {
    const sideEffectRuns = { alpha: 0, beta: 0 };

    const dag = defineDag({
      id: "freshness-retry",
      nodes: {
        // Both nodes sit in wave 0, so they dispatch concurrently and a single
        // freshness abort covers both.
        alpha: makeNode("alpha", {
          sideEffects: writesTo("pg:alpha", "2"),
          run: async () => {
            sideEffectRuns.alpha += 1;
            return ok({ charged: true });
          },
        }),
        beta: makeNode("beta", {
          sideEffects: writesTo("pg:beta", "2"),
          run: async () => {
            sideEffectRuns.beta += 1;
            return ok({ notified: true });
          },
        }),
        sink: makeNode("sink"),
      },
      edges: [
        { from: DAG_INPUT, to: "alpha" },
        { from: DAG_INPUT, to: "beta" },
        { from: "alpha", to: "sink" },
        { from: "beta", to: "sink" },
      ],
      outputNodeId: "sink",
      defaultRetryLimit: 1,
    });

    const observer = new RecordingObserver();
    const ctx = makeNodeContext({ runId: R("run-fr"), dagId: D("freshness-retry"), observer });

    const result = await runDagStateful(dag, null, ctx, {
      // `beta` is witnessed second, so `alpha`'s bookkeeping has already landed
      // when the abort fires — exactly the partial-progress case.
      freshnessIndex: flakyOnce("pg:beta"),
    });

    expect(result.ok).toBe(true);

    // The critical invariant: the transient freshness blip did NOT replay a
    // side effect that had already succeeded.
    expect(sideEffectRuns.alpha).toBe(1);
    expect(sideEffectRuns.beta).toBe(1);

    // The invariant a naive "just carry the outputs" fix would have broken:
    // beta's write witness is still recorded on the retry rather than skipped
    // because beta happened to have an output already.
    const writes = observer.events.filter(
      (e): e is WriteAttemptedEvent => e.type === "write-attempted",
    );
    expect(writes.map((w) => w.nodeId).sort()).toEqual([N("alpha"), N("beta")]);
    // alpha's witness is recorded once, not re-emitted by the retry.
    expect(writes.filter((w) => w.nodeId === N("alpha"))).toHaveLength(1);
    expect(writes.filter((w) => w.nodeId === N("beta"))).toHaveLength(1);
  });
});
