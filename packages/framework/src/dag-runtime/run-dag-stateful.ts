// runDagStateful — orchestrates the DAG executor with the state-machine runner.
// Stateful DAG lifecycle, input/output validation, retry with backoff.
//
// This file is intentionally orchestration-only. It composes helpers from
// sibling modules; add new behaviour to the matching helper, not here.

import { match } from "ts-pattern";
import type { JobLike, KernelRunOpts } from "../state-machine/types.js";
import type { DagPhase, DagEvent, DagMachineContext, DagMachineContextPersisted, HumanAction } from "./types.js";
import { EXECUTOR_NODE_ID } from "./types.js";
import type { DagDef } from "../types/dag.js";
import { withRetryLimits } from "../types/dag.js";
import type { NodeContext } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import { type Result, ok, err } from "../types/result.js";
import { FrameworkAugmentedError } from "../types/errors.js";
import { createInMemoryJob } from "../queue/in-memory-job.js";
import { runStateMachine } from "../state-machine/runner.js";
import { compileDagToMachine } from "./machine.js";
import { buildDagExecutor } from "./executor.js";
import { finalizeRunWithJudges, runFinalizeInBackground } from "./eval-judges.js";
import { createDagRunMeta, foldOutcomes, type DagRunMeta, type NodeSpanOutcome } from "./node-span.js";
import { validateCapabilities } from "../shared/capabilities.js";
import { wrapDagJobLike } from "./persistence.js";
import { beginRunTelemetry, closeRootSpan, startRunSpan } from "./run-telemetry.js";
import type { FreshnessIndex } from "./freshness-check.js";
import { sha256DedupKey } from "../shared/dedup-key.js";
import { fwLogger } from "../logger.js";

// ---------------------------------------------------------------------------
// DagRunOpts — caller-supplied options for runDagStateful
// ---------------------------------------------------------------------------

/** Result of background judge finalization, surfaced via `onBackground`. */
export interface BackgroundResult {
  /** True when all judges returned `passed: true`. */
  readonly judgesPassed: boolean;
  /** True when any judge crashed (threw unexpectedly). */
  readonly judgesCrashed: boolean;
  /** Full run meta including eval-judge results and guardrail state. */
  readonly meta: DagRunMeta;
}

export interface DagRunOpts
  extends Omit<KernelRunOpts<DagPhase, DagEvent, DagMachineContext>, "errorEventOf" | "computeDedupKey" | "logger"> {
  /** Provide a durable job backend (BullMQ, etc.). Falls back to in-memory when omitted.
   * Typed against `DagMachineContextPersisted` — the serialization-safe subset.
   * The runtime re-injects live DAG-derived fields (closures, schemas) on read.
   */
  readonly jobLike?: JobLike<DagPhase, unknown, DagMachineContextPersisted>;
  /**
   * Human-review hook. Called when the DAG enters `awaiting-human`.
   * The resolved action is delivered to the machine as `human-responded`.
   */
  readonly onHumanReview?: (req: {
    nodeId: string;
    output: unknown;
    prompt: string;
  }) => Promise<HumanAction>;
  /**
   * Per-node retry limits passed at call time — merged with (and takes precedence over)
   * DagDef.retryLimits. Allows callers to override retry budgets without mutating the DAG.
   */
  readonly retryLimits?: Readonly<Record<string, number>>;
  /**
   * When supplied, eval-judges run in the background after the run resolves
   * `ok`. The hook receives a promise that resolves with a typed result
   * indicating whether judges passed, crashed, or failed quality gates.
   * When omitted, judges still run before resolution.
   */
  readonly onBackground?: (p: Promise<BackgroundResult>) => void;
  /**
   * Checkpoint replay for crash-resume scenarios. When provided, nodes whose
   * ids appear in this Map are skipped on first encounter: their cached
   * output is validated against the node's current `outputSchema` and a
   * `node-skipped` observer event is emitted. On validation failure the
   * runtime emits `node-error` and aborts the run with `Err({kind: "validation"})`,
   * matching `resumeRun(...)` semantics.
   */
  readonly resumeCheckpoint?: Map<string, unknown>;
  /**
   * RNG seam for retry-backoff jitter. Defaults to `Math.random`; tests pass
   * a seeded deterministic source.
   */
  readonly random?: () => number;
  /**
   * In-memory freshness index for single-process witness tracking. When
   * omitted, a private instance is created per executor. Pass a shared
   * instance to enable cross-DAG freshness detection within a process.
   */
  readonly freshnessIndex?: FreshnessIndex;
}

// ---------------------------------------------------------------------------
// runDagStateful
// ---------------------------------------------------------------------------

/**
 * Run a DAG through the state-machine kernel, using a durable `JobLike` for
 * checkpointing. Falls back to an in-memory `JobLike` when `opts.jobLike` is
 * not supplied.
 *
 * Returns `ok(output)` when the DAG reaches `succeeded`, `err(error)` when
 * the machine ends in a `failed` terminal state.
 *
 * Observer events (run-start, node-start, node-end, node-error, run-end) are
 * emitted here so consumers see the full run-start / node-start / node-end /
 * run-end stream regardless of the execution path.
 */
