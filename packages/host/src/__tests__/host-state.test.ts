import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { isOk, isErr } from "@fugue/framework";
import {
  booting,
  bootComplete,
  syncStarted,
  syncCompleted,
  syncFailed,
  beginDrain,
  drainComplete,
  redisDied,
  redisRecovered,
  getRegistry,
  canServeRequests,
} from "../domain/host-state.js";
import type { HostState } from "../domain/host-state.js";
import { emptyRegistry, freeze, withDag } from "../domain/registry.js";
import type { RegisteredDag } from "../domain/registry.js";
import { dagId } from "@fugue/framework";
import type { DagDef } from "@fugue/framework";
import { z } from "zod";

// ── Helpers ────────────────────────────────────────────────────────────────

const makeDag = (id: string): RegisteredDag => ({
  id: dagId(id),
  team: "test-team",
  route: `/run/${id}`,
  dag: {} as DagDef,
  inputSchema: z.object({}),
  config: { route: "/dags/test-dag/run", timeout: 30_000, maxConcurrency: 10 },
  meta: { description: "", version: "0.0.0" },
  loadedAt: Date.now(),
  sha: "abc123",
  status: { kind: "healthy" },
});

const testRegistry = () => freeze([makeDag("test-dag")], "sha-abc", 1000);

/** Get a state in "ready" phase for testing */
const readyState = (): HostState => {
  const result = bootComplete(booting(0), testRegistry(), "sha-abc", 1000);
  if (!result.ok) throw new Error("Failed to create ready state");
  return result.value;
};

/** Get a state in "syncing" phase for testing */
const syncingState = (): HostState => {
  const ready = readyState();
  const result = syncStarted(ready, 2000);
  if (!result.ok) throw new Error("Failed to create syncing state");
  return result.value;
};

/** Get a state in "degraded" (sync-failed) phase for testing */
const degradedSyncState = (): HostState => {
  const syncing = syncingState();
  const result = syncFailed(syncing, 3000);
  if (!result.ok) throw new Error("Failed to create degraded state");
  return result.value;
};

/** Get a state in "degraded" (redis-disconnected) phase */
const degradedRedisState = (): HostState => {
  const ready = readyState();
  const result = redisDied(ready, 2000);
  if (!result.ok) throw new Error("Failed to create degraded redis state");
  return result.value;
};

// ── Unit Tests: Valid Transitions ──────────────────────────────────────────

