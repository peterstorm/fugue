/**
 * Circuit Guard — encapsulates the multi-step circuit breaker orchestration protocol.
 *
 * The run-dag handler must: get → attemptReset → set → isAllowed → consumeTestRequest → set → execute → recordSuccess/Failure → set.
 * This module captures that protocol as composable functions,
 * preventing ordering bugs and missed state writes.
 *
 * The CircuitPermit token enforces the protocol at the type level:
 * - checkCircuit() returns a permit when allowed (or denied result)
 * - markSuccess() and markFailure() CONSUME the permit — calling without one is a compile error
 * - This makes "mark without check" and "check without mark" impossible
 *
 * DESIGN: This module lives in domain/ because it encapsulates a deterministic
 * protocol over an injected port handle. The transition sequence is fully
 * determined by the port's current state — side effects (port.set()) are confined
 * to the injected handle. Testable with a trivial Map-backed fake.
 */

import type { DagId } from "@fuguejs/framework";
import type { CircuitState } from "./circuit-breaker.js";
import { attemptReset, isAllowed, consumeTestRequest, recordSuccess, recordFailure, DEFAULTS } from "./circuit-breaker.js";

// ── Circuit Breaker Port + Config ────────────────────────────────────────────
// These are domain concepts — a read/write handle over the circuit ADT and the
// thresholds that govern it — so they live in domain/, not ports.ts. Keeping them
// here means the dependency direction stays ports → domain (and run-dag → domain),
// never domain → ports. run-dag.ts imports both from this module.

/**
 * Minimal read/write handle for circuit breaker state.
 * Injected from the imperative shell's mutable Map.
 */
export type CircuitPort = {
  readonly get: (dagId: DagId) => CircuitState;
  readonly set: (dagId: DagId, s: CircuitState) => void;
};

/**
 * Configuration for circuit breaker thresholds.
 * Threaded from HostConfig.CIRCUIT_BREAKER_THRESHOLD / CIRCUIT_BREAKER_WINDOW_MS,
 * or from a per-DAG override (see ResolvedDagConfig.circuitBreaker).
 *
 * `cooldownMs` is optional — when omitted the circuit-breaker default (30s) applies.
 * It controls how long an open circuit waits before allowing a half-open probe.
 */
export type CircuitConfig = {
  readonly threshold: number;
  readonly windowMs: number;
  readonly cooldownMs?: number;
};

/**
 * Default circuit config — used when no explicit config is provided.
 * Matches the default values in HostConfigSchema.
 */
export const DEFAULT_CIRCUIT_CONFIG: CircuitConfig = {
  threshold: DEFAULTS.threshold,
  windowMs: DEFAULTS.windowMs,
};

// ── CircuitPermit Token ────────────────────────────────────────────────────

declare const __circuitPermitBrand: unique symbol;

/**
 * Proof that the circuit breaker allowed this request through.
 * Only `checkCircuit` can produce one. `markSuccess`/`markFailure` consume it.
 * This prevents calling mark* without first checking, or forgetting to mark after execution.
 */
export interface CircuitPermit {
  readonly [__circuitPermitBrand]: void;
  readonly dagId: DagId;
  readonly port: CircuitPort;
}

// ── Guard Results ──────────────────────────────────────────────────────────

export type CircuitCheckResult =
  | { readonly allowed: true; readonly permit: CircuitPermit }
  | { readonly allowed: false; readonly reason: "circuit-open" };

// ── Protocol Functions ─────────────────────────────────────────────────────

/**
 * Check if a request is allowed through the circuit breaker.
 * Handles the full pre-execution protocol: attemptReset → isAllowed → consumeTestRequest.
 *
 * Returns a CircuitPermit token when allowed — this token MUST be passed to
 * markSuccess or markFailure after execution completes.
 *
 * Side effect: writes back the potentially-updated circuit state.
 *
 * @param config - Optional circuit config; its `cooldownMs` governs how long an open
 *   circuit waits before allowing a half-open probe (per-DAG override capable).
 */
export const checkCircuit = (
  port: CircuitPort,
  dagId: DagId,
  now: number,
  config?: CircuitConfig,
): CircuitCheckResult => {
  let circuit = port.get(dagId);

  // Try reset if open and cooldown elapsed
  circuit = attemptReset(circuit, now, config?.cooldownMs);
  port.set(dagId, circuit);

  if (!isAllowed(circuit)) {
    return { allowed: false, reason: "circuit-open" };
  }

  // Consume the single test request in half-open state
  if (circuit.state === "half-open") {
    circuit = consumeTestRequest(circuit);
    port.set(dagId, circuit);
  }

  const permit: CircuitPermit = { dagId, port } as unknown as CircuitPermit;
  return { allowed: true, permit };
};

/**
 * Record a successful execution in the circuit breaker.
 * In half-open state, this heals the circuit back to closed.
 *
 * Consumes the CircuitPermit — enforces that check was called first.
 */
export const markSuccess = (permit: CircuitPermit, now: number): void => {
  const circuit = recordSuccess(permit.port.get(permit.dagId), now);
  permit.port.set(permit.dagId, circuit);
};

/**
 * Record a failed execution in the circuit breaker.
 * May transition closed → open if threshold exceeded.
 *
 * Consumes the CircuitPermit — enforces that check was called first.
 *
 * @param config - Circuit breaker thresholds (from HostConfig). Defaults to DEFAULTS if omitted.
 */
export const markFailure = (
  permit: CircuitPermit,
  now: number,
  config: CircuitConfig = DEFAULT_CIRCUIT_CONFIG,
): void => {
  const circuit = recordFailure(permit.port.get(permit.dagId), now, config.threshold, config.windowMs);
  permit.port.set(permit.dagId, circuit);
};
