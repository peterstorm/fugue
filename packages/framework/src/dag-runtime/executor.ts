// buildDagExecutor — DAG executor closure
// FR-025: validate inputs/outputs; FR-027: exponential backoff with jitter
// Returns an Executor<DagPhase, DagEvent, DagMachineContext> that runs one wave per call.

import { match } from "ts-pattern";
import type { Executor } from "../state-machine/types.js";
import type { DagPhase, DagEvent, DagMachineContext, HumanAction } from "./types.js";
import type { DagDef } from "../types/dag.js";
import type { NodeDef, NodeContext, ValidatedNodeContext } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { ObserverEvent } from "../types/events.js";
import type { Observer } from "../observer/observer.js";
import type { NodeId, DagId } from "../types/ids.js";
import { __brandNodeId } from "../types/ids.js";
import { type Result, ok, err } from "../types/result.js";
import { runNodeShared } from "./run-node.js";
import { type NodeSpanOutcome } from "./node-span.js";
import { applyJitter } from "../shared/jitter.js";
import { dispatchEvent } from "../observer/buffered.js";
import { decideRoute } from "./conditional.js";
import { isConditionalEdge } from "../types/dag.js";
import { fwLogger } from "../logger.js";
import type { Confidence } from "../types/confidence.js";
import type { SideEffectKind } from "../types/side-effects.js";
import type { HumanActionDetailed } from "../types/events.js";
import { computeJsonPatch } from "../shared/json-patch.js";
import type { Witness } from "../types/freshness.js";
import { type FreshnessIndex, InMemoryFreshnessIndex } from "./freshness-check.js";

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

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

// ---------------------------------------------------------------------------
// approve-with-edit validation
//
// Returns `null` on success, an error message on failure. Validation runs in
// the imperative shell because the pure transition layer can't depend on a
// live Zod schema (on resume, deserialized schemas are inert).
// ---------------------------------------------------------------------------

