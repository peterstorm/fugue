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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_000_000;
const THRESHOLD = DEFAULTS.threshold; // 5
const WINDOW_MS = DEFAULTS.windowMs; // 60_000
const COOLDOWN_MS = DEFAULTS.cooldownMs; // 30_000

/** Record N failures in sequence */
function failN(state: CircuitState, n: number, startTime: number = NOW): CircuitState {
  let current = state;
  for (let i = 0; i < n; i++) {
    current = recordFailure(current, startTime + i, THRESHOLD, WINDOW_MS);
  }
  return current;
}

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

describe("Circuit Breaker", () => {
  describe("initCircuit", () => {
    test("creates closed state with zero failures", () => {
      const state = initCircuit(NOW);
      expect(state.state).toBe("closed");
      if (state.state !== "closed") return;
      expect(state.failureCount).toBe(0);
      expect(state.windowStart).toBe(NOW);
    });

    test("defaults to windowStart of 0", () => {
      const state = initCircuit();
      if (state.state !== "closed") return;
      expect(state.windowStart).toBe(0);
    });
  });

  describe("recordSuccess", () => {
    test("closed → stays closed, resets failure count", () => {
      const initial = initCircuit(NOW);
      const withFailures = failN(initial, 3);
      if (withFailures.state !== "closed") throw new Error("Expected closed");
      expect(withFailures.failureCount).toBe(3);

      const after = recordSuccess(withFailures, NOW + 100);
      expect(after.state).toBe("closed");
      if (after.state !== "closed") return;
      expect(after.failureCount).toBe(0);
      expect(after.windowStart).toBe(NOW + 100);
    });

    test("half-open → transitions to closed (healed)", () => {
      const halfOpen: CircuitState = { state: "half-open", testRequestAllowed: false };
      const after = recordSuccess(halfOpen, NOW);
      expect(after.state).toBe("closed");
      if (after.state !== "closed") return;
      expect(after.failureCount).toBe(0);
    });

    test("open → stays open (unexpected success)", () => {
      const open: CircuitState = { state: "open", openedAt: NOW, reason: "test" };
      const after = recordSuccess(open, NOW + 1000);
      expect(after.state).toBe("open");
    });
  });

  describe("recordFailure", () => {
    test("closed → increments failure count within window", () => {
      const initial = initCircuit(NOW);
      const after = recordFailure(initial, NOW + 1000, THRESHOLD, WINDOW_MS);
      expect(after.state).toBe("closed");
      if (after.state !== "closed") return;
      expect(after.failureCount).toBe(1);
    });

    test("closed → transitions to open when threshold exceeded", () => {
      const initial = initCircuit(NOW);
      // 5 failures = at threshold, 6th failure exceeds it (>5)
      const after = failN(initial, THRESHOLD + 1);
      expect(after.state).toBe("open");
      if (after.state !== "open") return;
      expect(after.reason).toContain("5");
    });

    test("closed → does NOT transition to open at exactly threshold", () => {
      const initial = initCircuit(NOW);
      const after = failN(initial, THRESHOLD); // exactly 5
      expect(after.state).toBe("closed");
      if (after.state !== "closed") return;
      expect(after.failureCount).toBe(THRESHOLD);
    });

    test("closed → resets window when failures outside window", () => {
      const initial = initCircuit(NOW);
      const withFailures = failN(initial, 4); // 4 failures
      // Now record a failure way past the window
      const pastWindow = NOW + WINDOW_MS + 1;
      const after = recordFailure(withFailures, pastWindow, THRESHOLD, WINDOW_MS);
      expect(after.state).toBe("closed");
      if (after.state !== "closed") return;
      // Window reset — count should be 1, not 5
      expect(after.failureCount).toBe(1);
      expect(after.windowStart).toBe(pastWindow);
    });

    test("half-open → transitions back to open", () => {
      const halfOpen: CircuitState = { state: "half-open", testRequestAllowed: false };
      const after = recordFailure(halfOpen, NOW, THRESHOLD, WINDOW_MS);
      expect(after.state).toBe("open");
      if (after.state !== "open") return;
      expect(after.reason).toContain("Half-open test request failed");
    });

    test("open → stays open", () => {
      const open: CircuitState = { state: "open", openedAt: NOW, reason: "test" };
      const after = recordFailure(open, NOW + 1000, THRESHOLD, WINDOW_MS);
      expect(after).toBe(open); // Reference equality — no change
    });
  });

  describe("attemptReset", () => {
    test("open + cooldown elapsed → half-open", () => {
      const open: CircuitState = { state: "open", openedAt: NOW, reason: "test" };
      const after = attemptReset(open, NOW + COOLDOWN_MS, COOLDOWN_MS);
      expect(after.state).toBe("half-open");
      if (after.state !== "half-open") return;
      expect(after.testRequestAllowed).toBe(true);
    });

    test("open + cooldown NOT elapsed → stays open", () => {
      const open: CircuitState = { state: "open", openedAt: NOW, reason: "test" };
      const after = attemptReset(open, NOW + COOLDOWN_MS - 1, COOLDOWN_MS);
      expect(after.state).toBe("open");
    });

    test("closed → no change", () => {
      const closed = initCircuit(NOW);
      const after = attemptReset(closed, NOW + COOLDOWN_MS, COOLDOWN_MS);
      expect(after).toBe(closed);
    });

    test("half-open → no change", () => {
      const halfOpen: CircuitState = { state: "half-open", testRequestAllowed: true };
      const after = attemptReset(halfOpen, NOW + COOLDOWN_MS, COOLDOWN_MS);
      expect(after).toBe(halfOpen);
    });
  });

  describe("forceReset", () => {
    test("always returns closed state regardless of current state", () => {
      const open: CircuitState = { state: "open", openedAt: NOW, reason: "test" };
      const result = forceReset(NOW + 5000);
      expect(result.state).toBe("closed");
      if (result.state !== "closed") return;
      expect(result.failureCount).toBe(0);
      expect(result.windowStart).toBe(NOW + 5000);
    });

    test("from half-open → closed", () => {
      const result = forceReset(NOW);
      expect(result.state).toBe("closed");
    });

    test("from closed → fresh closed", () => {
      const result = forceReset(NOW);
      expect(result.state).toBe("closed");
      if (result.state !== "closed") return;
      expect(result.failureCount).toBe(0);
    });
  });

  describe("isAllowed", () => {
    test("closed → true", () => {
      expect(isAllowed(initCircuit(NOW))).toBe(true);
    });

    test("open → false", () => {
      const open: CircuitState = { state: "open", openedAt: NOW, reason: "test" };
      expect(isAllowed(open)).toBe(false);
    });

    test("half-open with testRequestAllowed → true", () => {
      const halfOpen: CircuitState = { state: "half-open", testRequestAllowed: true };
      expect(isAllowed(halfOpen)).toBe(true);
    });

    test("half-open without testRequestAllowed → false", () => {
      const halfOpen: CircuitState = { state: "half-open", testRequestAllowed: false };
      expect(isAllowed(halfOpen)).toBe(false);
    });
  });

  describe("consumeTestRequest", () => {
    test("half-open with allowed → sets to not allowed", () => {
      const halfOpen: CircuitState = { state: "half-open", testRequestAllowed: true };
      const after = consumeTestRequest(halfOpen);
      expect(after.state).toBe("half-open");
      if (after.state !== "half-open") return;
      expect(after.testRequestAllowed).toBe(false);
    });

    test("other states → no change", () => {
      const closed = initCircuit(NOW);
      expect(consumeTestRequest(closed)).toBe(closed);
    });
  });

  // -------------------------------------------------------------------------
  // Full lifecycle scenario
  // -------------------------------------------------------------------------

  describe("full lifecycle", () => {
    test("closed → open → half-open → closed (success path)", () => {
      let state: CircuitState = initCircuit(NOW);

      // Accumulate failures past threshold
      state = failN(state, THRESHOLD + 1);
      expect(state.state).toBe("open");

      // Wait for cooldown
      state = attemptReset(state, NOW + THRESHOLD + COOLDOWN_MS, COOLDOWN_MS);
      expect(state.state).toBe("half-open");

      // Test request succeeds → closed
      state = recordSuccess(state, NOW + THRESHOLD + COOLDOWN_MS + 1);
      expect(state.state).toBe("closed");
    });

    test("closed → open → half-open → open (failure path)", () => {
      let state: CircuitState = initCircuit(NOW);

      // Trip the breaker
      state = failN(state, THRESHOLD + 1);
      expect(state.state).toBe("open");

      // Wait for cooldown
      state = attemptReset(state, NOW + THRESHOLD + COOLDOWN_MS, COOLDOWN_MS);
      expect(state.state).toBe("half-open");

      // Test request fails → back to open
      state = recordFailure(state, NOW + THRESHOLD + COOLDOWN_MS + 1, THRESHOLD, WINDOW_MS);
      expect(state.state).toBe("open");
    });

    test("git sync force-resets open circuit (FR-092)", () => {
      let state: CircuitState = initCircuit(NOW);
      state = failN(state, THRESHOLD + 1);
      expect(state.state).toBe("open");

      // New git SHA synced → force reset
      state = forceReset(NOW + 10_000);
      expect(state.state).toBe("closed");
      if (state.state !== "closed") return;
      expect(state.failureCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Property Tests
  // -------------------------------------------------------------------------

  describe("property tests", () => {
    test("circuit never transitions from open to closed without going through half-open", () => {
      // Simulate random sequences of events and verify the invariant
      const arbAction = fc.constantFrom(
        "success" as const,
        "failure" as const,
        "reset-attempt" as const,
      );

      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              action: arbAction,
              time: fc.integer({ min: 0, max: 200_000 }),
            }),
            { minLength: 5, maxLength: 50 },
          ),
          (actions) => {
            let state: CircuitState = initCircuit(0);
            let prevState = state.state;

            for (const { action, time } of actions) {
              switch (action) {
                case "success":
                  state = recordSuccess(state, time);
                  break;
                case "failure":
                  state = recordFailure(state, time, THRESHOLD, WINDOW_MS);
                  break;
                case "reset-attempt":
                  state = attemptReset(state, time, COOLDOWN_MS);
                  break;
              }

              // INVARIANT: if we were "open" and now we're "closed",
              // we must have gone through "half-open" first
              if (prevState === "open" && state.state === "closed") {
                // This should NEVER happen — open can only go to half-open
                throw new Error("Illegal transition: open → closed directly");
              }

              prevState = state.state;
            }
          },
        ),
        { numRuns: 500 },
      );
    });

    test("forceReset always produces closed state regardless of input", () => {
      const arbCircuitState: fc.Arbitrary<CircuitState> = fc.oneof(
        fc.record({
          state: fc.constant("closed" as const),
          failureCount: fc.integer({ min: 0, max: 100 }),
          windowStart: fc.integer({ min: 0, max: 1_000_000 }),
        }),
        fc.record({
          state: fc.constant("open" as const),
          openedAt: fc.integer({ min: 0, max: 1_000_000 }),
          reason: fc.string({ minLength: 1, maxLength: 50 }),
        }),
        fc.record({
          state: fc.constant("half-open" as const),
          testRequestAllowed: fc.boolean(),
        }),
      );

      fc.assert(
        fc.property(
          arbCircuitState,
          fc.integer({ min: 0, max: 2_000_000 }),
          (_input, now) => {
            const result = forceReset(now);
            expect(result.state).toBe("closed");
            if (result.state !== "closed") return;
            expect(result.failureCount).toBe(0);
            expect(result.windowStart).toBe(now);
          },
        ),
        { numRuns: 200 },
      );
    });

    test("recordSuccess from half-open always transitions to closed", () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          fc.integer({ min: 0, max: 2_000_000 }),
          (testRequestAllowed, now) => {
            const halfOpen: CircuitState = { state: "half-open", testRequestAllowed };
            const result = recordSuccess(halfOpen, now);
            expect(result.state).toBe("closed");
          },
        ),
        { numRuns: 100 },
      );
    });

    test("failures below threshold never open the circuit", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: THRESHOLD }),
          fc.integer({ min: 0, max: 1_000_000 }),
          (failureCount, startTime) => {
            let state: CircuitState = initCircuit(startTime);
            for (let i = 0; i < failureCount; i++) {
              state = recordFailure(state, startTime + i, THRESHOLD, WINDOW_MS);
            }
            // Should still be closed since we have ≤threshold failures
            expect(state.state).toBe("closed");
          },
        ),
        { numRuns: 100 },
      );
    });

    test("threshold+1 failures within window always opens the circuit", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 1_000_000 }),
          (startTime) => {
            let state: CircuitState = initCircuit(startTime);
            for (let i = 0; i <= THRESHOLD; i++) {
              state = recordFailure(state, startTime + i, THRESHOLD, WINDOW_MS);
            }
            expect(state.state).toBe("open");
          },
        ),
        { numRuns: 100 },
      );
    });

    test("sliding window reset: spaced-out failures never trip", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 20 }),
          (count) => {
            let state: CircuitState = initCircuit(0);
            // Each failure is spaced beyond the window, so count resets each time
            for (let i = 0; i < count; i++) {
              state = recordFailure(state, i * (WINDOW_MS + 1), THRESHOLD, WINDOW_MS);
            }
            // Should always be closed since each failure resets the window
            expect(state.state).toBe("closed");
            if (state.state !== "closed") return;
            expect(state.failureCount).toBe(1); // only the last failure counts
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
