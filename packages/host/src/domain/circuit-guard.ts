/**
 * Circuit Guard — encapsulates the multi-step circuit breaker orchestration protocol.
 *
 * The run-dag handler must: get → attemptReset → set → isAllowed → consumeTestRequest → set → execute → recordSuccess/Failure → set.
 * This module captures that protocol as composable functions,
 * preventing ordering bugs and missed state writes.
 *
 * DESIGN: This module lives in domain/ because it encapsulates a deterministic
 * protocol over an injected port handle. The transition sequence is fully
 * determined by the port's current state — side effects (port.set()) are confined
 * to the injected handle. Testable with a trivial Map-backed fake.
 */

import type { DagId } from "@fugue/framework";
import type { CircuitState } from "./circuit-breaker.js";
import { attemptReset, isAllowed, consumeTestRequest, recordSuccess, recordFailure, DEFAULTS } from "./circuit-breaker.js";

// ── Port Interface ─────────────────────────────────────────────────────────

/**
 * Minimal read/write handle for circuit breaker state.
 * Injected from the imperative shell's mutable Map.
 */
export interface CircuitPort {
  readonly get: (dagId: DagId) => CircuitState;
  readonly set: (dagId: DagId, s: CircuitState) => void;
}

/**
 * Configuration for circuit breaker thresholds.
 * Threaded from HostConfig.CIRCUIT_BREAKER_THRESHOLD / CIRCUIT_BREAKER_WINDOW_MS.
 */
export interface CircuitConfig {
  readonly threshold: number;
  readonly windowMs: number;
}

/**
 * Default circuit config — used when no explicit config is provided.
 * Matches the default values in HostConfigSchema.
 */
export const DEFAULT_CIRCUIT_CONFIG: CircuitConfig = {
  threshold: DEFAULTS.threshold,
  windowMs: DEFAULTS.windowMs,
};

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
 *
 * @param config - Circuit breaker thresholds (from HostConfig). Defaults to DEFAULTS if omitted.
 */
export const markFailure = (
  port: CircuitPort,
  dagId: DagId,
  now: number,
  config: CircuitConfig = DEFAULT_CIRCUIT_CONFIG,
): void => {
  const circuit = recordFailure(port.get(dagId), now, config.threshold, config.windowMs);
  port.set(dagId, circuit);
};
