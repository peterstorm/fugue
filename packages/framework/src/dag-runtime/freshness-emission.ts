// emitFreshnessWitnessEvents — Phase 3: freshness witness emission
//
// Extracted from executor.ts for readability. Event-emission helper
// decoupled from the executor closure. Performs I/O via FreshnessIndex port.
//
// After all nodes in a wave succeed, emit witness events for reads and writes
// nodes. For writes nodes, check the freshness index for conflicts BEFORE the
// write's witness is recorded — so the conflict detection sees the state as
// of write time.

import { match } from "ts-pattern";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { NodeId, DagId } from "../types/ids.js";
import type { Witness } from "../types/freshness.js";
import type { DagMachineContext } from "./types.js";
import { type FreshnessIndex } from "./freshness-check.js";
import { fwLogger } from "../logger.js";
import { buildNodeInput } from "../shared/build-input.js";
import { emit } from "./emit.js";

export const emitFreshnessWitnessEvents = async (
  waveNodeIds: readonly NodeId[],
  newOutputs: ReadonlyMap<NodeId, unknown>,
  nodeMap: ReadonlyMap<NodeId, NodeDef<unknown, unknown>>,
  machineCtx: DagMachineContext,
  nodeCtx: NodeContext,
  dagId: DagId,
  nowFn: () => number,
  freshnessIndex: FreshnessIndex,
  skippedNodeIds: ReadonlySet<NodeId>,
  witnessAccumulator?: Map<string, Witness>,
): Promise<void> => {
  const stamp = (): Date => new Date(nowFn());
  const priorOutputs = machineCtx.outputs;

  for (const nodeId of waveNodeIds) {
    // Skip nodes that didn't actually execute (checkpoint-resumed or
    // already-completed from a prior wave). Their outputs are in newOutputs
    // for the wave-done event, but freshness witnesses should only be
    // emitted for nodes that actually performed I/O.
    if (!newOutputs.has(nodeId) || skippedNodeIds.has(nodeId)) continue;
    const nodeDef = nodeMap.get(nodeId);
    if (!nodeDef) continue;

    const output = newOutputs.get(nodeId);
    const se = nodeDef.sideEffects;

    await match(se)
      .with({ kind: "reads" }, async (se) => {
        if (!se.extractWitness) return;
        try {
          const witness: Witness = se.extractWitness(output);
          emit(nodeCtx, {
            type: "witness-captured",
            runId: nodeCtx.runId,
            dagId,
            nodeId,
            witness,
            capturedAtMs: nowFn(),
            timestamp: stamp(),
          });
          witnessAccumulator?.set(witness.resource, witness);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          fwLogger().warn(
            `[emitFreshnessWitnessEvents] extractWitness failed for node '${nodeId}': ${msg}`,
          );
          emit(nodeCtx, {
            type: "node-error",
            runId: nodeCtx.runId,
            dagId,
            nodeId,
            sideEffects: nodeMap.get(nodeId)?.sideEffects,
            timestamp: stamp(),
            error: `extractWitness failed: ${msg}`,
            frameworkError: { kind: "node-crash", nodeId, retriability: "non-retriable", message: `extractWitness threw: ${msg}` },
          });
        }
      })
      .with({ kind: "writes" }, async (se) => {
        if (!se.extractConditionedOn || !se.extractNewWitness) return;

        // Step 1: Rebuild the node's input via the shared helper
        let nodeInput: unknown;
        try {
          const incoming = machineCtx.incomingByNode.get(nodeId) ?? { required: [], optional: [] };
          nodeInput = buildNodeInput(machineCtx.initialInput, priorOutputs, incoming);
        } catch (e) {
          const message = `BUG: input reconstruction failed for writes node '${nodeId}': ${e instanceof Error ? e.message : e}`;
          fwLogger().error(`[emitFreshnessWitnessEvents] ${message}`);
          emit(nodeCtx, {
            type: "node-error",
            runId: nodeCtx.runId,
            dagId,
            nodeId,
            sideEffects: nodeMap.get(nodeId)?.sideEffects,
            timestamp: stamp(),
            error: message,
            frameworkError: { kind: "node-crash", nodeId, retriability: "non-retriable", message },
          });
          return;
        }

        // Step 2: User-provided extractors
        let conditionedOn: Witness;
        let newWitness: Witness;
        try {
          conditionedOn = se.extractConditionedOn(nodeInput);
          newWitness = se.extractNewWitness(output);
        } catch (e) {
          fwLogger().warn(
            `[emitFreshnessWitnessEvents] extractConditionedOn/extractNewWitness failed for node '${nodeId}': ${e instanceof Error ? e.message : e}`,
          );
          return;
        }

        // Step 3: Freshness conflict check + event emission
        // sinceMs: 0 is intentional — within a run, all prior writes are relevant
        // because topological ordering guarantees the read witness was captured
        // before any writes in later waves.
        let conflict: Awaited<ReturnType<typeof freshnessIndex.findConflict>> | null = null;
        try {
          conflict = await freshnessIndex.findConflict(
            conditionedOn.resource,
            conditionedOn.value,
            0,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          fwLogger().error(
            `[emitFreshnessWitnessEvents] freshnessIndex.findConflict failed for node '${nodeId}', resource '${conditionedOn.resource}': ${msg}`,
          );
          emit(nodeCtx, {
            type: "node-error",
            runId: nodeCtx.runId,
            dagId,
            nodeId,
            sideEffects: nodeMap.get(nodeId)?.sideEffects,
            timestamp: stamp(),
            error: `freshness conflict check failed (assumed conflict): ${msg}`,
            frameworkError: { kind: "node-crash", nodeId, retriability: "retriable", message: `freshness check unavailable: ${msg}` },
          });
          // Fail-closed: treat as conflict to prevent stale writes through
          conflict = { runId: nodeCtx.runId, nodeId, newWitness: conditionedOn, succeededAtMs: 0 };
        }
        if (conflict) {
          emit(nodeCtx, {
            type: "freshness-violation",
            runId: nodeCtx.runId,
            dagId,
            nodeId,
            resource: conditionedOn.resource,
            conditionedOnWitness: conditionedOn,
            conflictingWrite: {
              runId: conflict.runId,
              nodeId: conflict.nodeId,
              newWitness: conflict.newWitness,
              succeededAtMs: conflict.succeededAtMs,
            },
            detectedAtMs: nowFn(),
            timestamp: stamp(),
          });
        }

        const writeEvent = {
          type: "write-attempted" as const,
          runId: nodeCtx.runId,
          dagId,
          nodeId,
          conditionedOn,
          newWitness,
          succeededAtMs: nowFn(),
          timestamp: stamp(),
        };
        emit(nodeCtx, writeEvent);
        try {
          await freshnessIndex.recordWrite(writeEvent);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          fwLogger().error(
            `[emitFreshnessWitnessEvents] freshnessIndex.recordWrite failed for node '${nodeId}': ${msg}`,
          );
          emit(nodeCtx, {
            type: "node-error",
            runId: nodeCtx.runId,
            dagId,
            nodeId,
            sideEffects: nodeMap.get(nodeId)?.sideEffects,
            timestamp: stamp(),
            error: `freshness recordWrite failed: ${msg}`,
            frameworkError: { kind: "node-crash", nodeId, retriability: "retriable", message: `freshness recordWrite failed: ${msg}` },
          });
        }
      })
      .with({ kind: "none" }, () => { /* pure transform — no freshness tracking */ })
      .with({ kind: "external-call" }, () => { /* external calls don't participate in witness contract */ })
      .exhaustive();
  }
};
