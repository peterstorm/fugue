// runDagStateful — orchestrates the DAG executor with the state-machine runner (Phase 3a)
// FR-023, FR-024, FR-025, FR-027

import { match } from "ts-pattern";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { JobLike, RunOptions } from "../state-machine/types.js";
import type { DagPhase, DagEvent, DagMachineContext, HumanAction } from "./types.js";
import type { DagDef } from "../types/dag.js";
import type { NodeContext } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import { type Result, ok, err } from "../types/result.js";
import { createInMemoryJob } from "../state-machine/in-memory-job.js";
import { runStateMachine } from "../state-machine/runner.js";
import { compileDagToMachine } from "./machine.js";
import { buildDagExecutor } from "./executor.js";
import { runEvalJudges } from "./eval-judges.js";
import { createDagRunMeta } from "../executor/node-span.js";
import { dispatchEvent } from "../observer/buffered.js";
import type { Observer } from "../observer/observer.js";
import {
  AI_SPAN_TYPE,
  AI_DAG_ID,
  AI_RUN_ID,
  EVENT_NODE_INPUT,
  EVENT_NODE_OUTPUT,
  SPAN_TYPE_CHAIN,
} from "../tracing/semantic-conventions.js";

const tracer = trace.getTracer("ai-summary-framework");

// ---------------------------------------------------------------------------
// DagRunOpts — caller-supplied options for runDagStateful
// ---------------------------------------------------------------------------

export interface DagRunOpts
  extends Omit<RunOptions<DagPhase, DagMachineContext, DagEvent>, "errorEventOf"> {
  /** Provide a durable job backend (BullMQ, etc.). Falls back to in-memory when omitted. */
  readonly jobLike?: JobLike<DagPhase, DagMachineContext>;
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
  const effectiveDag: DagDef =
    opts?.retryLimits !== undefined
      ? { ...dag, retryLimits: { ...dag.retryLimits, ...opts.retryLimits } }
      : dag;

  // Compile the DAG into a Machine + initial state
  const { machine, initialContext, initialState } = compileDagToMachine(effectiveDag, input);

  // Per-run meta — carries guardrail/eval-judge state for rootSpan finalization (parity with legacy)
  const meta = createDagRunMeta();

  // Build the executor closure
  const executor = buildDagExecutor(effectiveDag, nodeCtx, {
    onHumanReview: opts?.onHumanReview,
    meta,
  });

  // Resolve the job handle — caller-supplied or fresh in-memory
  const job: JobLike<DagPhase, DagMachineContext> =
    opts?.jobLike ??
    createInMemoryJob<DagPhase, DagMachineContext>({
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

  // Assemble RunOptions for the kernel loop
  const runOpts: RunOptions<DagPhase, DagMachineContext, DagEvent> = {
    beforeExecute: opts?.beforeExecute,
    classifyError: opts?.classifyError,
    onTrace,
    errorEventOf,
  };

  const runStart = Date.now();

  // Emit run-start observer event
  if (nodeCtx.observer) {
    dispatchEvent(nodeCtx.observer as Observer, {
      type: "run-start",
      runId: nodeCtx.runId,
      dagId: dag.id,
      timestamp: new Date(),
    });
  }

  const emitRunEnd = (status: "ok" | "error"): void => {
    if (nodeCtx.observer) {
      dispatchEvent(nodeCtx.observer as Observer, {
        type: "run-end",
        runId: nodeCtx.runId,
        dagId: dag.id,
        timestamp: new Date(),
        duration: Date.now() - runStart,
        status,
      });
    }
  };

  return tracer.startActiveSpan(
    `run:${dag.id}`,
    { attributes: { [AI_SPAN_TYPE]: SPAN_TYPE_CHAIN } },
    async (rootSpan): Promise<Result<O, FrameworkError>> => {
      rootSpan.addEvent(EVENT_NODE_INPUT, { [AI_DAG_ID]: dag.id, [AI_RUN_ID]: nodeCtx.runId });

      try {
        const { state, context } = await runStateMachine(job, machine, executor, runOpts);

        return await match(state)
          .with({ kind: "succeeded" }, async (s) => {
            // Run eval-judges (mirrors legacy executor behavior) — fail-open, never crashes the run.
            let evalJudgeFailed = false;
            let evalJudgeResults: Awaited<ReturnType<typeof runEvalJudges>> = [];
            if (dag.evalJudges?.length) {
              evalJudgeResults = await runEvalJudges(dag.evalJudges, input, s.output, context.outputs as Map<string, unknown>, nodeCtx);
              evalJudgeFailed = evalJudgeResults.some((r) => !r.passed);
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
            const e: FrameworkError = { kind: "node-crash", nodeId: "__executor__", message: `runDagStateful: unexpected non-terminal state ${s.kind}` };
            rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
            rootSpan.end();
            emitRunEnd("error");
            return err(e);
          })
          .with({ kind: "running" }, async (s) => {
            const e: FrameworkError = { kind: "node-crash", nodeId: "__executor__", message: `runDagStateful: unexpected non-terminal state ${s.kind}` };
            rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
            rootSpan.end();
            emitRunEnd("error");
            return err(e);
          })
          .with({ kind: "retrying" }, async (s) => {
            const e: FrameworkError = { kind: "node-crash", nodeId: "__executor__", message: `runDagStateful: unexpected non-terminal state ${s.kind}` };
            rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
            rootSpan.end();
            emitRunEnd("error");
            return err(e);
          })
          .with({ kind: "retrying-hook" }, async (s) => {
            const e: FrameworkError = { kind: "node-crash", nodeId: s.nodeId, message: `runDagStateful: unexpected non-terminal state ${s.kind}` };
            rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
            rootSpan.end();
            emitRunEnd("error");
            return err(e);
          })
          .with({ kind: "awaiting-human" }, async (s) => {
            const e: FrameworkError = { kind: "node-crash", nodeId: "__executor__", message: `runDagStateful: unexpected non-terminal state ${s.kind}` };
            rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
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
          : { kind: "node-crash", nodeId: "__executor__", message: e instanceof Error ? e.message : String(e) };
        rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        rootSpan.addEvent(EVENT_NODE_OUTPUT, { status: "error", error: JSON.stringify(error) });
        rootSpan.end();
        emitRunEnd("error");
        return err(error);
      }
    },
  );
};
