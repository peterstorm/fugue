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
//
// An abort is PARTIAL: nodes earlier in the wave may already have had their
// witnesses recorded. That progress is returned as data on both branches of
// `FreshnessEmissionOutcome`, so a wave retry can tell what it still owes
// instead of inferring it from "does an output exist" — which would let a retry
// close the wave with a write witness permanently missing.

import { match } from "ts-pattern";
import type { NodeId } from "../types/ids.js";
import type { Witness } from "../types/freshness.js";
import { stampWitness, writeEntryOf } from "../types/freshness.js";
import type { FrameworkError } from "../types/errors.js";
import { type Result, ok, err } from "../types/result.js";
import { bestEffortLog } from "./best-effort.js";
import { formatFrameworkError } from "../types/errors.js";
import { safeErrorMessage } from "../types/safe-error.js";
import { buildNodeInput } from "../shared/build-input.js";
import { emit } from "./emit.js";
import type { PostWaveContext } from "./post-wave-context.js";
import { nodeErrorEmitter } from "./post-wave-context.js";

/**
 * The outcome of one wave's freshness emission.
 *
 * `witnessed` is present on BOTH variants: an abort still carries the nodes
 * whose bookkeeping completed before it, so the caller can record that progress
 * and a retry re-attempts only what is genuinely outstanding. Making the
 * partial-progress set part of the failure variant is what keeps "aborted with
 * unknown progress" unrepresentable.
 */
export type FreshnessEmissionOutcome =
  | { readonly kind: "complete"; readonly witnessed: ReadonlySet<NodeId> }
  | { readonly kind: "aborted"; readonly witnessed: ReadonlySet<NodeId>; readonly error: FrameworkError };

/**
 * Emit freshness witness events for all reads/writes nodes in a wave.
 *
 * Fail-closed: extractor failures abort the wave with an `aborted` outcome.
 * The authoring bug (broken extractor) must be fixed before the DAG
 * can proceed — silently proceeding would allow downstream writes nodes
 * to operate without the witness data they need for conflict detection.
 */
