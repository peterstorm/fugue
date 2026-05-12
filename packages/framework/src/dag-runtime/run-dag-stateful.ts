// runDagStateful — orchestrates the DAG executor with the state-machine runner
// FR-023, FR-024, FR-025, FR-027

import { match } from "ts-pattern";
import { SpanStatusCode } from "@opentelemetry/api";
import { fwTracer } from "../tracing/global-tracer.js";
import type { JobLike, RunOptions } from "../state-machine/types.js";
import type { DagPhase, DagEvent, DagMachineContext, HumanAction } from "./types.js";
import type { DagDef } from "../types/dag.js";
import { withRetryLimits } from "../types/dag.js";
import type { NodeContext } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import { type Result, ok, err } from "../types/result.js";
import { createInMemoryJob } from "../queue/in-memory-job.js";
import { runStateMachine } from "../state-machine/runner.js";
import { compileDagToMachine } from "./machine.js";
import { buildDagExecutor } from "./executor.js";
import { runEvalJudges } from "./eval-judges.js";
import { computeIncomingByNode } from "./conditional.js";
import { createDagRunMeta, foldOutcomes, type DagRunMeta, type NodeSpanOutcome } from "../shared/node-span.js";
import { validateCapabilities } from "../shared/capabilities.js";
import { dispatchEvent } from "../observer/buffered.js";
import { fwLogger } from "../logger.js";
import {
  AI_SPAN_TYPE,
  AI_DAG_ID,
  AI_RUN_ID,
  EVENT_NODE_INPUT,
  EVENT_NODE_OUTPUT,
  SPAN_TYPE_CHAIN,
} from "../tracing/semantic-conventions.js";

// ---------------------------------------------------------------------------
// DagRunOpts — caller-supplied options for runDagStateful
// ---------------------------------------------------------------------------

export interface DagRunOpts
  extends Omit<RunOptions<DagPhase, DagEvent, DagMachineContext>, "errorEventOf"> {
  /** Provide a durable job backend (BullMQ, etc.). Falls back to in-memory when omitted. */
  readonly jobLike?: JobLike<DagPhase, unknown, DagMachineContext>;
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
   * `ok`. The hook receives a promise that resolves once judges + span
   * finalization complete. When omitted, judges still run before resolution.
   */
  readonly onBackground?: (p: Promise<void>) => void;
  /**
   * Checkpoint replay for crash-resume scenarios. When provided, nodes whose
   * ids appear in this Map are skipped on first encounter: their cached
   * output is validated against the node's current `outputSchema` and a
   * `node-skipped` observer event is emitted. On validation failure the
   * runtime emits `node-error` and aborts the run with `Err({kind: "validation"})`,
   * preserving the legacy `resumeRun(...)` semantics.
   */
  readonly resumeCheckpoint?: Map<string, unknown>;
  /**
   * RNG seam for retry-backoff jitter. Defaults to `Math.random`; tests pass
   * a seeded deterministic source.
   */
  readonly random?: () => number;
}

// ---------------------------------------------------------------------------
// JobLike context adapter
//
// DagMachineContext carries two fields that must NOT round-trip through
// durable storage:
//   - `dag`: contains `run` closures and Zod schemas that JSON-strip to `{}`
//   - `incomingByNode`: derived from `dag.edges`, redundant with `dag`
//
// `wrapDagJobLike` strips both fields on `updateData` and re-injects them
// from the live call-site values on `data` read. The persisted snapshot
// stays compact and schema-stable; transition-time code sees a fully-formed
// context.
//
// The internal type cast on the write side (Omit-then-cast-as-full) is the
// inverse of the re-injection on read — they compose to identity from the
// runner's perspective.
// ---------------------------------------------------------------------------

