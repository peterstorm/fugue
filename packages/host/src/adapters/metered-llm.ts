/**
 * Metered LLM decorator — the imperative shell around the pure `llm-meter`.
 *
 * Wraps the host `LlmClient` so that every node-facing call is:
 *   1. attributed with the run's `(dagId, runId, nodeId)` triple (FR-W0-001),
 *   2. budget-checked BEFORE the call against the in-process cumulative counter
 *      (FR-W1-002, FR-W1-004) — refusing with `Err(llm-budget-exceeded)`,
 *   3. accumulated into the meter AFTER the call, then logged as a structured
 *      line carrying the attribution triple + token deltas (FR-W0-002).
 *
 * Zero network round trips are added: the meter and budget decision are pure
 * in-process operations (FR-W1-005, SC-002, SC-004). One decorator instance is
 * constructed per NodeContext (per run), so its meter is naturally run-scoped —
 * `budgetDecision` is keyed by `runId` for defence in depth but a given
 * decorator only ever sees one run.
 *
 * @satisfies FR-W0-001 FR-W0-002 FR-W0-004 FR-W1-002 FR-W1-003 FR-W1-004
 * @satisfies FR-W1-005 FR-W1-006 SC-001 SC-002 SC-003 SC-004
 * @satisfies FR-W2-009 — LLM is the first invocation-scoped capability
 */

import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  SendWithToolsRequest,
  NodeContext,
  Result,
  FrameworkError,
  DagId,
  RunId,
  NodeId,
} from "@fuguejs/framework";
import { err, usageOfError } from "@fuguejs/framework";
import type { LogPort } from "../ports.js";
import {
  emptyMeter,
  accumulate,
  budgetDecision,
  usageFor,
  runTotal,
  type LlmMeter,
  type BudgetDecision,
} from "../domain/llm-meter.js";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Construction-time dependencies for the metered decorator. `dagId`/`runId`
 * bind the decorator to a single run; `budget` is the optional per-run token
 * budget (`llmBudgetTokens`) — when `undefined`, metering still happens but no
 * call is ever refused (FR-W1-006).
 */
export interface MeteredLlmDeps {
  readonly dagId: DagId;
  readonly runId: RunId;
  readonly budget?: number;
  readonly logger: LogPort;
}

// ---------------------------------------------------------------------------
// Decorator
// ---------------------------------------------------------------------------

/**
 * Wrap an inner `LlmClient` with per-run metering + budget enforcement.
 *
 * The returned client satisfies the same `LlmClient` interface, so it is a
 * drop-in replacement at the NodeContext seam — nodes are unaware they are
 * metered.
 */
