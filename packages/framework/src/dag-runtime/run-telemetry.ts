// Run-level telemetry helpers — root-span lifecycle + observer run-start/run-end events.
//
// Centralises the OTel + observer plumbing the orchestrator (`runDagStateful`)
// would otherwise inline. Two consumers — the orchestrator on the happy
// path, and `eval-judges.ts/finalizeRunWithJudges` from the success branch
// — share the same span-close vocabulary so success/failure paths emit
// identical attributes.

import { INVALID_SPAN_CONTEXT, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { match } from "ts-pattern";
import { fwTracer } from "../tracing/global-tracer.js";
import { fwLogger } from "../logger.js";
import { bestEffort, bestEffortLog } from "./best-effort.js";
import { dispatchEvent } from "../observer/buffered.js";
import type { NodeContext } from "../types/node.js";
import type { DagDef } from "../types/dag.js";
import { safeErrorMessage } from "../types/safe-error.js";
import { type EvalJudgeResult, judgePassed } from "../nodes/eval-judge.js";
import type { DagRunMeta } from "./node-span.js";
import {
  AI_DAG_ID,
  AI_RUN_ID,
  AI_SPAN_TYPE,
  EVENT_NODE_INPUT,
  EVENT_NODE_OUTPUT,
  SPAN_TYPE_CHAIN,
} from "../tracing/semantic-conventions.js";

const FALLBACK_ROOT_SPAN = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);

/** Diagnostics are secondary to the modeled DAG outcome (see `best-effort.ts`). */
const bestEffortRootTelemetry = (operation: string, effect: () => void): void =>
  bestEffort("[runTelemetry]", operation, effect);

// ---------------------------------------------------------------------------
// run-start / run-end observer events
// ---------------------------------------------------------------------------

/** Returned by `beginRunTelemetry`; closes the run-end loop with `emitRunEnd`. */
interface RunTelemetry {
  /** Emit `run-end` with elapsed `duration` and the supplied status. Idempotent at the observer level. */
  readonly emitRunEnd: (status: "ok" | "error") => void;
  /** Time-source seam (defaults to `Date.now`); shared with retry/backoff jitter. */
  readonly nowFn: () => number;
}

/**
 * Emit `run-start` and return the matched `emitRunEnd` closure plus the
 * shared `nowFn`. Call before any code path that could fail (compile, capability
 * validation) so observers always see a balanced start/end pair.
 */
export const beginRunTelemetry = (
  nodeCtx: NodeContext,
  dag: DagDef,
  opts: { readonly now?: () => number },
): RunTelemetry => {
  const nowFn = opts.now ?? Date.now;
  const runStart = nowFn();

  const emitRunEnd = (status: "ok" | "error"): void => {
    const endMs = nowFn();
    dispatchEvent(nodeCtx.observer, {
      type: "run-end",
      runId: nodeCtx.runId,
      dagId: dag.id,
      timestamp: new Date(endMs),
      duration: endMs - runStart,
      status,
    });
  };

  // Capture `emitRunEnd` BEFORE dispatching `run-start`. Otherwise an
  // observer that throws on `run-start` propagates the error out of this
  // function — the caller never receives the closure and the run terminates
  // without a balanced `run-end`. The dispatch failure is logged once; the
  // closure is always returned so the rest of the run remains observable.
  try {
    dispatchEvent(nodeCtx.observer, {
      type: "run-start",
      runId: nodeCtx.runId,
      dagId: dag.id,
      timestamp: new Date(nowFn()),
    });
  } catch (e) {
    bestEffortRootTelemetry("run-start failure log", () => {
      fwLogger().error("[runTelemetry] run-start dispatch threw:", e);
    });
  }

  return { emitRunEnd, nowFn };
};

// ---------------------------------------------------------------------------
// Root-span lifecycle
// ---------------------------------------------------------------------------

/**
 * Open the per-run root span (`run:<dagId>`) with the standard semantic-
 * convention attributes and add the input event. Caller is responsible for
 * eventually closing the span (via `closeRootSpan`).
 */
