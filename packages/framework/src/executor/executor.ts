import type { DagDef } from "../types/dag.js";
import type { NodeContext, NodeDef } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { ObserverEvent } from "../types/events.js";
import type { Observer } from "../observer/observer.js";
import { type Result, ok, err } from "../types/result.js";
import { topoSort } from "./topo.js";
import { validateInput, validateOutput } from "./validate.js";
import { dispatchEvent } from "../observer/buffered.js";

// OTel span integration — optional, gracefully no-ops if tracing not initialized
let _withSpan: typeof import("@mlflow/core").withSpan | null = null;
let _SpanType: typeof import("@mlflow/core").SpanType | null = null;
let _SpanStatusCode: typeof import("@mlflow/core").SpanStatusCode | null = null;

// Lazy-load @mlflow/core to avoid hard dependency
const loadMlflow = async () => {
  if (_withSpan) return;
  try {
    const mlflow = await import("@mlflow/core");
    _withSpan = mlflow.withSpan;
    _SpanType = mlflow.SpanType;
    _SpanStatusCode = mlflow.SpanStatusCode;
  } catch {
    // @mlflow/core not available — tracing disabled
  }
};

const SPAN_TYPE_MAP: Record<string, string> = {
  llm: "LLM",
  fetch: "RETRIEVER",
  transform: "CHAIN",
  guardrail: "TOOL",
};

export interface RunOptions {
  readonly resume?: {
    readonly runId: string;
    readonly checkpoint: Map<string, unknown>;
  };
}

const emit = (ctx: NodeContext, event: ObserverEvent) => {
  if (ctx.observer) {
    dispatchEvent(ctx.observer as Observer, event);
  }
};

export const runDag = async <I, O>(
  dag: DagDef,
  input: I,
  ctx: NodeContext,
  opts?: RunOptions,
): Promise<Result<O, FrameworkError>> => {
  await loadMlflow();

  if (_withSpan) {
    return _withSpan(async (rootSpan) => {
      rootSpan.setInputs({ dagId: dag.id, runId: ctx.runId });
      const meta: DagRunMeta = { guardrailFailed: false, guardrailWarnings: [] };
      const result = await runDagInner(dag, input, ctx, opts, meta);
      if (result.ok) {
        if (meta.guardrailFailed) {
          // Guardrail failed but response still returned — mark trace as ERROR so it's visible in MLflow
          rootSpan.setStatus(_SpanStatusCode!.ERROR, `Guardrail failed: ${meta.guardrailWarnings.join("; ")}`);
          rootSpan.setOutputs({ status: "ok", guardrailWarnings: meta.guardrailWarnings });
        } else {
          rootSpan.setOutputs({ status: "ok" });
        }
      } else {
        rootSpan.setStatus(_SpanStatusCode!.ERROR, String(result.error));
        rootSpan.setOutputs({ status: "error", error: result.error });
      }
      return result;
    }, { name: `run:${dag.id}`, spanType: _SpanType!.CHAIN }) as Promise<Result<O, FrameworkError>>;
  }

  return runDagInner(dag, input, ctx, opts, undefined);
};

/** Metadata collected during DAG execution for trace-level status propagation. */
interface DagRunMeta {
  /** True if any guardrail node returned passed: false */
  guardrailFailed: boolean;
  /** Warning messages from failed guardrails */
  guardrailWarnings: string[];
}