export const createMeteredLlm = (inner: LlmClient, deps: MeteredLlmDeps): LlmClient => {
  // In-process, run-scoped counter. Mutated only here, behind the pure
  // `accumulate` transition — the meter value itself is immutable.
  let meter: LlmMeter = emptyMeter();
  const { dagId, runId, budget, logger } = deps;

  // Concurrency reservation (review I1 / SC-003). `budgetDecision` refuses only
  // once cumulative ≥ budget, but cumulative updates AFTER a call settles — so N
  // calls fired in parallel (e.g. several nodes in one wave) all read the same
  // pre-settle cumulative, all pass the gate, and overshoot by N rather than one.
  // We treat ADMITTED-but-unsettled calls as already-spending by reserving a
  // learned per-call estimate (`maxObservedCall`, the largest single call seen so
  // far) and refusing when `cumulative + reservedInFlight ≥ budget`. Steady-state
  // overshoot is bounded to ~one call; the very first parallel burst (before any
  // call has settled, so the estimate is still 0) can still overshoot, which is
  // the documented FR-W1-004 "overshoot by at most one" allowance generalised.
  let reservedInFlight = 0;
  let maxObservedCall = 0;

  /**
   * Pre-call gate. Returns either a budget-refusal error, or a `release` thunk to
   * call once the admitted call settles (which frees its reservation). Reserving
   * BEFORE the call and releasing AFTER is what makes the gate concurrency-safe.
   */
  const admit = (nodeId: NodeId): { readonly error: FrameworkError } | { readonly release: () => void } => {
    const decision: BudgetDecision = budgetDecision(meter, runId, budget);
    const projected = decision.cumulative + reservedInFlight;
    // The exceeded budget, when over: a `refuse` decision carries it; the
    // projection branch requires a defined `budget` to fire. Reading it off the
    // branches keeps this cast-free — `undefined` means "admit".
    const exceededBudget =
      decision.kind === "refuse"
        ? decision.budget
        : budget !== undefined && projected >= budget
          ? budget
          : undefined;
    if (exceededBudget !== undefined) {
      logger.warn("LLM budget exceeded — refusing call", {
        dagId: dagId as string,
        runId: runId as string,
        nodeId: nodeId as string,
        cumulative: decision.cumulative,
        reservedInFlight,
        budget: exceededBudget,
      });
      return {
        error: {
          kind: "llm-budget-exceeded",
          runId,
          nodeId,
          // SETTLED cumulative only (the errors.ts contract): the in-flight
          // reservation that may have triggered this refusal is reported in the
          // warn log above (`reservedInFlight`), never in the error figure, so
          // `cumulative` always reconciles against the `llm.metered` totals.
          cumulative: decision.cumulative,
          budget: exceededBudget,
        },
      };
    }
    // Admit: reserve this call's learned estimate; capture the exact amount so the
    // release frees precisely what was reserved even if `maxObservedCall` grows.
    const reserved = maxObservedCall;
    reservedInFlight += reserved;
    return { release: () => { reservedInFlight -= reserved; } };
  };

  /** Post-call bookkeeping — accumulate the delta and emit the metering log. */
  const record = (
    nodeId: NodeId,
    operation: "sendStructured" | "sendWithTools",
    tokensIn: number,
    tokensOut: number,
  ): void => {
    // Learn the per-call estimate the concurrency reservation uses (I1).
    maxObservedCall = Math.max(maxObservedCall, tokensIn + tokensOut);
    meter = accumulate(meter, runId, { tokensIn, tokensOut });
    const cumulative = runTotal(usageFor(meter, runId));
    logger.info("llm.metered", {
      dagId: dagId as string,
      runId: runId as string,
      nodeId: nodeId as string,
      operation,
      tokensIn,
      tokensOut,
      cumulative,
      ...(budget !== undefined ? { budget } : {}),
    });
  };

  /**
   * Settle one node-facing call's accounting, UNCONDITIONALLY (FR-W0-001).
   *
   * On `ok` the response's token deltas are metered. On `err` any partial usage
   * the failure carries (tokens burned across already-completed turns of a
   * multi-turn `sendWithTools` loop, or a final-answer parse failure) is ALSO
   * metered — so a failed call can never bypass the per-run budget — and a
   * structured `llm.call-failed` line is emitted (FR-W0-002). The `result` is
   * returned untouched so the decorator stays a transparent pass-through.
   */
  const settle = <O>(
    nodeId: NodeId,
    operation: "sendStructured" | "sendWithTools",
    result: Result<LlmResponse<O>, FrameworkError>,
  ): Result<LlmResponse<O>, FrameworkError> => {
    if (result.ok) {
      // `sendWithTools` aggregates tokens across all turns of its loop into a
      // single LlmResponse — one accumulate per outer call matches the
      // overshoot-by-one semantics (the whole loop is the in-flight "call").
      record(nodeId, operation, result.value.tokensIn, result.value.tokensOut);
      return result;
    }
    // Failure path: attribute any tokens the failed call consumed, then log.
    const partial = usageOfError(result.error);
    if (partial !== undefined && (partial.tokensIn > 0 || partial.tokensOut > 0)) {
      record(nodeId, operation, partial.tokensIn, partial.tokensOut);
    }
    logger.warn("llm.call-failed", {
      dagId: dagId as string,
      runId: runId as string,
      nodeId: nodeId as string,
      operation,
      errorKind: result.error.kind,
      ...(partial !== undefined ? { tokensIn: partial.tokensIn, tokensOut: partial.tokensOut } : {}),
    });
    return result;
  };

  return {
    sendStructured: async <O>(
      req: LlmRequest<O>,
    ): Promise<Result<LlmResponse<O>, FrameworkError>> => {
      const gate = admit(req.nodeId);
      if ("error" in gate) return err(gate.error);
      try {
        return settle(req.nodeId, "sendStructured", await inner.sendStructured(req));
      } finally {
        gate.release();
      }
    },

    sendWithTools: async <O>(
      req: SendWithToolsRequest<O>,
      ctx: NodeContext,
    ): Promise<Result<LlmResponse<O>, FrameworkError>> => {
      const gate = admit(req.nodeId);
      if ("error" in gate) return err(gate.error);
      try {
        return settle(req.nodeId, "sendWithTools", await inner.sendWithTools(req, ctx));
      } finally {
        gate.release();
      }
    },
  };
};
