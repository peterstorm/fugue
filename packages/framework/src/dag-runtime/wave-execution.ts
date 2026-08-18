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
import type { NodeDef, ValidatedNodeContext } from "../types/node.js";
import type { MintingAuthority } from "../types/capability-broker.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import { nodeId } from "../types/ids.js";
import { type Result, ok, err } from "../types/result.js";
import type { DagMachineContext, DagEvent } from "./types.js";
import { EXECUTOR_NODE_ID } from "./types.js";
import { runNodeShared } from "./run-node.js";
import { type NodeSpanOutcome, EMPTY_OUTCOME } from "./node-span.js";
import { emit } from "./emit.js";
import { fwLogger } from "../logger.js";
import { emitRoutingDecisions } from "./route-emission.js";
import type { Witness } from "../types/freshness.js";
import { type FreshnessIndex } from "./freshness-check.js";
import { emitFreshnessWitnessEvents } from "./freshness-emission.js";

/** Sentinel for wave-level invariant violations. */
const WAVE_NODE_ID: NodeId = nodeId("__wave__");

// ---------------------------------------------------------------------------
// WaveConfig — configuration object for executeWave
// ---------------------------------------------------------------------------

export interface WaveConfig {
  readonly dag: DagDef;
  readonly nodeMap: Map<NodeId, NodeDef<unknown, unknown>>;
  readonly nodeCtx: ValidatedNodeContext;
  readonly resumeCheckpoint?: Map<string, unknown>;
  readonly nowFn: () => number;
  readonly freshnessIndex: FreshnessIndex;
  readonly witnessAccumulator?: Map<string, Witness>;
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
  const { dag, nodeMap, nodeCtx, resumeCheckpoint, nowFn, freshnessIndex, witnessAccumulator, minting } = config;
  const stamp = (): Date => new Date(nowFn());

  // An out-of-bounds waveIndex is an invariant violation.
  if (waveIndex < 0 || waveIndex >= machineCtx.waves.length) {
    const message = `out-of-bounds waveIndex: ${waveIndex} (have ${machineCtx.waves.length} waves)`;
    fwLogger().error(`[executeWave] ${message}`);
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
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const crash: FrameworkError = {
          kind: "node-crash",
          nodeId,
          message: `unexpected executor error: ${message}`,
          retriability: "retriable",
          stack: e instanceof Error ? e.stack : undefined,
        };
        emit(nodeCtx, {
          type: "node-error",
          runId: nodeCtx.runId,
          dagId: dag.id,
          nodeId,
          timestamp: stamp(),
          error: message,
          frameworkError: crash,
        });
        return { nodeId, result: err(crash) as Result<unknown, FrameworkError>, outcome: EMPTY_OUTCOME };
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
        error: sibling.error.kind === "node-crash" ? sibling.error.message : JSON.stringify(sibling.error),
        frameworkError: sibling.error,
      });
    }

    const partialOutputs = new Map<NodeId, unknown>();
    for (const [id, val] of newOutputs) {
      if (!machineCtx.outputs.has(id)) {
        partialOutputs.set(id, val);
      }
    }

    const coFailedNodeIds = siblings.map((s) => s.nodeId);

    return {
      event: {
        type: "node-failed",
        nodeId: primary.nodeId,
        error: primary.error,
        partialOutputs: partialOutputs.size > 0 ? partialOutputs : undefined,
        coFailedNodeIds: coFailedNodeIds.length > 0 ? coFailedNodeIds : undefined,
      },
      outcomes,
    };
  }

  // -------------------------------------------------------------------------
  // Freshness witness emission (Phase 3)
  // -------------------------------------------------------------------------
  const skippedNodeIds = new Set<NodeId>();
  for (const nodeId of waveNodeIds) {
    if (priorOutputs.has(nodeId) || resumeCheckpoint?.has(nodeId)) {
      skippedNodeIds.add(nodeId);
    }
  }

  const postWaveCtx: PostWaveContext = {
    waveNodeIds, nodeMap, nodeCtx, machineCtx,
    dagId: dag.id, nowFn, freshnessIndex, witnessAccumulator,
    resumeCheckpoint, priorOutputs,
  };

  const freshnessResult = await emitFreshnessWitnessEvents(
    postWaveCtx, newOutputs, skippedNodeIds,
  );
  if (!freshnessResult.ok) {
    return {
      event: {
        type: "node-failed",
        nodeId: freshnessResult.error.kind === "node-crash" ? freshnessResult.error.nodeId : (waveNodeIds[0] ?? EXECUTOR_NODE_ID),
        error: freshnessResult.error,
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
    return { event: routing.earlyFailure, outcomes };
  }

  return {
    event: {
      type: "wave-done",
      wave: waveIndex,
      outputs: newOutputs,
      routingDecisions: routing.decisions,
      confidenceValues: routing.confidenceValues.size > 0 ? routing.confidenceValues : undefined,
    },
    outcomes,
  };
};
