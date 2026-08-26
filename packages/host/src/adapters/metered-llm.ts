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
 *
 * FR-W2-009 groundwork — run-scoped LLM authority, NOT yet on the broker's
 * `mintFor` seam: this decorator is per-run NodeContext wiring, and the runtime
 * currently rejects a broker claiming `provides("llm")` (see
 * keycloak-broker.ts). Migration onto the seam lifts both guards.
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
import { err, safeErrorMessage, totalTokens, usageOfError } from "@fuguejs/framework";
import type { TokenUsage } from "@fuguejs/framework";
import type { LogPort } from "../ports.js";
import { logWithoutThrowing } from "../hitl/diagnostic-logging.js";
import {
  emptyMeter,
  accumulate,
  usageFor,
  runTotal,
  emptyReservation,
  admitWithReservation,
  releaseReservation,
  learnObservedCall,
  type LlmMeter,
  type ReservationState,
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
interface MeteredLlmDeps {
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

  // Concurrency reservation (review I1 / SC-003). The DECISION logic is pure —
  // `admitWithReservation` / `releaseReservation` / `learnObservedCall` in
  // llm-meter.ts (see its ReservationState doc for the overshoot bound) — and
  // this shell holds the one mutable cell, the same shape as the broker's cells
  // over the pure token-cache.
  let reservation: ReservationState = emptyReservation;

  /**
   * The correlation triple every structured line in this adapter carries.
   *
   * Extracted because a metering or failure line that is MISSING one of these
   * is unjoinable to the run that produced it — the figure becomes a number
   * nobody can reconcile against a budget. One definition means the four call
   * sites cannot drift apart by hand-editing.
   */
  const attribution = (nodeId: NodeId): Record<string, string> => ({
    dagId: dagId as string,
    runId: runId as string,
    nodeId: nodeId as string,
  });

  /**
   * Pre-call gate. Returns either a budget-refusal error, or a `release` thunk to
   * call once the admitted call settles (which frees its reservation). Reserving
   * BEFORE the call and releasing AFTER is what makes the gate concurrency-safe.
   */
  const admit = (nodeId: NodeId): { readonly error: FrameworkError } | { readonly release: () => void } => {
    const decision = admitWithReservation(meter, runId, reservation, budget);
    if (decision.kind === "refuse") {
      logWithoutThrowing(logger, "warn", "LLM budget exceeded — refusing call", {
        ...attribution(nodeId),
        cumulative: decision.cumulative,
        reservedInFlight: decision.reservedInFlight,
        budget: decision.budget,
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
          budget: decision.budget,
        },
      };
    }
    // Admit: the pure transition already reserved this call's learned estimate;
    // `decision.reserved` captures the exact amount so the release frees
    // precisely what was reserved even if the estimate has since grown.
    reservation = decision.state;
    return { release: () => { reservation = releaseReservation(reservation, decision.reserved); } };
  };

  /** Post-call bookkeeping — accumulate the delta and emit the metering log. */
  const record = (
    nodeId: NodeId,
    operation: "sendStructured" | "sendWithTools",
    usage: TokenUsage,
  ): void => {
    // Learn the per-call estimate the concurrency reservation uses (I1).
    reservation = learnObservedCall(reservation, totalTokens(usage));
    meter = accumulate(meter, runId, usage);
    const cumulative = runTotal(usageFor(meter, runId));
    // The cache split rides on the metering line so an operator can see what a
    // run's tokens COST, not just how many there were: a cache read is billed
    // at ~0.1x and a write at a premium, so two runs with identical totals can
    // differ by an order of magnitude in spend.
    logWithoutThrowing(logger, "info", "llm.metered", {
      ...attribution(nodeId),
      operation,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      cacheWriteTokens: usage.cacheWriteTokens,
      cacheReadTokens: usage.cacheReadTokens,
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
      // `LlmResponse` extends `TokenUsage`, so the response IS the delta.
      record(nodeId, operation, result.value);
      return result;
    }
    // Failure path: attribute any tokens the failed call consumed, then log.
    const partial = usageOfError(result.error);
    if (partial !== undefined && totalTokens(partial) > 0) {
      record(nodeId, operation, partial);
    }
    logWithoutThrowing(logger, "warn", "llm.call-failed", {
      ...attribution(nodeId),
      operation,
      errorKind: result.error.kind,
      ...(partial !== undefined
        ? {
            tokensIn: partial.tokensIn,
            tokensOut: partial.tokensOut,
            cacheWriteTokens: partial.cacheWriteTokens,
            cacheReadTokens: partial.cacheReadTokens,
          }
        : {}),
    });
    return result;
  };

  /**
   * A THROWING inner client is a port-contract violation (the `LlmClient`
   * contract is a settled `Result`) — the error itself still surfaces via
   * run-node's catch as `node-crash`, but without this log the decorator's
   * accounting contract would be skipped silently (no `llm.call-failed` line,
   * nothing metered — tokens for a throwing call are unknowable). Log with
   * `errorKind: "thrown"` and rethrow; the `finally` still releases the
   * reservation either way.
   */
  const logThrown = (nodeId: NodeId, operation: "sendStructured" | "sendWithTools", e: unknown): void => {
    logWithoutThrowing(logger, "warn", "llm.call-failed", {
      ...attribution(nodeId),
      operation,
      errorKind: "thrown",
      message: safeErrorMessage(e),
    });
  };

  return {
    sendStructured: async <O>(
      req: LlmRequest<O>,
    ): Promise<Result<LlmResponse<O>, FrameworkError>> => {
      const gate = admit(req.nodeId);
      if ("error" in gate) return err(gate.error);
      try {
        return settle(req.nodeId, "sendStructured", await inner.sendStructured(req));
      } catch (e) {
        logThrown(req.nodeId, "sendStructured", e);
        throw e;
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
      } catch (e) {
        logThrown(req.nodeId, "sendWithTools", e);
        throw e;
      } finally {
        gate.release();
      }
    },
  };
};