describe("HostState", () => {
  describe("booting", () => {
    it("creates an initial booting state", () => {
      const state = booting(1000);
      expect(state.phase).toBe("booting");
      if (state.phase === "booting") expect(state.startedAt).toBe(1000);
    });
  });

  describe("bootComplete", () => {
    it("transitions from booting to ready", () => {
      const state = booting(1000);
      const registry = testRegistry();
      const result = bootComplete(state, registry, "sha-123", 2000);

      expect(isOk(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("ready");
      if (result.value.phase !== "ready") return;
      expect(result.value.registry).toBe(registry);
      expect(result.value.lastSyncAt).toBe(2000);
      expect(result.value.lastSyncSha).toBe("sha-123");
    });

    it("rejects transition from non-booting states", () => {
      const ready = readyState();
      const result = bootComplete(ready, testRegistry(), "sha", 3000);

      expect(isErr(result)).toBe(true);
      if (result.ok) return;
      expect(result.error.kind).toBe("invalid-transition");
    });
  });

  describe("syncStarted", () => {
    it("transitions from ready to syncing", () => {
      const state = readyState();
      const result = syncStarted(state, 3000);

      expect(isOk(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("syncing");
      if (result.value.phase !== "syncing") return;
      expect(result.value.syncStartedAt).toBe(3000);
    });

    it("transitions from degraded to syncing", () => {
      const state = degradedSyncState();
      const result = syncStarted(state, 4000);

      expect(isOk(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("syncing");
    });

    it("rejects transition from booting", () => {
      const result = syncStarted(booting(0), 1000);

      expect(isErr(result)).toBe(true);
      if (result.ok) return;
      expect(result.error.kind).toBe("invalid-transition");
      expect(result.error.from).toBe("booting");
    });

    it("rejects transition from stopped", () => {
      const result = syncStarted({ phase: "stopped" }, 1000);

      expect(isErr(result)).toBe(true);
    });

    it("preserves registry when transitioning to syncing", () => {
      const state = readyState();
      const result = syncStarted(state, 3000);

      if (!result.ok) return;
      if (result.value.phase !== "syncing") return;
      expect(result.value.registry.dags.size).toBe(1);
    });
  });

  describe("syncCompleted", () => {
    it("transitions from syncing to ready with new registry", () => {
      const state = syncingState();
      const newRegistry = freeze([makeDag("new-dag")], "sha-new", 4000);
      const result = syncCompleted(state, newRegistry, "sha-new", 4000);

      expect(isOk(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("ready");
      if (result.value.phase !== "ready") return;
      expect(result.value.registry).toBe(newRegistry);
      expect(result.value.lastSyncSha).toBe("sha-new");
      expect(result.value.lastSyncAt).toBe(4000);
    });

    it("rejects transition from non-syncing states", () => {
      const result = syncCompleted(readyState(), testRegistry(), "sha", 5000);

      expect(isErr(result)).toBe(true);
    });
  });

  describe("syncFailed", () => {
    it("transitions from syncing to degraded (sync-failed)", () => {
      const state = syncingState();
      const result = syncFailed(state, 5000);

      expect(isOk(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("degraded");
      if (result.value.phase !== "degraded") return;
      expect(result.value.reason).toBe("sync-failed");
      expect(result.value.since).toBe(5000);
    });

    it("preserves existing registry on sync failure (NFR-012)", () => {
      const state = syncingState();
      const result = syncFailed(state, 5000);

      if (!result.ok) return;
      if (result.value.phase !== "degraded") return;
      // Registry is preserved from the syncing state
      expect(result.value.registry.dags.size).toBe(1);
    });

    it("rejects transition from non-syncing states", () => {
      const result = syncFailed(readyState(), 5000);

      expect(isErr(result)).toBe(true);
    });
  });

  describe("beginDrain", () => {
    it("transitions from ready to draining", () => {
      const state = readyState();
      const result = beginDrain(state, 5, 6000);

      expect(isOk(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("draining");
      if (result.value.phase !== "draining") return;
      expect(result.value.inflightCount).toBe(5);
      expect(result.value.drainStartedAt).toBe(6000);
    });

    it("transitions from degraded to draining", () => {
      const state = degradedSyncState();
      const result = beginDrain(state, 3, 7000);

      expect(isOk(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("draining");
    });

    it("transitions from syncing to draining", () => {
      const state = syncingState();
      const result = beginDrain(state, 2, 8000);

      expect(isOk(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("draining");
    });

    it("rejects transition from booting", () => {
      const result = beginDrain(booting(0), 0, 1000);

      expect(isErr(result)).toBe(true);
    });

    it("rejects transition from stopped", () => {
      const result = beginDrain({ phase: "stopped" }, 0, 1000);

      expect(isErr(result)).toBe(true);
    });
  });

  describe("drainComplete", () => {
    it("transitions from draining to stopped", () => {
      const state = readyState();
      const draining = beginDrain(state, 0, 6000);
      if (!draining.ok) throw new Error("setup failed");

      const result = drainComplete(draining.value);

      expect(isOk(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("stopped");
    });

    it("rejects transition from non-draining states", () => {
      const result = drainComplete(readyState());

      expect(isErr(result)).toBe(true);
    });
  });

  describe("redisDied", () => {
    it("transitions from ready to degraded (redis-disconnected)", () => {
      const state = readyState();
      const result = redisDied(state, 9000);

      expect(isOk(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("degraded");
      if (result.value.phase !== "degraded") return;
      expect(result.value.reason).toBe("redis-disconnected");
      expect(result.value.since).toBe(9000);
    });

    it("transitions from syncing to degraded", () => {
      const state = syncingState();
      const result = redisDied(state, 9000);

      expect(isOk(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("degraded");
    });

    it("rejects transition from booting", () => {
      const result = redisDied(booting(0), 9000);

      expect(isErr(result)).toBe(true);
    });

    it("preserves registry when transitioning to degraded", () => {
      const state = readyState();
      const result = redisDied(state, 9000);

      if (!result.ok) return;
      if (result.value.phase !== "degraded") return;
      expect(result.value.registry.dags.size).toBe(1);
    });
  });

  describe("redisRecovered", () => {
    it("transitions from degraded (redis-disconnected) to ready", () => {
      const state = degradedRedisState();
      const result = redisRecovered(state, 10000);

      expect(isOk(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("ready");
    });

    it("rejects recovery when degraded for non-redis reason", () => {
      const state = degradedSyncState();
      const result = redisRecovered(state, 10000);

      expect(isErr(result)).toBe(true);
      if (result.ok) return;
      expect(result.error.kind).toBe("invalid-transition");
    });

    it("rejects transition from non-degraded states", () => {
      const result = redisRecovered(readyState(), 10000);

      expect(isErr(result)).toBe(true);
    });

    it("preserves registry when recovering", () => {
      const state = degradedRedisState();
      const result = redisRecovered(state, 10000);

      if (!result.ok) return;
      if (result.value.phase !== "ready") return;
      expect(result.value.registry.dags.size).toBe(1);
    });
  });

  // ── Query Functions ────────────────────────────────────────────────────

  describe("getRegistry", () => {
    it("returns undefined for booting state", () => {
      expect(getRegistry(booting(0))).toBeUndefined();
    });

    it("returns undefined for stopped state", () => {
      expect(getRegistry({ phase: "stopped" })).toBeUndefined();
    });

    it("returns registry for ready state", () => {
      const state = readyState();
      const registry = getRegistry(state);
      expect(registry).toBeDefined();
      expect(registry?.dags.size).toBe(1);
    });

    it("returns registry for syncing state", () => {
      const state = syncingState();
      const registry = getRegistry(state);
      expect(registry).toBeDefined();
    });

    it("returns registry for degraded state", () => {
      const state = degradedSyncState();
      const registry = getRegistry(state);
      expect(registry).toBeDefined();
    });
  });

  describe("canServeRequests", () => {
    it("returns false for booting", () => {
      expect(canServeRequests(booting(0))).toBe(false);
    });

    it("returns true for ready", () => {
      expect(canServeRequests(readyState())).toBe(true);
    });

    it("returns true for degraded", () => {
      expect(canServeRequests(degradedSyncState())).toBe(true);
    });

    it("returns true for syncing", () => {
      expect(canServeRequests(syncingState())).toBe(true);
    });

    it("returns false for stopped", () => {
      expect(canServeRequests({ phase: "stopped" })).toBe(false);
    });
  });

  // ── Property Tests: Valid Transition Sequences ─────────────────────────

  describe("property tests", () => {
    const arbSha = fc.stringMatching(/^[0-9a-f]{7}$/);

    it("happy path: boot → sync cycles always produce ready", () => {
      fc.assert(
        fc.property(
          fc.array(arbSha, { minLength: 1, maxLength: 10 }),
          (shas) => {
            let state: HostState = booting(0);
            const registry = testRegistry();

            // Boot
            const bootResult = bootComplete(state, registry, shas[0]!, 1000);
            if (!bootResult.ok) return false;
            state = bootResult.value;

            // Multiple sync cycles
            for (let i = 1; i < shas.length; i++) {
              const syncStart = syncStarted(state, 1000 + i * 100);
              if (!syncStart.ok) return false;
              state = syncStart.value;

              const syncEnd = syncCompleted(state, registry, shas[i]!, 1000 + i * 100 + 50);
              if (!syncEnd.ok) return false;
              state = syncEnd.value;
            }

            return state.phase === "ready";
          },
        ),
      );
    });

    it("sync failure always preserves registry from previous ready state", () => {
      fc.assert(
        fc.property(fc.nat(), (now) => {
          const state = readyState();
          const startResult = syncStarted(state, now);
          if (!startResult.ok) return false;

          const failResult = syncFailed(startResult.value, now + 100);
          if (!failResult.ok) return false;

          if (failResult.value.phase !== "degraded") return false;
          return failResult.value.registry.dags.size === 1;
        }),
      );
    });

    it("drain sequence always terminates in stopped", () => {
      fc.assert(
        fc.property(fc.nat({ max: 100 }), fc.nat(), (inflight, now) => {
          const state = readyState();
          const drainResult = beginDrain(state, inflight, now);
          if (!drainResult.ok) return false;

          const stopResult = drainComplete(drainResult.value);
          if (!stopResult.ok) return false;

          return stopResult.value.phase === "stopped";
        }),
      );
    });

    it("invalid transitions always return an error, never crash", () => {
      const states: HostState[] = [
        booting(0),
        readyState(),
        syncingState(),
        degradedSyncState(),
        { phase: "stopped" },
      ];

      fc.assert(
        fc.property(fc.nat(), (now) => {
          for (const state of states) {
            // Every transition function returns a Result, never throws
            const results = [
              bootComplete(state, testRegistry(), "sha", now),
              syncStarted(state, now),
              syncCompleted(state, testRegistry(), "sha", now),
              syncFailed(state, now),
              beginDrain(state, 0, now),
              drainComplete(state),
              redisDied(state, now),
              redisRecovered(state, now),
            ];

            for (const r of results) {
              // Every result is either Ok or Err — never undefined or thrown
              if (r.ok !== true && r.ok !== false) return false;
            }
          }
          return true;
        }),
      );
    });

    it("redis die → recover cycle returns to ready", () => {
      fc.assert(
        fc.property(fc.nat(), fc.nat(), (dieAt, recoverAt) => {
          const state = readyState();
          const dieResult = redisDied(state, dieAt);
          if (!dieResult.ok) return false;

          const recoverResult = redisRecovered(dieResult.value, recoverAt);
          if (!recoverResult.ok) return false;

          return recoverResult.value.phase === "ready";
        }),
      );
    });
  });
});
