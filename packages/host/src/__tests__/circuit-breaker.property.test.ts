/**
 * Property-based tests for the circuit breaker state machine.
 *
 * Verifies invariants hold for arbitrary sequences of operations:
 * - closed state always allows requests
 * - threshold+1 failures within window → open
 * - success always transitions closed/half-open → closed
 * - forceReset always returns closed
 * - failure count never goes negative
 */

import { describe, test, expect } from "bun:test";
import * as fc from "fast-check";
import {
  initCircuit,
  recordSuccess,
  recordFailure,
  attemptReset,
  forceReset,
  isAllowed,
  consumeTestRequest,
  DEFAULTS,
  type CircuitState,
} from "../domain/circuit-breaker.js";

// ── Arbitraries ────────────────────────────────────────────────────────────

type Action =
  | { type: "success"; now: number }
  | { type: "failure"; now: number }
  | { type: "attemptReset"; now: number }
  | { type: "forceReset"; now: number };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.record({ type: fc.constant("success" as const), now: fc.nat({ max: 1_000_000 }) }),
  fc.record({ type: fc.constant("failure" as const), now: fc.nat({ max: 1_000_000 }) }),
  fc.record({ type: fc.constant("attemptReset" as const), now: fc.nat({ max: 1_000_000 }) }),
  fc.record({ type: fc.constant("forceReset" as const), now: fc.nat({ max: 1_000_000 }) }),
);

const applyAction = (state: CircuitState, action: Action): CircuitState => {
  switch (action.type) {
    case "success":
      return recordSuccess(state, action.now);
    case "failure":
      return recordFailure(state, action.now);
    case "attemptReset":
      return attemptReset(state, action.now);
    case "forceReset":
      return forceReset(action.now);
  }
};

// ── Properties ─────────────────────────────────────────────────────────────

describe("circuit-breaker properties", () => {
  test("closed state always allows requests", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), (now) => {
        const state = initCircuit(now);
        expect(isAllowed(state)).toBe(true);
      }),
    );
  });

  test("forceReset always produces closed state that allows requests", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 1, maxLength: 50 }),
        (actions) => {
          let state: CircuitState = initCircuit(0);
          for (const action of actions) {
            state = applyAction(state, action);
          }
          // After forceReset, always closed
          const reset = forceReset(Date.now());
          expect(reset.state).toBe("closed");
          expect(isAllowed(reset)).toBe(true);
        },
      ),
    );
  });

  test("success from closed stays closed", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }),
        (startNow, successNow) => {
          const state = initCircuit(startNow);
          const next = recordSuccess(state, successNow);
          expect(next.state).toBe("closed");
          expect(isAllowed(next)).toBe(true);
        },
      ),
    );
  });

  test("success from half-open transitions to closed", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), (now) => {
        const halfOpen: CircuitState = { state: "half-open", testRequestAllowed: true };
        const next = recordSuccess(halfOpen, now);
        expect(next.state).toBe("closed");
      }),
    );
  });

  test("threshold+1 failures within window → open", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1000, max: 120_000 }),
        (threshold, windowMs) => {
          let state: CircuitState = initCircuit(0);
          // Apply exactly threshold+1 failures at time 0 (within window)
          for (let i = 0; i <= threshold; i++) {
            state = recordFailure(state, 0, threshold, windowMs);
          }
          expect(state.state).toBe("open");
          expect(isAllowed(state)).toBe(false);
        },
      ),
    );
  });

  test("fewer than threshold failures keeps circuit closed", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 20 }),
        fc.integer({ min: 1000, max: 120_000 }),
        (threshold, windowMs) => {
          let state: CircuitState = initCircuit(0);
          // Apply exactly threshold failures (NOT threshold+1)
          for (let i = 0; i < threshold; i++) {
            state = recordFailure(state, 0, threshold, windowMs);
          }
          expect(state.state).toBe("closed");
          expect(isAllowed(state)).toBe(true);
        },
      ),
    );
  });

  test("failure count is never negative after any sequence of actions", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 1, maxLength: 100 }),
        (actions) => {
          let state: CircuitState = initCircuit(0);
          for (const action of actions) {
            state = applyAction(state, action);
          }
          if (state.state === "closed") {
            expect(state.failureCount).toBeGreaterThanOrEqual(0);
          }
        },
      ),
    );
  });

  test("open circuit blocks all requests", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), (now) => {
        const open: CircuitState = { state: "open", openedAt: now, reason: { kind: "threshold-exceeded", threshold: 5, windowMs: 60_000 } };
        expect(isAllowed(open)).toBe(false);
      }),
    );
  });

  test("attemptReset only transitions from open after cooldown", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 500_000 }),
        fc.integer({ min: 1000, max: 60_000 }),
        fc.nat({ max: 500_000 }),
        (openedAt, cooldown, elapsed) => {
          const open: CircuitState = { state: "open", openedAt, reason: { kind: "threshold-exceeded", threshold: 5, windowMs: 60_000 } };
          const checkTime = openedAt + elapsed;
          const next = attemptReset(open, checkTime, cooldown);

          if (elapsed >= cooldown) {
            expect(next.state).toBe("half-open");
          } else {
            expect(next.state).toBe("open");
          }
        },
      ),
    );
  });

  test("consumeTestRequest in half-open disables further requests", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const halfOpen: CircuitState = { state: "half-open", testRequestAllowed: true };
        expect(isAllowed(halfOpen)).toBe(true);
        const consumed = consumeTestRequest(halfOpen);
        expect(isAllowed(consumed)).toBe(false);
      }),
    );
  });
});
