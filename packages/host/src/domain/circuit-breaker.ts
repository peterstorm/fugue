/**
 * Pure circuit breaker state machine — closed/open/half-open.
 *
 * All transitions are pure — time-based decisions use injected `now`.
 * No timers, no async, no side effects.
 *
 * FR-090: Host MUST track failure count per DAG within a sliding time window
 * FR-091: Host MUST auto-disable a DAG when failures exceed threshold (default: >5 in 1 minute)
 * FR-092: Disabled DAGs MUST be re-enabled automatically when a new version is synced from git
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CircuitState =
  | { readonly state: "closed"; readonly failureCount: number; readonly windowStart: number }
  | { readonly state: "open"; readonly openedAt: number; readonly reason: string }
  | { readonly state: "half-open"; readonly testRequestAllowed: boolean };

/** Default configuration constants */
export const DEFAULTS = {
  /** Number of failures that triggers open state */
  threshold: 5,
  /** Sliding window duration in milliseconds (60 seconds) */
  windowMs: 60_000,
  /** Cooldown before attempting half-open transition in milliseconds (30 seconds) */
  cooldownMs: 30_000,
} as const;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Create initial circuit state (closed, no failures).
 * @param now - Current timestamp for window start (defaults to 0 for testing)
 */
export const initCircuit = (now: number = 0): CircuitState => ({
  state: "closed",
  failureCount: 0,
  windowStart: now,
});

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/**
 * Record a successful execution.
 *
 * - closed → stays closed (resets failure count)
 * - half-open → transitions to closed (circuit healed)
 * - open → stays open (successes are not expected in open state)
 */
export const recordSuccess = (s: CircuitState, now: number): CircuitState => {
  switch (s.state) {
    case "closed":
      // On success in closed state, reset failure tracking
      return { state: "closed", failureCount: 0, windowStart: now };

    case "half-open":
      // Success in half-open means the circuit has healed → close it
      return { state: "closed", failureCount: 0, windowStart: now };

    case "open":
      // Shouldn't receive successes while open, but stay open
      return s;
  }
};

/**
 * Record a failed execution.
 *
 * - closed → increment failure count; if threshold exceeded within window → open
 * - half-open → back to open (the test request failed)
 * - open → stays open
 *
 * @param s - Current circuit state
 * @param now - Current timestamp
 * @param threshold - Number of failures to trigger open (default: 5)
 * @param windowMs - Sliding window size in ms (default: 60_000)
 */
export const recordFailure = (
  s: CircuitState,
  now: number,
  threshold: number = DEFAULTS.threshold,
  windowMs: number = DEFAULTS.windowMs,
): CircuitState => {
  switch (s.state) {
    case "closed": {
      // If we're outside the window, reset the window
      const windowExpired = now - s.windowStart > windowMs;
      const effectiveCount = windowExpired ? 1 : s.failureCount + 1;
      const effectiveWindowStart = windowExpired ? now : s.windowStart;

      // Check threshold (>threshold means we need more than threshold failures)
      if (effectiveCount > threshold) {
        return {
          state: "open",
          openedAt: now,
          reason: `Exceeded ${threshold} failures within ${windowMs}ms window`,
        };
      }

      return {
        state: "closed",
        failureCount: effectiveCount,
        windowStart: effectiveWindowStart,
      };
    }

    case "half-open":
      // Test request failed — back to open
      return {
        state: "open",
        openedAt: now,
        reason: "Half-open test request failed",
      };

    case "open":
      // Already open, no change
      return s;
  }
};

/**
 * Attempt to transition from open to half-open after the cooldown period.
 *
 * - open + cooldown elapsed → half-open (allow one test request)
 * - open + cooldown NOT elapsed → stays open
 * - closed/half-open → no change
 *
 * @param s - Current circuit state
 * @param now - Current timestamp
 * @param cooldownMs - Time that must pass before attempting reset (default: 30_000)
 */
export const attemptReset = (
  s: CircuitState,
  now: number,
  cooldownMs: number = DEFAULTS.cooldownMs,
): CircuitState => {
  switch (s.state) {
    case "open":
      if (now - s.openedAt >= cooldownMs) {
        return { state: "half-open", testRequestAllowed: true };
      }
      return s;

    case "closed":
    case "half-open":
      return s;
  }
};

/**
 * Force-reset the circuit to closed state.
 * Called when a new git version is synced (FR-092).
 * Always returns closed regardless of current state.
 *
 * @param now - Current timestamp for the new window start (defaults to 0)
 */
export const forceReset = (now: number = 0): CircuitState => ({
  state: "closed",
  failureCount: 0,
  windowStart: now,
});

// ---------------------------------------------------------------------------
// Queries (pure)
// ---------------------------------------------------------------------------

/** Check if the circuit allows requests through */
export const isAllowed = (s: CircuitState): boolean => {
  switch (s.state) {
    case "closed":
      return true;
    case "open":
      return false;
    case "half-open":
      return s.testRequestAllowed;
  }
};

/**
 * Consume the test request in half-open state.
 * After this, no more requests are allowed until the test succeeds or fails.
 */
export const consumeTestRequest = (s: CircuitState): CircuitState => {
  if (s.state === "half-open" && s.testRequestAllowed) {
    return { state: "half-open", testRequestAllowed: false };
  }
  return s;
};
