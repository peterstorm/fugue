// buildDagExecutor — DAG executor closure
// FR-025: validate inputs/outputs; FR-027: exponential backoff with jitter
// Returns an Executor<DagPhase, DagEvent, DagMachineContext> that runs one wave per call.

import { match } from "ts-pattern";
import type { Executor } from "../state-machine/types.js";
import type { DagPhase, DagEvent, DagMachineContext, HumanAction } from "./types.js";
import type { DagDef } from "../types/dag.js";
import type { NodeDef, NodeContext, ValidatedNodeContext } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId, DagId } from "../types/ids.js";
import { __brandNodeId } from "../types/ids.js";
import { type Result, ok, err } from "../types/result.js";
import { runNodeShared } from "./run-node.js";
import { type NodeSpanOutcome } from "./node-span.js";
import { emit } from "./emit.js";
import { applyJitter } from "../shared/jitter.js";
import { fwLogger } from "../logger.js";
import { emitRoutingDecisions } from "./route-emission.js";
import type { Witness } from "../types/freshness.js";
import { type FreshnessIndex, InMemoryFreshnessIndex } from "./freshness-check.js";
import { emitHumanIntervention } from "./human-emission.js";
import { emitFreshnessWitnessEvents } from "./freshness-emission.js";

const EMPTY_OUTCOME: NodeSpanOutcome = { guardrailFailed: false, guardrailWarnings: [] };

// ---------------------------------------------------------------------------
// Backoff + jitter (FR-027)
// ---------------------------------------------------------------------------

const DEFAULT_JITTER_RATIO = 0.2;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
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
  // Keyed by resource so only the latest witness per resource is retained—
  // prevents unbounded growth for long-running DAGs with many reads nodes.
  // Witnesses accumulate across all waves for the lifetime of the executor,
  // so a human gate in a later wave sees all prior reads.
  const capturedWitnesses = new Map<string, Witness>();

  const waveConfig: RunWaveConfig = {
    dag, nodeMap, nodeCtx, recordOutcomes, resumeCheckpoint, nowFn, freshnessIndex,
    witnessAccumulator: capturedWitnesses,
  };

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
        return runWave(p.wave, machineCtx, waveConfig);
      })

      // -----------------------------------------------------------------------
      // running: run the current wave
      // -----------------------------------------------------------------------
      .with({ kind: "running" }, (p) => runWave(p.wave, machineCtx, waveConfig))

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
            [...capturedWitnesses.values()],
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
            [...capturedWitnesses.values()],
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
// RunWaveConfig — configuration object for runWave to reduce parameter count
// ---------------------------------------------------------------------------

interface RunWaveConfig {
  readonly dag: DagDef;
  readonly nodeMap: Map<NodeId, NodeDef<unknown, unknown>>;
  readonly nodeCtx: ValidatedNodeContext;
  readonly recordOutcomes?: (outcomes: readonly NodeSpanOutcome[]) => void;
  readonly resumeCheckpoint?: Map<string, unknown>;
  readonly nowFn: () => number;
  readonly freshnessIndex: FreshnessIndex;
  readonly witnessAccumulator?: Map<string, Witness>;
}

// ---------------------------------------------------------------------------
// runWave — run all nodes in a wave concurrently; return wave-done or node-failed
// ---------------------------------------------------------------------------

const runWave = async (
  waveIndex: number,
  machineCtx: DagMachineContext,
  config: RunWaveConfig,
): Promise<DagEvent> => {
  const { dag, nodeMap, nodeCtx, recordOutcomes, resumeCheckpoint, nowFn, freshnessIndex, witnessAccumulator } = config;
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

  // Compute routing decisions for all source nodes with conditional out-edges.
  // Emits route-decided and node-pruned observer events. Short-circuits on
  // predicate-malformed (config error, not transient).
  const routing = emitRoutingDecisions(
    waveNodeIds, newOutputs, nodeMap, machineCtx, nodeCtx, dag.id, nowFn,
  );
  if (routing.earlyFailure) return routing.earlyFailure;

  return {
    type: "wave-done",
    wave: waveIndex,
    outputs: newOutputs,
    routingDecisions: routing.decisions.size > 0 ? routing.decisions : undefined,
  };
};
