// runDag — the single public runtime entry point for DAG execution.
//
// All DAG runs flow through this function (ADR-0021). Responsibilities:
//   1. Pre-flight validation: HITL contract, durability advisory.
//   2. Translate options into the kernel's internal DagRunOpts.
//   3. Delegate to `runDagStateful` for the state-machine kernel invocation.
//
// `runDagStateful` and `runDagAsWorkerJob` on the `/advanced` subpath are
// thin wrappers around this function for backward compatibility.

import type { DagDef } from "../types/dag.js";
import { isConditionalEdge, isDefaultEdge } from "../types/dag.js";
import type { NodeContext } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { JobLike, KernelRunOpts } from "../state-machine/types.js";
import type { DagPhase, DagEvent, DagMachineContext, DagMachineContextPersisted, HumanAction } from "../dag-runtime/types.js";
import { EXECUTOR_NODE_ID } from "../dag-runtime/types.js";
import { type Result, err } from "../types/result.js";
import { FrameworkAugmentedError } from "../types/errors.js";
import { runDagStateful as runDagStatefulInternal, type BackgroundResult } from "../dag-runtime/run-dag-stateful.js";
import type { FreshnessIndex } from "../dag-runtime/freshness-check.js";

export type { BackgroundResult } from "../dag-runtime/run-dag-stateful.js";

export interface RunOptions {
  /**
   * Crash-resume checkpoint. Nodes in `checkpoint` are skipped (with their
   * output validated against the current `outputSchema`) on first encounter;
   * remaining nodes run normally. `runId` is informational and is expected
   * to match `ctx.runId` for the resumed run.
   */
  readonly resume?: {
    readonly runId: string;
    readonly checkpoint: Map<string, unknown>;
  };
  /** Called with a promise that resolves when background work (eval-judge) completes. */
  readonly onBackground?: (p: Promise<BackgroundResult>) => void;
  /**
   * Durable job handle for checkpoint/resume. When omitted, an in-memory
   * `JobLike` is used (runtime semantics preserved; durability across worker
   * crashes is not).
   */
  readonly jobLike?: JobLike<DagPhase, unknown, DagMachineContextPersisted>;
  /**
   * Human-review hook — required when any node in the DAG declares
   * `humanReview`; rejected otherwise.
   */
  readonly onHumanReview?: (req: { nodeId: string; output: unknown; prompt: string }) => Promise<HumanAction>;
  /**
   * Per-call retry limit overrides, merged with (and taking precedence over)
   * `DagDef.retryLimits`.
   */
  readonly retryLimits?: Readonly<Record<string, number>>;
  /**
   * Suppress the "DAG declares retries/conditional edges but no `jobLike`"
   * warning. Default `false`. Set to `true` when in-memory
   * semantics are the deliberate intent (tests, transient batch jobs).
   */
  readonly suppressRoutingWarnings?: boolean;
  /**
   * Wall-clock source for observer-event `timestamp` fields and the kernel's
   * `durationMs` measurement. Threaded through into every observer event
   * (`run-start`, `node-start`, `node-end`, `run-end`, ...). Defaults to
   * `Date.now`; tests pass a deterministic clock so event ordering is
   * reproducible across replays.
   */
  readonly now?: () => number;
  /**
   * RNG seam for retry-backoff jitter. Defaults to `Math.random`; tests pass
   * a seeded deterministic source.
   */
  readonly random?: () => number;
  /**
   * Shared freshness index for cross-DAG detection within a process. When
   * omitted, a private instance is created per executor.
   */
  readonly freshnessIndex?: FreshnessIndex;

  // ─── Advanced kernel hooks (rarely needed outside tests) ───────────────

  /**
   * Called before each executor invocation. Return `false` to abort the run.
   * Primarily used by tests to simulate mid-run aborts.
   */
  readonly beforeExecute?: KernelRunOpts<DagPhase, DagEvent, DagMachineContext>["beforeExecute"];
  /**
   * Error classifier for executor exceptions. Maps raw errors to
   * `{ retriable, message }` for the kernel's error-event construction.
   */
  readonly classifyError?: KernelRunOpts<DagPhase, DagEvent, DagMachineContext>["classifyError"];
  /**
   * Trace callback — invoked after each state transition with the previous
   * state, event, next state, outcome, and duration.
   */
  readonly onTrace?: KernelRunOpts<DagPhase, DagEvent, DagMachineContext>["onTrace"];
}