const wrapDagJobLike = (
  inner: JobLike<DagPhase, unknown, DagMachineContext>,
  dag: DagDef,
): JobLike<DagPhase, unknown, DagMachineContext> => {
  const incomingByNode = computeIncomingByNode(dag);
  return {
    get data(): { state: DagPhase; context: DagMachineContext } {
      const raw = inner.data;
      // Re-inject the live dag + incomingByNode. The persisted raw.context
      // is intentionally missing them (post-strip); live values win.
      return {
        state: raw.state,
        context: { ...raw.context, dag, incomingByNode },
      };
    },
    async updateData(d: { state: DagPhase; context: DagMachineContext }): Promise<void> {
      // The inner `JobLike` is typed against the full `DagMachineContext`, but
      // we deliberately persist the stripped form; the live `dag` + `incoming`
      // are re-injected on read. The cast is the boundary between the typed
      // strip and the inner adapter's wider type.
      const persistable = stripNonPersistable(d.context);
      await inner.updateData({
        state: d.state,
        context: persistable as unknown as DagMachineContext,
      });
    },
    updateProgress: (pct: number) => inner.updateProgress(pct),
    // Tightened from `(event: unknown, ...)` so the wrapper's declared
    // JobLike<…, unknown, DagEvent> contract is honest. Inner's E defaults to unknown,
    // which accepts DagEvent cleanly.
    appendEvent: (event: DagEvent, dedupKey?: string) =>
      inner.appendEvent(event, dedupKey),
  };
};

/**
 * The closure-only fields on `DagMachineContext` that are intentionally NOT
 * persisted by `JobLike` backends — `dag` carries Zod schemas and function
 * predicates, `incomingByNode` is recomputed from edges. Both are re-injected
 * on read via `wrapDagJobLike.get data()` from the live values at the call site.
 */
type PersistableDagMachineContext = Omit<DagMachineContext, "dag" | "incomingByNode">;

/**
 * Strip the closure-bearing fields before handing state to the durable
 * backend. The explicit return type makes adding a new non-persistable field
 * to `DagMachineContext` a compile error here, rather than a silent strip.
 */
