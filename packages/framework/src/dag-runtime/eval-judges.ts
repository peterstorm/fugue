// Eval-judge runner called by runDagStateful after a successful DAG run.
// Each judge runs in its own OTel span. LLM-side errors surface as the explicit
// `skipped-llm-failure` outcome and fail quality gating closed; they do not erase
// the already-produced DAG output. Orchestrator-level exceptions caught here
// surface as `crash`, which is also fail-closed.

import { type Span, SpanStatusCode } from "@opentelemetry/api";
import type { EvalJudgeNodeDef, EvalJudgeResult } from "../nodes/eval-judge.js";
import { judgePassed, judgeCrashed } from "../types/eval-judge.js";
import { safeErrorMessage } from "../types/safe-error.js";
import { crashResult } from "../nodes/eval-judge.js";
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
import { bestEffort as sharedBestEffort } from "./best-effort.js";

/**
 * Secondary diagnostics must never replace the primary modeled outcome. Bound to
 * the shared `bestEffort` (`best-effort.ts`) — the module that already exists to
 * be the ONE encoding of this rule — so a change to it (e.g. counting suppressed
 * diagnostics) reaches the judge path too. The scope/operation labels are fixed
 * here because every site in this file is the same concern: judge telemetry.
 */
const bestEffort = (action: () => void): void =>
  sharedBestEffort("[eval-judges]", "judge diagnostic", action);

const reportJudgeCrash = (
  judge: EvalJudgeNodeDef,
  ctx: NodeContext,
  cause: unknown,
  span?: Span,
): EvalJudgeResult => {
  const message = safeErrorMessage(cause);
  const diagnostic = `[eval-judge:${judge.id}] Unexpected error: ${message}`;
  bestEffort(() => ctx.logger.error(diagnostic));
  if (span) bestEffort(() => span.setStatus({ code: SpanStatusCode.ERROR, message: diagnostic }));
  return crashResult(message);
};

const executeJudge = async (
  judge: EvalJudgeNodeDef,
  dagInput: unknown,
  dagOutput: unknown,
  nodeOutputs: ReadonlyMap<NodeId, unknown>,
  ctx: NodeContext,
  span?: Span,
): Promise<EvalJudgeResult> => {
  let result: EvalJudgeResult;
  try {
    const judgeInput = { dagInput, dagOutput, nodeOutputs: Object.fromEntries(nodeOutputs) };
    if (span) {
      bestEffort(() => {
        const filter = resolveContentFilter(ctx);
        span.addEvent(EVENT_NODE_INPUT, filter
          ? { data: filter(JSON.stringify({ ...judgeInput, criteria: judge.config.criteria })) }
          : { data_redacted: "true", criteria: JSON.stringify(judge.config.criteria) });
      });
    }
    result = await judge.run(judgeInput, dagOutput, ctx);
  } catch (cause) {
    result = reportJudgeCrash(judge, ctx, cause, span);
  }

  if (span) {
    bestEffort(() => span.addEvent(EVENT_NODE_OUTPUT, { data: JSON.stringify(result) }));
    if (!judgePassed(result)) {
      bestEffort(() => span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `${result.outcome}: score=${result.score ?? "null"}. ${result.reason}`,
      }));
    }
    bestEffort(() => span.end());
  }
  return result;
};

export const runEvalJudges = async (
  judges: readonly EvalJudgeNodeDef[],
  dagInput: unknown,
  dagOutput: unknown,
  nodeOutputs: ReadonlyMap<NodeId, unknown>,
  ctx: NodeContext,
): Promise<EvalJudgeResult[]> =>
  Promise.all(
    judges.map(async (judge): Promise<EvalJudgeResult> => {
      let callbackResult: Promise<EvalJudgeResult> | undefined;
      try {
        return await fwTracer().startActiveSpan(
          `eval-judge:${judge.id}`,
          { attributes: { [AI_SPAN_TYPE]: SPAN_TYPE_TOOL } },
          (span) => {
            callbackResult = executeJudge(judge, dagInput, dagOutput, nodeOutputs, ctx, span);
            return callbackResult;
          },
        );
      } catch (cause) {
        bestEffort(() => ctx.logger.warn(
          `[eval-judge:${judge.id}] tracing unavailable; judge outcome remains authoritative: ${safeErrorMessage(cause)}`,
        ));
        return callbackResult ?? executeJudge(judge, dagInput, dagOutput, nodeOutputs, ctx);
      }
    }),
  );

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
    const evalJudgeFailed = evalJudgeResults.some((r) => !judgePassed(r));
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
      judgesCrashed: meta.evalJudgeResults?.some(judgeCrashed) ?? false,
      meta,
    }))
    .catch((cause): import("./run-dag-stateful.js").BackgroundResult => {
      const logCleanupFailure = (message: string, error: unknown): void =>
        bestEffort(() => fwLogger().error(message, safeErrorMessage(error)));

      logCleanupFailure("[runDagStateful] background finalize failed:", cause);
      try {
        rootSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: safeErrorMessage(cause),
        });
      } catch (setStatusError) {
        logCleanupFailure(
          "[runDagStateful] rootSpan.setStatus threw during background-finalize error cleanup:",
          setStatusError,
        );
      }
      try {
        rootSpan.end();
      } catch (endError) {
        logCleanupFailure(
          "[runDagStateful] rootSpan.end threw during background-finalize error cleanup (span will leak until TTL eviction):",
          endError,
        );
      }
      try {
        emitRunEnd("error");
      } catch (emitError) {
        logCleanupFailure(
          "[runDagStateful] emitRunEnd threw during background-finalize error cleanup:",
          emitError,
        );
      }
      return {
        judgesPassed: false,
        judgesCrashed: true,
        meta: { guardrailFailed: false, guardrailWarnings: [], evalJudgeFailed: true, evalJudgeResults: [] },
      };
    });
