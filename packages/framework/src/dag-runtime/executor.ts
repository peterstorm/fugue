// buildDagExecutor — DAG executor closure
// FR-025: validate inputs/outputs; FR-027: exponential backoff with jitter
// Returns an Executor<DagPhase, DagEvent, DagMachineContext> that runs one wave per call.

import { match } from "ts-pattern";
import type { Executor } from "../state-machine/types.js";
import type { DagPhase, DagEvent, DagMachineContext } from "./types.js";
import type { DagDef } from "../types/dag.js";
import type { NodeDef, NodeContext, ValidatedNodeContext } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { ObserverEvent } from "../types/events.js";
import type { Observer } from "../observer/observer.js";
import { type Result, ok, err } from "../types/result.js";
import { runNodeShared } from "./run-node.js";
import { type NodeSpanOutcome } from "./node-span.js";
import { applyJitter } from "../shared/jitter.js";
import { dispatchEvent } from "../observer/buffered.js";
import { decideRoute } from "./conditional.js";
import { isConditionalEdge } from "../types/dag.js";
import { fwLogger } from "../logger.js";

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
// approve-with-edit validation
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

/**
 * Shared body of the `awaiting-human` and `retrying-hook` executor branches.
 * Both paths: check for a wired hook, invoke it, catch exceptions into a
 * `node-failed`, validate `approve-with-edit` output against the node schema,
 * and finally emit `human-responded`. Only the retrying-hook branch prepends
 * a sleep — that lives at the call site.
 */
const callHumanReviewHook = async (
  phaseKind: "awaiting-human" | "retrying-hook",
  nodeId: string,
  output: unknown,
  prompt: string,
  hooks: {
    onHumanReview?: (req: {
      nodeId: string;
      output: unknown;
      prompt: string;
    }) => Promise<import("./types.js").HumanAction>;
  } | undefined,
  nodeMap: Map<string, NodeDef<unknown, unknown, unknown>>,
  nodeCtx: NodeContext,
  dagId: string,
): Promise<DagEvent> => {
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
      timestamp: new Date(),
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
      timestamp: new Date(),
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
 * emitted to preserve the existing observable behavior (AD-2).
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
  },
): Executor<DagPhase, DagEvent, DagMachineContext> => {
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

        // `runWave` is called for the whole wave, but iterates with a
        // succeeded-output guard (see runWave:341): siblings already present
        // in `machineCtx.outputs` short-circuit to a `node-skipped` event with
        // their cached value, so only the failed node (plus any sibling that
        // co-failed and is still absent from outputs) actually re-runs.
        return runWave(p.wave, machineCtx, dag, nodeMap, nodeCtx, recordOutcomes, resumeCheckpoint);
      })

      // -----------------------------------------------------------------------
      // running: run the current wave
      // -----------------------------------------------------------------------
      .with({ kind: "running" }, (p) => runWave(p.wave, machineCtx, dag, nodeMap, nodeCtx, recordOutcomes, resumeCheckpoint))

      // -----------------------------------------------------------------------
      // awaiting-human: dispatch the review hook
      // -----------------------------------------------------------------------
      .with({ kind: "awaiting-human" }, (p) =>
        callHumanReviewHook("awaiting-human", p.nodeId, p.output, p.prompt, hooks, nodeMap, nodeCtx, dag.id),
      )

      // -----------------------------------------------------------------------
      // retrying-hook: sleep with jitter then re-call the onHumanReview hook.
      // The node is NOT re-run — only the hook is retried (FR-029a).
      // -----------------------------------------------------------------------
      .with({ kind: "retrying-hook" }, async (p) => {
        const nodeDef = nodeMap.get(p.nodeId);
        const jitterRatio = nodeDef?.retry?.jitterRatio ?? DEFAULT_JITTER_RATIO;
        const delayWithJitter = applyJitter(p.nextDelayMs, jitterRatio, random);
        await sleep(delayWithJitter);
        return callHumanReviewHook("retrying-hook", p.nodeId, p.output, p.prompt, hooks, nodeMap, nodeCtx, dag.id);
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
  nodeCtx: ValidatedNodeContext,
  recordOutcomes: ((outcomes: readonly NodeSpanOutcome[]) => void) | undefined,
  resumeCheckpoint: Map<string, unknown> | undefined,
): Promise<DagEvent> => {
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
      nodeId: "__wave__",
      error: { kind: "node-crash", nodeId: "__wave__", message, retriability: "non-retriable" },
    };
  }
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
        frameworkError: sibling.error,
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

  // Compute routing decisions exactly once per source node. The executor uses
  // the result to emit observer events; the transition (`handleWaveDone`)
  // reads them off the wave-done event to expand `activeNodeIds` without
  // re-running the same predicates (W5.8).
  //
  // When `decideRoute` returns `predicate-malformed`, short-circuit the wave
  // with `node-failed` instead of letting it fall through to `wave-done`.
  // `handleNodeFailed` special-cases the `predicate-malformed` error kind to
  // fail-fast without consuming the retry budget — a malformed predicate is a
  // config error, not a transient runtime failure.
  const routingDecisions = new Map<string, import("./conditional.js").Decision>();
  for (const nodeId of waveNodeIds) {
    if (!newOutputs.has(nodeId)) continue;
    const outgoing = machineCtx.outgoingByNode.get(nodeId) ?? [];
    if (!outgoing.some(isConditionalEdge)) continue;
    const decision = decideRoute(nodeId, newOutputs.get(nodeId), outgoing);
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
        timestamp: new Date(),
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
    routingDecisions: routingDecisions.size > 0 ? routingDecisions : undefined,
  };
};