const validateApproveEdit = (
  action: import("./types.js").HumanAction,
  nodeId: NodeId,
  nodeMap: Map<NodeId, NodeDef<unknown, unknown>>,
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

/**
 * Shared body of the `awaiting-human` and `retrying-hook` executor branches.
 * Both paths: check for a wired hook, invoke it, catch exceptions into a
 * `node-failed`, validate `approve-with-edit` output against the node schema,
 * and finally emit `human-responded`. Only the retrying-hook branch prepends
 * a sleep — that lives at the call site.
 */
const callHumanReviewHook = async (
  phaseKind: "awaiting-human" | "retrying-hook",
  nodeId: NodeId,
  output: unknown,
  prompt: string,
  hooks: {
    onHumanReview?: (req: {
      nodeId: string;
      output: unknown;
      prompt: string;
    }) => Promise<import("./types.js").HumanAction>;
  } | undefined,
  nodeMap: Map<NodeId, NodeDef<unknown, unknown>>,
  nodeCtx: NodeContext,
  dagId: DagId,
  nowFn: () => number,
): Promise<DagEvent> => {
  const stamp = (): Date => new Date(nowFn());
  if (!hooks?.onHumanReview) {
    return {
      type: "node-failed",
      nodeId,
      error: {
        kind: "node-crash",
        retriability: "retriable",
        nodeId,
        message: `${phaseKind}: no onHumanReview hook supplied`,
      },
    } satisfies DagEvent;
  }

  let action: import("./types.js").HumanAction;
  try {
    action = await hooks.onHumanReview({ nodeId, output, prompt });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    const crash: FrameworkError = { kind: "node-crash", nodeId, retriability: "retriable", message, stack };
    emit(nodeCtx, {
      type: "node-error",
      runId: nodeCtx.runId,
      dagId,
      nodeId,
      sideEffects: nodeMap.get(nodeId)?.sideEffects,
      timestamp: stamp(),
      error: message,
      stack,
      frameworkError: crash,
    });
    return {
      type: "node-failed",
      nodeId,
      error: crash,
    } satisfies DagEvent;
  }

  // approve-with-edit goes through the live Zod schema here in the shell —
  // the pure transition can't validate (deserialized schemas are inert).
  const validationFailure = validateApproveEdit(action, nodeId, nodeMap);
  if (validationFailure !== null) {
    const valErr: FrameworkError = {
      kind: "validation",
      nodeId,
      message: validationFailure,
    };
    emit(nodeCtx, {
      type: "node-error",
      runId: nodeCtx.runId,
      dagId,
      nodeId,
      sideEffects: nodeMap.get(nodeId)?.sideEffects,
      timestamp: stamp(),
      error: validationFailure,
      frameworkError: valErr,
    });
    return {
      type: "node-failed",
      nodeId,
      error: valErr,
    } satisfies DagEvent;
  }

  return { type: "human-responded", nodeId, action } satisfies DagEvent;
};


// ---------------------------------------------------------------------------
// emitHumanIntervention — Phase 4: human-intervention observer event
// ---------------------------------------------------------------------------

/**
 * Translate a DAG-layer `HumanAction` into the detailed observer-event
 * shape, then emit `HumanInterventionEvent`. Called in the executor after
 * `callHumanReviewHook` produces a successful `human-responded` event.
 */
const emitHumanIntervention = (
  phase: { nodeId: NodeId; output: unknown },
  action: HumanAction,
  nodeMap: ReadonlyMap<NodeId, NodeDef<unknown, unknown>>,
  nodeCtx: NodeContext,
  dagId: DagId,
  nowFn: () => number,
  awaitStartMs: number,
  capturedWitnesses: readonly Witness[],
): void => {
  const stamp = (): Date => new Date(nowFn());
  const nodeDef = nodeMap.get(phase.nodeId);

  // Build HumanActionDetailed from the DAG-layer HumanAction
  const detailed: HumanActionDetailed = match(action)
    .with({ action: "approve" }, () => ({ kind: "approve" as const }))
    .with({ action: "approve-with-edit" }, (a) => ({
      kind: "approve-with-edit" as const,
      originalOutput: phase.output,
      replacedOutput: a.newOutput,
      diff: computeJsonPatch(phase.output, a.newOutput),
    }))
    .with({ action: "reject" }, (a) => ({ kind: "reject" as const, reason: a.reason }))
    .with({ action: "reroute" }, (a) => ({
      kind: "reroute" as const,
      targetNodeId: a.targetNodeId,
      ...(a.reason !== undefined ? { reason: a.reason } : {}),
    }))
    .exhaustive();

  // Extract confidence from the node's output
  let nodeConfidence: Confidence | null = null;
  if (nodeDef && nodeDef.confidence.mode === "value") {
    try {
      nodeConfidence = nodeDef.confidence.extract(phase.output);
    } catch (e) {
      fwLogger().warn(
        `[emitHumanIntervention] confidence.extract failed for node '${phase.nodeId}': ${e instanceof Error ? e.message : e}`,
      );
      nodeConfidence = null;
    }
  }

  // Side-effects kind
  const nodeSideEffects: SideEffectKind = nodeDef?.sideEffects.kind ?? "none";

  emit(nodeCtx, {
    type: "human-intervention",
    runId: nodeCtx.runId,
    dagId,
    nodeId: phase.nodeId,
    action: detailed,
    actor: action.actor ?? "unknown",
    elapsedMsSinceAwait: nowFn() - awaitStartMs,
    context: {
      nodeConfidence,
      nodeSideEffects,
      priorWitnesses: [...capturedWitnesses],
    },
    timestamp: stamp(),
  });
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
 * emitted here so consumers see the full run-start / node-start / node-end /
 * run-end stream regardless of the execution path.
 */
export const buildDagExecutor = (
  dag: DagDef,
  nodeCtx: ValidatedNodeContext,
  hooks?: {
    onHumanReview?: (req: {
      nodeId: string;
      output: unknown;
      prompt: string;
    }) => Promise<import("./types.js").HumanAction>;
    /** Called once per wave with the per-node outcomes; the caller folds them into run-level meta. */
    recordOutcomes?: (outcomes: readonly NodeSpanOutcome[]) => void;
    /**
     * Crash-resume checkpoint. When provided, nodes whose ids
     * appear in this Map are skipped via `runNodeShared`'s checkpoint path
     * (validated against `outputSchema`, observer sees `node-skipped` with
     * `reason: "checkpoint"`).
     */
    resumeCheckpoint?: Map<string, unknown>;
    /**
     * RNG seam for retry-backoff jitter. Defaults to
     * `Math.random`; tests pass a seeded deterministic source.
     */
    random?: () => number;
    /**
     * Wall-clock source for observer-event `timestamp` fields. Threaded into
     * `runWave`, `callHumanReviewHook`, and `runNodeShared`. Defaults to
     * `Date.now`; tests pass a deterministic clock so event ordering is
     * checkable via property tests.
     */
    now?: () => number;
    /**
     * In-memory freshness index for single-process witness tracking. When
     * omitted, a private instance is created per executor. Pass a shared
     * instance to enable cross-DAG freshness detection within a process.
     */
    freshnessIndex?: FreshnessIndex;
  },
): Executor<DagPhase, DagEvent, DagMachineContext> => {
  const nodeMap = new Map<NodeId, NodeDef<unknown, unknown>>(
    dag.nodes.map((n) => [n.id, n]),
  );
  const recordOutcomes = hooks?.recordOutcomes;
  const resumeCheckpoint = hooks?.resumeCheckpoint;
  const random = hooks?.random ?? Math.random;
  const nowFn = hooks?.now ?? Date.now;
  const freshnessIndex = hooks?.freshnessIndex ?? new InMemoryFreshnessIndex();

  // Phase 4: Track captured witnesses for HumanInterventionEvent context.
  // Accumulated as witness-captured events are emitted; read by the
  // awaiting-human branch to populate context.priorWitnesses.
  // Witnesses accumulate across all waves for the lifetime of the executor,
  // so a human gate in a later wave sees all prior reads.
  // TODO: For long-running DAGs with many reads nodes, consider deduplicating
  // by resource (keep latest per resource) or capping with a sliding window.
  const capturedWitnesses: Witness[] = [];

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
        await sleep(delayWithJitter, nodeCtx.signal);

        // `runWave` is called for the whole wave, but iterates with a
        // succeeded-output guard: siblings already present in
        // `machineCtx.outputs` short-circuit to a `node-skipped` event with
        // their cached value, so only the failed node (plus any sibling that
        // co-failed and is still absent from outputs) actually re-runs.
        return runWave(p.wave, machineCtx, dag, nodeMap, nodeCtx, recordOutcomes, resumeCheckpoint, nowFn, freshnessIndex, capturedWitnesses);
      })

      // -----------------------------------------------------------------------
      // running: run the current wave
      // -----------------------------------------------------------------------
      .with({ kind: "running" }, (p) => runWave(p.wave, machineCtx, dag, nodeMap, nodeCtx, recordOutcomes, resumeCheckpoint, nowFn, freshnessIndex, capturedWitnesses))

      // -----------------------------------------------------------------------
      // awaiting-human: dispatch the review hook
      // -----------------------------------------------------------------------
      .with({ kind: "awaiting-human" }, async (p) => {
        const awaitStartMs = nowFn();
        const event = await callHumanReviewHook("awaiting-human", p.nodeId, p.output, p.prompt, hooks, nodeMap, nodeCtx, dag.id, nowFn);
        if (event.type === "human-responded") {
          emitHumanIntervention(
            { nodeId: p.nodeId, output: p.output },
            event.action,
            nodeMap,
            nodeCtx,
            dag.id,
            nowFn,
            awaitStartMs,
            capturedWitnesses,
          );
        }
        return event;
      })

      // -----------------------------------------------------------------------
      // retrying-hook: sleep with jitter then re-call the onHumanReview hook.
      // The node is NOT re-run — only the hook is retried (FR-029a).
      // -----------------------------------------------------------------------
      .with({ kind: "retrying-hook" }, async (p) => {
        const nodeDef = nodeMap.get(p.nodeId);
        const jitterRatio = nodeDef?.retry?.jitterRatio ?? DEFAULT_JITTER_RATIO;
        const delayWithJitter = applyJitter(p.nextDelayMs, jitterRatio, random);
        await sleep(delayWithJitter, nodeCtx.signal);
        const awaitStartMs = nowFn();
        const event = await callHumanReviewHook("retrying-hook", p.nodeId, p.output, p.prompt, hooks, nodeMap, nodeCtx, dag.id, nowFn);
        if (event.type === "human-responded") {
          emitHumanIntervention(
            { nodeId: p.nodeId, output: p.output },
            event.action,
            nodeMap,
            nodeCtx,
            dag.id,
            nowFn,
            awaitStartMs,
            capturedWitnesses,
          );
        }
        return event;
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
// emitFreshnessWitnessEvents — extracted from runWave for readability
//
// After all nodes in a wave succeed, emit witness events for reads and writes
// nodes. For writes nodes, check the freshness index for conflicts BEFORE the
// write's witness is recorded — so the conflict detection sees the state as
// of write time.
// ---------------------------------------------------------------------------

const emitFreshnessWitnessEvents = async (
  waveNodeIds: readonly NodeId[],
  newOutputs: ReadonlyMap<NodeId, unknown>,
  nodeMap: ReadonlyMap<NodeId, NodeDef<unknown, unknown>>,
  machineCtx: DagMachineContext,
  nodeCtx: NodeContext,
  dagId: DagId,
  nowFn: () => number,
  freshnessIndex: FreshnessIndex,
  skippedNodeIds: ReadonlySet<NodeId>,
  witnessAccumulator?: Witness[],
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
      .with({ kind: "reads" }, async () => {
        if (!nodeDef.extractWitness) return;
        try {
          const witness: Witness = nodeDef.extractWitness(output);
          emit(nodeCtx, {
            type: "witness-captured",
            runId: nodeCtx.runId,
            dagId,
            nodeId,
            witness,
            capturedAtMs: nowFn(),
            timestamp: stamp(),
          });
          witnessAccumulator?.push(witness);
        } catch (e) {
          fwLogger().warn(
            `[emitFreshnessWitnessEvents] extractWitness failed for node '${nodeId}': ${e instanceof Error ? e.message : e}`,
          );
        }
      })
      .with({ kind: "writes" }, async () => {
        if (!nodeDef.extractConditionedOn || !nodeDef.extractNewWitness) return;

        // Step 1: Rebuild the node's input (framework invariant — should not fail)
        let nodeInput: unknown;
        try {
          const incoming = machineCtx.incomingByNode.get(nodeId) ?? { required: [], optional: [] };
          const { required, optional } = incoming;
          if (optional.length > 0) {
            nodeInput = Object.fromEntries(
              [...required, ...optional].map((d) => [d, priorOutputs.get(d as NodeId)]),
            );
          } else if (required.length === 0) {
            nodeInput = machineCtx.initialInput;
          } else if (required.length === 1) {
            nodeInput = priorOutputs.get(required[0] as NodeId);
          } else {
            nodeInput = Object.fromEntries(required.map((d) => [d, priorOutputs.get(d as NodeId)]));
          }
        } catch (e) {
          fwLogger().error(
            `[emitFreshnessWitnessEvents] BUG: input reconstruction failed for node '${nodeId}': ${e instanceof Error ? e.message : e}`,
          );
          return;
        }

        // Step 2: User-provided extractors
        let conditionedOn: Witness;
        let newWitness: Witness;
        try {
          conditionedOn = nodeDef.extractConditionedOn(nodeInput);
          newWitness = nodeDef.extractNewWitness(output);
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
        const conflict = await freshnessIndex.findConflict(
          conditionedOn.resource,
          conditionedOn.value,
          0,
        );
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
        await freshnessIndex.recordWrite(writeEvent);
      })
      .with({ kind: "none" }, () => { /* pure transform — no freshness tracking */ })
      .with({ kind: "external-call" }, () => { /* external calls don't participate in witness contract */ })
      .exhaustive();
  }
};

// ---------------------------------------------------------------------------
// runWave — run all nodes in a wave concurrently; return wave-done or node-failed
// ---------------------------------------------------------------------------

const runWave = async (
  waveIndex: number,
  machineCtx: DagMachineContext,
  dag: DagDef,
  nodeMap: Map<NodeId, NodeDef<unknown, unknown>>,
  nodeCtx: ValidatedNodeContext,
  recordOutcomes: ((outcomes: readonly NodeSpanOutcome[]) => void) | undefined,
  resumeCheckpoint: Map<string, unknown> | undefined,
  nowFn: () => number,
  freshnessIndex: FreshnessIndex,
  witnessAccumulator?: Witness[],
): Promise<DagEvent> => {
  const stamp = (): Date => new Date(nowFn());
  // Filter to active nodes only. Pruned nodes are silently skipped — they
  // did not fire on this routing decision; downstream consumers that list
  // them as `optional` sources in `incomingByNode` see `undefined`.
  //
  // An out-of-bounds waveIndex is an invariant violation (the runtime asks
  // for a wave the compiled DAG does not have). Surface it loudly rather
  // than emitting a `wave-done` with no outputs, which would silently advance
  // the run and either fail with `output-missing` or — worse — succeed with
  // stale output from a prior wave.
  if (waveIndex < 0 || waveIndex >= machineCtx.waves.length) {
    const message = `out-of-bounds waveIndex: ${waveIndex} (have ${machineCtx.waves.length} waves)`;
    fwLogger().error(`[runWave] ${message}`);
    return {
      type: "node-failed",
      nodeId: __brandNodeId("__wave__"),
      error: { kind: "node-crash", nodeId: __brandNodeId("__wave__"), message, retriability: "non-retriable" },
    };
  }
  const allWaveNodeIds = machineCtx.waves[waveIndex] ?? [];
  const waveNodeIds = allWaveNodeIds.filter((id) => machineCtx.activeNodeIds.has(id));

  // Snapshot prior-wave outputs so concurrent nodes in this wave can't
  // observe each other's results mid-execution. Each node reads only from
  // the frozen snapshot; the caller merges successes after Promise.all.
  const priorOutputs: ReadonlyMap<NodeId, unknown> = machineCtx.outputs;

  // Run all wave nodes concurrently
  const settled = await Promise.all(
    waveNodeIds.map(async (nodeId) => {
      // Skip nodes already successfully completed in this wave
      // (they already appear in machineCtx.outputs with correct values)
      if (priorOutputs.has(nodeId)) {
        // Already have output — re-emit node-skipped for observability
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
        machineCtx.initialInput,
        nodeCtx,
        dag.id,
        priorOutputs,
        incoming,
        { checkpoint: resumeCheckpoint, writeCheckpoint: true, now: nowFn },
      );
      return { nodeId, result, outcome };
    }),
  );

  // Fold this wave's outcomes into run-level meta after Promise.all.
  if (recordOutcomes) {
    recordOutcomes(settled.map((s) => s.outcome));
  }

  const results = settled.map(({ nodeId, result }) => ({ nodeId, result }));

  // Collect new outputs + check for failures.
  // - Collect all succeeded sibling outputs before returning the first failure,
  //   so they can be persisted into ctx.outputs and skipped on retry.
  // - Collect ALL failures (not just the first) so co-failed siblings get their
  //   retry counters pre-incremented, preventing off-by-one retry accounting.
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

    // Emit node-error for each sibling failure beyond the primary so operators can observe them.
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

    // Build partialOutputs: succeeded siblings (excludes already-known outputs from prior waves
    // since those are already in machineCtx.outputs; only new outputs from this wave execution).
    const partialOutputs = new Map<NodeId, unknown>();
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

  // -------------------------------------------------------------------------
  // Freshness witness emission (Phase 3)
  // -------------------------------------------------------------------------
  // Build the set of nodes that were skipped (checkpoint-resumed or already
  // completed) so freshness events are only emitted for nodes that actually ran.
  const skippedNodeIds = new Set<NodeId>();
  for (const nodeId of waveNodeIds) {
    if (priorOutputs.has(nodeId) || resumeCheckpoint?.has(nodeId)) {
      skippedNodeIds.add(nodeId);
    }
  }
  await emitFreshnessWitnessEvents(
    waveNodeIds, newOutputs, nodeMap, machineCtx, nodeCtx, dag.id, nowFn, freshnessIndex, skippedNodeIds, witnessAccumulator,
  );

  // Compute routing decisions exactly once per source node. The executor uses
  // the result to emit observer events; the transition (`handleWaveDone`)
  // reads them off the wave-done event to expand `activeNodeIds` without
  // re-running the same predicates.
  //
  // When `decideRoute` returns `predicate-malformed`, short-circuit the wave
  // with `node-failed` instead of letting it fall through to `wave-done`.
  // `handleNodeFailed` special-cases the `predicate-malformed` error kind to
  // fail-fast without consuming the retry budget — a malformed predicate is a
  // config error, not a transient runtime failure.
  const routingDecisions = new Map<NodeId, import("./conditional.js").Decision>();
  for (const nodeId of waveNodeIds) {
    if (!newOutputs.has(nodeId)) continue;
    const outgoing = machineCtx.outgoingByNode.get(nodeId) ?? [];
    if (!outgoing.some(isConditionalEdge)) continue;

    // Extract upstream confidence from the node definition
    const nodeDef = nodeMap.get(nodeId);
    let upstreamConfidence: Confidence | null = null;
    if (nodeDef && nodeDef.confidence.mode === "value") {
      try {
        upstreamConfidence = nodeDef.confidence.extract(newOutputs.get(nodeId));
      } catch (e) {
        fwLogger().warn(
          `[runWave] confidence.extract failed for node '${nodeId}': ${e instanceof Error ? e.message : e}`,
        );
        upstreamConfidence = null;
      }
    }

    const decision = decideRoute(nodeId, newOutputs.get(nodeId), outgoing, upstreamConfidence);
    if (decision.kind === "predicate-malformed") {
      const predErr: FrameworkError = {
        kind: "predicate-malformed",
        nodeId: decision.fromNodeId,
        message: decision.message,
      };
      emit(nodeCtx, {
        type: "node-error",
        runId: nodeCtx.runId,
        dagId: dag.id,
        nodeId,
        sideEffects: nodeMap.get(nodeId)?.sideEffects,
        timestamp: stamp(),
        error: `predicate-malformed: ${decision.message}`,
        frameworkError: predErr,
      });
      return {
        type: "node-failed",
        nodeId,
        error: predErr,
      };
    }
    routingDecisions.set(nodeId, decision);
    emit(nodeCtx, {
      type: "route-decided",
      runId: nodeCtx.runId,
      dagId: dag.id,
      fromNodeId: nodeId,
      chosenTargets: [...decision.chosenTargets],
      prunedTargets: [...decision.prunedTargets],
      defaultTaken: decision.defaultTaken,
      evidence: {
        upstreamOutput: newOutputs.get(nodeId),
        upstreamConfidence,
        predicateResults: decision.predicateResults,
        decidedAtMs: nowFn(),
      },
      timestamp: stamp(),
    });
    for (const pruned of decision.prunedTargets) {
      emit(nodeCtx, {
        type: "node-pruned",
        runId: nodeCtx.runId,
        dagId: dag.id,
        nodeId: pruned,
        reason: "branch-not-taken",
        timestamp: stamp(),
      });
    }
  }

  return {
    type: "wave-done",
    wave: waveIndex,
    outputs: newOutputs,
    routingDecisions: routingDecisions.size > 0 ? routingDecisions : undefined,
  };
};