export async function emitFreshnessWitnessEvents(
  ctx: PostWaveContext,
  newOutputs: ReadonlyMap<NodeId, unknown>,
  skippedNodeIds: ReadonlySet<NodeId>,
): Promise<FreshnessEmissionOutcome> {
  const { waveNodeIds, nodeMap, nodeCtx, machineCtx, dagId, nowFn, freshnessIndex, witnessAccumulator } = ctx;
  const stamp = (): Date => new Date(nowFn());
  const priorOutputs = machineCtx.outputs;
  const witnessed = new Set<NodeId>();
  const emitNodeError = nodeErrorEmitter(ctx);

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
          const msg = safeErrorMessage(e);
          bestEffortLog(
            "warn",
            `[emitFreshnessWitnessEvents] extractWitness failed for node '${nodeId}': ${msg}`,
          );
          const fwError: FrameworkError = { kind: "node-crash", nodeId, retriability: "non-retriable", message: `extractWitness threw: ${msg}` };
          emitNodeError(nodeId, `extractWitness failed: ${msg}`, fwError);
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
          bestEffortLog("error", `[emitFreshnessWitnessEvents] ${message}`);
          emitNodeError(nodeId, message, fwError);
          return err(fwError);
        }

        // Step 1: Rebuild the node's input via the shared helper
        const incoming = machineCtx.incomingByNode.get(nodeId) ?? { required: [], optional: [] };
        const inputResult = buildNodeInput(priorOutputs, incoming, nodeId);
        if (!inputResult.ok) {
          const message = `BUG: input reconstruction failed for writes node '${nodeId}': ${inputResult.error.kind === "node-crash" ? inputResult.error.message : "unknown"}`;
          bestEffortLog("error", `[emitFreshnessWitnessEvents] ${message}`);
          emitNodeError(nodeId, message, inputResult.error);
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
          const msg = `extractConditionedOn/extractNewWitness failed for node '${nodeId}': ${safeErrorMessage(e)}`;
          bestEffortLog("warn", `[emitFreshnessWitnessEvents] ${msg}`);
          const fwError: FrameworkError = { kind: "node-crash", nodeId, retriability: "non-retriable", message: `freshness extractor threw: ${msg}` };
          emitNodeError(nodeId, `freshness extractor failed: ${msg}`, fwError);
          // Fail-closed: broken extractors are an authoring bug that must be fixed.
          return err(fwError);
        }

        // Step 3: Ask the acknowledgement question directly. Conflict lookup
        // cannot answer it once another write has become latest.
        const identity = {
          runId: nodeCtx.runId,
          nodeId,
          executionEpoch: machineCtx.freshnessExecutionEpoch,
          newWitness,
        };
        const acknowledgement = await freshnessIndex.hasRecordedWrite(identity);
        if (!acknowledgement.ok) {
          const msg = formatFrameworkError(acknowledgement.error);
          bestEffortLog(
            "error",
            `[emitFreshnessWitnessEvents] freshnessIndex.hasRecordedWrite failed for node '${nodeId}': ${msg}`,
          );
          const fwError: FrameworkError = {
            kind: "node-crash",
            nodeId,
            retriability: "retriable",
            message: `freshness acknowledgement unavailable: ${msg}`,
          };
          emitNodeError(nodeId, `freshness acknowledgement check failed: ${msg}`, fwError);
          return err(fwError);
        }
        if (acknowledgement.value) return ok(undefined);

        // Step 4: Freshness conflict check + event emission.
        // sinceMs: 0 is intentional — within a run, all prior writes are relevant
        // because topological ordering guarantees the read witness was captured
        // before any writes in later waves.
        const conflictResult = await freshnessIndex.findConflict(conditionedOn, 0);
        if (!conflictResult.ok) {
          const msg = formatFrameworkError(conflictResult.error);
          bestEffortLog(
            "error",
            `[emitFreshnessWitnessEvents] freshnessIndex.findConflict failed for node '${nodeId}', resource '${conditionedOn.resource}': ${msg}`,
          );
          // Fail-closed: index unavailable → abort the wave. Proceeding without
          // conflict detection would allow undetectable stale writes; synthesizing
          // a fake conflict event would mislead consumers. ADR-0025.
          const fwError: FrameworkError = { kind: "node-crash", nodeId, retriability: "retriable", message: `freshness check unavailable: ${msg}` };
          emitNodeError(nodeId, `freshness conflict check failed: ${msg}`, fwError);
          return err(fwError);
        }
        const conflict = conflictResult.value;
        if (conflict !== null) {
          emit(nodeCtx, {
            type: "freshness-violation",
            runId: nodeCtx.runId,
            dagId,
            nodeId,
            conditionedOnWitness: conditionedOn,
            conflictingWrite: writeEntryOf(conflict),
            detectedAtMs: nowFn(),
            timestamp: stamp(),
          });
        }

        const writeEvent = {
          type: "write-attempted" as const,
          runId: nodeCtx.runId,
          dagId,
          nodeId,
          executionEpoch: machineCtx.freshnessExecutionEpoch,
          conditionedOn,
          newWitness,
          succeededAtMs: nowFn(),
          timestamp: stamp(),
        };
        emit(nodeCtx, writeEvent);
        const writeResult = await freshnessIndex.recordWrite(writeEvent);
        if (!writeResult.ok) {
          const msg = formatFrameworkError(writeResult.error);
          bestEffortLog(
            "error",
            `[emitFreshnessWitnessEvents] freshnessIndex.recordWrite failed for node '${nodeId}': ${msg}`,
          );
          const fwError: FrameworkError = { kind: "node-crash", nodeId, retriability: "retriable", message: `freshness recordWrite failed: ${msg}` };
          emitNodeError(nodeId, `freshness recordWrite failed: ${msg}`, fwError);
          return err(fwError);
        }
        return ok(undefined);
      })
      .with(
        { kind: "none" },
        { kind: "external-call" },
        async () => ok(undefined),
      )
      .exhaustive();

    if (!branchResult.ok) return { kind: "aborted", witnessed, error: branchResult.error };
    // Recorded only after the node's whole branch succeeded — a node that
    // aborted mid-branch still owes its bookkeeping on the retry.
    witnessed.add(nodeId);
  }
  return { kind: "complete", witnessed };
}