const stripNonPersistable = (
  ctx: DagMachineContext,
): PersistableDagMachineContext => {
  const { dag: _dag, incomingByNode: _ibn, ...rest } = ctx;
  return rest;
};

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
 * emitted to preserve the existing observable behavior (AD-2).
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

  const runStart = Date.now();

  // Emit run-start BEFORE compile so a malformed DAG still produces a balanced
  // run-start/run-end pair. Otherwise observers see neither and the failure is
  // invisible from the event stream.
  dispatchEvent(nodeCtx.observer, {
    type: "run-start",
    runId: nodeCtx.runId,
    dagId: dag.id,
    timestamp: new Date(),
  });

  const emitRunEnd = (status: "ok" | "error"): void => {
    dispatchEvent(nodeCtx.observer, {
      type: "run-end",
      runId: nodeCtx.runId,
      dagId: dag.id,
      timestamp: new Date(),
      duration: Date.now() - runStart,
      status,
    });
  };

  // Capability validation at run start. On success, hands back a phantom-
  // branded `ValidatedNodeContext` token — `runNodeShared` requires it, so
  // any code path that bypasses this check fails to typecheck.
  const capCheck = validateCapabilities(effectiveDag, nodeCtx);
  if (!capCheck.ok) {
    emitRunEnd("error");
    return err(capCheck.error);
  }
  const validatedCtx = capCheck.value;

  return fwTracer().startActiveSpan(
    `run:${dag.id}`,
    {
      attributes: {
        [AI_SPAN_TYPE]: SPAN_TYPE_CHAIN,
        [AI_DAG_ID]: dag.id,
        [AI_RUN_ID]: nodeCtx.runId,
      },
    },
    async (rootSpan): Promise<Result<O, FrameworkError>> => {
      rootSpan.addEvent(EVENT_NODE_INPUT, { [AI_DAG_ID]: dag.id, [AI_RUN_ID]: nodeCtx.runId });

      // Compile inside the span so topo errors are funneled through the same
      // observer/trace path as runtime failures.
      const compiled = compileDagToMachine(effectiveDag, input);
      if (!compiled.ok) {
        rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(compiled.error) });
        rootSpan.addEvent(EVENT_NODE_OUTPUT, { status: "error", error: JSON.stringify(compiled.error) });
        rootSpan.end();
        emitRunEnd("error");
        return err(compiled.error);
      }
      const { machine, initialContext, initialState } = compiled.value;

      // Per-run meta — carries guardrail/eval-judge state for rootSpan finalization (parity with legacy)
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
      const job: JobLike<DagPhase, unknown, DagMachineContext> = opts?.jobLike
        ? wrapDagJobLike(opts.jobLike, effectiveDag)
        : createInMemoryJob<DagPhase, DagMachineContext>({
            state: initialState,
            context: initialContext,
          });

      // errorEventOf adapter — converts classified errors to DagEvent ERROR
      const errorEventOf = (classified: {
        retriable: boolean;
        message: string;
      }): DagEvent => ({
        type: "ERROR",
        retriable: classified.retriable,
        error: classified.message,
      });

      // Capture the last failed state via onTrace so we can extract the error
      // even though the failed state is not checkpointed (FR-005)
      let lastFailedState: Extract<DagPhase, { kind: "failed" }> | undefined;

      const onTrace = (t: import("../state-machine/types.js").TraceEvent<DagPhase, DagEvent>): void => {
        if (t.nextState.kind === "failed") {
          lastFailedState = t.nextState as Extract<DagPhase, { kind: "failed" }>;
        }
        opts?.onTrace?.(t);
      };

      const runOpts: RunOptions<DagPhase, DagEvent, DagMachineContext> = {
        beforeExecute: opts?.beforeExecute,
        classifyError: opts?.classifyError,
        onTrace,
        errorEventOf,
      };

      try {
        const { state, context } = await runStateMachine(job, machine, executor, runOpts);

        return await match(state)
          .with({ kind: "succeeded" }, async (s) => {
            // Finalize: run eval-judges + close root span + emit run-end.
            // Background mode (onBackground supplied) resolves the caller
            // before judges finish, so request-bound timeouts don't block on
            // judge I/O.
            const finalize = async (): Promise<void> => {
              let evalJudgeFailed = false;
              let evalJudgeResults: Awaited<ReturnType<typeof runEvalJudges>> = [];
              if (dag.evalJudges?.length) {
                evalJudgeResults = await runEvalJudges(dag.evalJudges, input, s.output, context.outputs as Map<string, unknown>, nodeCtx);
                evalJudgeFailed = evalJudgeResults.some((r) => !r.passed);
                // Fold judge results into meta (immutable update).
                meta = { ...meta, evalJudgeResults, evalJudgeFailed };
              }

              if (evalJudgeFailed) {
                const failed = evalJudgeResults.filter((r) => !r.passed).flatMap((r) => r.failedCriteria);
                rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: `Eval-judge failed: ${failed.join(", ")}` });
                rootSpan.addEvent(EVENT_NODE_OUTPUT, { status: "ok", evalJudgeFailed: "true", evalJudgeResults: JSON.stringify(evalJudgeResults) });
              } else if (meta.guardrailFailed) {
                rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: `Guardrail failed: ${meta.guardrailWarnings.join("; ")}` });
                rootSpan.addEvent(EVENT_NODE_OUTPUT, { status: "ok", guardrailWarnings: JSON.stringify(meta.guardrailWarnings) });
              } else {
                rootSpan.addEvent(EVENT_NODE_OUTPUT, { status: "ok" });
              }
              rootSpan.end();
              emitRunEnd("ok");
            };

            if (opts?.onBackground) {
              // finalize() rejection must still close the root span and emit
              // `run-end` — otherwise the OTel span leaks open and
              // BufferedObserver retains the run buffer until its TTL.
              // Each cleanup is wrapped independently: a setStatus failure
              // must not block end(); an end() failure must not block
              // emitRunEnd.
              const p = finalize().catch((e) => {
                fwLogger().error("[runDagStateful] background finalize failed:", e);
                // Each cleanup wrapped independently; log any secondary failure
                // so it doesn't masquerade as the primary `finalize` error or
                // get attributed to BufferedObserver's TTL eviction.
                try {
                  rootSpan.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: e instanceof Error ? e.message : String(e),
                  });
                } catch (setStatusErr) {
                  fwLogger().error(
                    "[runDagStateful] rootSpan.setStatus threw during background-finalize error cleanup:",
                    setStatusErr,
                  );
                }
                try {
                  rootSpan.end();
                } catch (endErr) {
                  fwLogger().error(
                    "[runDagStateful] rootSpan.end threw during background-finalize error cleanup (span will leak until TTL eviction):",
                    endErr,
                  );
                }
                try {
                  emitRunEnd("error");
                } catch (emitErr) {
                  fwLogger().error(
                    "[runDagStateful] emitRunEnd threw during background-finalize error cleanup:",
                    emitErr,
                  );
                }
              });
              opts.onBackground(p);
            } else {
              await finalize();
            }
            return ok(s.output as O);
          })
          // state.kind === "failed" — can happen when job was pre-loaded with a failed state
          // (runStateMachine skips the loop entirely when already terminal)
          .with({ kind: "failed" }, async (s) => {
            rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(s.error) });
            rootSpan.addEvent(EVENT_NODE_OUTPUT, { status: "error", error: JSON.stringify(s.error) });
            rootSpan.end();
            emitRunEnd("error");
            return err(s.error);
          })
          // Unexpected non-terminal states — should not be reached
          .with({ kind: "pending" }, async (s) => {
            const msg = `runDagStateful: unexpected non-terminal state ${s.kind}`;

            const e: FrameworkError = { kind: "node-crash", nodeId: "__executor__", retriability: "retriable", message: msg };
            rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: msg });
            rootSpan.end();
            emitRunEnd("error");
            return err(e);
          })
          .with({ kind: "running" }, async (s) => {
            const msg = `runDagStateful: unexpected non-terminal state ${s.kind}`;

            const e: FrameworkError = { kind: "node-crash", nodeId: "__executor__", retriability: "retriable", message: msg };
            rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: msg });
            rootSpan.end();
            emitRunEnd("error");
            return err(e);
          })
          .with({ kind: "retrying" }, async (s) => {
            const msg = `runDagStateful: unexpected non-terminal state ${s.kind}`;

            const e: FrameworkError = { kind: "node-crash", nodeId: "__executor__", retriability: "retriable", message: msg };
            rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: msg });
            rootSpan.end();
            emitRunEnd("error");
            return err(e);
          })
          .with({ kind: "retrying-hook" }, async (s) => {
            const msg = `runDagStateful: unexpected non-terminal state ${s.kind}`;

            const e: FrameworkError = { kind: "node-crash", nodeId: s.nodeId, retriability: "retriable", message: msg };
            rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: msg });
            rootSpan.end();
            emitRunEnd("error");
            return err(e);
          })
          .with({ kind: "awaiting-human" }, async (s) => {
            const msg = `runDagStateful: unexpected non-terminal state ${s.kind}`;

            const e: FrameworkError = { kind: "node-crash", nodeId: "__executor__", retriability: "retriable", message: msg };
            rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: msg });
            rootSpan.end();
            emitRunEnd("error");
            return err(e);
          })
          .exhaustive();
      } catch (e) {
        // runStateMachine throws on terminal-failed (FR-007); also propagate beforeExecute abort.
        // The failed state is NOT checkpointed (FR-005), so we capture it via onTrace above.
        const error: FrameworkError = lastFailedState !== undefined
          ? lastFailedState.error
          : { kind: "node-crash", nodeId: "__executor__", retriability: "retriable", message: e instanceof Error ? e.message : String(e) };
        rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        rootSpan.addEvent(EVENT_NODE_OUTPUT, { status: "error", error: JSON.stringify(error) });
        rootSpan.end();
        emitRunEnd("error");
        return err(error);
      }
    },
  );
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
    throw new Error(`runDagAsWorkerJob: DAG '${dag.id}' failed: ${detail}`, {
      cause: result.error,
    });
  }
  return result.value;
};
