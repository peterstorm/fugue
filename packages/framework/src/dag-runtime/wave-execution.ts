// wave-execution.ts — deep module for DAG wave dispatch.
//
// Single entry point: `executeWave(waveIndex, machineCtx, config)`.
// Owns the full lifecycle from "dispatch all wave nodes" through
// "emit freshness witnesses and routing decisions" to "produce a
// wave-done or node-failed DagEvent".
//
// Callers (buildDagExecutor) pattern-match on DagPhase and call this
// for `running` and `retrying` states. Everything else (human hooks,
// sleep/jitter) stays in the executor.
//
// Requirement → ADR cross-reference:
//   FR-005  → ADR-0003 (event sourcing, checkpoint after every wave)
//   FR-021  → ADR-0021 (single-path runtime, wave-based execution)
//   FR-025  → ADR-0025 (freshness witness emission post-wave, fail-closed)
//   FR-029  → ADR-0029 (routing decisions pre-computed by executor, carried on wave-done)

import type { DagDef } from "../types/dag.js";
import type { Capability, NodeDef, ValidatedNodeContext } from "../types/node.js";
import type { MintingAuthority } from "../types/capability-broker.js";
import { messageOf, asNodeFrameworkError, type FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import { nodeId } from "../types/ids.js";
import { type Result, ok, err } from "../types/result.js";
import type { DagMachineContext, DagEvent } from "./types.js";
import { EXECUTOR_NODE_ID } from "./types.js";
import { runNodeShared } from "./run-node.js";
import { type NodeSpanOutcome, EMPTY_OUTCOME } from "./node-span.js";
import { emit } from "./emit.js";
import { bestEffortLog } from "./best-effort.js";
import { emitRoutingDecisions } from "./route-emission.js";
import { type FreshnessIndex } from "./freshness-check.js";
import { emitFreshnessWitnessEvents } from "./freshness-emission.js";

/** Sentinel for wave-level invariant violations. */
const WAVE_NODE_ID: NodeId = nodeId("__wave__");

/**
 * THE one "which of this wave's outputs are new" computation, shared by every
 * failure branch that must carry succeeded siblings forward so a retry does not
 * re-execute their side effects.
 */
const carriedOutputs = (
  newOutputs: ReadonlyMap<NodeId, unknown>,
  alreadyInContext: ReadonlyMap<NodeId, unknown>,
): ReadonlyMap<NodeId, unknown> => {
  const carried = new Map<NodeId, unknown>();
  for (const [id, val] of newOutputs) {
    if (!alreadyInContext.has(id)) carried.set(id, val);
  }
  return carried;
};

/** `node-failed.partialOutputs` is absent, never empty — one encoding of "none". */
const sizedOrUndefined = (
  outputs: ReadonlyMap<NodeId, unknown>,
): ReadonlyMap<NodeId, unknown> | undefined => (outputs.size > 0 ? outputs : undefined);

// ---------------------------------------------------------------------------
// WaveConfig — configuration object for executeWave
// ---------------------------------------------------------------------------

export interface WaveConfig {
  readonly dag: DagDef;
  readonly nodeMap: Map<
    NodeId,
    NodeDef<unknown, unknown, FrameworkError, readonly Capability[]>
  >;
  readonly nodeCtx: ValidatedNodeContext;
  readonly resumeCheckpoint?: Map<string, unknown>;
  readonly nowFn: () => number;
  readonly freshnessIndex: FreshnessIndex;
  /** Per-invocation minting authority (broker + origin) — resolves each node's `requires` at dispatch. */
  readonly minting?: MintingAuthority;
}

/**
 * Per-wave-invocation context assembled at the top of `executeWave`.
 * Concentrates everything the post-dispatch pipeline (freshness + routing)
 * needs into one object, eliminating 10-param / 7-param positional calls.
 */
import type { PostWaveContext } from "./post-wave-context.js";

interface WaveResult {
  readonly event: DagEvent;
  readonly outcomes: readonly NodeSpanOutcome[];
}

// ---------------------------------------------------------------------------
// executeWave — run all nodes in a wave concurrently; return wave-done or node-failed
// ---------------------------------------------------------------------------

/**
 * Execute all active nodes in a wave concurrently, then:
 * 1. Collect outputs and detect failures
 * 2. Emit freshness witness events for reads/writes nodes
 * 3. Compute routing decisions for conditional out-edges
 * 4. Return wave-done (success) or node-failed (first failure)
 *
 * Returns both the event AND the per-node outcomes so the caller can fold
 * them into run-level meta without a callback.
 */
export const executeWave = async (
  waveIndex: number,
  machineCtx: DagMachineContext,
  config: WaveConfig,
): Promise<WaveResult> => {
  const { dag, nodeMap, nodeCtx, resumeCheckpoint, nowFn, freshnessIndex, minting } = config;
  const stamp = (): Date => new Date(nowFn());

  // An out-of-bounds waveIndex is an invariant violation.
  if (waveIndex < 0 || waveIndex >= machineCtx.waves.length) {
    const message = `out-of-bounds waveIndex: ${waveIndex} (have ${machineCtx.waves.length} waves)`;
    bestEffortLog("error", `[executeWave] ${message}`);
    return {
      event: {
        type: "node-failed",
        nodeId: WAVE_NODE_ID,
        error: { kind: "node-crash", nodeId: WAVE_NODE_ID, message, retriability: "non-retriable" },
      },
      outcomes: [],
    };
  }

  const allWaveNodeIds = machineCtx.waves[waveIndex] ?? [];
  const waveNodeIds = allWaveNodeIds.filter((id) => machineCtx.activeNodeIds.has(id));

  // Snapshot prior-wave outputs so concurrent nodes in this wave can't
  // observe each other's results mid-execution.
  const priorOutputs: ReadonlyMap<NodeId, unknown> = machineCtx.outputs;
  // Durable resource→latest-witness projection. Freshness emission mutates this
  // invocation-local copy; the resulting event moves it into the pure transition.
  const priorWitnesses = new Map(machineCtx.priorWitnesses);

  // Run all wave nodes concurrently
  const settled = await Promise.all(
    waveNodeIds.map(async (nodeId) => {
      try {
        // Skip nodes already successfully completed in this wave
        if (priorOutputs.has(nodeId)) {
          emit(nodeCtx, {
            type: "node-skipped",
            runId: nodeCtx.runId,
            dagId: dag.id,
            nodeId,
            timestamp: stamp(),
            reason: "already-completed",
          });
          return {
            nodeId,
            result: ok(priorOutputs.get(nodeId)) as Result<unknown, FrameworkError>,
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
              retriability: "non-retriable" as const,
            }) as Result<unknown, FrameworkError>,
            outcome: EMPTY_OUTCOME,
          };
        }

        const incoming = machineCtx.incomingByNode.get(nodeId) ?? { required: [], optional: [] };
        const { result, outcome } = await runNodeShared(
          node,
          nodeCtx,
          dag.id,
          priorOutputs,
          incoming,
          { checkpoint: resumeCheckpoint, now: nowFn, minting },
        );
        return { nodeId, result, outcome };
      } catch (caught) {
        const frameworkError = asNodeFrameworkError(caught, nodeId);
        emit(nodeCtx, {
          type: "node-error",
          runId: nodeCtx.runId,
          dagId: dag.id,
          nodeId,
          timestamp: stamp(),
          error: messageOf(frameworkError),
          frameworkError,
        });
        return {
          nodeId,
          result: err(frameworkError) as Result<unknown, FrameworkError>,
          outcome: EMPTY_OUTCOME,
        };
      }
    }),
  );

  const outcomes = settled.map((s) => s.outcome);
  const results = settled.map(({ nodeId, result }) => ({ nodeId, result }));

  // Collect new outputs + check for failures.
  const newOutputs = new Map<NodeId, unknown>();
  const failures: Array<{ nodeId: NodeId; error: FrameworkError }> = [];

  for (const { nodeId, result } of results) {
    if (result.ok) {
      newOutputs.set(nodeId, result.value);
    } else {
      failures.push({ nodeId, error: result.error });
    }
  }

  if (failures.length > 0) {
    const [primary, ...siblings] = failures as [{ nodeId: NodeId; error: FrameworkError }, ...{ nodeId: NodeId; error: FrameworkError }[]];

    for (const sibling of siblings) {
      emit(nodeCtx, {
        type: "node-error",
        runId: nodeCtx.runId,
        dagId: dag.id,
        nodeId: sibling.nodeId,
        sideEffects: nodeMap.get(sibling.nodeId)?.sideEffects,
        timestamp: stamp(),
        error: messageOf(sibling.error),
        frameworkError: sibling.error,
      });
    }

    const partialOutputs = carriedOutputs(newOutputs, machineCtx.outputs);

    const coFailedNodeIds = siblings.map((s) => s.nodeId);

    return {
      event: {
        type: "node-failed",
        nodeId: primary.nodeId,
        error: primary.error,
        partialOutputs: sizedOrUndefined(partialOutputs),
        coFailedNodeIds: coFailedNodeIds.length > 0 ? coFailedNodeIds : undefined,
      },
      outcomes,
    };
  }

  // -------------------------------------------------------------------------
  // Freshness witness emission (Phase 3)
  // -------------------------------------------------------------------------
  // A node is owed NO witness emission only when this executor has proof that
  // its bookkeeping completed. A node-output checkpoint proves only that the
  // node result was persisted: `runNodeShared` writes it BEFORE this post-wave
  // step, so a crash in that window must resume the owed freshness work.
  // Deliberately NOT `priorOutputs.has(id)` either: a node carried across a wave
  // retry has an output but may still owe its witness (ADR-0025).
  const skippedNodeIds = new Set<NodeId>(machineCtx.freshnessCompletedNodeIds);

  const postWaveCtx: PostWaveContext = {
    waveNodeIds, nodeMap, nodeCtx, machineCtx,
    dagId: dag.id, nowFn, freshnessIndex, witnessAccumulator: priorWitnesses,
  };

  const freshness = await emitFreshnessWitnessEvents(
    postWaveCtx, newOutputs, skippedNodeIds,
  );
  // Record progress BEFORE branching: an abort's completed prefix must survive
  // into the retry on exactly the same terms as a completed wave's. The set is
  // carried as event data and folded by the pure transition; no executor-local
  // mutation owns durable authority.
  const freshnessCompletedNodeIds = new Set(machineCtx.freshnessCompletedNodeIds);
  for (const id of freshness.witnessed) freshnessCompletedNodeIds.add(id);
  if (freshness.kind === "aborted") {
    const { error } = freshness;
    return {
      event: {
        type: "node-failed",
        nodeId: error.kind === "node-crash" ? error.nodeId : (waveNodeIds[0] ?? EXECUTOR_NODE_ID),
        error,
        // Same carry as the in-dispatch failure path: every node in this wave
        // already ran its side effect successfully, so a retry must not
        // re-execute them. Freshness bookkeeping is what the retry re-attempts,
        // and the durable completion set tells it which nodes still owe it.
        partialOutputs: sizedOrUndefined(carriedOutputs(newOutputs, machineCtx.outputs)),
        priorWitnesses,
        freshnessCompletedNodeIds,
      },
      outcomes,
    };
  }

  // -------------------------------------------------------------------------
  // Routing decisions
  // -------------------------------------------------------------------------
  const routing = emitRoutingDecisions(
    postWaveCtx, newOutputs,
  );
  if (routing.earlyFailure) {
    return {
      event: { ...routing.earlyFailure, priorWitnesses, freshnessCompletedNodeIds },
      outcomes,
    };
  }

  return {
    event: {
      type: "wave-done",
      wave: waveIndex,
      outputs: newOutputs,
      routingDecisions: routing.decisions,
      confidenceValues: routing.confidenceValues.size > 0 ? routing.confidenceValues : undefined,
      priorWitnesses,
      freshnessCompletedNodeIds,
    },
    outcomes,
  };
};
