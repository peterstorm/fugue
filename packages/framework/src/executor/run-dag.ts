// runDag — the single public runtime entry point for DAG execution.
//
// All DAG runs flow through this function (ADR-0021). Responsibilities:
//   1. Pre-flight validation: HITL contract, durability advisory.
//   2. Translate options into the kernel's internal DagRunOpts.
//   3. Delegate to `runDagStateful` (in dag-runtime/run-dag-stateful.ts)
//      for the state-machine kernel invocation.
//
// `runDagAsWorkerJob` (on the `/advanced` subpath) wraps this function,
// rethrowing on Err so the queue layer sees the failure.

import type { DagDef } from "../types/dag.js";
import { isConditionalEdge, isDefaultEdge } from "../types/dag.js";
import type { NodeContext } from "../types/node.js";
import type { MintingAuthority } from "../types/capability-broker.js";
import type { FrameworkError } from "../types/errors.js";
import type { JobLike, KernelRunOpts } from "../state-machine/types.js";
import type { DagPhase, DagEvent, DagMachineContext, DagMachineContextPersisted, HumanReviewOutcome } from "../dag-runtime/types.js";
import { EXECUTOR_NODE_ID } from "../dag-runtime/types.js";
import type { NodeId } from "../types/ids.js";
import { type Result, ok, err } from "../types/result.js";
import { FrameworkAugmentedError } from "../types/errors.js";
import { runDagStatefulOutcome as runDagStatefulInternal, type BackgroundResult, type StatefulOutcome } from "../dag-runtime/run-dag-stateful.js";
import type { FreshnessIndex } from "../dag-runtime/freshness-check.js";

export type { BackgroundResult, StatefulOutcome } from "../dag-runtime/run-dag-stateful.js";

export interface RunOptions {
  /**
   * Crash-resume checkpoint. Nodes in `checkpoint` are skipped (with their
   * output validated against the current `outputSchema`) on first encounter;
   * remaining nodes run normally. `runId` is informational and is expected
   * to match `ctx.runId` for the resumed run.
   *
   * @see ADR-0017 — checkpoint fingerprinting and version-mismatch detection
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
   *
   * @see ADR-0025 — HumanInterventionEvent telemetry design
   */
  readonly onHumanReview?: (req: { nodeId: import("../types/ids.js").NodeId; output: unknown; prompt: string }) => Promise<HumanReviewOutcome>;
  /**
   * ADR-0060: effectively-once decision consumption. Invoked with the resolved
   * gate's `nodeId` AFTER the post-gate state is durably checkpointed, so a host
   * can clear a consumed decision only once it is safe to — a crash before the
   * checkpoint re-reads the decision on resume rather than losing it.
   */
  readonly onDecisionConsumed?: (nodeId: import("../types/ids.js").NodeId) => void | Promise<void>;
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
   *
   * @see ADR-0024 — freshness witness contract design
   */
  readonly freshnessIndex?: FreshnessIndex;
  /**
   * Per-invocation minting authority (ADR-0053): the broker AND the origin it
   * authorizes against, as one value — `broker`-without-`origin` is not
   * representable. When supplied, each node's declared `requires` are resolved
   * through `broker.mintFor` AT DISPATCH (against an `Invocation` built from
   * `origin` + the real `nodeId`), and the minted narrowly-scoped handles are
   * merged over the node context for that node only — broker-resolvable
   * `"<provider>:<operation>"` scopes get their narrowed handle, plain
   * capabilities keep their static client. A mint refusal fails the node
   * fail-closed. Omitted ⇒ the node context is used as-is (zero-regression).
   *
   * The broker must remain host-agnostic at this seam: the framework never
   * inspects scope names; it forwards `node.requires` verbatim and merges
   * whatever the broker returns.
   */
  readonly minting?: MintingAuthority;

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
 * Shared pre-flight + kernel invocation, returning the full `StatefulOutcome`
 * (completed | suspended) on the `ok` channel. Both the synchronous `runDag` and
 * the resumable `runResumableDagJob` delegate here so the HITL contract and
 * durability advisory live in one place; they differ only in how they surface a
 * `suspended` outcome (ADR-0060).
 */
const runDagToOutcome = async <I, O>(
  dag: DagDef,
  input: I,
  ctx: NodeContext,
  opts?: RunOptions,
): Promise<Result<StatefulOutcome<O>, FrameworkError>> => {
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
    onDecisionConsumed: opts?.onDecisionConsumed,
    retryLimits: opts?.retryLimits,
    onBackground: opts?.onBackground,
    resumeCheckpoint: opts?.resume?.checkpoint,
    now: opts?.now,
    random: opts?.random,
    freshnessIndex: opts?.freshnessIndex,
    minting: opts?.minting,
    beforeExecute: opts?.beforeExecute,
    classifyError: opts?.classifyError,
    onTrace: opts?.onTrace,
  });
};

