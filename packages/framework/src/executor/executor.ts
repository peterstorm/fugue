import type { DagDef } from "../types/dag.js";
import { isConditionalEdge, isDefaultEdge } from "../types/dag.js";
import type { NodeContext, NodeDef } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { ObserverEvent } from "../types/events.js";
import type { Observer } from "../observer/observer.js";
import type { JobLike } from "../state-machine/types.js";
import type { DagPhase, DagMachineContext, HumanAction } from "../dag-runtime/types.js";
import { type Result, ok, err } from "../types/result.js";
import { runDagStateful, type DagRunOpts } from "../dag-runtime/run-dag-stateful.js";
import { runEvalJudges } from "../dag-runtime/eval-judges.js";
import {
  computeIncomingByNode,
  type IncomingSources,
} from "../dag-runtime/conditional.js";
import { topoSort } from "./topo.js";
import { validateInput, validateOutput } from "./validate.js";
import { dispatchEvent } from "../observer/buffered.js";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import {
  AI_SPAN_TYPE,
  AI_DAG_ID,
  AI_RUN_ID,
  EVENT_NODE_INPUT,
  EVENT_NODE_OUTPUT,
  SPAN_TYPE_CHAIN,
} from "../tracing/semantic-conventions.js";
import {
  withNodeSpan,
  createDagRunMeta,
  foldOutcomes,
  type DagRunMeta,
  type NodeSpanOutcome,
} from "./node-span.js";

export interface RunOptions {
  readonly resume?: {
    readonly runId: string;
    readonly checkpoint: Map<string, unknown>;
  };
  /** Called with a promise that resolves when background work (eval-judge) completes. */
  readonly onBackground?: (p: Promise<void>) => void;
  /**
   * State-machine path: provide a persistent JobLike handle for checkpoint/resume.
   * When set, runDag delegates to runDagStateful instead of the legacy runDagInner.
   * INCOMPATIBLE with `resume` — provide jobLike.data.context instead.
   */
  readonly jobLike?: JobLike<DagPhase, DagMachineContext>;
  /**
   * Human-review hook — called when a node with `humanReview` set completes.
   * Required when any node in the DAG declares `humanReview`; rejected otherwise.
   * Routing to the state-machine path is driven by `node.humanReview`, not by
   * the presence of this hook.
   */
  readonly onHumanReview?: (req: { nodeId: string; output: unknown; prompt: string }) => Promise<HumanAction>;
  /**
   * State-machine path: per-node retry limits passed at call time (overrides DagDef.retryLimits).
   * Presence of this option triggers the state-machine path.
   */
  readonly retryLimits?: Readonly<Record<string, number>>;
}

const emit = (ctx: NodeContext, event: ObserverEvent) => {
  if (ctx.observer) {
    dispatchEvent(ctx.observer as Observer, event);
  }
};