export const runDagStateful = async <I, O>(
  dag: DagDef,
  input: I,
  nodeCtx: NodeContext,
  opts?: DagRunOpts,
): Promise<Result<O, FrameworkError>> => {
  // Merge call-time retryLimits (takes precedence) into dag before compiling.
  // getRetryLimit reads from ctx.dag.retryLimits, so this is the correct wiring point.
  // withRetryLimits preserves the DagDef brand instead of laundering it via spread.
  const effectiveDag: DagDef =
    opts?.retryLimits !== undefined ? withRetryLimits(dag, opts.retryLimits) : dag;

  // Emit run-start BEFORE compile so a malformed DAG still produces a balanced
  // run-start/run-end pair. Otherwise observers see neither and the failure is
  // invisible from the event stream.
  const { emitRunEnd } = beginRunTelemetry(nodeCtx, dag, { now: opts?.now });

  // Capability validation at run start. On success, hands back a phantom-
  // branded `ValidatedNodeContext` token — `runNodeShared` requires it, so
  // any code path that bypasses this check fails to typecheck.
  const capCheck = validateCapabilities(effectiveDag, nodeCtx);
  if (!capCheck.ok) {
    emitRunEnd("error");
    return err(capCheck.error);
  }
  const validatedCtx = capCheck.value;

  return startRunSpan(dag, nodeCtx, async (rootSpan): Promise<Result<O, FrameworkError>> => {
    // Compile inside the span so topo errors are funneled through the same
    // observer/trace path as runtime failures.
    const compiled = compileDagToMachine(effectiveDag, input);
    if (!compiled.ok) {
      closeRootSpan(rootSpan, { kind: "error", error: compiled.error });
      emitRunEnd("error");
      return err(compiled.error);
    }
    const { machine, initialContext, initialState } = compiled.value;

    // Per-run meta — carries guardrail/eval-judge state for rootSpan finalization.
    // Held in `let` so each wave can fold in its outcomes via recordOutcomes;
    // the inner DagRunMeta value remains immutable.
    let meta: DagRunMeta = createDagRunMeta();
    const recordOutcomes = (outcomes: readonly NodeSpanOutcome[]): void => {
      meta = foldOutcomes(meta, outcomes);
    };

    // Build the executor closure (uses the validated-capabilities token).
    const executor = buildDagExecutor(effectiveDag, validatedCtx, {
      onHumanReview: opts?.onHumanReview,
      recordOutcomes,
      resumeCheckpoint: opts?.resumeCheckpoint,
      random: opts?.random,
      now: opts?.now,
      freshnessIndex: opts?.freshnessIndex,
    });

    // Resolve the job handle — caller-supplied or fresh in-memory.
    //
    // When `opts.jobLike` is provided, the runner reads
    // `job.data` (the checkpointed state + context) — `initialState` and
    // `initialContext` are unused. In particular, the call-time `input`
    // argument is intentionally ignored on resume; the resumed run's
    // `ctx.initialInput` comes from the original enqueue's checkpoint.
    // `compileDagToMachine` is still called above so the DAG's topology
    // (cycle detection) is re-validated on every entry; the resulting
    // `initialContext` is then dropped for resumed runs.
    let job: JobLike<DagPhase, unknown, DagMachineContext>;
    if (opts?.jobLike) {
      const wrapped = wrapDagJobLike(opts.jobLike, effectiveDag, nodeCtx.runId);
      const fingerprintCheck = wrapped.verifyDagFingerprint();
      if (!fingerprintCheck.ok) {
        closeRootSpan(rootSpan, { kind: "error", error: fingerprintCheck.error });
        emitRunEnd("error");
        return err(fingerprintCheck.error);
      }
      job = wrapped.job;
    } else {
      job = createInMemoryJob<DagPhase, DagMachineContext>({
        state: initialState,
        context: initialContext,
      });
    }

    // errorEventOf adapter — converts classified errors to DagEvent ERROR
    const errorEventOf = (classified: { retriable: boolean; message: string }): DagEvent => ({
      type: "executor-error",
      retriable: classified.retriable,
      error: classified.message,
    });

    const runOpts: KernelRunOpts<DagPhase, DagEvent, DagMachineContext> = {
      beforeExecute: opts?.beforeExecute,
      classifyError: opts?.classifyError,
      onTrace: opts?.onTrace,
      errorEventOf,
      now: opts?.now,
      computeDedupKey: sha256DedupKey,
      logger: fwLogger(),
    };

    try {
      const { state, context } = await runStateMachine(job, machine, executor, runOpts);

      return await match(state)
        .returnType<Promise<Result<O, FrameworkError>>>()
        .with({ kind: "succeeded" }, async (s) => {
          // Background mode (onBackground supplied) resolves the caller before
          // judges finish, so request-bound timeouts don't block on judge I/O.
          const finalize = (): Promise<DagRunMeta> =>
            finalizeRunWithJudges(
              rootSpan,
              dag,
              input,
              s.output,
              context.outputs,
              nodeCtx,
              meta,
              emitRunEnd,
            );

          if (opts?.onBackground) {
            opts.onBackground(runFinalizeInBackground(finalize, rootSpan, emitRunEnd));
          } else {
            await finalize();
          }
          return ok(s.output as O);
        })
        // state.kind === "failed" — can happen when job was pre-loaded with a failed state
        // (runStateMachine skips the loop entirely when already terminal)
        .with({ kind: "failed" }, async (s) => {
          closeRootSpan(rootSpan, { kind: "error", error: s.error });
          emitRunEnd("error");
          return err(s.error);
        })
        // Unexpected non-terminal states — should not be reached
        .with({ kind: "pending" }, async (s) =>
          unexpectedNonTerminal(rootSpan, emitRunEnd, s.kind, EXECUTOR_NODE_ID),
        )
        .with({ kind: "running" }, async (s) =>
          unexpectedNonTerminal(rootSpan, emitRunEnd, s.kind, EXECUTOR_NODE_ID),
        )
        .with({ kind: "retrying" }, async (s) =>
          unexpectedNonTerminal(rootSpan, emitRunEnd, s.kind, EXECUTOR_NODE_ID),
        )
        .with({ kind: "retrying-hook" }, async (s) =>
          unexpectedNonTerminal(rootSpan, emitRunEnd, s.kind, s.nodeId),
        )
        .with({ kind: "awaiting-human" }, async (s) =>
          unexpectedNonTerminal(rootSpan, emitRunEnd, s.kind, EXECUTOR_NODE_ID),
        )
        .exhaustive();
    } catch (e) {
      // The kernel throws on terminal-failed (FR-007) and beforeExecute abort.
      // Split handling: abort gets `kind: "aborted"`, terminal-failed uses the
      // structured error captured via onTrace (synchronous, always populated
      // before the throw).
      const isAbort = e instanceof Error && e.message.includes("aborted by beforeExecute");
      if (isAbort) {
        const error: FrameworkError = { kind: "aborted", reason: "beforeExecute hook returned false" };
        closeRootSpan(rootSpan, { kind: "error", error });
        emitRunEnd("error");
        return err(error);
      }
      // Terminal-failed: the kernel attaches { state, context } to Error.cause.
      const cause = (e as Error)?.cause as { state?: DagPhase } | undefined;
      const failedState = cause?.state?.kind === "failed"
        ? (cause.state as Extract<DagPhase, { kind: "failed" }>)
        : undefined;
      const error: FrameworkError = failedState?.error ?? {
        kind: "node-crash",
        nodeId: EXECUTOR_NODE_ID,
        retriability: "retriable",
        message: e instanceof Error ? e.message : String(e),
      };
      closeRootSpan(rootSpan, { kind: "error", error });
      emitRunEnd("error");
      return err(error);
    }
  });
};

