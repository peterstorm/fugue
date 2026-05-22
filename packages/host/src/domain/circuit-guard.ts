/**
 * Circuit Guard — encapsulates the multi-step circuit breaker orchestration protocol.
 *
 * The run-dag handler must: get → attemptReset → set → isAllowed → consumeTestRequest → set → execute → recordSuccess/Failure → set.
 * This module captures that protocol as composable pure functions,
 * preventing ordering bugs and missed state writes.
 *
 * DESIGN: This module lives in domain/ despite performing side effects (port.set())
 * because it encapsulates a PURE PROTOCOL — the sequence of state transitions is
 * deterministic given the port's current state. The side effects are limited to
 * the injected port handle; the functions are testable with a trivial Map-backed fake.
 * This is the "pure protocol over injected port" pattern.
 */

import type { DagId } from "@fugue/framework";
import type { CircuitState } from "./circuit-breaker.js";
import { attemptReset, isAllowed, consumeTestRequest, recordSuccess, recordFailure } from "./circuit-breaker.js";

// ── Port Interface ─────────────────────────────────────────────────────────

/**
 * Minimal read/write handle for circuit breaker state.
 * Injected from the imperative shell's mutable Map.
 */
export interface CircuitPort {
  readonly get: (dagId: DagId) => CircuitState;
  readonly set: (dagId: DagId, s: CircuitState) => void;
}

// ── Guard Results ──────────────────────────────────────────────────────────

export type CircuitCheckResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "circuit-open" };

// ── Protocol Functions ─────────────────────────────────────────────────────

/**
 * Check if a request is allowed through the circuit breaker.
 * Handles the full pre-execution protocol: attemptReset → isAllowed → consumeTestRequest.
 *
 * Side effect: writes back the potentially-updated circuit state.
 */
export const checkCircuit = (port: CircuitPort, dagId: DagId, now: number): CircuitCheckResult => {
  let circuit = port.get(dagId);

  // Try reset if open and cooldown elapsed
  circuit = attemptReset(circuit, now);
  port.set(dagId, circuit);

  if (!isAllowed(circuit)) {
    return { allowed: false, reason: "circuit-open" };
  }

  // Consume the single test request in half-open state
  if (circuit.state === "half-open") {
    circuit = consumeTestRequest(circuit);
    port.set(dagId, circuit);
  }

  return { allowed: true };
};

/**
 * Record a successful execution in the circuit breaker.
 * In half-open state, this heals the circuit back to closed.
 */
export const markSuccess = (port: CircuitPort, dagId: DagId, now: number): void => {
  const circuit = recordSuccess(port.get(dagId), now);
  port.set(dagId, circuit);
};

/**
 * Record a failed execution in the circuit breaker.
 * May transition closed → open if threshold exceeded.
 */
export const markFailure = (port: CircuitPort, dagId: DagId, now: number): void => {
  const circuit = recordFailure(port.get(dagId), now);
  port.set(dagId, circuit);
};
