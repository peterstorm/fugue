/**
 * Token Store — Redis adapter edge case tests.
 *
 * Tests:
 * - Rollback when token SET fails after team slot claimed
 * - Atomic store prevents concurrent duplicate creation
 * - Scan-based listTeams with cursor iteration
 */

import { describe, it, expect } from "bun:test";
import { ok, err } from "@fugue/framework";
import type { Result } from "@fugue/framework";
import type { HostError } from "../domain/host-error.js";
import type { TokenGrant, TokenHash } from "../domain/auth.js";
import type { RedisPort, LogPort } from "../ports.js";
import { createRedisTokenStore } from "../adapters/token-store.js";

// ── Test Helpers ───────────────────────────────────────────────────────────

const noopLogger: LogPort = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const hash1 = "aabbccdd11223344" as TokenHash;
const hash2 = "eeff0011aabbccdd" as TokenHash;
const grant1: TokenGrant = { team: "team-a", label: "Team A", createdAt: 1000 };
const grant2: TokenGrant = { team: "team-b", label: "Team B", createdAt: 2000 };

/**
 * Create a fake RedisPort backed by a Map, with injectable failure hooks.
 */
const createFakeRedis = (opts?: {
  failSetOnKey?: string;
  failSetNxOnKey?: string;
  failDelOnKey?: string;
}): { redis: RedisPort; store: Map<string, string> } => {
  const store = new Map<string, string>();

  const redis: RedisPort = {
    get: async (key) => ok(store.get(key) ?? null),
    set: async (key, value, _opts) => {
      if (opts?.failSetOnKey && key.includes(opts.failSetOnKey)) {
        return err({ kind: "redis-unavailable", operation: `SET ${key}` } as HostError);
      }
      store.set(key, value);
      return ok("OK" as string | null);
    },
    del: async (key) => {
      if (opts?.failDelOnKey && key.includes(opts.failDelOnKey)) {
        return err({ kind: "redis-unavailable", operation: `DEL ${key}` } as HostError);
      }
      const had = store.has(key) ? 1 : 0;
      store.delete(key);
      return ok(had);
    },
    keys: async (pattern) => {
      const prefix = pattern.replace(/\*$/, "");
      return ok([...store.keys()].filter(k => k.startsWith(prefix)));
    },
    scan: async (pattern, _cursor = "0") => {
      const prefix = pattern.replace(/\*$/, "");
      const keys = [...store.keys()].filter(k => k.startsWith(prefix));
      return ok({ cursor: "0", keys });
    },
    setNx: async (key, value) => {
      if (opts?.failSetNxOnKey && key.includes(opts.failSetNxOnKey)) {
        return err({ kind: "redis-unavailable", operation: `SETNX ${key}` } as HostError);
      }
      if (store.has(key)) return ok(false);
      store.set(key, value);
      return ok(true);
    },
  };

  return { redis, store };
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("createRedisTokenStore", () => {
  describe("store — atomic via SETNX", () => {
    it("stores team token successfully", async () => {
      const { redis } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, noopLogger);

      const result = await tokenStore.store("team-a", hash1, grant1);
      expect(result.ok).toBe(true);
    });

    it("rejects duplicate team creation atomically", async () => {
      const { redis } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, noopLogger);

      const first = await tokenStore.store("team-a", hash1, grant1);
      expect(first.ok).toBe(true);

      const second = await tokenStore.store("team-a", hash2, grant2);
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error.kind).toBe("team-already-exists");
      }
    });

    it("two concurrent stores for same team — exactly one wins", async () => {
      const { redis } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, noopLogger);

      // Simulate concurrency by launching both without awaiting
      const [r1, r2] = await Promise.all([
        tokenStore.store("team-a", hash1, grant1),
        tokenStore.store("team-a", hash2, grant2),
      ]);

      // Exactly one succeeds
      const successes = [r1, r2].filter(r => r.ok);
      const failures = [r1, r2].filter(r => !r.ok);
      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);
      if (!failures[0].ok) {
        expect(failures[0].error.kind).toBe("team-already-exists");
      }
    });

    it("rolls back team claim when token SET fails", async () => {
      // Fail any SET that targets the token hash key
      const { redis, store } = createFakeRedis({ failSetOnKey: "fugue:tokens:" });
      const tokenStore = createRedisTokenStore(redis, noopLogger);

      const result = await tokenStore.store("team-a", hash1, grant1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("redis-unavailable");
      }

      // Team key should be rolled back (deleted)
      expect(store.has("fugue:teams:team-a")).toBe(false);
    });

    it("logs critical error when rollback DEL also fails", async () => {
      const logs: { level: string; msg: string }[] = [];
      const logger: LogPort = {
        info: () => {},
        warn: () => {},
        error: (msg) => { logs.push({ level: "error", msg }); },
      };

      // Fail SET on token key AND DEL on team key (double failure)
      const { redis } = createFakeRedis({
        failSetOnKey: "fugue:tokens:",
        failDelOnKey: "fugue:teams:",
      });
      const tokenStore = createRedisTokenStore(redis, logger);

      const result = await tokenStore.store("team-a", hash1, grant1);
      expect(result.ok).toBe(false);

      // Should log CRITICAL about failed rollback
      expect(logs.some(l => l.msg.includes("CRITICAL"))).toBe(true);
    });

    it("returns error when SETNX itself fails (infra)", async () => {
      const { redis } = createFakeRedis({ failSetNxOnKey: "fugue:teams:" });
      const tokenStore = createRedisTokenStore(redis, noopLogger);

      const result = await tokenStore.store("team-a", hash1, grant1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("redis-unavailable");
      }
    });
  });

  describe("listTeams — scan-based", () => {
    it("returns empty list when no teams exist", async () => {
      const { redis } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, noopLogger);

      const result = await tokenStore.listTeams();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it("returns all teams after multiple stores", async () => {
      const { redis } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, noopLogger);

      await tokenStore.store("team-a", hash1, grant1);
      await tokenStore.store("team-b", hash2, grant2);

      const result = await tokenStore.listTeams();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
        const teams = result.value.map(g => g.team).sort();
        expect(teams).toEqual(["team-a", "team-b"]);
      }
    });

    it("uses cursor-based scan (not KEYS)", async () => {
      let scanCalled = false;
      let keysCalled = false;

      const { redis: baseRedis } = createFakeRedis();
      const redis: RedisPort = {
        ...baseRedis,
        scan: async (...args) => {
          scanCalled = true;
          return baseRedis.scan(...args);
        },
        keys: async (...args) => {
          keysCalled = true;
          return baseRedis.keys(...args);
        },
      };
      const tokenStore = createRedisTokenStore(redis, noopLogger);

      await tokenStore.listTeams();
      expect(scanCalled).toBe(true);
      expect(keysCalled).toBe(false);
    });

    it("handles multi-batch cursor iteration", async () => {
      // Simulate a Redis that returns results in two batches
      const store = new Map<string, string>();
      store.set("fugue:teams:team-a", JSON.stringify({ hash: hash1, grant: grant1 }));
      store.set("fugue:teams:team-b", JSON.stringify({ hash: hash2, grant: grant2 }));

      let callCount = 0;
      const redis: RedisPort = {
        get: async (key) => ok(store.get(key) ?? null),
        set: async (key, value) => { store.set(key, value); return ok("OK" as string | null); },
        del: async (key) => { store.delete(key); return ok(1); },
        keys: async () => ok([]),
        scan: async (_pattern, cursor = "0") => {
          callCount++;
          if (cursor === "0") {
            // First batch — return first key and non-zero cursor
            return ok({ cursor: "1", keys: ["fugue:teams:team-a"] });
          }
          // Second batch — return second key and cursor "0" (done)
          return ok({ cursor: "0", keys: ["fugue:teams:team-b"] });
        },
        setNx: async (key, value) => {
          if (store.has(key)) return ok(false);
          store.set(key, value);
          return ok(true);
        },
      };

      const tokenStore = createRedisTokenStore(redis, noopLogger);
      const result = await tokenStore.listTeams();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
      }
      expect(callCount).toBe(2); // Two SCAN calls
    });
  });

  describe("resolve", () => {
    it("returns grant for stored token", async () => {
      const { redis } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, noopLogger);

      await tokenStore.store("team-a", hash1, grant1);
      const result = await tokenStore.resolve(hash1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value?.team).toBe("team-a");
      }
    });

    it("returns null for unknown hash", async () => {
      const { redis } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, noopLogger);

      const result = await tokenStore.resolve(hash1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe("revoke", () => {
    it("removes both token and team keys", async () => {
      const { redis, store } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, noopLogger);

      await tokenStore.store("team-a", hash1, grant1);
      expect(store.size).toBeGreaterThan(0);

      const result = await tokenStore.revoke("team-a");
      expect(result.ok).toBe(true);

      // Both keys should be gone
      expect(store.has(`fugue:tokens:${hash1}`)).toBe(false);
      expect(store.has("fugue:teams:team-a")).toBe(false);
    });

    it("is idempotent for non-existent team", async () => {
      const { redis } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, noopLogger);

      const result = await tokenStore.revoke("nonexistent");
      expect(result.ok).toBe(true);
    });

    it("resolving a revoked token returns null", async () => {
      const { redis } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, noopLogger);

      await tokenStore.store("team-a", hash1, grant1);
      await tokenStore.revoke("team-a");

      const result = await tokenStore.resolve(hash1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });
});
