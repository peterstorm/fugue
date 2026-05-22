import { describe, it, expect } from "bun:test";
import { gitSha } from "@fugue/framework";
import { freeze } from "../domain/registry.js";
import {
  booting, bootComplete, syncStarted, syncCompleted, syncFailed,
  beginDrain, drainComplete, redisDied, redisRecovered,
  getRegistry, canServeRequests,
} from "../domain/host-state.js";
import type { HostState } from "../domain/host-state.js";
import type { Registry } from "../domain/registry.js";

const sha40 = "a".repeat(40);
const sha40b = "b".repeat(40);
const makeRegistry = (): Registry => freeze([], gitSha(sha40), 1000);
const makeRegistry2 = (): Registry => freeze([], gitSha(sha40b), 2000);

const readyState = (): HostState => {
  const s = booting(100);
  const r = bootComplete(s, makeRegistry(), gitSha(sha40), 200);
  if (!r.ok) throw new Error("setup failed");
  return r.value;
};

const syncingState = (): HostState => {
  const r = syncStarted(readyState(), 300);
  if (!r.ok) throw new Error("setup failed");
  return r.value;
};

const degradedSyncFailed = (): HostState => {
  const r = syncFailed(syncingState(), 400);
  if (!r.ok) throw new Error("setup failed");
  return r.value;
};

const degradedRedis = (): HostState => {
  const r = redisDied(readyState(), 400);
  if (!r.ok) throw new Error("setup failed");
  return r.value;
};

const drainingState = (): HostState => {
  const r = beginDrain(readyState(), 5, 500);
  if (!r.ok) throw new Error("setup failed");
  return r.value;
};