export const runDag = async <I, O>(
  dag: DagDef,
  input: I,
  ctx: NodeContext,
  opts?: RunOptions,
): Promise<Result<O, FrameworkError>> => {
  const outcome = await runDagToOutcome<I, O>(dag, input, ctx, opts);
  if (!outcome.ok) return outcome;
  // ADR-0060: a synchronous `runDag` cannot pause. A `suspended` outcome means
  // the caller supplied a `pending`-returning hook to a synchronous run — a
  // misuse. Surface it as an invariant error rather than silently swallowing a
  // paused run; durable HITL runs must use `runResumableDagJob`.
  if (outcome.value.kind === "suspended") {
    return err({
      kind: "node-crash",
      retriability: "non-retriable",
      nodeId: EXECUTOR_NODE_ID,
      message: `[runDag] DAG '${dag.id}' suspended at human gate '${outcome.value.nodeId}' — a synchronous runDag cannot pause; use runResumableDagJob with a durable jobLike for HITL runs.`,
    });
  }
  return ok(outcome.value.output);
};

/**
 * Outcome of a resumable worker run (ADR-0060): the DAG either `completed` with
 * its output, or `suspended` at a human gate. Unlike `runDagAsWorkerJob`, a
 * suspend is NOT an error — the worker should ack the job and let an out-of-band
 * approval re-enqueue it to resume from the durably-persisted state.
 */
export type WorkerJobOutcome<O> =
  | { readonly kind: "completed"; readonly output: O }
  | { readonly kind: "suspended"; readonly nodeId: NodeId; readonly prompt: string };

/**
 * Worker entry for DURABLE, suspendable DAG runs (ADR-0060). Like
 * `runDagAsWorkerJob` it re-throws on a genuine `Err` so the queue (BullMQ) sees
 * the failure and applies its retry / DLQ policy — but it returns a `suspended`
 * outcome WITHOUT throwing, so a run parked at a human gate cleanly completes the
 * job (ack) and stays parked in its durable `jobLike` until an approval
 * re-enqueues it. Requires a durable `opts.jobLike` for resume to survive a
 * worker restart; with an in-memory job the suspend is still returned but the
 * parked state is lost on process exit.
 */
export const runResumableDagJob = async <I, O>(
  dag: DagDef,
  input: I,
  ctx: NodeContext,
  opts?: RunOptions,
): Promise<WorkerJobOutcome<O>> => {
  const result = await runDagToOutcome<I, O>(dag, input, ctx, opts);
  if (!result.ok) {
    const detail =
      result.error.kind === "node-crash"
        ? result.error.message
        : JSON.stringify(result.error);
    throw new FrameworkAugmentedError(
      `runResumableDagJob: DAG '${dag.id}' failed: ${detail}`,
      result.error,
    );
  }
  if (result.value.kind === "suspended") {
    return { kind: "suspended", nodeId: result.value.nodeId, prompt: result.value.prompt };
  }
  return { kind: "completed", output: result.value.output };
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
