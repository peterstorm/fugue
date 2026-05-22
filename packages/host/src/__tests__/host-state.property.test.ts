/**
 * Property-based tests for HostState state machine.
 *
 * Invariants verified via fast-check arbitrary action sequences:
 * 1. Registry is never lost from a serving state (ready, syncing, degraded)
 * 2. canServeRequests is true iff phase is ready|syncing|degraded
 * 3. drainComplete is always reachable from any serving state
 * 4. No valid transition sequence from "stopped" produces any other state
 */

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import { gitSha } from "@fugue/framework";
import { freeze } from "../domain/registry.js";
import {
  booting, bootComplete, syncStarted, syncCompleted, syncFailed,
  beginDrain, drainComplete, redisDied, redisRecovered,
  getRegistry, canServeRequests,
} from "../domain/host-state.js";
import type { HostState } from "../domain/host-state.js";
import type { Registry } from "../domain/registry.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const sha1 = gitSha("a".repeat(40));
const sha2 = gitSha("b".repeat(40));
const makeRegistry = (): Registry => freeze([], sha1, 1000);
const makeRegistry2 = (): Registry => freeze([], sha2, 2000);

type Action =
  | { kind: "bootComplete" }
  | { kind: "syncStarted" }
  | { kind: "syncCompleted" }
  | { kind: "syncFailed" }
  | { kind: "beginDrain" }
  | { kind: "drainComplete" }
  | { kind: "redisDied" }
  | { kind: "redisRecovered" };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.constant({ kind: "bootComplete" } as Action),
  fc.constant({ kind: "syncStarted" } as Action),
  fc.constant({ kind: "syncCompleted" } as Action),
  fc.constant({ kind: "syncFailed" } as Action),
  fc.constant({ kind: "beginDrain" } as Action),
  fc.constant({ kind: "drainComplete" } as Action),
  fc.constant({ kind: "redisDied" } as Action),
  fc.constant({ kind: "redisRecovered" } as Action),
);

const applyAction = (state: HostState, action: Action, now: number): HostState => {
  let result;
  switch (action.kind) {
    case "bootComplete":
      result = bootComplete(state, makeRegistry(), sha1, now);
      break;
    case "syncStarted":
      result = syncStarted(state, now);
      break;
    case "syncCompleted":
      result = syncCompleted(state, makeRegistry2(), sha2, now);
      break;
    case "syncFailed":
      result = syncFailed(state, now);
      break;
    case "beginDrain":
      result = beginDrain(state, 0, now);
      break;
    case "drainComplete":
      result = drainComplete(state);
      break;
    case "redisDied":
      result = redisDied(state, now);
      break;
    case "redisRecovered":
      result = redisRecovered(state, now);
      break;
  }
  // Only apply valid transitions — invalid ones leave state unchanged
  return result.ok ? result.value : state;
};

const isServingPhase = (state: HostState): boolean =>
  state.phase === "ready" || state.phase === "syncing" || state.phase === "degraded";

// ── Property Tests ─────────────────────────────────────────────────────────

describe("HostState property tests", () => {
  it("INVARIANT: registry is never lost from a serving state", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 1, maxLength: 30 }),
        (actions) => {
          let state: HostState = booting(0);
          let now = 1;

          for (const action of actions) {
            state = applyAction(state, action, now++);
            // If we're in a serving state, registry must exist
            if (isServingPhase(state)) {
              expect(getRegistry(state)).toBeDefined();
            }
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("INVARIANT: canServeRequests matches serving phases exactly", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 1, maxLength: 30 }),
        (actions) => {
          let state: HostState = booting(0);
          let now = 1;

          for (const action of actions) {
            state = applyAction(state, action, now++);
            expect(canServeRequests(state)).toBe(isServingPhase(state));
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("INVARIANT: drainComplete is reachable from any serving state", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 1, maxLength: 20 }),
        (actions) => {
          let state: HostState = booting(0);
          let now = 1;

          for (const action of actions) {
            state = applyAction(state, action, now++);
          }

          // If in a serving state, we should be able to drain → stop
          if (isServingPhase(state)) {
            const drained = beginDrain(state, 0, now++);
            expect(drained.ok).toBe(true);
            if (drained.ok) {
              const stopped = drainComplete(drained.value);
              expect(stopped.ok).toBe(true);
              if (stopped.ok) {
                expect(stopped.value.phase).toBe("stopped");
              }
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("INVARIANT: no action sequence from stopped produces a non-stopped state", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 1, maxLength: 20 }),
        (actions) => {
          // Start from stopped state
          let current: HostState = { phase: "stopped" as const };
          let now = 1;

          for (const action of actions) {
            current = applyAction(current, action, now++);
          }

          // Should still be stopped — no valid transition out
          expect(current.phase).toBe("stopped");
        },
      ),
      { numRuns: 500 },
    );
  });

  it("INVARIANT: applying an invalid transition never crashes", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 1, maxLength: 50 }),
        (actions) => {
          let state: HostState = booting(0);
          let now = 1;

          // Should never throw regardless of action sequence
          for (const action of actions) {
            state = applyAction(state, action, now++);
          }

          // If we reach here, no crash occurred
          expect(state.phase).toBeDefined();
        },
      ),
      { numRuns: 1000 },
    );
  });
});
