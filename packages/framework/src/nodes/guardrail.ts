import type { z } from "zod";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { ok } from "../types/result.js";

/**
 * Result of a guardrail check.
 */
export interface GuardrailResult<T> {
  /** The original value being validated (passed through). */
  readonly value: T;
  /** Whether all checks passed. */
  readonly passed: boolean;
  /** Human-readable warnings for failed checks. */
  readonly warnings: readonly string[];
  /** Per-check details. */
  readonly checks: readonly {
    readonly dimension: string;
    readonly passed: boolean;
    readonly detail: string;
  }[];
}

export interface GuardrailNodeConfig<I, T> {
  /** Unique node ID. */
  readonly id: string;
  /** Zod schema for the node's input (deps output). */
  readonly inputSchema: z.ZodType<I>;
  /** Zod schema for the node's output. */
  readonly outputSchema: z.ZodType<GuardrailResult<T>>;
  /** Dependency node IDs. */
  readonly deps: readonly string[];
  /**
   * Pure validation function.
   * Receives the assembled input from deps, returns a GuardrailResult.
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
): NodeDef<I, GuardrailResult<T>, FrameworkError> => ({
  id: config.id,
  kind: "guardrail",
  inputSchema: config.inputSchema,
  outputSchema: config.outputSchema,
  deps: config.deps,
  run: async (input, ctx): Promise<Result<GuardrailResult<T>, FrameworkError>> => {
    const result = config.validate(input);

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
