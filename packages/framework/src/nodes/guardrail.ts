import type { z } from "zod";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { ok } from "../types/result.js";

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
 */
export type GuardrailResult<T> = GuardrailSkipped | GuardrailValidated<T>;

export interface GuardrailSkipped {
  readonly kind: "skipped";
  readonly value: undefined;
  readonly passed: true;
  readonly warnings: readonly string[];  readonly checks: readonly GuardrailCheck[];
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

export interface GuardrailNodeConfig<I, T, Id extends string = string> {
  /** Unique node ID. */
  readonly id: Id;
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
export const createGuardrailNode = <I, T, const Id extends string = string>(
  config: GuardrailNodeConfig<I, T, Id>,
): NodeDef<I, GuardrailResult<T>, FrameworkError, readonly []> & { readonly id: Id } => ({
  id: config.id,
  kind: "guardrail",
  inputSchema: config.inputSchema,
  outputSchema: config.outputSchema,
  requires: [] as const,
  run: async (input, ctx): Promise<Result<GuardrailResult<T>, FrameworkError>> => {
    let result: GuardrailResult<T>;
    try {
      result = config.validate(input);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[guardrail:${config.id}] validate() threw:`, msg);
      // Return a failed validation rather than crashing the pipeline
      result = {
        kind: "validated",
        value: undefined as unknown as T,
        passed: false,
        warnings: [`Guardrail validation threw an error: ${msg}`],
        checks: [{ dimension: "internal-error", passed: false, detail: msg }],
      };
    }

    // Emit guardrail-specific sub-span attributes via observer
    if (ctx.observer && !result.passed) {
      ctx.observer.onSubSpan({
        type: "sub-span",
        runId: ctx.runId,
        dagId: ctx.dagId,
        nodeId: config.id,
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
});
