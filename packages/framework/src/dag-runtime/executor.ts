// buildDagExecutor — DAG executor closure (Phase 3a)
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
import { validateInput, validateOutput } from "../executor/validate.js";
import { withNodeSpan, type DagRunMeta } from "../executor/node-span.js";
import { dispatchEvent } from "../observer/buffered.js";

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

/**
 * Apply jitter to a base delay.
 * `baseDelay * (1 + jitterRatio * Math.random())`
 */
const applyJitter = (baseDelayMs: number, jitterRatio: number): number =>
  baseDelayMs * (1 + jitterRatio * Math.random());

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Single-node execution (mirrors runNode from executor.ts — FR-025)
// ---------------------------------------------------------------------------

const runNode = async (
  node: NodeDef<any, any, any>,
  dagInput: unknown,
  ctx: NodeContext,
  dagId: string,
  outputs: Map<string, unknown>,
  meta: DagRunMeta | undefined,
): Promise<Result<unknown, FrameworkError>> => {
  const nodeId = node.id;

  // Build node input from deps (same logic as legacy executor)
  const nodeInput =
    node.deps.length === 0
      ? dagInput
      : node.deps.length === 1
        ? outputs.get(node.deps[0])
        : Object.fromEntries(node.deps.map((d) => [d, outputs.get(d)]));

  // FR-025: validate input
  const inputResult = validateInput(node.inputSchema, nodeInput, nodeId);
  if (!inputResult.ok) return inputResult;

  return withNodeSpan(nodeId, node.kind, inputResult.value, meta, async () => {
    const nodeStart = Date.now();
    emit(ctx, { type: "node-start", runId: ctx.runId, dagId, nodeId, timestamp: new Date() });

    let runResult: Result<any, any>;
    try {
      runResult = await node.run(inputResult.value, ctx);
    } catch (e) {
      emit(ctx, {
        type: "node-error",
        runId: ctx.runId,
        dagId,
        nodeId,
        timestamp: new Date(),
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
      return err({
        kind: "node-crash" as const,
        nodeId,
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
    }

    if (!runResult.ok) {
      const frameworkError: FrameworkError =
        runResult.error !== null &&
        typeof runResult.error === "object" &&
        "kind" in runResult.error
          ? (runResult.error as FrameworkError)
          : { kind: "node-crash" as const, nodeId, message: String(runResult.error) };

      const errorMsg =
        frameworkError.kind === "node-crash"
          ? frameworkError.message
          : JSON.stringify(frameworkError);

      emit(ctx, {
        type: "node-error",
        runId: ctx.runId,
        dagId,
        nodeId,
        timestamp: new Date(),
        error: errorMsg,
      });
      return err(frameworkError);
    }

    // FR-025: validate output
    const outputResult = validateOutput(node.outputSchema, runResult.value, nodeId);
    if (!outputResult.ok) {
      emit(ctx, {
        type: "node-error",
        runId: ctx.runId,
        dagId,
        nodeId,
        timestamp: new Date(),
        error: `output validation failed: ${JSON.stringify((outputResult.error as FrameworkError))}`,
      });
      return outputResult;
    }

    const duration = Date.now() - nodeStart;
    outputs.set(nodeId, outputResult.value);

    emit(ctx, {
      type: "node-end",
      runId: ctx.runId,
      dagId,
      nodeId,
      timestamp: new Date(),
      duration,
      output: outputResult.value,
    });

    return ok(outputResult.value);
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
    meta?: DagRunMeta;
  },
): Executor<DagPhase, DagMachineContext, DagEvent> => {
  const nodeMap = new Map<string, NodeDef<any, any, any>>(
    dag.nodes.map((n) => [n.id, n]),
  );
  const meta = hooks?.meta;

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
        const delayWithJitter = applyJitter(p.nextDelayMs, jitterRatio);
        await sleep(delayWithJitter);

        // Re-run the whole wave (other nodes in the wave may have already
        // succeeded on previous attempt; outputs are in machineCtx.outputs).
        // We only re-run the failed node, then run the rest that haven't completed yet.
        return runWave(p.wave, machineCtx, dag, nodeMap, nodeCtx, meta);
      })

      // -----------------------------------------------------------------------
      // running: run the current wave
      // -----------------------------------------------------------------------
      .with({ kind: "running" }, (p) => runWave(p.wave, machineCtx, dag, nodeMap, nodeCtx, meta))

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
        const delayWithJitter = applyJitter(p.nextDelayMs, jitterRatio);
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
  nodeMap: Map<string, NodeDef<any, any, any>>,
  nodeCtx: NodeContext,
  meta: DagRunMeta | undefined,
): Promise<DagEvent> => {
  const waveNodeIds = machineCtx.waves[waveIndex] ?? [];

  // Build a mutable outputs map for this wave execution.
  // Pre-seed with existing outputs so deps from earlier waves resolve.
  const outputs = new Map<string, unknown>(machineCtx.outputs);

  // Run all wave nodes concurrently
  const results = await Promise.all(
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
        return { nodeId, result: ok(machineCtx.outputs.get(nodeId)) as Result<unknown, FrameworkError> };
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
        };
      }

      const result = await runNode(node, machineCtx.initialInput, nodeCtx, dag.id, outputs, meta);
      return { nodeId, result };
    }),
  );

  // Collect new outputs + check for failures.
  // M2 fix: collect all succeeded sibling outputs before returning the first failure,
  // so they can be persisted into ctx.outputs and skipped on retry.
  // Fix 1: collect ALL failures (not just the first) so co-failed siblings get their
  // retry counters pre-incremented, preventing off-by-one retry accounting.
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

  return {
    type: "wave-done",
    wave: waveIndex,
    outputs: newOutputs,
  };
};
