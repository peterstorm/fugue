import { describe, test, expect } from "bun:test";
import * as fc from "fast-check";
import { dagId } from "@fuguejs/framework";
import type { DagId } from "@fuguejs/framework";
import { isOk, isErr } from "@fuguejs/framework";
import {
  initConcurrency,
  acquire,
  release,
  withDagLimit,
  forgetDagLimit,
  reconcileDagLimits,
  hasCapacity,
  globalUtilization,
  dagUtilization,
  type ConcurrencyState,
  type AcquireToken,
} from "../domain/concurrency.js";
import { unsafeTestToken } from "./fixtures/concurrency-token.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAG_A = dagId("dag-a");
const DAG_B = dagId("dag-b");
const DAG_C = dagId("dag-c");

const NOW = 1_000_000;

/** Acquire N times, collecting tokens. Asserts all succeed. */
function acquireN(
  state: ConcurrencyState,
  id: DagId,
  n: number,
  startTime: number = NOW,
): { state: ConcurrencyState; tokens: AcquireToken[] } {
  let current = state;
  const tokens: AcquireToken[] = [];
  for (let i = 0; i < n; i++) {
    const result = acquire(current, id, startTime + i);
    if (!result.ok) throw new Error(`Acquire failed at iteration ${i}: ${result.error}`);
    current = result.value.state;
    tokens.push(result.value.token);
  }
  return { state: current, tokens };
}

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

