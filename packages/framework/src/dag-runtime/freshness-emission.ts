// emitFreshnessWitnessEvents — freshness witness emission.
//
// After all nodes in a wave succeed, emit witness events for reads and writes
// nodes. For writes nodes, check the freshness index for conflicts BEFORE the
// write's witness is recorded — so the conflict detection sees the state as
// of write time.
//
// Fail-closed (ADR-0025): if any extractor throws OR the freshness index is
// unavailable, the wave aborts. Synthesizing a fake conflict or proceeding
// silently would allow undetectable stale writes.

import { match } from "ts-pattern";
import type { NodeId } from "../types/ids.js";
import type { Witness } from "../types/freshness.js";
import { stampWitness } from "../types/freshness.js";
import type { FrameworkError } from "../types/errors.js";
import { type Result, ok, err } from "../types/result.js";
import { fwLogger } from "../logger.js";
import { formatFrameworkError } from "../types/errors.js";
import { buildNodeInput } from "../shared/build-input.js";
import { emit } from "./emit.js";
import type { PostWaveContext } from "./wave-execution.js";

/**
 * Emit freshness witness events for all reads/writes nodes in a wave.
 *
 * Fail-closed: extractor failures surface as `Err` and abort the wave.
 * The authoring bug (broken extractor) must be fixed before the DAG
 * can proceed — silently proceeding would allow downstream writes nodes
 * to operate without the witness data they need for conflict detection.
 */