/**
 * @deprecated Use `RunOptions` directly. `DagRunOpts` is retained as an alias
 * for backward compatibility on the `/advanced` subpath.
 */
export type DagRunOpts = RunOptions;

export const runDag = async <I, O>(
  dag: DagDef,
  input: I,
  ctx: NodeContext,
  opts?: RunOptions,
): Promise<Result<O, FrameworkError>> => {
  const hitlNodes = dag.nodes.filter((n) => n.humanReview !== undefined);
  const dagDeclaresHITL = hitlNodes.length > 0;

  // HITL contract — DAG declares human review but caller didn't supply the hook.
  if (dagDeclaresHITL && !opts?.onHumanReview) {
    return err({
      kind: "node-crash",
      retriability: "retriable",
      nodeId: EXECUTOR_NODE_ID,
      message: `[runDag] DAG declares humanReview node(s) [${hitlNodes.map((n) => n.id).join(", ")}] but no \`onHumanReview\` hook supplied`,
    });
  }

  // Durability advisory — durability across crashes requires a durable jobLike.
  const dagDeclaresRetries =
    dag.defaultRetryLimit !== undefined ||
    (dag.retryLimits !== undefined && Object.keys(dag.retryLimits).length > 0);
  const dagDeclaresConditionalEdges = dag.edges.some(
    (e) => isConditionalEdge(e) || isDefaultEdge(e),
  );
  if (
    !opts?.jobLike &&
    !opts?.suppressRoutingWarnings &&
    (dagDeclaresRetries || dagDeclaresConditionalEdges)
  ) {
    ctx.logger?.warn?.(
      "[runDag] DAG declares retries/conditional edges but no `jobLike` provided — runtime semantics intact, but durability across worker crashes is not guaranteed.",
    );
  }

  return runDagStatefulInternal<I, O>(dag, input, ctx, {
    jobLike: opts?.jobLike,
    onHumanReview: opts?.onHumanReview,
    retryLimits: opts?.retryLimits,
    onBackground: opts?.onBackground,
    resumeCheckpoint: opts?.resume?.checkpoint,
    now: opts?.now,
    random: opts?.random,
    freshnessIndex: opts?.freshnessIndex,
    beforeExecute: opts?.beforeExecute,
    classifyError: opts?.classifyError,
    onTrace: opts?.onTrace,
  });
};

/**
 * Resume a previously-failed run from a checkpoint. Convenience wrapper
 * around `runDag` with the `resume` option.
 */
export const resumeRun = async <O>(
  runId: string,
  dag: DagDef,
  ctx: NodeContext,
  checkpoint: Map<string, unknown>,
): Promise<Result<O, FrameworkError>> => {
  return runDag(dag, undefined, ctx, { resume: { runId, checkpoint } });
};

/**
 * Wrapper around `runDag` for use inside a queue worker's `process` callback.
 * Re-throws on `err` so the queue (BullMQ) sees the failure and applies its
 * retry / DLQ policy.
 *
 * `runDag` returns `Result<O, FrameworkError>`. A worker that simply awaits it
 * without rethrowing on `!ok` would **silently ack failed jobs**, bypassing
 * queue-level `attempts` and dead-letter handlers.
 */
export const runDagAsWorkerJob = async <I, O>(
  dag: DagDef,
  input: I,
  ctx: NodeContext,
  opts?: RunOptions,
): Promise<O> => {
  const result = await runDag<I, O>(dag, input, ctx, opts);
  if (!result.ok) {
    const detail =
      result.error.kind === "node-crash"
        ? result.error.message
        : JSON.stringify(result.error);
    throw new FrameworkAugmentedError(
      `runDagAsWorkerJob: DAG '${dag.id}' failed: ${detail}`,
      result.error,
    );
  }
  return result.value;
};