// ---------------------------------------------------------------------------
// unexpectedNonTerminal — invariant violation: runStateMachine returned without a terminal state
// ---------------------------------------------------------------------------

const unexpectedNonTerminal = <O>(
  rootSpan: import("@opentelemetry/api").Span,
  emitRunEnd: (status: "ok" | "error") => void,
  kind: string,
  nodeId: NodeId,
): Result<O, FrameworkError> => {
  const message = `runDagStateful: unexpected non-terminal state ${kind}`;
  const error: FrameworkError = {
    kind: "node-crash",
    nodeId,
    retriability: "retriable",
    message,
  };
  closeRootSpan(rootSpan, { kind: "error", error });
  emitRunEnd("error");
  return err(error);
};

// ---------------------------------------------------------------------------
// runDagAsWorkerJob — queue worker entry point
// ---------------------------------------------------------------------------

/**
 * Wrapper around `runDagStateful` for use inside a queue worker's `process`
 * callback. Re-throws on `err` so the queue (BullMQ) sees the failure and
 * applies its retry / DLQ policy.
 *
 * Why this exists:
 *   `runDagStateful` returns `Result<O, FrameworkError>`. A worker that simply
 *   awaits it without rethrowing on `!ok` will **silently ack failed jobs**,
 *   bypassing queue-level `attempts` and dead-letter handlers. Use this helper
 *   from `createWorker(name, async (job) => runDagAsWorkerJob(...))` so failed
 *   runs reach `WorkerHandle.onFailed`.
 */
export const runDagAsWorkerJob = async <I, O>(
  dag: DagDef,
  input: I,
  nodeCtx: NodeContext,
  opts?: DagRunOpts,
): Promise<O> => {
  const result = await runDagStateful<I, O>(dag, input, nodeCtx, opts);
  if (!result.ok) {
    const detail =
      result.error.kind === "node-crash"
        ? result.error.message
        : JSON.stringify(result.error);
    const thrownError = new FrameworkAugmentedError(
      `runDagAsWorkerJob: DAG '${dag.id}' failed: ${detail}`,
      result.error,
    );
    throw thrownError;
  }
  return result.value;
};
