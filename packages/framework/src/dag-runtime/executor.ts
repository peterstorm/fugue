// buildDagExecutor — DAG executor closure
// FR-025: validate inputs/outputs; FR-027: exponential backoff with jitter
// Returns an Executor<DagPhase, DagMachineContext, DagEvent> that runs one wave per call.

import { match } from "ts-pattern";
import type { Executor } from "../state-machine/types.js";
import type { DagPhase, DagEvent, DagMachineContext } from "./types.js";
import type { DagDef } from "../types/dag.js";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { ObserverEvent } from "../types/events.js";
import type { Observer } from "../observer/observer.js";
import { type Result, ok, err } from "../types/result.js";
import { runNodeShared } from "../shared/run-node.js";
import { type NodeSpanOutcome } from "../shared/node-span.js";
import { applyJitter } from "../shared/jitter.js";
import { dispatchEvent } from "../observer/buffered.js";
import { decideRoute, outgoingOf } from "./conditional.js";
import { isConditionalEdge } from "../types/dag.js";

const EMPTY_OUTCOME: NodeSpanOutcome = { guardrailFailed: false, guardrailWarnings: [] };

// ---------------------------------------------------------------------------
// Observer helper
// ---------------------------------------------------------------------------

const emit = (ctx: NodeContext, event: ObserverEvent): void => {
  if (ctx.observer) {
    dispatchEvent(ctx.observer as Observer, event);
  }
};

// ---------------------------------------------------------------------------
// Backoff + jitter (FR-027)
// ---------------------------------------------------------------------------

const DEFAULT_JITTER_RATIO = 0.2;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// approve-with-edit validation (Wave 2 §2.5)
//
// Returns `null` on success, an error message on failure. Validation runs in
// the imperative shell because the pure transition layer can't depend on a
// live Zod schema (on resume, deserialized schemas are inert).
// ---------------------------------------------------------------------------

const validateApproveEdit = (
  action: import("./types.js").HumanAction,
  nodeId: string,
  nodeMap: Map<string, NodeDef<unknown, unknown, unknown>>,
): string | null => {
  if (action.action !== "approve-with-edit") return null;
  const nodeDef = nodeMap.get(nodeId);
  if (!nodeDef) {
    return `approve-with-edit: node '${nodeId}' not found in DAG`;
  }
  const parsed = nodeDef.outputSchema.safeParse(action.newOutput);
  if (!parsed.success) {
    return `approve-with-edit output failed schema for node '${nodeId}': ${parsed.error.message}`;
  }
  return null;
};


// ---------------------------------------------------------------------------
// buildDagExecutor — FR-027 applied when state.kind === "retrying"
// ---------------------------------------------------------------------------

/**
 * Builds an Executor closure for a DAG. The executor:
 * 1. If state is `retrying`: sleeps for `nextDelayMs * jitter` then re-runs the
 *    failed node. Returns `wave-done` (if all nodes in the wave now pass) or
 *    `node-failed`.
 * 2. If state is `pending`: returns a `start` event (drives first transition).
 * 3. If state is `running`: runs the full wave via Promise.all, returns
 *    `wave-done` or `node-failed` for the first failure.
 * 4. If state is `awaiting-human` and `onHumanReview` is supplied: dispatches
 *    the hook, returns `human-responded`.
 *
 * The executor never performs state transitions — it only produces DagEvents.
 * Observer events (node-start, node-end, node-error, run-start, run-end) are
 * emitted to preserve the existing observable behavior (AD-2).
 */