const runDagInner = async <I, O>(
  dag: DagDef,
  input: I,
  ctx: NodeContext,
  opts?: RunOptions,
  meta?: DagRunMeta,
): Promise<Result<O, FrameworkError>> => {
  // 1. Topo sort (cycle detection)
  const sortResult = topoSort(dag);
  if (!sortResult.ok) return sortResult;

  const waves = sortResult.value;
  const nodeMap = new Map<string, NodeDef<any, any, any>>(
    dag.nodes.map((n) => [n.id, n]),
  );
  const outputs = new Map<string, unknown>();
  const checkpoint = opts?.resume?.checkpoint;

  const runStart = Date.now();
  emit(ctx, { type: "run-start", runId: ctx.runId, dagId: dag.id, timestamp: new Date() });

  for (const wave of waves) {
    const results = await Promise.all(
      wave.map(async (nodeId) => {
        const node = nodeMap.get(nodeId)!;

        // Check checkpoint for resume
        if (checkpoint?.has(nodeId)) {
          const cached = checkpoint.get(nodeId);
          emit(ctx, {
            type: "node-skipped",
            runId: ctx.runId,
            dagId: dag.id,
            nodeId,
            timestamp: new Date(),
            reason: "checkpoint",
          });
          outputs.set(nodeId, cached);
          return ok(cached);
        }

        // Build node input from deps
        const nodeInput = node.deps.length === 0
          ? input
          : node.deps.length === 1
            ? outputs.get(node.deps[0])
            : Object.fromEntries(node.deps.map((d) => [d, outputs.get(d)]));

        // Validate input
        const inputResult = validateInput(node.inputSchema, nodeInput, nodeId);
        if (!inputResult.ok) return inputResult;

        // Execute node — optionally wrapped in an OTel span
        const executeNode = async (): Promise<Result<any, FrameworkError>> => {
          const nodeStart = Date.now();
          emit(ctx, {
            type: "node-start",
            runId: ctx.runId,
            dagId: dag.id,
            nodeId,
            timestamp: new Date(),
          });

          let runResult: Result<any, any>;
          try {
            runResult = await node.run(inputResult.value, ctx);
          } catch (e) {
            const error: FrameworkError = {
              kind: "node-crash",
              nodeId,
              message: e instanceof Error ? e.message : String(e),
              stack: e instanceof Error ? e.stack : undefined,
            };
            return err(error);
          }

          if (!runResult.ok) {
            emit(ctx, {
              type: "node-error",
              runId: ctx.runId,
              dagId: dag.id,
              nodeId,
              timestamp: new Date(),
              error: String(runResult.error),
            });
            return runResult as Result<never, FrameworkError>;
          }

          // Validate output
          const outputResult = validateOutput(node.outputSchema, runResult.value, nodeId);
          if (!outputResult.ok) return outputResult;

          const duration = Date.now() - nodeStart;
          outputs.set(nodeId, outputResult.value);

          // Write checkpoint if available
          if (ctx.cache?.writeCheckpoint) {
            await ctx.cache.writeCheckpoint(ctx.runId, nodeId, outputResult.value);
          }

          emit(ctx, {
            type: "node-end",
            runId: ctx.runId,
            dagId: dag.id,
            nodeId,
            timestamp: new Date(),
            duration,
            output: outputResult.value,
          });

          return ok(outputResult.value);
        };

        // Wrap in OTel span if tracing is available
        if (_withSpan && _SpanType) {
          const spanType = (SPAN_TYPE_MAP[node.kind] ?? "CHAIN") as keyof typeof _SpanType;
          return _withSpan(async (span) => {
            span.setInputs(inputResult.value);
            const result = await executeNode();
            if (result.ok) {
              span.setOutputs(result.value);
              // Guardrail nodes: set span to ERROR when validation fails
              if (node.kind === "guardrail" && result.value && typeof result.value === "object" && "passed" in result.value && !(result.value as any).passed) {
                const warnings = (result.value as any).warnings ?? [];
                span.setStatus(_SpanStatusCode!.ERROR, `Guardrail failed: ${warnings.join("; ")}`);
                // Propagate to trace-level meta
                if (meta) {
                  meta.guardrailFailed = true;
                  meta.guardrailWarnings.push(...warnings);
                }
              }
            } else {
              span.setStatus(_SpanStatusCode!.ERROR, String(result.error));
            }
            return result;
          }, { name: `node:${nodeId}`, spanType: (_SpanType as any)[spanType] ?? _SpanType.CHAIN }) as Promise<Result<any, FrameworkError>>;
        }

        return executeNode();
      }),
    );

    // Check for any errors in this wave
    for (const r of results) {
      if (!r.ok) {
        emit(ctx, {
          type: "run-end",
          runId: ctx.runId,
          dagId: dag.id,
          timestamp: new Date(),
          duration: Date.now() - runStart,
          status: "error",
        });
        return r as Result<O, FrameworkError>;
      }
    }
  }

  emit(ctx, {
    type: "run-end",
    runId: ctx.runId,
    dagId: dag.id,
    timestamp: new Date(),
    duration: Date.now() - runStart,
    status: "ok",
  });

  // Return last node's output
  const lastWave = waves[waves.length - 1];
  const lastNodeId = lastWave[lastWave.length - 1];
  return ok(outputs.get(lastNodeId) as O);
};

export const resumeRun = async <O>(
  runId: string,
  dag: DagDef,
  ctx: NodeContext,
  checkpoint: Map<string, unknown>,
): Promise<Result<O, FrameworkError>> => {
  return runDag(dag, undefined, ctx, { resume: { runId, checkpoint } });
};