describe("Concurrency Limiter", () => {
  describe("initConcurrency", () => {
    test("creates state with default limits", () => {
      const state = initConcurrency();
      expect(state.global.current).toBe(0);
      expect(state.global.max).toBe(50);
      expect(state.defaultDagMax).toBe(10);
      expect(state.perDag.size).toBe(0);
    });

    test("creates state with custom limits", () => {
      const state = initConcurrency(100, 20);
      expect(state.global.max).toBe(100);
      expect(state.defaultDagMax).toBe(20);
    });
  });

  describe("acquire", () => {
    test("succeeds when under capacity", () => {
      const state = initConcurrency();
      const result = acquire(state, DAG_A, NOW);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.state.global.current).toBe(1);
      expect(result.value.token.dagId).toBe(DAG_A);
      expect(result.value.token.acquiredAt).toBe(NOW);
    });

    test("initializes per-DAG state on first acquire", () => {
      const state = initConcurrency(50, 10);
      const result = acquire(state, DAG_A, NOW);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const dagState = result.value.state.perDag.get(DAG_A);
      expect(dagState).toBeDefined();
      expect(dagState!.current).toBe(1);
      expect(dagState!.max).toBe(10);
    });

    test("returns global-at-capacity when global limit reached", () => {
      const state = initConcurrency(3, 10); // global max = 3
      const { state: afterAcquires } = acquireN(state, DAG_A, 3);
      const result = acquire(afterAcquires, DAG_A, NOW + 10);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("global-at-capacity");
    });

    test("returns dag-at-capacity when per-DAG limit reached", () => {
      const state = initConcurrency(50, 2); // per-DAG max = 2
      const { state: afterAcquires } = acquireN(state, DAG_A, 2);
      const result = acquire(afterAcquires, DAG_A, NOW + 10);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("dag-at-capacity");
    });

    test("per-DAG isolation: DAG B not affected by DAG A capacity", () => {
      const state = initConcurrency(50, 2); // per-DAG max = 2
      const { state: afterA } = acquireN(state, DAG_A, 2);
      // DAG_A is at capacity, but DAG_B should still work
      const result = acquire(afterA, DAG_B, NOW + 10);
      expect(result.ok).toBe(true);
    });

    test("does not mutate original state", () => {
      const state = initConcurrency();
      const originalGlobal = state.global.current;
      acquire(state, DAG_A, NOW);
      expect(state.global.current).toBe(originalGlobal);
    });
  });

  describe("release", () => {
    test("decrements global and per-DAG counts", () => {
      const state = initConcurrency();
      const { state: afterAcquire, tokens } = acquireN(state, DAG_A, 1);
      expect(afterAcquire.global.current).toBe(1);

      const released = release(afterAcquire, tokens[0]);
      expect(released.global.current).toBe(0);
      expect(released.perDag.get(DAG_A)!.current).toBe(0);
    });

    test("clamps to zero on underflow (defensive)", () => {
      const state = initConcurrency();
      const fakeToken = unsafeTestToken(DAG_A, NOW);
      const released = release(state, fakeToken);
      expect(released.global.current).toBe(0);
    });

    test("does not affect other DAGs", () => {
      const state = initConcurrency();
      const { state: afterA, tokens: tokensA } = acquireN(state, DAG_A, 2);
      const { state: afterB } = acquireN(afterA, DAG_B, 3);

      const released = release(afterB, tokensA[0]);
      expect(released.perDag.get(DAG_A)!.current).toBe(1);
      expect(released.perDag.get(DAG_B)!.current).toBe(3);
      expect(released.global.current).toBe(4); // was 5, now 4
    });

    test("does not mutate original state", () => {
      const state = initConcurrency();
      const { state: afterAcquire, tokens } = acquireN(state, DAG_A, 1);
      const originalCurrent = afterAcquire.global.current;
      release(afterAcquire, tokens[0]);
      expect(afterAcquire.global.current).toBe(originalCurrent);
    });
  });

  describe("withDagLimit", () => {
    test("sets custom per-DAG limit", () => {
      const state = initConcurrency(50, 10);
      const updated = withDagLimit(state, DAG_A, 25);
      const dagState = updated.perDag.get(DAG_A);
      expect(dagState).toBeDefined();
      expect(dagState!.max).toBe(25);
      expect(dagState!.current).toBe(0);
    });

    test("preserves existing current count when updating limit", () => {
      const state = initConcurrency(50, 10);
      const { state: afterAcquire } = acquireN(state, DAG_A, 3);
      const updated = withDagLimit(afterAcquire, DAG_A, 25);
      const dagState = updated.perDag.get(DAG_A);
      expect(dagState!.current).toBe(3);
      expect(dagState!.max).toBe(25);
    });

    test("custom limit is enforced on acquire", () => {
      const state = withDagLimit(initConcurrency(50, 10), DAG_A, 2);
      const { state: afterAcquires } = acquireN(state, DAG_A, 2);
      const result = acquire(afterAcquires, DAG_A, NOW + 10);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("dag-at-capacity");
    });
  });

  describe("forgetDagLimit", () => {
    test("drops an idle per-key entry (current === 0)", () => {
      const state = withDagLimit(initConcurrency(50, 10), DAG_A, 5);
      expect(state.perDag.has(DAG_A)).toBe(true);
      const forgotten = forgetDagLimit(state, DAG_A);
      expect(forgotten.perDag.has(DAG_A)).toBe(false);
    });

    test("preserves a LIVE entry (current > 0) so a pending release still finds its slot", () => {
      const state = withDagLimit(initConcurrency(50, 10), DAG_A, 5);
      const { state: live } = acquireN(state, DAG_A, 1);
      const forgotten = forgetDagLimit(live, DAG_A);
      // Same reference — nothing reclaimed while in-flight.
      expect(forgotten).toBe(live);
      expect(forgotten.perDag.get(DAG_A)!.current).toBe(1);
    });

    test("is a same-reference no-op for an absent key", () => {
      const state = initConcurrency(50, 10);
      expect(forgetDagLimit(state, DAG_A)).toBe(state);
    });

    test("does not touch the global counter", () => {
      const seeded = withDagLimit(initConcurrency(50, 10), DAG_A, 5);
      const forgotten = forgetDagLimit(seeded, DAG_A);
      expect(forgotten.global).toEqual(seeded.global);
    });
  });

  describe("queries", () => {
    test("globalUtilization returns correct fraction", () => {
      const state = initConcurrency(4, 10);
      const { state: after } = acquireN(state, DAG_A, 2);
      expect(globalUtilization(after)).toBe(0.5);
    });

    test("dagUtilization returns 0 for unknown DAG", () => {
      const state = initConcurrency();
      expect(dagUtilization(state, DAG_C)).toBe(0);
    });

    test("hasCapacity returns true when available", () => {
      const state = initConcurrency(50, 10);
      expect(hasCapacity(state, DAG_A)).toBe(true);
    });

    test("hasCapacity returns false at global capacity", () => {
      const state = initConcurrency(2, 10);
      const { state: after } = acquireN(state, DAG_A, 2);
      expect(hasCapacity(after, DAG_B)).toBe(false);
    });

    test("hasCapacity returns false at dag capacity", () => {
      const state = initConcurrency(50, 2);
      const { state: after } = acquireN(state, DAG_A, 2);
      expect(hasCapacity(after, DAG_A)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Property Tests
  // -------------------------------------------------------------------------

  describe("property tests", () => {
    // Arbitrary valid DagId (using the ID_REGEX pattern)
    const arbDagId = fc.stringMatching(/^[a-z][a-z0-9_-]{0,15}$/).map((s) => dagId(s));

    test("N acquires followed by N releases returns to initial global count", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 20 }),
          arbDagId,
          (n, id) => {
            const initial = initConcurrency(100, 100);
            const { state: afterAcquires, tokens } = acquireN(initial, id, n);
            expect(afterAcquires.global.current).toBe(n);

            let state = afterAcquires;
            for (const token of tokens) {
              state = release(state, token);
            }
            expect(state.global.current).toBe(0);
          },
        ),
        { numRuns: 100 },
      );
    });

    test("N acquires followed by N releases returns to initial per-DAG count", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 20 }),
          arbDagId,
          (n, id) => {
            const initial = initConcurrency(100, 100);
            const { state: afterAcquires, tokens } = acquireN(initial, id, n);
            const dagState = afterAcquires.perDag.get(id);
            expect(dagState!.current).toBe(n);

            let state = afterAcquires;
            for (const token of tokens) {
              state = release(state, token);
            }
            const finalDag = state.perDag.get(id);
            expect(finalDag!.current).toBe(0);
          },
        ),
        { numRuns: 100 },
      );
    });

    test("acquire never exceeds global max", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: 1, max: 50 }),
          arbDagId,
          (globalMax, attempts, id) => {
            let state = initConcurrency(globalMax, 100);
            let successCount = 0;

            for (let i = 0; i < attempts; i++) {
              const result = acquire(state, id, NOW + i);
              if (result.ok) {
                state = result.value.state;
                successCount++;
              }
            }

            expect(state.global.current).toBeLessThanOrEqual(globalMax);
            expect(successCount).toBeLessThanOrEqual(globalMax);
          },
        ),
        { numRuns: 100 },
      );
    });

    test("acquire never exceeds per-DAG max", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: 1, max: 50 }),
          arbDagId,
          (dagMax, attempts, id) => {
            let state = initConcurrency(100, dagMax);
            let successCount = 0;

            for (let i = 0; i < attempts; i++) {
              const result = acquire(state, id, NOW + i);
              if (result.ok) {
                state = result.value.state;
                successCount++;
              }
            }

            const dagState = state.perDag.get(id);
            if (dagState) {
              expect(dagState.current).toBeLessThanOrEqual(dagMax);
            }
            expect(successCount).toBeLessThanOrEqual(dagMax);
          },
        ),
        { numRuns: 100 },
      );
    });

    test("release is idempotent at zero (clamps, never goes negative)", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10 }),
          arbDagId,
          (extraReleases, id) => {
            const initial = initConcurrency();
            const fakeToken = unsafeTestToken(id, NOW);

            let state = initial;
            for (let i = 0; i < extraReleases; i++) {
              state = release(state, fakeToken);
            }

            expect(state.global.current).toBe(0);
          },
        ),
        { numRuns: 50 },
      );
    });

    test("interleaved acquires/releases across multiple DAGs maintain consistency", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              action: fc.constantFrom("acquire" as const, "release" as const),
              dagIdx: fc.integer({ min: 0, max: 2 }),
            }),
            { minLength: 5, maxLength: 30 },
          ),
          (actions) => {
            const dags = [DAG_A, DAG_B, DAG_C];
            let state = initConcurrency(50, 10);
            const tokensByDag: Map<DagId, AcquireToken[]> = new Map();

            for (const { action, dagIdx } of actions) {
              const id = dags[dagIdx];
              if (action === "acquire") {
                const result = acquire(state, id, NOW);
                if (result.ok) {
                  state = result.value.state;
                  const existing = tokensByDag.get(id) ?? [];
                  tokensByDag.set(id, [...existing, result.value.token]);
                }
              } else {
                const tokens = tokensByDag.get(id) ?? [];
                if (tokens.length > 0) {
                  const [token, ...rest] = tokens;
                  tokensByDag.set(id, rest);
                  state = release(state, token);
                }
              }
            }

            // Invariant: global current == sum of all per-DAG currents
            let sumDag = 0;
            for (const [, dagState] of state.perDag) {
              sumDag += dagState.current;
              expect(dagState.current).toBeGreaterThanOrEqual(0);
            }
            expect(state.global.current).toBe(sumDag);
            expect(state.global.current).toBeGreaterThanOrEqual(0);
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});