describe("HostState", () => {
  describe("bootComplete", () => {
    it("transitions booting → ready", () => {
      const result = bootComplete(booting(100), makeRegistry(), gitSha(sha40), 200);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("ready");
    });

    it("rejects from ready", () => {
      const result = bootComplete(readyState(), makeRegistry(), gitSha(sha40), 300);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.from).toBe("ready");
      expect(result.error.to).toBe("ready");
    });

    it("rejects from syncing", () => {
      const result = bootComplete(syncingState(), makeRegistry(), gitSha(sha40), 300);
      expect(result.ok).toBe(false);
    });
  });

  describe("syncStarted", () => {
    it("transitions ready → syncing", () => {
      const result = syncStarted(readyState(), 300);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("syncing");
    });

    it("transitions degraded → syncing", () => {
      const result = syncStarted(degradedSyncFailed(), 500);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("syncing");
    });

    it("rejects from booting", () => {
      const result = syncStarted(booting(100), 200);
      expect(result.ok).toBe(false);
    });

    it("rejects from syncing (already syncing)", () => {
      const result = syncStarted(syncingState(), 400);
      expect(result.ok).toBe(false);
    });

    it("rejects from draining", () => {
      const result = syncStarted(drainingState(), 600);
      expect(result.ok).toBe(false);
    });

    it("rejects from stopped", () => {
      const stopped = drainComplete(drainingState());
      if (!stopped.ok) throw new Error("setup");
      const result = syncStarted(stopped.value, 700);
      expect(result.ok).toBe(false);
    });
  });

  describe("syncCompleted", () => {
    it("transitions syncing → ready with new registry", () => {
      const newReg = makeRegistry2();
      const result = syncCompleted(syncingState(), newReg, gitSha(sha40b), 400);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("ready");
      if (result.value.phase !== "ready") return;
      expect(result.value.registry).toBe(newReg);
      expect(result.value.lastSyncSha).toBe(gitSha(sha40b));
    });

    it("rejects from ready", () => {
      const result = syncCompleted(readyState(), makeRegistry(), gitSha(sha40), 400);
      expect(result.ok).toBe(false);
    });
  });

  describe("syncFailed", () => {
    it("transitions syncing → degraded", () => {
      const result = syncFailed(syncingState(), 400);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("degraded");
    });

    it("preserves existing registry (NFR-012)", () => {
      const syncing = syncingState();
      if (syncing.phase !== "syncing") throw new Error("setup");
      const prevRegistry = syncing.registry;
      const result = syncFailed(syncing, 400);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      if (result.value.phase !== "degraded") return;
      expect(result.value.registry).toBe(prevRegistry);
    });

    it("sets reason to sync-failed", () => {
      const result = syncFailed(syncingState(), 400);
      if (!result.ok) return;
      if (result.value.phase !== "degraded") return;
      expect(result.value.reason).toBe("sync-failed");
    });

    it("rejects from ready", () => {
      const result = syncFailed(readyState(), 400);
      expect(result.ok).toBe(false);
    });
  });

  describe("beginDrain", () => {
    it("transitions ready → draining", () => {
      const result = beginDrain(readyState(), 3, 500);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("draining");
      if (result.value.phase !== "draining") return;
      expect(result.value.inflightCount).toBe(3);
    });

    it("transitions degraded → draining", () => {
      const result = beginDrain(degradedSyncFailed(), 0, 500);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("draining");
    });

    it("transitions syncing → draining", () => {
      const result = beginDrain(syncingState(), 1, 500);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("draining");
    });

    it("rejects from booting", () => {
      const result = beginDrain(booting(100), 0, 500);
      expect(result.ok).toBe(false);
    });

    it("rejects from draining (already draining)", () => {
      const result = beginDrain(drainingState(), 0, 600);
      expect(result.ok).toBe(false);
    });

    it("rejects from stopped", () => {
      const stopped = drainComplete(drainingState());
      if (!stopped.ok) throw new Error("setup");
      const result = beginDrain(stopped.value, 0, 700);
      expect(result.ok).toBe(false);
    });
  });

  describe("drainComplete", () => {
    it("transitions draining → stopped", () => {
      const result = drainComplete(drainingState());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("stopped");
    });

    it("rejects from ready", () => {
      const result = drainComplete(readyState());
      expect(result.ok).toBe(false);
    });

    it("rejects from booting", () => {
      const result = drainComplete(booting(100));
      expect(result.ok).toBe(false);
    });
  });

  describe("redisDied", () => {
    it("transitions ready → degraded:redis-disconnected", () => {
      const result = redisDied(readyState(), 400);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("degraded");
      if (result.value.phase !== "degraded") return;
      expect(result.value.reason).toBe("redis-disconnected");
    });

    it("transitions syncing → degraded:redis-disconnected", () => {
      const result = redisDied(syncingState(), 400);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      if (result.value.phase !== "degraded") return;
      expect(result.value.reason).toBe("redis-disconnected");
    });

    it("preserves registry", () => {
      const ready = readyState();
      const prevReg = getRegistry(ready);
      const result = redisDied(ready, 400);
      if (!result.ok) return;
      expect(getRegistry(result.value)).toBe(prevReg);
    });

    it("rejects from booting", () => {
      expect(redisDied(booting(100), 400).ok).toBe(false);
    });

    it("rejects from degraded", () => {
      expect(redisDied(degradedSyncFailed(), 500).ok).toBe(false);
    });

    it("rejects from draining", () => {
      expect(redisDied(drainingState(), 600).ok).toBe(false);
    });
  });

  describe("redisRecovered", () => {
    it("transitions degraded:redis-disconnected → ready", () => {
      const result = redisRecovered(degradedRedis(), 500);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("ready");
    });

    it("preserves registry and SHA on recovery", () => {
      const degraded = degradedRedis();
      const prevReg = getRegistry(degraded);
      const result = redisRecovered(degraded, 500);
      if (!result.ok) return;
      expect(getRegistry(result.value)).toBe(prevReg);
    });

    it("rejects from degraded:sync-failed", () => {
      const result = redisRecovered(degradedSyncFailed(), 500);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.from).toContain("sync-failed");
    });

    it("rejects from ready", () => {
      expect(redisRecovered(readyState(), 500).ok).toBe(false);
    });
  });

  describe("getRegistry", () => {
    it("returns undefined for booting", () => {
      expect(getRegistry(booting(100))).toBeUndefined();
    });

    it("returns registry for ready", () => {
      expect(getRegistry(readyState())).toBeDefined();
    });

    it("returns registry for syncing", () => {
      expect(getRegistry(syncingState())).toBeDefined();
    });

    it("returns registry for degraded", () => {
      expect(getRegistry(degradedSyncFailed())).toBeDefined();
    });

    it("returns registry for draining", () => {
      expect(getRegistry(drainingState())).toBeDefined();
    });

    it("returns undefined for stopped", () => {
      const stopped = drainComplete(drainingState());
      if (!stopped.ok) throw new Error("setup");
      expect(getRegistry(stopped.value)).toBeUndefined();
    });
  });

  describe("canServeRequests", () => {
    it("true for ready", () => expect(canServeRequests(readyState())).toBe(true));
    it("true for syncing", () => expect(canServeRequests(syncingState())).toBe(true));
    it("true for degraded", () => expect(canServeRequests(degradedSyncFailed())).toBe(true));
    it("false for booting", () => expect(canServeRequests(booting(100))).toBe(false));
    it("false for draining", () => expect(canServeRequests(drainingState())).toBe(false));
    it("false for stopped", () => {
      const stopped = drainComplete(drainingState());
      if (!stopped.ok) throw new Error("setup");
      expect(canServeRequests(stopped.value)).toBe(false);
    });
  });
});