const tracer = trace.getTracer("ai-summary-framework");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const runDag = async <I, O>(
  dag: DagDef,
  input: I,
  ctx: NodeContext,
  opts?: RunOptions,
): Promise<Result<O, FrameworkError>> => {
  // ---------------------------------------------------------------------------
  // Routing: legacy fast path vs. state-machine path (AD-7 / Gap-3)
  //
  // Source of truth for HITL routing is *node config*: any node that declares
  // `humanReview` requires the state-machine path. Opts only supply hooks and
  // toggles; they do NOT independently flip routing for HITL.
  //
  // The state-machine path is selected when:
  //   - the DAG declares any `humanReview` node, OR
  //   - the DAG declares retry policy (`defaultRetryLimit` or `retryLimits`), OR
  //   - opts.jobLike is set (durable checkpoint handle), OR
  //   - opts.retryLimits is set (per-call retry override)
  //
  // `resume` is a legacy-path flag and is incompatible with the state-machine
  // path. `onBackground` works on both paths — it defers eval-judge / span
  // finalization so request-bound timeouts don't block on judge I/O. See
  // ADR-0018 for the SM-path semantics.
  // ---------------------------------------------------------------------------

  const hitlNodes = dag.nodes.filter((n) => n.humanReview !== undefined);
  const dagDeclaresHITL = hitlNodes.length > 0;
  const dagDeclaresRetries =
    dag.defaultRetryLimit !== undefined ||
    (dag.retryLimits !== undefined && Object.keys(dag.retryLimits).length > 0);

  // Bidirectional contract between node config and call-site hook.
  if (dagDeclaresHITL && !opts?.onHumanReview) {
    return err({
      kind: "node-crash",
      nodeId: "__executor__",
      message: `[runDag] DAG declares humanReview node(s) [${hitlNodes.map((n) => n.id).join(", ")}] but no \`onHumanReview\` hook supplied`,
    });
  }
  if (!dagDeclaresHITL && opts?.onHumanReview !== undefined) {
    return err({
      kind: "node-crash",
      nodeId: "__executor__",
      message: "[runDag] `onHumanReview` hook supplied but no node declares `humanReview`",
    });
  }

  // Conditional edges require runtime active-set filtering (ADR 0015) which
  // only the state-machine path implements. Any DAG with `when` or default
  // edges routes through runDagStateful regardless of HITL/retry config.
  const dagDeclaresConditionalEdges = dag.edges.some(
    (e) => isConditionalEdge(e) || isDefaultEdge(e),
  );

  const useStateMachinePath =
    dagDeclaresHITL ||
    dagDeclaresRetries ||
    dagDeclaresConditionalEdges ||
    opts?.jobLike !== undefined ||
    opts?.retryLimits !== undefined;

  if (opts?.resume && useStateMachinePath) {
    return err({
      kind: "node-crash",
      nodeId: "__executor__",
      message: "[runDag] `resume` is incompatible with the state-machine path (humanReview node, jobLike, or retryLimits). Use jobLike.data.context.outputs to restore prior state.",
    });
  }

  if (useStateMachinePath) {
    // Delegate to the state-machine path (T4 — run-dag-stateful.ts).
    // Explicitly project only the fields DagRunOpts accepts to avoid silently
    // passing legacy-only fields (resume) into the state-machine path.
    const stateMachineOpts: DagRunOpts = {
      jobLike: opts?.jobLike,
      onHumanReview: opts?.onHumanReview,
      retryLimits: opts?.retryLimits,
      onBackground: opts?.onBackground,
    };
    return runDagStateful<I, O>(dag, input, ctx, stateMachineOpts);
  }

  // Legacy fast path: same behavior as the original single-path executor.
  // Retained for back-compat with callers that don't declare humanReview,
  // retry config, conditional edges, or a durable jobLike. New features
  // must go through runDagStateful — see ADR-0007.
  // Traced path — span stays open until judge completes
  let resolveResult!: (r: Result<O, FrameworkError>) => void;
  const resultPromise = new Promise<Result<O, FrameworkError>>((resolve) => { resolveResult = resolve; });

  const background = tracer.startActiveSpan(
    `run:${dag.id}`,
    {
      attributes: {
        [AI_SPAN_TYPE]: SPAN_TYPE_CHAIN,
        [AI_DAG_ID]: dag.id,
        [AI_RUN_ID]: ctx.runId,
      },
    },
    async (rootSpan) => {
    let meta: DagRunMeta = createDagRunMeta();
    const recordOutcomes = (outcomes: readonly NodeSpanOutcome[]): void => {
      meta = foldOutcomes(meta, outcomes);
    };

    rootSpan.addEvent(EVENT_NODE_INPUT, { [AI_DAG_ID]: dag.id, [AI_RUN_ID]: ctx.runId });

    let innerResult: Result<{ output: O; nodeOutputs: Map<string, unknown> }, FrameworkError>;
    try {
      innerResult = await runDagInner<I, O>(dag, input, ctx, opts, recordOutcomes);
    } catch (e) {
      const error: FrameworkError = { kind: "node-crash", nodeId: "__executor__", message: e instanceof Error ? e.message : String(e) };
      rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
      rootSpan.addEvent(EVENT_NODE_OUTPUT, { status: "error", error: JSON.stringify(error) });
      resolveResult(err(error) as Result<O, FrameworkError>);
      rootSpan.end();
      return;
    }

    if (!innerResult.ok) {
      rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(innerResult.error) });
      rootSpan.addEvent(EVENT_NODE_OUTPUT, { status: "error", error: JSON.stringify(innerResult.error) });
      resolveResult(err(innerResult.error) as Result<O, FrameworkError>);
      rootSpan.end();
      return;
    }

    const { output, nodeOutputs } = innerResult.value;

    // Release the result to the caller immediately
    resolveResult(ok(output) as Result<O, FrameworkError>);

    // Run eval-judge (still inside the span — appears in trace)
    if (dag.evalJudges?.length) {
      const results = await runEvalJudges(dag.evalJudges, input, output, nodeOutputs, ctx);
      meta = {
        ...meta,
        evalJudgeResults: results,
        evalJudgeFailed: results.some((r) => !r.passed),
      };
    }

    // Finalize span status based on judge + guardrail results
    if (meta.evalJudgeFailed) {
      const failed = meta.evalJudgeResults.filter((r) => !r.passed).flatMap((r) => r.failedCriteria);
      rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: `Eval-judge failed: ${failed.join(", ")}` });
      rootSpan.addEvent(EVENT_NODE_OUTPUT, { status: "ok", evalJudgeFailed: "true", evalJudgeResults: JSON.stringify(meta.evalJudgeResults) });
    } else if (meta.guardrailFailed) {
      rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: `Guardrail failed: ${meta.guardrailWarnings.join("; ")}` });
      rootSpan.addEvent(EVENT_NODE_OUTPUT, { status: "ok", guardrailWarnings: JSON.stringify(meta.guardrailWarnings) });
    } else {
      rootSpan.addEvent(EVENT_NODE_OUTPUT, { status: "ok" });
    }
    rootSpan.end();
  },
  );

  const safeBackground = (background as Promise<void>).catch((e) => {
    console.error("[runDag] background task error:", e);
  });
  opts?.onBackground?.(safeBackground);
  const result = await resultPromise;
  return result;
};