export async function emitFreshnessWitnessEvents(
  ctx: PostWaveContext,
  newOutputs: ReadonlyMap<NodeId, unknown>,
  skippedNodeIds: ReadonlySet<NodeId>,
): Promise<Result<void, FrameworkError>> {
  const { waveNodeIds, nodeMap, nodeCtx, machineCtx, dagId, nowFn, freshnessIndex, witnessAccumulator } = ctx;
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

    const branchResult = await match(se)
      .returnType<Promise<Result<void, FrameworkError>>>()
      .with({ kind: "reads" }, async (se) => {
        if (!se.extractWitness) return ok(undefined);
        try {
          // The extractor returns only (kind, value); stamp this node's
          // resource so the witness can never name a different resource.
          const capturedWitness: Witness = stampWitness(se.resource, se.extractWitness(output));
          emit(nodeCtx, {
            type: "witness-captured",
            runId: nodeCtx.runId,
            dagId,
            nodeId,
            witness: capturedWitness,
            capturedAtMs: nowFn(),
            timestamp: stamp(),
          });
          witnessAccumulator?.set(capturedWitness.resource, capturedWitness);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          fwLogger().warn(
            `[emitFreshnessWitnessEvents] extractWitness failed for node '${nodeId}': ${msg}`,
          );
          const fwError: FrameworkError = { kind: "node-crash", nodeId, retriability: "non-retriable", message: `extractWitness threw: ${msg}` };
          emit(nodeCtx, {
            type: "node-error",
            runId: nodeCtx.runId,
            dagId,
            nodeId,
            sideEffects: nodeMap.get(nodeId)?.sideEffects,
            timestamp: stamp(),
            error: `extractWitness failed: ${msg}`,
            frameworkError: fwError,
          });
          // Fail-closed: downstream writes nodes need this witness for conflict
          // detection. Proceeding without it would silently allow stale writes.
          return err(fwError);
        }
        return ok(undefined);
      })
      .with({ kind: "writes" }, async (se) => {
        // Neither extractor → the node opts out of freshness tracking entirely.
        if (!se.extractConditionedOn && !se.extractNewWitness) return ok(undefined);
        // Exactly one extractor is an authoring error: a lone extractor can
        // never produce a conflict check, so freshness tracking would be
        // silently disabled. Fail closed. (validate-dag also rejects this at
        // defineDag time; this is defense-in-depth for hand-built DAGs.)
        if (!se.extractConditionedOn || !se.extractNewWitness) {
          const message = `writes node '${nodeId}' declares only one of extractConditionedOn/extractNewWitness — both are required for freshness tracking`;
          const fwError: FrameworkError = { kind: "node-crash", nodeId, retriability: "non-retriable", message };
          fwLogger().error(`[emitFreshnessWitnessEvents] ${message}`);
          emit(nodeCtx, {
            type: "node-error",
            runId: nodeCtx.runId,
            dagId,
            nodeId,
            sideEffects: nodeMap.get(nodeId)?.sideEffects,
            timestamp: stamp(),
            error: message,
            frameworkError: fwError,
          });
          return err(fwError);
        }

        // Step 1: Rebuild the node's input via the shared helper
        const incoming = machineCtx.incomingByNode.get(nodeId) ?? { required: [], optional: [] };
        const inputResult = buildNodeInput(priorOutputs, incoming, nodeId);
        if (!inputResult.ok) {
          const message = `BUG: input reconstruction failed for writes node '${nodeId}': ${inputResult.error.kind === "node-crash" ? inputResult.error.message : "unknown"}`;
          fwLogger().error(`[emitFreshnessWitnessEvents] ${message}`);
          emit(nodeCtx, {
            type: "node-error",
            runId: nodeCtx.runId,
            dagId,
            nodeId,
            sideEffects: nodeMap.get(nodeId)?.sideEffects,
            timestamp: stamp(),
            error: message,
            frameworkError: inputResult.error,
          });
          return err(inputResult.error);
        }
        const nodeInput = inputResult.value;

        // Step 2: User-provided extractors
        let conditionedOn: Witness;
        let newWitness: Witness;
        try {
          // conditionedOn keeps its own resource (a write may condition on a
          // different resource it read upstream). newWitness is the new version
          // of *this* node's resource, so the framework stamps it.
          conditionedOn = se.extractConditionedOn(nodeInput);
          newWitness = stampWitness(se.resource, se.extractNewWitness(output));
        } catch (e) {
          const msg = `extractConditionedOn/extractNewWitness failed for node '${nodeId}': ${e instanceof Error ? e.message : e}`;
          fwLogger().warn(`[emitFreshnessWitnessEvents] ${msg}`);
          const fwError: FrameworkError = { kind: "node-crash", nodeId, retriability: "non-retriable", message: `freshness extractor threw: ${msg}` };
          emit(nodeCtx, {
            type: "node-error",
            runId: nodeCtx.runId,
            dagId,
            nodeId,
            sideEffects: nodeMap.get(nodeId)?.sideEffects,
            timestamp: stamp(),
            error: `freshness extractor failed: ${msg}`,
            frameworkError: fwError,
          });
          // Fail-closed: broken extractors are an authoring bug that must be fixed.
          return err(fwError);
        }

        // Step 3: Freshness conflict check + event emission
        // sinceMs: 0 is intentional — within a run, all prior writes are relevant
        // because topological ordering guarantees the read witness was captured
        // before any writes in later waves.
        const conflictResult = await freshnessIndex.findConflict(conditionedOn, 0);
        if (!conflictResult.ok) {
          const msg = formatFrameworkError(conflictResult.error);
          fwLogger().error(
            `[emitFreshnessWitnessEvents] freshnessIndex.findConflict failed for node '${nodeId}', resource '${conditionedOn.resource}': ${msg}`,
          );
          // Fail-closed: index unavailable → abort the wave. Proceeding without
          // conflict detection would allow undetectable stale writes; synthesizing
          // a fake conflict event would mislead consumers. ADR-0025.
          const fwError: FrameworkError = { kind: "node-crash", nodeId, retriability: "retriable", message: `freshness check unavailable: ${msg}` };
          emit(nodeCtx, {
            type: "node-error",
            runId: nodeCtx.runId,
            dagId,
            nodeId,
            sideEffects: nodeMap.get(nodeId)?.sideEffects,
            timestamp: stamp(),
            error: `freshness conflict check failed: ${msg}`,
            frameworkError: fwError,
          });
          return err(fwError);
        }
        const conflict = conflictResult.value;
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
        const writeResult = await freshnessIndex.recordWrite(writeEvent);
        if (!writeResult.ok) {
          const msg = formatFrameworkError(writeResult.error);
          fwLogger().error(
            `[emitFreshnessWitnessEvents] freshnessIndex.recordWrite failed for node '${nodeId}': ${msg}`,
          );
          const fwError: FrameworkError = { kind: "node-crash", nodeId, retriability: "retriable", message: `freshness recordWrite failed: ${msg}` };
          emit(nodeCtx, {
            type: "node-error",
            runId: nodeCtx.runId,
            dagId,
            nodeId,
            sideEffects: nodeMap.get(nodeId)?.sideEffects,
            timestamp: stamp(),
            error: `freshness recordWrite failed: ${msg}`,
            frameworkError: fwError,
          });
          return err(fwError);
        }
        return ok(undefined);
      })
      .with({ kind: "none" }, async () => ok(undefined))
      .with({ kind: "external-call" }, async () => ok(undefined))
      .exhaustive();

    if (!branchResult.ok) return branchResult;
  }
  return ok(undefined);
}
