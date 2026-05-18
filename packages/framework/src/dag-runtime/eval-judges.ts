// Eval-judge runner called by runDagStateful after a successful DAG run.
// Each judge runs in its own OTel span. Judge-internal failures (LLM call,
// schema mismatch) fail open with `passed: true, skipped: true` so a broken
// model can't block a run. Orchestrator-level exceptions surface as
// `passed: false, skipped: true, crash: { ... }` so quality gates filtering
// on `passed` see a broken judge rather than silently treating it as passing.

import { type Span, SpanStatusCode } from "@opentelemetry/api";
import type { EvalJudgeNodeDef, EvalJudgeResult } from "../nodes/eval-judge.js";
import type { NodeContext } from "../types/node.js";
import type { DagDef } from "../types/dag.js";
import { fwLogger } from "../logger.js";
import { fwTracer } from "../tracing/global-tracer.js";
import { resolveContentFilter } from "../tracing/content-filter.js";
import {
  AI_SPAN_TYPE,
  EVENT_NODE_INPUT,
  EVENT_NODE_OUTPUT,
  SPAN_TYPE_TOOL,
} from "../tracing/semantic-conventions.js";
import { type DagRunMeta } from "./node-span.js";
import { closeRootSpan, outcomeFromMeta } from "./run-telemetry.js";

import type { NodeId } from "../types/ids.js";

export const runEvalJudges = async (
  judges: readonly EvalJudgeNodeDef[],
  dagInput: unknown,
  dagOutput: unknown,
  nodeOutputs: ReadonlyMap<NodeId, unknown>,
  ctx: NodeContext,
): Promise<EvalJudgeResult[]> => {
  return Promise.all(
    judges.map(async (judge) =>
      fwTracer().startActiveSpan(
        `eval-judge:${judge.id}`,
        { attributes: { [AI_SPAN_TYPE]: SPAN_TYPE_TOOL } },
        async (span) => {
          try {
            const judgeInput = { dagInput, dagOutput, nodeOutputs: Object.fromEntries(nodeOutputs) };
            const filter = resolveContentFilter(ctx);
            span.addEvent(EVENT_NODE_INPUT, filter
              ? { data: filter(JSON.stringify({ ...judgeInput, criteria: judge.config.criteria })) }
              : { data_redacted: "true", criteria: JSON.stringify(judge.config.criteria) });

            const result = await judge.run(judgeInput, dagOutput, ctx);
            span.addEvent(EVENT_NODE_OUTPUT, { data: JSON.stringify(result) });
            if (!result.passed) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: `Score ${result.score} below threshold. ${result.reason}` });
            }
            span.end();
            return result;
          } catch (e) {
            // Orchestrator-side exception (span setup, tracer/attribute bug,
            // or a judge whose `run` threw past its own internal fail-open).
            // Returning `passed: true` here would silently disable quality
            // gates filtering on `passed` — operators would see a broken
            // judge as passing every run. Return `passed: false` with a
            // structured `crash` payload so the failure is visible to both
            // run-end aggregation (`evalJudgeFailed`) and any downstream
            // gating logic.
            const msg = e instanceof Error ? e.message : String(e);
            const prefix = `[eval-judge:${judge.id}] Unexpected error: ${msg}`;
            (ctx.logger?.warn ?? fwLogger().warn)(prefix);
            span.setStatus({ code: SpanStatusCode.ERROR, message: prefix });
            span.end();
            return {
              passed: false,
              score: null,
              criteriaScores: {},
              failedCriteria: [] as string[],
              reason: `[crashed: ${msg}]`,
              skipped: true,
              crash: { kind: "judge-crash" as const, message: msg },
            };
          }
        },
      ),
    ),
  );
};

// ---------------------------------------------------------------------------
// finalizeRunWithJudges — happy-path finalize for runDagStateful
// ---------------------------------------------------------------------------

/**
 * Run eval judges (if any), fold results into `meta`, then close the root
 * span with the matching outcome and emit `run-end("ok")`. Returns the
 * updated meta so callers can inspect judge results without re-running them.
 *
 * Pulled out of `runDagStateful` so the orchestrator only does control flow
 * and the judge/telemetry plumbing lives next to the judges themselves.
 */
export const finalizeRunWithJudges = async (
  rootSpan: Span,
  dag: DagDef,
  input: unknown,
  output: unknown,
  nodeOutputs: ReadonlyMap<NodeId, unknown>,
  nodeCtx: NodeContext,
  meta: DagRunMeta,
  emitRunEnd: (status: "ok" | "error") => void,
): Promise<DagRunMeta> => {
  let updatedMeta = meta;
  if (dag.evalJudges?.length) {
    const evalJudgeResults = await runEvalJudges(
      dag.evalJudges,
      input,
      output,
      nodeOutputs,
      nodeCtx,
    );
    const evalJudgeFailed = evalJudgeResults.some((r) => !r.passed);
    updatedMeta = { ...meta, evalJudgeResults, evalJudgeFailed };
  }
  closeRootSpan(rootSpan, outcomeFromMeta(updatedMeta));
  emitRunEnd("ok");
  return updatedMeta;
};

// ---------------------------------------------------------------------------
// runFinalizeInBackground — defensive cleanup wrapper for `onBackground` mode
// ---------------------------------------------------------------------------

/**
 * Wrap `finalize` so a rejection still closes the root span and emits
 * `run-end("error")`. Each cleanup step is wrapped independently — a
 * `setStatus` failure must not block `end()`, an `end()` failure must not
 * block `emitRunEnd`, etc — otherwise the OTel span leaks open and
 * BufferedObserver retains the run buffer until its TTL.
 *
 * Returns a typed `BackgroundResult` so callers can inspect judge outcomes.
 */
export const runFinalizeInBackground = (
  finalize: () => Promise<DagRunMeta>,
  rootSpan: Span,
  emitRunEnd: (status: "ok" | "error") => void,
): Promise<import("./run-dag-stateful.js").BackgroundResult> =>
  finalize()
    .then((meta): import("./run-dag-stateful.js").BackgroundResult => ({
      judgesPassed: !meta.evalJudgeFailed,
      judgesCrashed: meta.evalJudgeResults?.some((r) => r.crash !== undefined) ?? false,
      meta,
    }))
    .catch((e): import("./run-dag-stateful.js").BackgroundResult => {
      fwLogger().error("[runDagStateful] background finalize failed:", e);
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
      return {
        judgesPassed: false,
        judgesCrashed: true,
        meta: { guardrailFailed: false, guardrailWarnings: [], evalJudgeFailed: true, evalJudgeResults: [] },
      };
    });
