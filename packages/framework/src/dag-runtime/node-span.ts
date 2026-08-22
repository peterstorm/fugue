// node-span.ts — OTel span wrapper + pure guardrail classifier.
//
// Two distinct concerns, deliberately separated:
//
//   1. `withTracedNodeSpan` — OTel infrastructure. Creates a span, sets
//      attributes, records input/output events, sets status, ends the span.
//      Has NO knowledge of guardrails, "passed", or domain semantics.
//
//   2. `classifyGuardrailOutcome` — pure domain logic. Examines a node's
//      result to determine if it represents a guardrail failure. Has NO
//      dependency on OTel.
//
// The caller (`runNodeShared`) composes them: wraps execution in a span,
// then classifies the result. Guardrail-specific span attributes (e.g.
// `ai.guardrail.passed`) are set by the caller after classification, not
// inside the span wrapper.

import { SpanStatusCode } from "@opentelemetry/api";
import { fwTracer } from "../tracing/global-tracer.js";
import type { Result } from "../types/result.js";
import { err } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { EvalJudgeResult } from "../nodes/eval-judge.js";
import type { ContentFilter } from "../tracing/content-filter.js";
import {
  AI_NODE_ID,
  AI_NODE_KIND,
  AI_SPAN_TYPE,
  AI_GUARDRAIL_PASSED,
  AI_NODE_SIDE_EFFECTS_KIND,
  AI_NODE_SIDE_EFFECTS_RESOURCE,
  AI_NODE_IDEMPOTENCY_KEY,
  EVENT_NODE_INPUT,
  EVENT_NODE_OUTPUT,
  NODE_KIND_TO_SPAN_TYPE,
  SPAN_TYPE_CHAIN,
} from "../tracing/semantic-conventions.js";
import { fwLogger } from "../logger.js";
import type { SideEffectProfile } from "../types/side-effects.js";
import { nodeId as brandNodeId } from "../types/ids.js";
import { __brandNodeId } from "../types/ids.js";
import { safeErrorMessage, safeErrorStack } from "../types/safe-error.js";

// ---------------------------------------------------------------------------
// Types (unchanged public surface)
// ---------------------------------------------------------------------------

/** Per-node guardrail outcome — pure data, no OTel coupling. */
export interface NodeSpanOutcome {
  readonly guardrailFailed: boolean;
  readonly guardrailWarnings: readonly string[];
}

export interface DagRunMeta {
  readonly guardrailFailed: boolean;
  readonly guardrailWarnings: readonly string[];
  readonly evalJudgeFailed: boolean;
  readonly evalJudgeResults: readonly EvalJudgeResult[];
}

const EMPTY_OUTCOME: NodeSpanOutcome = {
  guardrailFailed: false,
  guardrailWarnings: [],
};

export { EMPTY_OUTCOME };

export const createDagRunMeta = (): DagRunMeta => ({
  guardrailFailed: false,
  guardrailWarnings: [],
  evalJudgeFailed: false,
  evalJudgeResults: [],
});

/** Diagnostics are secondary to the modeled node outcome. */
const bestEffortLog = (
  level: "debug" | "error",
  message: string,
): void => {
  try {
    fwLogger()[level](message);
  } catch {
    // A broken logger must not replace the primary node failure.
  }
};

/**
 * Fold a batch of per-node outcomes into a fresh, immutable `DagRunMeta`.
 * Concurrent siblings each return their own outcome; the wave caller folds
 * them after `Promise.all` so no two callbacks ever write the same field.
 */
export const foldOutcomes = (
  meta: DagRunMeta,
  outcomes: readonly NodeSpanOutcome[],
): DagRunMeta => {
  if (outcomes.length === 0) return meta;
  const newWarnings = outcomes.flatMap((o) => o.guardrailWarnings);
  const anyFailed = outcomes.some((o) => o.guardrailFailed);
  if (!anyFailed && newWarnings.length === 0) return meta;
  return {
    ...meta,
    guardrailFailed: meta.guardrailFailed || anyFailed,
    guardrailWarnings: [...meta.guardrailWarnings, ...newWarnings],
  };
};

// ---------------------------------------------------------------------------
// classifyGuardrailOutcome — pure domain logic, no OTel dependency
// ---------------------------------------------------------------------------

/**
 * Classify a node's result into a guardrail outcome. Pure function — takes
 * the node kind and result, returns a `NodeSpanOutcome`.
 *
 * Only `guardrail` nodes can produce a failure outcome. A guardrail result
 * is considered failed when `result.value.passed === false`.
 */
export const classifyGuardrailOutcome = (
  kind: string,
  result: Result<unknown, FrameworkError>,
): NodeSpanOutcome => {
  if (!result.ok) return EMPTY_OUTCOME;
  if (kind !== "guardrail") return EMPTY_OUTCOME;
  if (
    result.value &&
    typeof result.value === "object" &&
    "passed" in result.value &&
    !(result.value as { passed: boolean }).passed
  ) {
    const warnings = ((result.value as { warnings?: string[] }).warnings) ?? [];
    return { guardrailFailed: true, guardrailWarnings: warnings };
  }
  return EMPTY_OUTCOME;
};