describe("reconcileDagLimits — FR-051", () => {
  test("applies per-DAG max from the registry into perDag", () => {
    const state = initConcurrency(50, 10);
    const next = reconcileDagLimits(state, [
      { dagId: DAG_A, max: 2 },
      { dagId: DAG_B, max: 25 },
    ]);
    expect(next.perDag.get(DAG_A)).toEqual({ current: 0, max: 2 });
    expect(next.perDag.get(DAG_B)).toEqual({ current: 0, max: 25 });
    expect(next.defaultDagMax).toBe(10);
  });

  test("preserves in-flight current for surviving DAGs", () => {
    let state = initConcurrency(50, 10);
    const { value } = acquire(state, DAG_A, NOW) as { value: { state: ConcurrencyState } };
    state = value.state;
    expect(state.perDag.get(DAG_A)!.current).toBe(1);

    const next = reconcileDagLimits(state, [{ dagId: DAG_A, max: 3 }]);
    expect(next.perDag.get(DAG_A)).toEqual({ current: 1, max: 3 });
  });

  test("drops idle DAGs absent from the new registry", () => {
    const seeded = withDagLimit(initConcurrency(50, 10), DAG_A, 5);
    const next = reconcileDagLimits(seeded, [{ dagId: DAG_B, max: 7 }]);
    expect(next.perDag.has(DAG_A)).toBe(false);
    expect(next.perDag.get(DAG_B)).toEqual({ current: 0, max: 7 });
  });

  test("retains a removed DAG that still has in-flight work, so release stays consistent", () => {
    let state = initConcurrency(50, 10);
    const acquired = acquire(state, DAG_A, NOW) as { value: { state: ConcurrencyState; token: AcquireToken } };
    state = acquired.value.state;
    const token = acquired.value.token;

    // DAG_A removed from the registry while a request is still in flight.
    const reconciled = reconcileDagLimits(state, [{ dagId: DAG_B, max: 4 }]);
    expect(reconciled.perDag.get(DAG_A)).toEqual({ current: 1, max: 10 });

    // Release must still decrement BOTH global and the retained per-DAG entry — no drift.
    const released = release(reconciled, token);
    expect(released.global.current).toBe(0);
    expect(released.perDag.get(DAG_A)!.current).toBe(0);
  });

  test("is a no-op shape for an empty registry with no in-flight work", () => {
    const state = initConcurrency(50, 10);
    const next = reconcileDagLimits(state, []);
    expect(next.perDag.size).toBe(0);
    expect(next.global).toEqual(state.global);
  });
});
