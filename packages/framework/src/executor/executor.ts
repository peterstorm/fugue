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
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { SpanAttributeRegistry } from "../observer/span-attribute-registry.js";

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
  // Traced path — span stays open until judge completes
  let resolveResult!: (r: Result<O, FrameworkError>) => void;
  const resultPromise = new Promise<Result<O, FrameworkError>>((resolve) => { resolveResult = resolve; });

  const background = tracer.startActiveSpan(`run:${dag.id}`, { attributes: { "mlflow.spanType": "CHAIN" } }, async (rootSpan) => {
    const meta: DagRunMeta = { guardrailFailed: false, guardrailWarnings: [], evalJudgeFailed: false, evalJudgeResults: [] };
    const spanId = rootSpan.spanContext().spanId;
    SpanAttributeRegistry.set(spanId, { "mlflow.spanInputs": { dagId: dag.id, runId: ctx.runId } });

    const innerResult = await runDagInner<I, O>(dag, input, ctx, opts, meta);

    if (!innerResult.ok) {
      rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(innerResult.error) });
      SpanAttributeRegistry.set(spanId, { "mlflow.spanOutputs": { status: "error", error: innerResult.error } });
      resolveResult(err(innerResult.error) as Result<O, FrameworkError>);
      rootSpan.end();
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
    if (meta.evalJudgeFailed) {
      const failed = meta.evalJudgeResults.filter((r) => !r.passed).flatMap((r) => r.failedCriteria);
      rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: `Eval-judge failed: ${failed.join(", ")}` });
      SpanAttributeRegistry.set(spanId, { "mlflow.spanOutputs": { status: "ok", evalJudgeFailed: true, evalJudgeResults: meta.evalJudgeResults } });
    } else if (meta.guardrailFailed) {
      rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: `Guardrail failed: ${meta.guardrailWarnings.join("; ")}` });
      SpanAttributeRegistry.set(spanId, { "mlflow.spanOutputs": { status: "ok", guardrailWarnings: meta.guardrailWarnings } });
    } else {
      SpanAttributeRegistry.set(spanId, { "mlflow.spanOutputs": { status: "ok" } });
    }
    rootSpan.end();
  });

  opts?.onBackground?.(background as Promise<void>);
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

  // Wrap in OTel span
  return withNodeSpan(nodeId, node.kind, inputResult.value, meta, executeNode);
};

/** Wrap execution in an OTel span. */
const withNodeSpan = async (
  nodeId: string,
  kind: string,
  input: unknown,
  meta: DagRunMeta | undefined,
  fn: () => Promise<Result<any, FrameworkError>>,
): Promise<Result<any, FrameworkError>> => {
  const spanType = SPAN_TYPE_MAP[kind] ?? "CHAIN";

  return tracer.startActiveSpan(`node:${nodeId}`, { attributes: { "mlflow.spanType": spanType } }, async (span) => {
    const spanId = span.spanContext().spanId;
    SpanAttributeRegistry.set(spanId, { "mlflow.spanInputs": input });

    const result = await fn();
    if (result.ok) {
    SpanAttributeRegistry.set(spanId, { "mlflow.spanOutputs": result.value });
      // Guardrail nodes: propagate failure to trace-level meta
      if (kind === "guardrail" && result.value && typeof result.value === "object" && "passed" in result.value && !(result.value as any).passed) {
        const warnings = (result.value as any).warnings ?? [];
        span.setStatus({ code: SpanStatusCode.ERROR, message: `Guardrail failed: ${warnings.join("; ")}` });
        if (meta) {
          meta.guardrailFailed = true;
          meta.guardrailWarnings.push(...warnings);
        }
      }
    } else {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(result.error) });
    }
    span.end();
    return result;
  });
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
  const results = await Promise.all(
    judges.map(async (judge) => {
      return tracer.startActiveSpan(`eval-judge:${judge.id}`, { attributes: { "mlflow.spanType": "TOOL" } }, async (span) => {
        const spanId = span.spanContext().spanId;
        try {
          const judgeInput = { dagInput, dagOutput, nodeOutputs: Object.fromEntries(nodeOutputs) };
          SpanAttributeRegistry.set(spanId, { "mlflow.spanInputs": { ...judgeInput, criteria: judge.config.criteria } });

          const result = await judge.run(judgeInput, dagOutput, ctx);
          SpanAttributeRegistry.set(spanId, { "mlflow.spanOutputs": result });
          if (!result.passed) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: `Score ${result.score} below threshold. ${result.reason}` });
          }
          span.end();
          return result;
        } catch (e) {
          const msg = `[eval-judge:${judge.id}] Unexpected error: ${e instanceof Error ? e.message : e}`;
          (ctx.logger?.warn ?? console.warn)(msg);
          span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
          span.end();
          return { passed: true, score: 1.0, criteriaScores: {}, failedCriteria: [] as string[], reason: `[skipped: ${msg}]` };
        }
      });
    }),
  );

  meta.evalJudgeResults = results;
  meta.evalJudgeFailed = results.some((r) => !r.passed);
};
