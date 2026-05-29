/**
 * Property-based tests for the concurrency limiter.
 *
 * Verifies invariants hold for arbitrary sequences of acquire/release:
 * - Global current never goes negative
 * - Per-DAG current never goes negative
 * - Acquire N then release N returns to 0 global (no slot leaks)
 * - Acquire always fails at capacity
 * - hasCapacity is consistent with acquire result
 */

import { describe, test, expect } from "bun:test";
import * as fc from "fast-check";
import type { DagId } from "@fugue/framework";
import { dagId } from "@fugue/framework";
import {
  initConcurrency,
  withDagLimit,
  acquire,
  release,
  globalUtilization,
  dagUtilization,
  hasCapacity,
  type ConcurrencyState,
  type AcquireToken,
} from "../domain/concurrency.js";

// ── Properties ─────────────────────────────────────────────────────────────

describe("concurrency properties", () => {
  test("acquire N then release N in order → global.current === 0", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 20 }),
        (globalMax, n) => {
          const effectiveN = Math.min(n, globalMax);
          let state = initConcurrency(globalMax, globalMax);
          const tokens: AcquireToken[] = [];
          const id = dagId("test-dag");

          // Acquire effectiveN tokens
          for (let i = 0; i < effectiveN; i++) {
            const result = acquire(state, id, i);
            if (result.ok) {
              state = result.value.state;
              tokens.push(result.value.token);
            }
          }

          // Release all tokens
          for (const token of tokens) {
            state = release(state, token);
          }

          expect(state.global.current).toBe(0);
        },
      ),
    );
  });

  test("acquire N then release N in reverse order → global.current === 0", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 20 }),
        (globalMax, n) => {
          const effectiveN = Math.min(n, globalMax);
          let state = initConcurrency(globalMax, globalMax);
          const tokens: AcquireToken[] = [];
          const id = dagId("test-dag");

          for (let i = 0; i < effectiveN; i++) {
            const result = acquire(state, id, i);
            if (result.ok) {
              state = result.value.state;
              tokens.push(result.value.token);
            }
          }

          // Release in reverse order
          for (let i = tokens.length - 1; i >= 0; i--) {
            state = release(state, tokens[i]);
          }

          expect(state.global.current).toBe(0);
        },
      ),
    );
  });

  test("global.current never exceeds global.max", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 200 }),
        (globalMax, attempts) => {
          let state = initConcurrency(globalMax, globalMax);
          const id = dagId("test-dag");

          for (let i = 0; i < attempts; i++) {
            const result = acquire(state, id, i);
            if (result.ok) {
              state = result.value.state;
            }
          }

          expect(state.global.current).toBeLessThanOrEqual(state.global.max);
        },
      ),
    );
  });

  test("acquire at exact capacity returns error", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        (max) => {
          let state = initConcurrency(max, max);
          const id = dagId("test-dag");
          const tokens: AcquireToken[] = [];

          // Fill to capacity
          for (let i = 0; i < max; i++) {
            const result = acquire(state, id, i);
            if (result.ok) {
              state = result.value.state;
              tokens.push(result.value.token);
            }
          }

          // Next acquire should fail
          const overflowResult = acquire(state, id, max);
          expect(overflowResult.ok).toBe(false);
        },
      ),
    );
  });

  test("hasCapacity is consistent with acquire result", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        (max, fills) => {
          let state = initConcurrency(max, max);
          const id = dagId("test-dag");

          const effectiveFills = Math.min(fills, max);
          for (let i = 0; i < effectiveFills; i++) {
            const result = acquire(state, id, i);
            if (result.ok) state = result.value.state;
          }

          const capacity = hasCapacity(state, id);
          const acquireResult = acquire(state, id, effectiveFills);

          // hasCapacity should predict acquire success
          expect(capacity).toBe(acquireResult.ok);
        },
      ),
    );
  });

  test("globalUtilization is between 0 and 1", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (max, fills) => {
          let state = initConcurrency(max, max);
          const id = dagId("test-dag");
          const effectiveFills = Math.min(fills, max);

          for (let i = 0; i < effectiveFills; i++) {
            const result = acquire(state, id, i);
            if (result.ok) state = result.value.state;
          }

          const util = globalUtilization(state);
          expect(util).toBeGreaterThanOrEqual(0);
          expect(util).toBeLessThanOrEqual(1);
        },
      ),
    );
  });

  test("release never makes current go below zero", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 0, max: 10 }),
        (max, extraReleases) => {
          let state = initConcurrency(max, max);
          const id = dagId("test-dag");

          // Acquire one
          const result = acquire(state, id, 0);
          if (result.ok) {
            state = result.value.state;
            const token = result.value.token;

            // Release it
            state = release(state, token);

            // Release it again N extra times (defensive)
            for (let i = 0; i < extraReleases; i++) {
              state = release(state, token);
            }
          }

          expect(state.global.current).toBeGreaterThanOrEqual(0);
          const dagState = state.perDag.get(id);
          if (dagState) {
            expect(dagState.current).toBeGreaterThanOrEqual(0);
          }
        },
      ),
    );
  });

  test("multiple DAGs don't interfere with each other's per-DAG limits", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        fc.integer({ min: 1, max: 5 }),
        (dagCount, perDagMax) => {
          let state = initConcurrency(dagCount * perDagMax, perDagMax);
          const dags = Array.from({ length: dagCount }, (_, i) => dagId(`dag-${i}`));

          // Fill each DAG to capacity
          for (const id of dags) {
            for (let i = 0; i < perDagMax; i++) {
              const result = acquire(state, id, i);
              if (result.ok) state = result.value.state;
            }
          }

          // Each DAG should be at capacity
          for (const id of dags) {
            expect(hasCapacity(state, id)).toBe(false);
          }

          // Global should also be at capacity
          expect(state.global.current).toBe(dagCount * perDagMax);
        },
      ),
    );
  });
});
