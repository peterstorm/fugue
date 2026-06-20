/**
 * Tests for the PURE worker lifecycle ADT (worker-lifecycle.ts).
 *
 * Covers: legal transition paths (spawn, drain, crash→restart), illegal-
 * transition REJECTION (every from→to that is not allowed returns an error),
 * idle-evict respecting eager-pin and the TTL gate, and property tests asserting
 * transition TOTALITY (no transition ever throws, only returns ok/err).
 */

import { describe, test, expect } from "bun:test";
import * as fc from "fast-check";
import { tenantId } from "../../../domain/tenant.js";
import type { TenantId } from "../../../domain/tenant.js";
import {
  requestWorker,
  workerLive,
  adoptLive,
  adoptDraining,
  touch,
  idleEvict,
  isIdleEvictable,
  beginDrain,
  drainComplete,
  crash,
  restart,
  canServe,
  occupiesSlot,
  udsPathOf,
  type WorkerState,
} from "../../../supervisor/lifecycle/worker-lifecycle.js";

const T = ((): TenantId => {
  const r = tenantId("acme");
  if (!r.ok) throw new Error("bad fixture tenant");
  return r.value;
})();

const unwrap = (r: ReturnType<typeof workerLive>): WorkerState => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.message}`);
  return r.value;
};

// ── Legal paths ────────────────────────────────────────────────────────────

describe("worker-lifecycle: lazy spawn → live", () => {
  test("requestWorker enters spawning; workerLive → live with socket", () => {
    const spawning = requestWorker(T, false, 1000);
    expect(spawning.phase).toBe("spawning");

    const live = unwrap(workerLive(spawning, 4242, "/run/fugue/acme.sock", 1100));
    expect(live.phase).toBe("live");
    if (live.phase === "live") {
      expect(live.pid).toBe(4242);
      expect(live.udsPath).toBe("/run/fugue/acme.sock");
      expect(live.startedAt).toBe(1100);
    }
    expect(canServe(live)).toBe(true);
    expect(udsPathOf(live)).toBe("/run/fugue/acme.sock");
  });

  test("adoptLive constructs a live worker directly (re-adoption, SC-006)", () => {
    const live = adoptLive(T, true, 999, "/run/fugue/acme.sock", 500, 2000);
    expect(live.phase).toBe("live");
    if (live.phase === "live") {
      expect(live.startedAt).toBe(500); // preserves original uptime
      expect(live.lastActivityAt).toBe(2000);
      expect(live.eagerPin).toBe(true);
    }
    expect(canServe(live)).toBe(true);
  });

  test("adoptDraining re-adopts a draining worker as draining — NOT live (FR-017, SC-006)", () => {
    // A worker persisted as `draining` (SIGTERM'd to drain) that survived a
    // supervisor restart must be re-adopted as DRAINING, never resurrected as
    // `live` — otherwise `canServe` would be true and the supervisor would route
    // NEW traffic to a worker we deliberately drained.
    const draining = adoptDraining(T, false, 999, "/run/fugue/acme.sock", 500);
    expect(draining.phase).toBe("draining");
    if (draining.phase === "draining") {
      expect(draining.pid).toBe(999);
      expect(draining.udsPath).toBe("/run/fugue/acme.sock");
      expect(draining.drainStartedAt).toBe(500); // the persisted drain-start instant
      expect(draining.eagerPin).toBe(false);
    }
    expect(canServe(draining)).toBe(false); // NOT served new traffic
    expect(occupiesSlot(draining)).toBe(true); // still counts against the live cap
    expect(udsPathOf(draining)).toBe("/run/fugue/acme.sock");
    // The drain can still complete from a re-adopted draining state (no new spawn).
    const evicted = unwrap(drainComplete(draining, 600));
    expect(evicted.phase).toBe("evicted");
    expect(occupiesSlot(evicted)).toBe(false);
  });
});

describe("worker-lifecycle: drain path (FR-017)", () => {
  test("live → draining → evicted", () => {
    const live = unwrap(workerLive(requestWorker(T, false, 0), 1, "/s", 10));
    const draining = unwrap(beginDrain(live, 20));
    expect(draining.phase).toBe("draining");
    expect(canServe(draining)).toBe(false); // no NEW routing to a draining worker
    expect(occupiesSlot(draining)).toBe(true); // still holds a process+socket

    const evicted = unwrap(drainComplete(draining, 30));
    expect(evicted.phase).toBe("evicted");
    expect(occupiesSlot(evicted)).toBe(false);
  });
});

describe("worker-lifecycle: crash → restart (AD-8, FR-015)", () => {
  test("live → crashed → spawning", () => {
    const live = unwrap(workerLive(requestWorker(T, false, 0), 7, "/s", 10));
    const crashed = unwrap(crash(live, 137, 50)); // 137 = OOM-ish
    expect(crashed.phase).toBe("crashed");
    if (crashed.phase === "crashed") expect(crashed.exitCode).toBe(137);
    expect(occupiesSlot(crashed)).toBe(false);

    const respawning = unwrap(restart(crashed, 60));
    expect(respawning.phase).toBe("spawning");
  });

  test("a draining worker can still crash", () => {
    const draining = unwrap(beginDrain(unwrap(workerLive(requestWorker(T, false, 0), 1, "/s", 10)), 20));
    const crashed = unwrap(crash(draining, null, 25));
    expect(crashed.phase).toBe("crashed");
    if (crashed.phase === "crashed") expect(crashed.exitCode).toBe(null); // signal kill
  });
});

// ── Idle-evict (AD-7) ────────────────────────────────────────────────────────

describe("worker-lifecycle: idle-evict respects eager-pin + TTL", () => {
  const TTL = 900_000;

  test("evicts a non-pinned worker idle past the TTL", () => {
    const live = unwrap(workerLive(requestWorker(T, false, 0), 1, "/s", 0));
    expect(isIdleEvictable(live, TTL, TTL)).toBe(true);
    const evicted = unwrap(idleEvict(live, TTL, TTL));
    expect(evicted.phase).toBe("evicted");
  });

  test("NEVER evicts an eager-pinned worker (AD-7)", () => {
    const pinned = unwrap(workerLive(requestWorker(T, true, 0), 1, "/s", 0));
    expect(isIdleEvictable(pinned, TTL, TTL * 10)).toBe(false);
    const r = idleEvict(pinned, TTL, TTL * 10);
    expect(r.ok).toBe(false);
  });

  test("does NOT evict before the TTL elapses", () => {
    const live = unwrap(workerLive(requestWorker(T, false, 0), 1, "/s", 0));
    expect(isIdleEvictable(live, TTL, TTL - 1)).toBe(false);
    expect(idleEvict(live, TTL, TTL - 1).ok).toBe(false);
  });

  test("touch refreshes the idle clock, deferring eviction", () => {
    const live = unwrap(workerLive(requestWorker(T, false, 0), 1, "/s", 0));
    const touched = unwrap(touch(live, TTL - 1));
    // Now idle measured from TTL-1; at exactly TTL it is not yet evictable.
    expect(isIdleEvictable(touched, TTL, TTL)).toBe(false);
    expect(isIdleEvictable(touched, TTL, TTL - 1 + TTL)).toBe(true);
  });
});

// ── Illegal transition rejection ──────────────────────────────────────────────

describe("worker-lifecycle: illegal transitions are rejected (not thrown)", () => {
  const spawning = requestWorker(T, false, 0);
  const live = unwrap(workerLive(spawning, 1, "/s", 1));
  const draining = unwrap(beginDrain(live, 2));
  const crashed = unwrap(crash(live, 1, 3));
  const evicted = unwrap(drainComplete(draining, 4));

  test("workerLive only from spawning", () => {
    expect(workerLive(live, 1, "/s", 5).ok).toBe(false);
    expect(workerLive(crashed, 1, "/s", 5).ok).toBe(false);
    expect(workerLive(evicted, 1, "/s", 5).ok).toBe(false);
  });

  test("beginDrain only from live", () => {
    expect(beginDrain(spawning, 5).ok).toBe(false);
    expect(beginDrain(draining, 5).ok).toBe(false);
    expect(beginDrain(crashed, 5).ok).toBe(false);
    expect(beginDrain(evicted, 5).ok).toBe(false);
  });

  test("drainComplete only from draining", () => {
    expect(drainComplete(spawning, 5).ok).toBe(false);
    expect(drainComplete(live, 5).ok).toBe(false);
    expect(drainComplete(crashed, 5).ok).toBe(false);
    expect(drainComplete(evicted, 5).ok).toBe(false);
  });

  test("crash only from live or draining", () => {
    expect(crash(spawning, 1, 5).ok).toBe(false);
    expect(crash(crashed, 1, 5).ok).toBe(false);
    expect(crash(evicted, 1, 5).ok).toBe(false);
  });

  test("restart only from crashed", () => {
    expect(restart(spawning, 5).ok).toBe(false);
    expect(restart(live, 5).ok).toBe(false);
    expect(restart(draining, 5).ok).toBe(false);
    expect(restart(evicted, 5).ok).toBe(false);
  });

  test("rejection carries tenant + from/to + message", () => {
    const r = restart(live, 5);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("invalid-worker-transition");
      expect(r.error.tenant).toBe(T);
      expect(r.error.from).toBe("live");
      expect(r.error.to).toBe("spawning");
      expect(r.error.message).toContain("acme");
    }
  });
});

// ── Property: transition totality ──────────────────────────────────────────────

describe("worker-lifecycle: property — transitions are total (never throw)", () => {
  // Generate an arbitrary reachable state.
  const arbState = (): fc.Arbitrary<WorkerState> =>
    fc.oneof(
      fc.record({ eagerPin: fc.boolean(), now: fc.nat() }).map(({ eagerPin, now }) => requestWorker(T, eagerPin, now)),
      fc
        .record({ eagerPin: fc.boolean(), pid: fc.nat(), at: fc.nat() })
        .map(({ eagerPin, pid, at }) => unwrap(workerLive(requestWorker(T, eagerPin, at), pid, "/s", at))),
      fc
        .record({ eagerPin: fc.boolean(), at: fc.nat() })
        .map(({ eagerPin, at }) => unwrap(beginDrain(unwrap(workerLive(requestWorker(T, eagerPin, at), 1, "/s", at)), at + 1))),
      fc
        .record({ eagerPin: fc.boolean(), at: fc.nat(), code: fc.option(fc.integer(), { nil: null }) })
        .map(({ eagerPin, at, code }) => unwrap(crash(unwrap(workerLive(requestWorker(T, eagerPin, at), 1, "/s", at)), code, at + 1))),
      fc
        .record({ eagerPin: fc.boolean(), at: fc.nat() })
        .map(({ eagerPin, at }) =>
          unwrap(drainComplete(unwrap(beginDrain(unwrap(workerLive(requestWorker(T, eagerPin, at), 1, "/s", at)), at + 1)), at + 2)),
        ),
    );

  test("every transition on every state returns a Result, never throws", () => {
    fc.assert(
      fc.property(arbState(), fc.nat(), fc.integer({ min: 1, max: 2_000_000 }), (state, now, ttl) => {
        // Calling each transition must not throw; result must be a discriminated Result.
        const results = [
          workerLive(state, 1, "/s", now),
          touch(state, now),
          idleEvict(state, ttl, now),
          beginDrain(state, now),
          drainComplete(state, now),
          crash(state, 0, now),
          restart(state, now),
        ];
        for (const r of results) {
          expect(typeof r.ok).toBe("boolean");
        }
        // Queries are total too.
        expect(typeof canServe(state)).toBe("boolean");
        expect(typeof occupiesSlot(state)).toBe("boolean");
        return true;
      }),
      { numRuns: 500 },
    );
  });

  test("property — eager-pinned live workers are NEVER idle-evictable", () => {
    fc.assert(
      fc.property(fc.nat(), fc.integer({ min: 1, max: 1_000_000 }), fc.nat(), (start, ttl, elapsed) => {
        const live = unwrap(workerLive(requestWorker(T, true, start), 1, "/s", start));
        const now = start + elapsed;
        expect(isIdleEvictable(live, ttl, now)).toBe(false);
        expect(idleEvict(live, ttl, now).ok).toBe(false);
        return true;
      }),
      { numRuns: 300 },
    );
  });
});
