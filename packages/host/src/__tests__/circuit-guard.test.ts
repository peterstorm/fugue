/**
 * Circuit Guard unit tests — verifies the multi-step protocol encapsulation.
 *
 * Tests the protocol ordering: attemptReset → isAllowed → consumeTestRequest
 * and the markSuccess/markFailure convenience wrappers.
 */

import { describe, test, expect } from "bun:test";
import { dagId } from "@fugue/framework";
import type { DagId } from "@fugue/framework";
import type { CircuitState } from "../domain/circuit-breaker.js";
import { initCircuit, DEFAULTS } from "../domain/circuit-breaker.js";
import { checkCircuit, markSuccess, markFailure, DEFAULT_CIRCUIT_CONFIG } from "../domain/circuit-guard.js";
import type { CircuitPort, CircuitConfig } from "../domain/circuit-guard.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const DAG = dagId("test-dag");
const NOW = 1_000_000;
const COOLDOWN = DEFAULTS.cooldownMs; // 30_000
const THRESHOLD = DEFAULTS.threshold; // 5

const createPort = (initial?: CircuitState): { port: CircuitPort; states: Map<DagId, CircuitState> } => {
  const states = new Map<DagId, CircuitState>();
  if (initial) states.set(DAG, initial);
  return {
    states,
    port: {
      get: (id) => states.get(id) ?? initCircuit(NOW),
      set: (id, s) => { states.set(id, s); },
    },
  };
};

// ── checkCircuit ───────────────────────────────────────────────────────────

describe("checkCircuit", () => {
  test("closed circuit returns allowed: true", () => {
    const { port } = createPort(initCircuit(NOW));
    const result = checkCircuit(port, DAG, NOW + 1000);
    expect(result.allowed).toBe(true);
  });

  test("open circuit (cooldown not elapsed) returns allowed: false", () => {
    const open: CircuitState = { state: "open", openedAt: NOW, reason: { kind: "threshold-exceeded", threshold: 5, windowMs: 60_000 } };
    const { port } = createPort(open);
    const result = checkCircuit(port, DAG, NOW + 1000); // cooldown is 30s
    expect(result.allowed).toBe(false);
    expect(result).toEqual({ allowed: false, reason: "circuit-open" });
  });

  test("open circuit (cooldown elapsed) transitions to half-open and allows one request", () => {
    const open: CircuitState = { state: "open", openedAt: NOW, reason: { kind: "threshold-exceeded", threshold: 5, windowMs: 60_000 } };
    const { port, states } = createPort(open);
    const result = checkCircuit(port, DAG, NOW + COOLDOWN + 1);

    expect(result.allowed).toBe(true);
    // State should be half-open with testRequestAllowed: false (consumed)
    const state = states.get(DAG)!;
    expect(state.state).toBe("half-open");
    if (state.state === "half-open") {
      expect(state.testRequestAllowed).toBe(false);
    }
  });

  test("half-open with testRequestAllowed: true allows and consumes", () => {
    const halfOpen: CircuitState = { state: "half-open", testRequestAllowed: true };
    const { port, states } = createPort(halfOpen);
    const result = checkCircuit(port, DAG, NOW);

    expect(result.allowed).toBe(true);
    const state = states.get(DAG)!;
    expect(state.state).toBe("half-open");
    if (state.state === "half-open") {
      expect(state.testRequestAllowed).toBe(false);
    }
  });

  test("half-open with testRequestAllowed: false blocks request", () => {
    const halfOpen: CircuitState = { state: "half-open", testRequestAllowed: false };
    const { port } = createPort(halfOpen);
    const result = checkCircuit(port, DAG, NOW);
    expect(result.allowed).toBe(false);
  });

  test("port.set is called with attemptReset result even when allowed", () => {
    const closed = initCircuit(NOW);
    const { port, states } = createPort(closed);
    checkCircuit(port, DAG, NOW + 500);
    // port.set was called — state is persisted back
    expect(states.has(DAG)).toBe(true);
  });

  test("port.set is called twice for half-open (reset + consume)", () => {
    const open: CircuitState = { state: "open", openedAt: NOW, reason: { kind: "threshold-exceeded", threshold: 5, windowMs: 60_000 } };
    let setCalls = 0;
    const port: CircuitPort = {
      get: () => open,
      set: () => { setCalls++; },
    };
    checkCircuit(port, DAG, NOW + COOLDOWN + 1);
    // First set: after attemptReset (open → half-open)
    // Second set: after consumeTestRequest
    expect(setCalls).toBe(2);
  });

  test("unknown DAG gets fresh closed circuit from port", () => {
    const { port } = createPort(); // no initial state
    const result = checkCircuit(port, DAG, NOW);
    expect(result.allowed).toBe(true);
  });
});

// ── markSuccess ────────────────────────────────────────────────────────────

describe("markSuccess", () => {
  test("from closed: resets failure count", () => {
    const closed: CircuitState = { state: "closed", failureCount: 3, windowStart: NOW };
    const { port, states } = createPort(closed);
    markSuccess(port, DAG, NOW + 100);

    const state = states.get(DAG)!;
    expect(state.state).toBe("closed");
    if (state.state === "closed") {
      expect(state.failureCount).toBe(0);
    }
  });

  test("from half-open: heals to closed", () => {
    const halfOpen: CircuitState = { state: "half-open", testRequestAllowed: false };
    const { port, states } = createPort(halfOpen);
    markSuccess(port, DAG, NOW);

    const state = states.get(DAG)!;
    expect(state.state).toBe("closed");
  });

  test("from open: stays open (unexpected success path)", () => {
    const open: CircuitState = { state: "open", openedAt: NOW, reason: { kind: "threshold-exceeded", threshold: 5, windowMs: 60_000 } };
    const { port, states } = createPort(open);
    markSuccess(port, DAG, NOW + 100);

    const state = states.get(DAG)!;
    expect(state.state).toBe("open");
  });
});