export const resumeRun = async <O>(
  runId: string,
  dag: DagDef,
  ctx: NodeContext,
  checkpoint: Map<string, unknown>,
): Promise<Result<O, FrameworkError>> => {
  return runDag(dag, undefined, ctx, { resume: { runId, checkpoint } });
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const runDagInner = async <I, O>(
  dag: DagDef,
  input: I,
  ctx: NodeContext,
  opts?: RunOptions,
  recordOutcomes?: (outcomes: readonly NodeSpanOutcome[]) => void,
): Promise<Result<{ output: O; nodeOutputs: Map<string, unknown> }, FrameworkError>> => {
  // Structural soundness is enforced at construction time by `defineDag`.
  // Only topological failure (cycle) needs runtime detection here.
  const sortResult = topoSort(dag);
  if (!sortResult.ok) return sortResult;

  const waves = sortResult.value;
  const nodeMap = new Map<string, NodeDef<unknown, unknown, unknown>>(dag.nodes.map((n) => [n.id, n]));
  const incomingByNode = computeIncomingByNode(dag);
  const outputs = new Map<string, unknown>();
  const checkpoint = opts?.resume?.checkpoint;
  const runStart = Date.now();

  emit(ctx, { type: "run-start", runId: ctx.runId, dagId: dag.id, timestamp: new Date() });

  for (const wave of waves) {
    const settled = await Promise.all(
      wave.map((nodeId) =>
        runNode(
          nodeMap.get(nodeId)!,
          input,
          ctx,
          dag.id,
          outputs,
          incomingByNode.get(nodeId) ?? { required: [], optional: [] },
          checkpoint,
        ),
      ),
    );

    // Fold this wave's outcomes into the run-level meta after Promise.all.
    if (recordOutcomes) {
      recordOutcomes(settled.map((s) => s.outcome));
    }

    for (const { result } of settled) {
      if (!result.ok) {
        emit(ctx, { type: "run-end", runId: ctx.runId, dagId: dag.id, timestamp: new Date(), duration: Date.now() - runStart, status: "error" });
        return result as Result<any, FrameworkError>;
      }
    }
  }

  emit(ctx, { type: "run-end", runId: ctx.runId, dagId: dag.id, timestamp: new Date(), duration: Date.now() - runStart, status: "ok" });

  const lastWave = waves[waves.length - 1];
  const outputNodeId = dag.outputNodeId ?? lastWave[lastWave.length - 1];
  return ok({ output: outputs.get(outputNodeId) as O, nodeOutputs: outputs });
};

// ---------------------------------------------------------------------------
// Node execution
// ---------------------------------------------------------------------------

const EMPTY_OUTCOME: NodeSpanOutcome = { guardrailFailed: false, guardrailWarnings: [] };

const runNode = async (
  node: NodeDef<unknown, unknown, unknown>,
  dagInput: unknown,
  ctx: NodeContext,
  dagId: string,
  outputs: Map<string, unknown>,
  incoming: IncomingSources,
  checkpoint: Map<string, unknown> | undefined,
): Promise<{ result: Result<unknown, FrameworkError>; outcome: NodeSpanOutcome }> => {
  const nodeId = node.id;

  // Resume from checkpoint. Validate the cached value against the current
  // node's outputSchema before reusing it — a deploy may have tightened the
  // schema since the checkpoint was written, and the server-side fingerprint
  // check only catches structural drift (added/removed nodes), not schema
  // evolution within an unchanged node.
  if (checkpoint?.has(nodeId)) {
    const cached = checkpoint.get(nodeId);
    const validated = validateOutput(node.outputSchema, cached, nodeId);
    if (!validated.ok) {
      emit(ctx, { type: "node-error", runId: ctx.runId, dagId, nodeId, timestamp: new Date(), error: `checkpoint replay rejected: ${String(validated.error)}` });
      return { result: validated, outcome: EMPTY_OUTCOME };
    }
    emit(ctx, { type: "node-skipped", runId: ctx.runId, dagId, nodeId, timestamp: new Date(), reason: "checkpoint" });
    outputs.set(nodeId, validated.value);
    return { result: ok(validated.value), outcome: EMPTY_OUTCOME };
  }

  // Build node input from derived incoming sources (ADR 0017). The legacy
  // fast path never runs DAGs with conditional/default edges, so `optional`
  // is always empty here — but we honor the same shape rules as the
  // state-machine path for consistency.
  const { required, optional } = incoming;
  const nodeInput =
    optional.length > 0
      ? Object.fromEntries(
          [...required, ...optional].map((d) => [d, outputs.get(d)]),
        )
      : required.length === 0
        ? dagInput
        : required.length === 1
          ? outputs.get(required[0]!)
          : Object.fromEntries(required.map((d) => [d, outputs.get(d)]));

  const inputResult = validateInput(node.inputSchema, nodeInput, nodeId);
  if (!inputResult.ok) return { result: inputResult, outcome: EMPTY_OUTCOME };

  // Core execution logic
  const executeNode = async (): Promise<Result<unknown, FrameworkError>> => {
    const nodeStart = Date.now();
    emit(ctx, { type: "node-start", runId: ctx.runId, dagId, nodeId, timestamp: new Date() });

    let runResult: Result<unknown, FrameworkError>;
    try {
      runResult = (await node.run(inputResult.value, ctx)) as Result<unknown, FrameworkError>;
    } catch (e) {
      return err({ kind: "node-crash", nodeId, message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
    }

    if (!runResult.ok) {
      emit(ctx, { type: "node-error", runId: ctx.runId, dagId, nodeId, timestamp: new Date(), error: String(runResult.error) });
      return runResult;
    }

    const outputResult = validateOutput(node.outputSchema, runResult.value, nodeId);
    if (!outputResult.ok) return outputResult;

    const duration = Date.now() - nodeStart;
    outputs.set(nodeId, outputResult.value);

    if (ctx.cache?.writeCheckpoint) {
      try {
        await ctx.cache.writeCheckpoint(ctx.runId, nodeId, outputResult.value);
      } catch (e) {
        // Wave 2 §2.4: surface checkpoint failures instead of warn-and-continue.
        // A swallowed failure means the next resume re-runs the node, breaking the
        // idempotency contract the checkpoint exists to provide.
        const message = e instanceof Error ? e.message : String(e);
        emit(ctx, {
          type: "node-error",
          runId: ctx.runId,
          dagId,
          nodeId,
          timestamp: new Date(),
          error: `checkpoint-write-failed: ${message}`,
        });
        return err({
          kind: "checkpoint-write-failed" as const,
          runId: ctx.runId,
          nodeId,
          message,
        });
      }
    }

    emit(ctx, { type: "node-end", runId: ctx.runId, dagId, nodeId, timestamp: new Date(), duration, output: outputResult.value });
    return ok(outputResult.value);
  };

  // Wrap in OTel span
  return withNodeSpan(nodeId, node.kind, inputResult.value, ctx.includeContent ?? false, executeNode);
};