export const buildDagExecutor = (
  dag: DagDef,
  nodeCtx: NodeContext,
  hooks?: {
    onHumanReview?: (req: {
      nodeId: string;
      output: unknown;
      prompt: string;
    }) => Promise<import("./types.js").HumanAction>;
    /** Called once per wave with the per-node outcomes; the caller folds them into run-level meta. */
    recordOutcomes?: (outcomes: readonly NodeSpanOutcome[]) => void;
    /**
     * Wave 7 §7.3 — crash-resume checkpoint. When provided, nodes whose ids
     * appear in this Map are skipped via `runNodeShared`'s checkpoint path
     * (validated against `outputSchema`, observer sees `node-skipped` with
     * `reason: "checkpoint"`).
     */
    resumeCheckpoint?: Map<string, unknown>;
    /**
     * Wave 7 §7.6 — RNG seam for retry-backoff jitter. Defaults to
     * `Math.random`; tests pass a seeded deterministic source.
     */
    random?: () => number;
  },
): Executor<DagPhase, DagMachineContext, DagEvent> => {
  const nodeMap = new Map<string, NodeDef<unknown, unknown, unknown>>(
    dag.nodes.map((n) => [n.id, n]),
  );
  const recordOutcomes = hooks?.recordOutcomes;
  const resumeCheckpoint = hooks?.resumeCheckpoint;
  const random = hooks?.random ?? Math.random;

  return async (phase: DagPhase, machineCtx: DagMachineContext): Promise<DagEvent> =>
    match(phase)
      // -----------------------------------------------------------------------
      // pending: just need to fire the first transition
      // -----------------------------------------------------------------------
      .with({ kind: "pending" }, () => ({ type: "start" } as DagEvent))

      // -----------------------------------------------------------------------
      // retrying: sleep with jitter then re-run the failing node in its wave
      // FR-027: delay = nextDelayMs * (1 + jitterRatio * random)
      // -----------------------------------------------------------------------
      .with({ kind: "retrying" }, async (p) => {
        const nodeDef = nodeMap.get(p.nodeId);
        const jitterRatio = nodeDef?.retry?.jitterRatio ?? DEFAULT_JITTER_RATIO;
        const delayWithJitter = applyJitter(p.nextDelayMs, jitterRatio, random);
        await sleep(delayWithJitter);

        // Re-run the whole wave (other nodes in the wave may have already
        // succeeded on previous attempt; outputs are in machineCtx.outputs).
        // We only re-run the failed node, then run the rest that haven't completed yet.
        return runWave(p.wave, machineCtx, dag, nodeMap, nodeCtx, recordOutcomes, resumeCheckpoint);
      })

      // -----------------------------------------------------------------------
      // running: run the current wave
      // -----------------------------------------------------------------------
      .with({ kind: "running" }, (p) => runWave(p.wave, machineCtx, dag, nodeMap, nodeCtx, recordOutcomes, resumeCheckpoint))

      // -----------------------------------------------------------------------
      // awaiting-human: dispatch the review hook
      // -----------------------------------------------------------------------
      .with({ kind: "awaiting-human" }, async (p) => {
        if (!hooks?.onHumanReview) {
          // No hook registered — the DAG would be stuck. Surface an error.
          return {
            type: "node-failed",
            nodeId: p.nodeId,
            error: {
              kind: "node-crash",
              nodeId: p.nodeId,
              message: "awaiting-human: no onHumanReview hook supplied",
            },
          } satisfies DagEvent;
        }

        let action: import("./types.js").HumanAction;
        try {
          action = await hooks.onHumanReview({
            nodeId: p.nodeId,
            output: p.output,
            prompt: p.prompt,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          const stack = e instanceof Error ? e.stack : undefined;
          emit(nodeCtx, {
            type: "node-error",
            runId: nodeCtx.runId,
            dagId: dag.id,
            nodeId: p.nodeId,
            timestamp: new Date(),
            error: message,
            stack,
          });
          return {
            type: "node-failed",
            nodeId: p.nodeId,
            error: { kind: "node-crash", nodeId: p.nodeId, message, stack },
          } satisfies DagEvent;
        }

        // Wave 2 §2.5: validate `approve-with-edit` output against the node's
        // outputSchema before writing it into ctx.outputs. The transition layer
        // is pure and cannot run validation (schemas may not survive resume
        // serialization); validation belongs in the imperative shell where
        // nodeMap holds the live Zod schema.
        const validationFailure = validateApproveEdit(action, p.nodeId, nodeMap);
        if (validationFailure !== null) {
          emit(nodeCtx, {
            type: "node-error",
            runId: nodeCtx.runId,
            dagId: dag.id,
            nodeId: p.nodeId,
            timestamp: new Date(),
            error: validationFailure,
          });
          return {
            type: "node-failed",
            nodeId: p.nodeId,
            error: {
              kind: "validation",
              nodeId: p.nodeId,
              message: validationFailure,
            },
          } satisfies DagEvent;
        }

        return {
          type: "human-responded",
          nodeId: p.nodeId,
          action,
        } satisfies DagEvent;
      })

      // -----------------------------------------------------------------------
      // retrying-hook: sleep with jitter then re-call the onHumanReview hook.
      // The node is NOT re-run — only the hook is retried (FR-029a).
      // -----------------------------------------------------------------------
      .with({ kind: "retrying-hook" }, async (p) => {
        const nodeDef = nodeMap.get(p.nodeId);
        const jitterRatio = nodeDef?.retry?.jitterRatio ?? DEFAULT_JITTER_RATIO;
        const delayWithJitter = applyJitter(p.nextDelayMs, jitterRatio, random);
        await sleep(delayWithJitter);

        if (!hooks?.onHumanReview) {
          return {
            type: "node-failed",
            nodeId: p.nodeId,
            error: {
              kind: "node-crash",
              nodeId: p.nodeId,
              message: "retrying-hook: no onHumanReview hook supplied",
            },
          } satisfies DagEvent;
        }

        let action: import("./types.js").HumanAction;
        try {
          action = await hooks.onHumanReview({
            nodeId: p.nodeId,
            output: p.output,
            prompt: p.prompt,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          const stack = e instanceof Error ? e.stack : undefined;
          emit(nodeCtx, {
            type: "node-error",
            runId: nodeCtx.runId,
            dagId: dag.id,
            nodeId: p.nodeId,
            timestamp: new Date(),
            error: message,
            stack,
          });
          return {
            type: "node-failed",
            nodeId: p.nodeId,
            error: { kind: "node-crash", nodeId: p.nodeId, message, stack },
          } satisfies DagEvent;
        }

        // Wave 2 §2.5: same validation as the awaiting-human path. Hook
        // retries can also produce approve-with-edit; the reviewer's edited
        // output must conform to the node's schema before reaching ctx.outputs.
        const validationFailure = validateApproveEdit(action, p.nodeId, nodeMap);
        if (validationFailure !== null) {
          emit(nodeCtx, {
            type: "node-error",
            runId: nodeCtx.runId,
            dagId: dag.id,
            nodeId: p.nodeId,
            timestamp: new Date(),
            error: validationFailure,
          });
          return {
            type: "node-failed",
            nodeId: p.nodeId,
            error: {
              kind: "validation",
              nodeId: p.nodeId,
              message: validationFailure,
            },
          } satisfies DagEvent;
        }

        return {
          type: "human-responded",
          nodeId: p.nodeId,
          action,
        } satisfies DagEvent;
      })

      // -----------------------------------------------------------------------
      // Terminal states — unreachable per runner's isTerminal guard.
      // Throw to surface the invariant violation.
      // -----------------------------------------------------------------------
      .with({ kind: "succeeded" }, () => {
        throw new Error("buildDagExecutor: unreachable — terminal succeeded");
      })
      .with({ kind: "failed" }, () => {
        throw new Error("buildDagExecutor: unreachable — terminal failed");
      })
      .exhaustive();
};

// ---------------------------------------------------------------------------
// runWave — run all nodes in a wave concurrently; return wave-done or node-failed
// ---------------------------------------------------------------------------

const runWave = async (
  waveIndex: number,
  machineCtx: DagMachineContext,
  dag: DagDef,
  nodeMap: Map<string, NodeDef<unknown, unknown, unknown>>,
  nodeCtx: NodeContext,
  recordOutcomes: ((outcomes: readonly NodeSpanOutcome[]) => void) | undefined,
  resumeCheckpoint: Map<string, unknown> | undefined,
): Promise<DagEvent> => {
  // Filter to active nodes only. Pruned nodes are silently skipped — they
  // did not fire on this routing decision; downstream consumers that list
  // them as `optional` sources in `incomingByNode` see `undefined`.
  const allWaveNodeIds = machineCtx.waves[waveIndex] ?? [];
  const waveNodeIds = allWaveNodeIds.filter((id) => machineCtx.activeNodeIds.has(id));

  // Build a mutable outputs map for this wave execution.
  // Pre-seed with existing outputs so deps from earlier waves resolve.
  const outputs = new Map<string, unknown>(machineCtx.outputs);

  // Run all wave nodes concurrently
  const settled = await Promise.all(
    waveNodeIds.map(async (nodeId) => {
      // Skip nodes already successfully completed in this wave
      // (they already appear in machineCtx.outputs with correct values)
      if (machineCtx.outputs.has(nodeId)) {
        // Already have output — re-emit node-skipped for observability
        emit(nodeCtx, {
          type: "node-skipped",
          runId: nodeCtx.runId,
          dagId: dag.id,
          nodeId,
          timestamp: new Date(),
          reason: "already-completed",
        });
        return {
          nodeId,
          result: ok(machineCtx.outputs.get(nodeId)) as Result<unknown, FrameworkError>,
          outcome: EMPTY_OUTCOME,
        };
      }

      const node = nodeMap.get(nodeId);
      if (!node) {
        return {
          nodeId,
          result: err({
            kind: "node-crash" as const,
            nodeId,
            message: `node-not-found: ${nodeId}`,
          }) as Result<unknown, FrameworkError>,
          outcome: EMPTY_OUTCOME,
        };
      }

      const incoming = machineCtx.incomingByNode.get(nodeId) ?? { required: [], optional: [] };
      const { result, outcome } = await runNodeShared(
        node,
        machineCtx.initialInput,
        nodeCtx,
        dag.id,
        outputs,
        incoming,
        { checkpoint: resumeCheckpoint, writeCheckpoint: true },
      );
      return { nodeId, result, outcome };
    }),
  );

  // Fold this wave's outcomes into run-level meta after Promise.all.
  if (recordOutcomes) {
    recordOutcomes(settled.map((s) => s.outcome));
  }

  // Preserve the previous local name to keep the rest of the function unchanged.
  const results = settled.map(({ nodeId, result }) => ({ nodeId, result }));

  // Collect new outputs + check for failures.
  // - Collect all succeeded sibling outputs before returning the first failure,
  //   so they can be persisted into ctx.outputs and skipped on retry.
  // - Collect ALL failures (not just the first) so co-failed siblings get their
  //   retry counters pre-incremented, preventing off-by-one retry accounting.
  const newOutputs = new Map<string, unknown>();
  const failures: Array<{ nodeId: string; error: FrameworkError }> = [];

  for (const { nodeId, result } of results) {
    if (result.ok) {
      newOutputs.set(nodeId, result.value);
    } else {
      failures.push({ nodeId, error: result.error });
    }
  }

  if (failures.length > 0) {
    const [primary, ...siblings] = failures as [{ nodeId: string; error: FrameworkError }, ...{ nodeId: string; error: FrameworkError }[]];

    // Emit node-error for each sibling failure beyond the primary so operators can observe them.
    for (const sibling of siblings) {
      emit(nodeCtx, {
        type: "node-error",
        runId: nodeCtx.runId,
        dagId: dag.id,
        nodeId: sibling.nodeId,
        timestamp: new Date(),
        error: sibling.error.kind === "node-crash" ? sibling.error.message : JSON.stringify(sibling.error),
      });
    }

    // Build partialOutputs: succeeded siblings (excludes already-known outputs from prior waves
    // since those are already in machineCtx.outputs; only new outputs from this wave execution).
    const partialOutputs = new Map<string, unknown>();
    for (const [id, val] of newOutputs) {
      if (!machineCtx.outputs.has(id)) {
        partialOutputs.set(id, val);
      }
    }

    const coFailedNodeIds = siblings.map((s) => s.nodeId);

    return {
      type: "node-failed",
      nodeId: primary.nodeId,
      error: primary.error,
      partialOutputs: partialOutputs.size > 0 ? partialOutputs : undefined,
      coFailedNodeIds: coFailedNodeIds.length > 0 ? coFailedNodeIds : undefined,
    };
  }

  // Emit observer events for routing decisions taken in this wave. The
  // transition layer recomputes the same decisions to update activeNodeIds —
  // both calls are deterministic because guards are pure.
  //
  // Wave 3 §3.6: when `decideRoute` returns `predicate-malformed`, short-
  // circuit the wave with `node-failed` instead of letting it fall through to
  // `wave-done` (which previously produced the confusing observer sequence
  // node-error → wave-done → failed). `handleNodeFailed` special-cases the
  // `predicate-malformed` error kind to fail-fast without consuming the
  // retry budget — a malformed predicate is a config error, not a transient
  // runtime failure.
  for (const nodeId of waveNodeIds) {
    if (!newOutputs.has(nodeId)) continue;
    const outgoing = outgoingOf(dag, nodeId);
    if (!outgoing.some(isConditionalEdge)) continue;
    const decision = decideRoute(nodeId, newOutputs.get(nodeId), outgoing);
    if (decision.kind === "predicate-malformed") {
      emit(nodeCtx, {
        type: "node-error",
        runId: nodeCtx.runId,
        dagId: dag.id,
        nodeId,
        timestamp: new Date(),
        error: `predicate-malformed: ${decision.message}`,
      });
      return {
        type: "node-failed",
        nodeId,
        error: {
          kind: "predicate-malformed",
          nodeId: decision.fromNodeId,
          message: decision.message,
        },
      };
    }
    emit(nodeCtx, {
      type: "route-decided",
      runId: nodeCtx.runId,
      dagId: dag.id,
      fromNodeId: nodeId,
      chosenTargets: [...decision.chosenTargets],
      prunedTargets: [...decision.prunedTargets],
      defaultTaken: decision.defaultTaken,
      matchedPredicate: decision.matchedPredicate,
      timestamp: new Date(),
    });
    for (const pruned of decision.prunedTargets) {
      emit(nodeCtx, {
        type: "node-pruned",
        runId: nodeCtx.runId,
        dagId: dag.id,
        nodeId: pruned,
        reason: "branch-not-taken",
        timestamp: new Date(),
      });
    }
  }

  return {
    type: "wave-done",
    wave: waveIndex,
    outputs: newOutputs,
  };
};