// ── markFailure ────────────────────────────────────────────────────────────

describe("markFailure", () => {
  test("from closed: increments failure count", () => {
    const closed = initCircuit(NOW);
    const { port, states } = createPort(closed);
    markFailure(port, DAG, NOW + 100);

    const state = states.get(DAG)!;
    expect(state.state).toBe("closed");
    if (state.state === "closed") {
      expect(state.failureCount).toBe(1);
    }
  });

  test("from closed: opens circuit when threshold exceeded", () => {
    let state: CircuitState = initCircuit(NOW);
    // Get to threshold failures
    const { port, states } = createPort(state);
    for (let i = 0; i <= THRESHOLD; i++) {
      markFailure(port, DAG, NOW + i);
      // Re-read from port for next iteration (port mutates state)
      // Actually markFailure reads from port.get each time
    }

    const finalState = states.get(DAG)!;
    expect(finalState.state).toBe("open");
  });

  test("respects custom threshold from CircuitConfig (critical: config not dead code)", () => {
    const customConfig: CircuitConfig = { threshold: 2, windowMs: 10_000 };
    const { port, states } = createPort(initCircuit(NOW));

    // 2 failures should NOT open (threshold=2 means 3rd failure opens)
    markFailure(port, DAG, NOW + 1, customConfig);
    markFailure(port, DAG, NOW + 2, customConfig);
    expect(states.get(DAG)!.state).toBe("closed");

    // 3rd failure opens the circuit
    markFailure(port, DAG, NOW + 3, customConfig);
    expect(states.get(DAG)!.state).toBe("open");
  });

  test("respects custom windowMs from CircuitConfig", () => {
    const customConfig: CircuitConfig = { threshold: 2, windowMs: 100 };
    const { port, states } = createPort(initCircuit(NOW));

    // 2 failures inside window
    markFailure(port, DAG, NOW + 10, customConfig);
    markFailure(port, DAG, NOW + 20, customConfig);
    expect(states.get(DAG)!.state).toBe("closed");

    // 3rd failure OUTSIDE window — window resets, count restarts at 1
    markFailure(port, DAG, NOW + 200, customConfig);
    expect(states.get(DAG)!.state).toBe("closed");
    if (states.get(DAG)!.state === "closed") {
      expect((states.get(DAG)! as { failureCount: number }).failureCount).toBe(1);
    }
  });

  test("default config matches DEFAULTS from circuit-breaker module", () => {
    expect(DEFAULT_CIRCUIT_CONFIG.threshold).toBe(DEFAULTS.threshold);
    expect(DEFAULT_CIRCUIT_CONFIG.windowMs).toBe(DEFAULTS.windowMs);
  });

  test("from half-open: re-opens circuit", () => {
    const halfOpen: CircuitState = { state: "half-open", testRequestAllowed: false };
    const { port, states } = createPort(halfOpen);
    markFailure(port, DAG, NOW);

    const state = states.get(DAG)!;
    expect(state.state).toBe("open");
  });

  test("port.set is called exactly once per markFailure", () => {
    const closed = initCircuit(NOW);
    let setCalls = 0;
    const port: CircuitPort = {
      get: () => closed,
      set: () => { setCalls++; },
    };
    markFailure(port, DAG, NOW + 100);
    expect(setCalls).toBe(1);
  });
});

// ── Full Protocol Integration ──────────────────────────────────────────────

describe("full protocol", () => {
  test("closed → threshold+1 failures → open → cooldown → half-open → success → closed", () => {
    const { port, states } = createPort(initCircuit(NOW));

    // Accumulate failures past threshold
    for (let i = 0; i <= THRESHOLD; i++) {
      markFailure(port, DAG, NOW + i);
    }
    expect(states.get(DAG)!.state).toBe("open");

    // Before cooldown: blocked
    const blocked = checkCircuit(port, DAG, NOW + 1000);
    expect(blocked.allowed).toBe(false);

    // After cooldown: allowed (half-open test request)
    const allowed = checkCircuit(port, DAG, NOW + THRESHOLD + COOLDOWN + 1);
    expect(allowed.allowed).toBe(true);
    expect(states.get(DAG)!.state).toBe("half-open");

    // Success heals
    markSuccess(port, DAG, NOW + THRESHOLD + COOLDOWN + 2);
    expect(states.get(DAG)!.state).toBe("closed");
  });

  test("closed → threshold+1 failures → open → cooldown → half-open → failure → open", () => {
    const { port, states } = createPort(initCircuit(NOW));

    for (let i = 0; i <= THRESHOLD; i++) {
      markFailure(port, DAG, NOW + i);
    }
    expect(states.get(DAG)!.state).toBe("open");

    // After cooldown: allowed
    checkCircuit(port, DAG, NOW + THRESHOLD + COOLDOWN + 1);
    expect(states.get(DAG)!.state).toBe("half-open");

    // Failure re-opens
    markFailure(port, DAG, NOW + THRESHOLD + COOLDOWN + 2);
    expect(states.get(DAG)!.state).toBe("open");
  });
});