export const startRunSpan = async <T>(
  dag: DagDef,
  nodeCtx: NodeContext,
  fn: (rootSpan: Span) => Promise<T>,
): Promise<T> => {
  let callbackResult: Promise<T> | undefined;
  try {
    return await fwTracer().startActiveSpan(
      `run:${dag.id}`,
      {
        attributes: {
          [AI_SPAN_TYPE]: SPAN_TYPE_CHAIN,
          [AI_DAG_ID]: dag.id,
          [AI_RUN_ID]: nodeCtx.runId,
        },
      },
      (rootSpan: Span) => {
        bestEffortRootTelemetry("input event", () => {
          rootSpan.addEvent(EVENT_NODE_INPUT, {
            [AI_DAG_ID]: dag.id,
            [AI_RUN_ID]: nodeCtx.runId,
          });
        });
        callbackResult = Promise.resolve().then(() => fn(rootSpan));
        return callbackResult;
      },
    );
  } catch (error) {
    bestEffortLog(
      "debug",
      `[runTelemetry] span creation failed; DAG outcome remains authoritative: ${safeErrorMessage(error)}`,
    );
    return callbackResult ?? fn(FALLBACK_ROOT_SPAN);
  }
};

// ---------------------------------------------------------------------------
// Root-span finalize — single vocabulary for ok / eval-failed / guardrail-failed / error
// ---------------------------------------------------------------------------

/** Discriminated union describing how to close the root span. */
type RootSpanOutcome =
  | { readonly kind: "ok" }
  | {
      readonly kind: "ok-eval-failed";
      readonly failedCriteria: readonly string[];
      readonly evalJudgeResults: readonly EvalJudgeResult[];
    }
  | {
      readonly kind: "ok-guardrail-failed";
      readonly warnings: readonly string[];
    }
  | { readonly kind: "error"; readonly error: unknown };

/**
 * Best-effort status/event finalization. Every span operation is independent so
 * one hostile telemetry method cannot block later cleanup or replace the DAG outcome.
 */
export const closeRootSpan = (rootSpan: Span, outcome: RootSpanOutcome): void => {
  try {
    match(outcome)
      .with({ kind: "ok" }, () => {
        bestEffortRootTelemetry("output event", () => {
          rootSpan.addEvent(EVENT_NODE_OUTPUT, { status: "ok" });
        });
      })
      .with({ kind: "ok-eval-failed" }, ({ failedCriteria, evalJudgeResults }) => {
        bestEffortRootTelemetry("eval status", () => {
          rootSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: `Eval-judge failed: ${failedCriteria.join(", ")}`,
          });
        });
        bestEffortRootTelemetry("eval output event", () => {
          rootSpan.addEvent(EVENT_NODE_OUTPUT, {
            status: "ok",
            evalJudgeFailed: "true",
            evalJudgeResults: JSON.stringify(evalJudgeResults),
          });
        });
      })
      .with({ kind: "ok-guardrail-failed" }, ({ warnings }) => {
        bestEffortRootTelemetry("guardrail status", () => {
          rootSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: `Guardrail failed: ${warnings.join("; ")}`,
          });
        });
        bestEffortRootTelemetry("guardrail output event", () => {
          rootSpan.addEvent(EVENT_NODE_OUTPUT, {
            status: "ok",
            guardrailWarnings: JSON.stringify(warnings),
          });
        });
      })
      .with({ kind: "error" }, ({ error }) => {
        bestEffortRootTelemetry("error status", () => {
          rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: safeErrorMessage(error) });
        });
        bestEffortRootTelemetry("error output event", () => {
          rootSpan.addEvent(EVENT_NODE_OUTPUT, {
            status: "error",
            error: JSON.stringify(error),
          });
        });
      })
      .exhaustive();
  } catch (error) {
    bestEffortLog("debug", `[runTelemetry] outcome finalization failed: ${safeErrorMessage(error)}`);
  } finally {
    bestEffortRootTelemetry("span.end", () => rootSpan.end());
  }
};

/**
 * Translate a finalised `DagRunMeta` (post eval-judge fold) into the matching
 * root-span outcome. Eval-judge failure takes precedence over a guardrail
 * failure when both occur — matches the previous inline ordering.
 */
export const outcomeFromMeta = (meta: DagRunMeta): RootSpanOutcome => {
  if (meta.evalJudgeFailed) {
    const failedCriteria = meta.evalJudgeResults
      .filter((r) => !judgePassed(r))
      .flatMap((r) => r.failedCriteria);
    return {
      kind: "ok-eval-failed",
      failedCriteria,
      evalJudgeResults: meta.evalJudgeResults,
    };
  }
  if (meta.guardrailFailed) {
    return { kind: "ok-guardrail-failed", warnings: meta.guardrailWarnings };
  }
  return { kind: "ok" };
};
