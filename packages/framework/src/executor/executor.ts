import type { DagDef } from "../types/dag.js";
import type { NodeContext, NodeDef } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { ObserverEvent } from "../types/events.js";
import type { Observer } from "../observer/observer.js";
import type { EvalJudgeNodeDef, EvalJudgeResult } from "../nodes/eval-judge.js";
import { type Result, ok, err } from "../types/result.js";
import { topoSort } from "./topo.js";
import { validateInput, validateOutput } from "./validate.js";
import { dispatchEvent } from "../observer/buffered.js";
import { loadMlflow, mlflow } from "../tracing/index.js";

const SPAN_TYPE_MAP: Record<string, string> = {
  llm: "LLM",
  fetch: "RETRIEVER",
  transform: "CHAIN",
  guardrail: "TOOL",
  "eval-judge": "TOOL",
};

export interface RunOptions {
  readonly resume?: {
    readonly runId: string;
    readonly checkpoint: Map<string, unknown>;
  };
  /** Called with a promise that resolves when background work (eval-judge) completes. */
  readonly onBackground?: (p: Promise<void>) => void;
}

const emit = (ctx: NodeContext, event: ObserverEvent) => {
  if (ctx.observer) {
    dispatchEvent(ctx.observer as Observer, event);
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const runDag = async <I, O>(
  dag: DagDef,
  input: I,
  ctx: NodeContext,
  opts?: RunOptions,
): Promise<Result<O, FrameworkError>> => {
  await loadMlflow();

  const { withSpan, SpanType } = mlflow();

  // No tracing path
  if (!withSpan || !SpanType) {
    const meta: DagRunMeta = { guardrailFailed: false, guardrailWarnings: [], evalJudgeFailed: false, evalJudgeResults: [] };
    const innerResult = await runDagInner<I, O>(dag, input, ctx, opts, meta);
    const result = innerResult.ok ? ok(innerResult.value.output) as Result<O, FrameworkError> : innerResult;

    // Run eval-judge in background (fire-and-forget)
    if (innerResult.ok && dag.evalJudges?.length) {
      const bg = runEvalJudges(dag.evalJudges, input, innerResult.value.output, innerResult.value.nodeOutputs, ctx, meta).then(() => {});
      opts?.onBackground?.(bg);
    }

    return result;
  }

  // Traced path — span stays open until judge completes
  let resolveResult!: (r: Result<O, FrameworkError>) => void;
  const resultPromise = new Promise<Result<O, FrameworkError>>((resolve) => { resolveResult = resolve; });

  const background = withSpan(async (rootSpan) => {
    const meta: DagRunMeta = { guardrailFailed: false, guardrailWarnings: [], evalJudgeFailed: false, evalJudgeResults: [] };
    rootSpan.setInputs({ dagId: dag.id, runId: ctx.runId });

    const innerResult = await runDagInner<I, O>(dag, input, ctx, opts, meta);

    if (!innerResult.ok) {
      rootSpan.setStatus(mlflow().SpanStatusCode!.ERROR, String(innerResult.error));
      rootSpan.setOutputs({ status: "error", error: innerResult.error });
      resolveResult(err(innerResult.error) as Result<O, FrameworkError>);
      return;
    }

    const { output, nodeOutputs } = innerResult.value;

    // Release the result to the caller immediately
    resolveResult(ok(output) as Result<O, FrameworkError>);

    // Run eval-judge (still inside the span — appears in trace)
    if (dag.evalJudges?.length) {
      await runEvalJudges(dag.evalJudges, input, output, nodeOutputs, ctx, meta);
    }

    // Finalize span status based on judge + guardrail results
    const sc = mlflow().SpanStatusCode!;
    if (meta.evalJudgeFailed) {
      const failed = meta.evalJudgeResults.filter((r) => !r.passed).flatMap((r) => r.failedCriteria);
      rootSpan.setStatus(sc.ERROR, `Eval-judge failed: ${failed.join(", ")}`);
      rootSpan.setOutputs({ status: "ok", evalJudgeFailed: true, evalJudgeResults: meta.evalJudgeResults });
    } else if (meta.guardrailFailed) {
      rootSpan.setStatus(sc.ERROR, `Guardrail failed: ${meta.guardrailWarnings.join("; ")}`);
      rootSpan.setOutputs({ status: "ok", guardrailWarnings: meta.guardrailWarnings });
    } else {
      rootSpan.setOutputs({ status: "ok" });
    }
  }, { name: `run:${dag.id}`, spanType: SpanType.CHAIN }) as Promise<void>;

  opts?.onBackground?.(background);
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

interface DagRunMeta {
  guardrailFailed: boolean;
  guardrailWarnings: string[];
  evalJudgeFailed: boolean;
  evalJudgeResults: EvalJudgeResult[];
}

const runDagInner = async <I, O>(
  dag: DagDef,
  input: I,
  ctx: NodeContext,
  opts?: RunOptions,
  meta?: DagRunMeta,
): Promise<Result<{ output: O; nodeOutputs: Map<string, unknown> }, FrameworkError>> => {
  const sortResult = topoSort(dag);
  if (!sortResult.ok) return sortResult;

  const waves = sortResult.value;
  const nodeMap = new Map<string, NodeDef<any, any, any>>(dag.nodes.map((n) => [n.id, n]));
  const outputs = new Map<string, unknown>();
  const checkpoint = opts?.resume?.checkpoint;
  const runStart = Date.now();

  emit(ctx, { type: "run-start", runId: ctx.runId, dagId: dag.id, timestamp: new Date() });

  for (const wave of waves) {
    const results = await Promise.all(
      wave.map((nodeId) => runNode(nodeMap.get(nodeId)!, input, ctx, dag.id, outputs, checkpoint, meta)),
    );

    for (const r of results) {
      if (!r.ok) {
        emit(ctx, { type: "run-end", runId: ctx.runId, dagId: dag.id, timestamp: new Date(), duration: Date.now() - runStart, status: "error" });
        return r as Result<any, FrameworkError>;
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

const runNode = async (
  node: NodeDef<any, any, any>,
  dagInput: unknown,
  ctx: NodeContext,
  dagId: string,
  outputs: Map<string, unknown>,
  checkpoint: Map<string, unknown> | undefined,
  meta: DagRunMeta | undefined,
): Promise<Result<any, FrameworkError>> => {
  const nodeId = node.id;

  // Resume from checkpoint
  if (checkpoint?.has(nodeId)) {
    const cached = checkpoint.get(nodeId);
    emit(ctx, { type: "node-skipped", runId: ctx.runId, dagId, nodeId, timestamp: new Date(), reason: "checkpoint" });
    outputs.set(nodeId, cached);
    return ok(cached);
  }

  // Build node input from deps
  const nodeInput = node.deps.length === 0
    ? dagInput
    : node.deps.length === 1
      ? outputs.get(node.deps[0])
      : Object.fromEntries(node.deps.map((d) => [d, outputs.get(d)]));

  const inputResult = validateInput(node.inputSchema, nodeInput, nodeId);
  if (!inputResult.ok) return inputResult;

  // Core execution logic
  const executeNode = async (): Promise<Result<any, FrameworkError>> => {
    const nodeStart = Date.now();
    emit(ctx, { type: "node-start", runId: ctx.runId, dagId, nodeId, timestamp: new Date() });

    let runResult: Result<any, any>;
    try {
      runResult = await node.run(inputResult.value, ctx);
    } catch (e) {
      return err({ kind: "node-crash", nodeId, message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
    }

    if (!runResult.ok) {
      emit(ctx, { type: "node-error", runId: ctx.runId, dagId, nodeId, timestamp: new Date(), error: String(runResult.error) });
      return runResult as Result<never, FrameworkError>;
    }

    const outputResult = validateOutput(node.outputSchema, runResult.value, nodeId);
    if (!outputResult.ok) return outputResult;

    const duration = Date.now() - nodeStart;
    outputs.set(nodeId, outputResult.value);

    if (ctx.cache?.writeCheckpoint) {
      try {
        await ctx.cache.writeCheckpoint(ctx.runId, nodeId, outputResult.value);
      } catch (e) {
        (ctx.logger?.warn ?? console.warn)(`Checkpoint write failed for ${nodeId}: ${e instanceof Error ? e.message : e}`);
      }
    }

    emit(ctx, { type: "node-end", runId: ctx.runId, dagId, nodeId, timestamp: new Date(), duration, output: outputResult.value });
    return ok(outputResult.value);
  };

  // Wrap in OTel span if available
  return withNodeSpan(nodeId, node.kind, inputResult.value, meta, executeNode);
};

/** Wrap execution in an OTel span if tracing is available; otherwise just call fn. */
const withNodeSpan = async (
  nodeId: string,
  kind: string,
  input: unknown,
  meta: DagRunMeta | undefined,
  fn: () => Promise<Result<any, FrameworkError>>,
): Promise<Result<any, FrameworkError>> => {
  const { withSpan, SpanType, SpanStatusCode } = mlflow();
  if (!withSpan || !SpanType) return fn();

  const spanType = (SpanType as any)[SPAN_TYPE_MAP[kind] ?? "CHAIN"] ?? SpanType.CHAIN;
  return withSpan(async (span: any) => {
    span.setInputs(input);
    const result = await fn();
    if (result.ok) {
      span.setOutputs(result.value);
      // Guardrail nodes: propagate failure to trace-level meta
      if (kind === "guardrail" && result.value && typeof result.value === "object" && "passed" in result.value && !(result.value as any).passed) {
        const warnings = (result.value as any).warnings ?? [];
        span.setStatus(SpanStatusCode!.ERROR, `Guardrail failed: ${warnings.join("; ")}`);
        if (meta) {
          meta.guardrailFailed = true;
          meta.guardrailWarnings.push(...warnings);
        }
      }
    } else {
      span.setStatus(SpanStatusCode!.ERROR, String(result.error));
    }
    return result;
  }, { name: `node:${nodeId}`, spanType }) as Promise<Result<any, FrameworkError>>;
};

// ---------------------------------------------------------------------------
// Eval-judge execution
// ---------------------------------------------------------------------------

const runEvalJudges = async (
  judges: readonly EvalJudgeNodeDef[],
  dagInput: unknown,
  dagOutput: unknown,
  nodeOutputs: Map<string, unknown>,
  ctx: NodeContext,
  meta: DagRunMeta,
): Promise<void> => {
  const { withSpan, SpanType, SpanStatusCode } = mlflow();

  const results = await Promise.all(
    judges.map(async (judge) => {
      const runJudge = async (span?: any): Promise<EvalJudgeResult> => {
        try {
          const judgeInput = { dagInput, dagOutput, nodeOutputs: Object.fromEntries(nodeOutputs) };
          if (span) {
            span.setInputs({ ...judgeInput, criteria: judge.config.criteria });
          }
          const result = await judge.run(judgeInput, dagOutput, ctx);
          if (span) {
            span.setOutputs(result);
            if (!result.passed && SpanStatusCode) {
              span.setStatus(SpanStatusCode.ERROR, `Score ${result.score} below threshold. ${result.reason}`);
            }
          }
          return result;
        } catch (e) {
          const msg = `[eval-judge:${judge.id}] Unexpected error: ${e instanceof Error ? e.message : e}`;
          (ctx.logger?.warn ?? console.warn)(msg);
          if (span && SpanStatusCode) {
            span.setStatus(SpanStatusCode.ERROR, msg);
          }
          return { passed: true, score: 1.0, criteriaScores: {}, failedCriteria: [] as string[], reason: `[skipped: ${msg}]` };
        }
      };

      if (withSpan && SpanType) {
        return withSpan((span: any) => runJudge(span), { name: `eval-judge:${judge.id}`, spanType: SpanType.TOOL });
      }
      return runJudge();
    }),
  );

  meta.evalJudgeResults = results;
  meta.evalJudgeFailed = results.some((r) => !r.passed);
};