// ---------------------------------------------------------------------------
// withTracedNodeSpan — OTel infrastructure, no domain logic
// ---------------------------------------------------------------------------

/**
 * Wrap node execution in an OTel span. Infrastructure only — creates the span,
 * sets attributes, records input/output events, sets error status, ends span.
 *
 * Does NOT inspect the result for guardrail semantics. The caller classifies
 * the result via `classifyGuardrailOutcome` after this returns, and may set
 * additional span attributes (e.g. `ai.guardrail.passed`) on the active span.
 *
 * Returns `{ result, span }` where `span` is the (already-ended) span reference.
 * The caller can use the span for post-hoc attribute setting if needed before
 * the span is exported (span attributes can be set after `end()` in many SDKs).
 */
export const withTracedNodeSpan = async (
  nodeId: string,
  kind: string,
  input: unknown,
  contentFilter: ContentFilter | null,
  sideEffects: SideEffectProfile,
  fn: () => Promise<Result<unknown, FrameworkError>>,
): Promise<{ result: Result<unknown, FrameworkError>; outcome: NodeSpanOutcome }> => {
  const spanType = NODE_KIND_TO_SPAN_TYPE[kind] ?? SPAN_TYPE_CHAIN;

  // Build base attributes
  const attrs: Record<string, string> = {
    [AI_SPAN_TYPE]: spanType,
    [AI_NODE_ID]: nodeId,
    [AI_NODE_KIND]: kind,
    [AI_NODE_SIDE_EFFECTS_KIND]: sideEffects.kind,
  };
  if (sideEffects.kind !== "none" && sideEffects.resource) {
    attrs[AI_NODE_SIDE_EFFECTS_RESOURCE] = sideEffects.resource;
  }
  // Evaluate idempotency key lazily — only if the node declares one
  if (
    (sideEffects.kind === "writes" || sideEffects.kind === "external-call") &&
    sideEffects.idempotencyKey
  ) {
    try {
      const idemKey = sideEffects.idempotencyKey(input);
      attrs[AI_NODE_IDEMPOTENCY_KEY] = idemKey;
    } catch (e) {
      // Fail closed: the idempotency key is the dedup signal infrastructure
      // uses for writes / external calls. Running the node without it risks a
      // double-write or duplicate external call. Abort the node instead.
      const message = safeErrorMessage(e);
      bestEffortLog(
        "error",
        `[withTracedNodeSpan] idempotencyKey evaluation failed for node '${nodeId}': ${message}`,
      );
      return {
        result: err({
          kind: "node-crash",
          nodeId: brandNodeId(nodeId),
          retriability: "non-retriable",
          message: `idempotencyKey extractor threw for node '${nodeId}': ${message}`,
        }),
        outcome: EMPTY_OUTCOME,
      };
    }
  }

  return fwTracer().startActiveSpan(
    `node:${nodeId}`,
    { attributes: attrs },
    async (span) => {
      span.addEvent(
        EVENT_NODE_INPUT,
        contentFilter ? { data: contentFilter(JSON.stringify(input)) } : { data_redacted: "true" },
      );

      let result: Result<unknown, FrameworkError>;
      // Guarantee `span.end()` runs on every path — including observer throws
      // re-raised by `dispatchEvent` under `OBSERVER_STRICT=1`. Without the
      // try/finally an unhandled rejection inside `fn()` would leak the span.
      try {
        result = await fn();
      } catch (e) {
        const message = safeErrorMessage(e);
        const stack = safeErrorStack(e);
        try {
          span.setStatus({ code: SpanStatusCode.ERROR, message });
        } catch (spanError) {
          bestEffortLog(
            "debug",
            `[withTracedNodeSpan] span.setStatus failed: ${safeErrorMessage(spanError)}`,
          );
        }
        try {
          span.end();
        } catch (spanError) {
          bestEffortLog(
            "debug",
            `[withTracedNodeSpan] span.end failed — span may leak: ${safeErrorMessage(spanError)}`,
          );
        }
        return {
          result: err({
            kind: "node-crash" as const,
            nodeId: __brandNodeId(nodeId),
            retriability: "retriable" as const,
            message,
            ...(stack ? { stack } : {}),
          }),
          outcome: EMPTY_OUTCOME,
        };
      }

      if (result.ok) {
        span.addEvent(
          EVENT_NODE_OUTPUT,
          contentFilter ? { data: contentFilter(JSON.stringify(result.value)) } : { data_redacted: "true" },
        );
        // Classify guardrail outcome and set span attributes accordingly.
        // This is the one place where the span wrapper touches domain logic —
        // but only to set the span's error status and attribute; the outcome
        // classification itself is delegated to classifyGuardrailOutcome.
        const outcome = classifyGuardrailOutcome(kind, result);
        if (outcome.guardrailFailed) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: `Guardrail failed: ${outcome.guardrailWarnings.join("; ")}` });
          span.setAttribute(AI_GUARDRAIL_PASSED, false);
        }
        span.end();
        return { result, outcome };
      } else {
        const errMsg = result.error && typeof result.error === "object" && "message" in result.error
          ? (result.error as { message: string }).message
          : JSON.stringify(result.error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
        span.end();
        return { result, outcome: EMPTY_OUTCOME };
      }
    },
  );
};

