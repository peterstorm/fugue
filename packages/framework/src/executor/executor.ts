// runDag — public runtime entry point. All DAG runs flow through
// `runDagStateful` (ADR-0021). Responsibilities:
//   1. Bidirectional HITL contract — reject if the DAG declares `humanReview`
//      without an `onHumanReview` hook, and reject the inverse.
//   2. Durability advisory (ADR-0019) — warn when the DAG declares retries
//      or conditional edges but the caller did not provide a durable jobLike.
//   3. Translate the public `resume: { runId, checkpoint }` shape into
//      `runDagStateful`'s `resumeCheckpoint`.

import type { DagDef } from "../types/dag.js";
import { isConditionalEdge, isDefaultEdge } from "../types/dag.js";
import type { NodeContext } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { JobLike } from "../state-machine/types.js";
import type { DagPhase, DagMachineContext, HumanAction } from "../dag-runtime/types.js";
import { type Result, err } from "../types/result.js";
import { runDagStateful, type DagRunOpts } from "../dag-runtime/run-dag-stateful.js";

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
  readonly onBackground?: (p: Promise<void>) => void;
  /**
   * Durable job handle for checkpoint/resume. When omitted, an in-memory
   * `JobLike` is used (runtime semantics preserved; durability across worker
   * crashes is not).
   */
  readonly jobLike?: JobLike<DagPhase, unknown, DagMachineContext>;
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
   * warning (ADR 0019). Default `false`. Set to `true` when in-memory
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
}

export const runDag = async <I, O>(
  dag: DagDef,
  input: I,
  ctx: NodeContext,
  opts?: RunOptions,
): Promise<Result<O, FrameworkError>> => {
  const hitlNodes = dag.nodes.filter((n) => n.humanReview !== undefined);
  const dagDeclaresHITL = hitlNodes.length > 0;

  // HITL bidirectional contract — symmetric to keep mistakes loud.
  if (dagDeclaresHITL && !opts?.onHumanReview) {
    return err({
      kind: "node-crash",
      retriability: "retriable",
      nodeId: "__executor__",
      message: `[runDag] DAG declares humanReview node(s) [${hitlNodes.map((n) => n.id).join(", ")}] but no \`onHumanReview\` hook supplied`,
    });
  }
  if (!dagDeclaresHITL && opts?.onHumanReview !== undefined) {
    return err({
      kind: "node-crash",
      retriability: "retriable",
      nodeId: "__executor__",
      message: "[runDag] `onHumanReview` hook supplied but no node declares `humanReview`",
    });
  }

  // ADR-0019 advisory — durability across crashes requires a durable jobLike.
  // The in-memory fallback preserves runtime semantics but not durability.
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

  const stateMachineOpts: DagRunOpts = {
    jobLike: opts?.jobLike,
    onHumanReview: opts?.onHumanReview,
    retryLimits: opts?.retryLimits,
    onBackground: opts?.onBackground,
    resumeCheckpoint: opts?.resume?.checkpoint,
    now: opts?.now,
  };
  return runDagStateful<I, O>(dag, input, ctx, stateMachineOpts);
};

export const resumeRun = async <O>(
  runId: string,
  dag: DagDef,
  ctx: NodeContext,
  checkpoint: Map<string, unknown>,
): Promise<Result<O, FrameworkError>> => {
  return runDag(dag, undefined, ctx, { resume: { runId, checkpoint } });
};
