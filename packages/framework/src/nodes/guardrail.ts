import type { z } from "zod";
import type { NodeDef } from "../types/node.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { ok } from "../types/result.js";
import { nodeId } from "../types/ids.js";
import type { NodeId } from "../types/ids.js";
import { emit } from "../dag-runtime/emit.js";

/** Individual check detail. */
export interface GuardrailCheck {
  readonly dimension: string;
  readonly passed: boolean;
  readonly detail: string;
}

/**
 * Result of a guardrail check — discriminated union.
 *
 * - `skipped`: upstream produced no data (e.g. non-ok branch); no validation was performed.
 * - `validated`: upstream data was present and validation ran; `passed` indicates outcome.
 * - `failed`: the validator threw. No `value` is exposed; consumers must branch on `kind`.
 */
export type GuardrailResult<T> = GuardrailSkipped | GuardrailValidated<T> | GuardrailFailed;

export interface GuardrailSkipped {
  readonly kind: "skipped";
  readonly value: undefined;
  readonly passed: true;
  readonly warnings: readonly string[];
  readonly checks: readonly GuardrailCheck[];
}

export interface GuardrailValidated<T> {
  readonly kind: "validated";
  /** The original value being validated (passed through). */
  readonly value: T;
  /** Whether all checks passed. */
  readonly passed: boolean;
  /** Human-readable warnings for failed checks. */
  readonly warnings: readonly string[];
  /** Per-check details. */
  readonly checks: readonly GuardrailCheck[];
}

/**
 * Emitted when the `validate` function throws. Carries the error message but
 * deliberately omits `value` — consumers that read `.value` on the error path
 * get a compile error rather than `undefined as unknown as T` masquerading as T.
 */
export interface GuardrailFailed {
  readonly kind: "failed";
  readonly passed: false;
  readonly error: string;
  readonly warnings: readonly string[];
  readonly checks: readonly GuardrailCheck[];
}

export interface GuardrailNodeConfig<I, T> {
  /** Unique node ID. */
  readonly id: string;
  /** Zod schema for the node's assembled input. */
  readonly inputSchema: z.ZodType<I>;
  /** Zod schema for the node's output. */
  readonly outputSchema: z.ZodType<GuardrailResult<T>>;
  /**
   * Pure validation function.
   * Receives the assembled input (built from incoming edges), returns a GuardrailResult.
   * Must NOT perform I/O — keep it pure and testable.
   */
  readonly validate: (input: I) => GuardrailResult<T>;
}

/**
 * Create a guardrail node that validates data flowing through the DAG.
 *
 * Guardrail nodes:
 * - Run a pure validation function against upstream outputs
 * - Always pass data through (never block the pipeline)
 * - Attach warnings when validation fails
 * - Emit as TOOL spans in MLflow (mapped by the executor via SPAN_TYPE_MAP)
 *
 * The executor is responsible for setting span status to ERROR when
 * `result.passed === false`. See executor.ts for span wrapping behavior.
 */
export const createGuardrailNode = <I, T>(
  config: GuardrailNodeConfig<I, T>,
): NodeDef<I, GuardrailResult<T>, FrameworkError, readonly []> & { readonly id: NodeId } => {
  const id = nodeId(config.id);
  return {
  id,
  kind: "guardrail",
  inputSchema: config.inputSchema,
  outputSchema: config.outputSchema,
  requires: [] as const,
  sideEffects: { kind: "none" },
  confidence: { mode: "none" },
  run: async (input, ctx): Promise<Result<GuardrailResult<T>, FrameworkError>> => {
    let result: GuardrailResult<T>;
    try {
      result = config.validate(input);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.logger.error(`[guardrail:${config.id}] validate() threw: ${msg}`);
      result = {
        kind: "failed",
        passed: false,
        error: msg,
        warnings: [`Guardrail validation threw an error: ${msg}`],
        checks: [{ dimension: "internal-error", passed: false, detail: msg }],
      };
    }

    // Emit guardrail-specific sub-span attributes via observer
    if (!result.passed) {
      emit(ctx, {
        type: "sub-span",
        runId: ctx.runId,
        dagId: ctx.dagId,
        nodeId: id,
        parentSpanId: config.id,
        kind: "GUARDRAIL",
        timestamp: new Date(),
        duration: 0,
        attributes: {
          "guardrail.passed": result.passed,
          "guardrail.checks_total": result.checks.length,
          "guardrail.checks_passed": result.checks.filter((c) => c.passed).length,
          "guardrail.warnings": JSON.stringify(result.warnings),
        },
      });
    }

    return ok(result);
  },
};
};
