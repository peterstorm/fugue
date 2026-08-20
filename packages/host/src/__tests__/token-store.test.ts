/**
 * Token Store — Redis adapter edge case + tenant-isolation tests.
 *
 * Tests:
 * - Tenant-prefixed key layout (`fugue:<tenant>:tokens:*` / `fugue:<tenant>:teams:*`)
 * - No cross-tenant key collision (the AD-4 Redis-ACL invariant)
 * - Rollback when token SET fails after team slot claimed
 * - Atomic store prevents concurrent duplicate creation
 * - Index-set-based listTeams (SMEMBERS, never SCAN — the per-tenant ACL denies it)
 */

import { describe, it, expect } from "bun:test";
import { ok, err, isOk } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../domain/host-error.js";
import type { TokenGrant, TokenHash } from "../domain/auth.js";
import type { RedisPort, LogPort } from "../ports.js";
import { createRedisTokenStore } from "../adapters/token-store.js";
import { tenantId } from "../domain/tenant.js";
import type { TenantId } from "../domain/tenant.js";

/** Build a `TenantId` for a test from a known-good literal via the canonical constructor. */
const mkTenant = (s: string): TenantId => {
  const r = tenantId(s);
  if (!isOk(r)) throw new Error(`test tenant id "${s}" is invalid (kind: ${r.error.kind})`);
  return r.value;
};

// ── Test Helpers ───────────────────────────────────────────────────────────

const noopLogger: LogPort = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Bound tenant used by the bulk of the suite. A second tenant exercises the
// cross-tenant isolation invariant.
const TENANT = mkTenant("tenant-a");
const OTHER_TENANT = mkTenant("tenant-b");

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
  failSAddOnKey?: string;
  failSMembersOnKey?: string;
  failGetOnKey?: string;
}): { redis: RedisPort; store: Map<string, string>; sets: Map<string, Set<string>> } => {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();

  const redis: RedisPort = {
    get: async (key) => {
      if (opts?.failGetOnKey && key.includes(opts.failGetOnKey)) {
        return err({ kind: "redis-unavailable", operation: `GET ${key}` } as HostError);
      }
      return ok(store.get(key) ?? null);
    },
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
    sAdd: async (key, member) => {
      if (opts?.failSAddOnKey && key.includes(opts.failSAddOnKey)) {
        return err({ kind: "redis-unavailable", operation: `SADD ${key}` } as HostError);
      }
      const set = sets.get(key) ?? new Set<string>();
      const had = set.has(member);
      set.add(member);
      sets.set(key, set);
      return ok(had ? 0 : 1);
    },
    sRem: async (key, member) => {
      const set = sets.get(key);
      if (!set || !set.has(member)) return ok(0);
      set.delete(member);
      return ok(1);
    },
    sMembers: async (key) => {
      if (opts?.failSMembersOnKey && key.includes(opts.failSMembersOnKey)) {
        return err({ kind: "redis-unavailable", operation: `SMEMBERS ${key}` } as HostError);
      }
      return ok(Array.from(sets.get(key) ?? []));
    },
  };

  return { redis, store, sets };
};

// ── Tenant key-namespacing + isolation ──────────────────────────────────────

describe("token store — tenant key namespacing (SECURITY: AD-4 / US2 / SC-001)", () => {
  it("writes token + team keys under the bound tenant prefix", async () => {
    const { redis, store } = createFakeRedis();
    const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

    const result = await tokenStore.store("team-a", hash1, grant1);
    expect(result.ok).toBe(true);

    // Both keys carry the tenant prefix — NOTHING escapes `fugue:<tenant>:`.
    expect(store.has(`fugue:${TENANT}:teams:team-a`)).toBe(true);
    expect(store.has(`fugue:${TENANT}:tokens:${hash1}`)).toBe(true);

    // Every emitted key is under the tenant prefix (the ACL scope ~fugue:<tenant>:*).
    for (const key of store.keys()) {
      expect(key.startsWith(`fugue:${TENANT}:`)).toBe(true);
    }
  });

  it("two tenants storing the SAME team + hash never collide on a key", async () => {
    // One shared Redis backing store — exactly the single-server, one-ACL-user-
    // per-tenant deployment the AD-4 scheme relies on.
    const { redis, store } = createFakeRedis();
    const storeA = createRedisTokenStore(redis, TENANT, noopLogger);
    const storeB = createRedisTokenStore(redis, OTHER_TENANT, noopLogger);

    // Identical logical inputs (same team name, same token hash, same grant).
    const sharedGrant: TokenGrant = { ...grant1, team: "shared-team" };
    const ra = await storeA.store("shared-team", hash1, sharedGrant);
    const rb = await storeB.store("shared-team", hash1, sharedGrant);

    // Both succeed — they do NOT clash on the team-claim SETNX, because the keys
    // are namespaced by tenant. A collision would make the second store fail with
    // team-already-exists, which is the exact cross-tenant leak this prevents.
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);

    // Four distinct keys: two tenants × (token key + team key). No overlap.
    expect(store.has(`fugue:${TENANT}:teams:shared-team`)).toBe(true);
    expect(store.has(`fugue:${OTHER_TENANT}:teams:shared-team`)).toBe(true);
    expect(store.has(`fugue:${TENANT}:tokens:${hash1}`)).toBe(true);
    expect(store.has(`fugue:${OTHER_TENANT}:tokens:${hash1}`)).toBe(true);
    expect(store.size).toBe(4);
  });

  it("listTeams for one tenant never returns another tenant's teams", async () => {
    const { redis } = createFakeRedis();
    const storeA = createRedisTokenStore(redis, TENANT, noopLogger);
    const storeB = createRedisTokenStore(redis, OTHER_TENANT, noopLogger);

    await storeA.store("team-a", hash1, grant1);
    await storeB.store("team-b", hash2, grant2);

    const listA = await storeA.listTeams();
    const listB = await storeB.listTeams();

    expect(listA.ok).toBe(true);
    expect(listB.ok).toBe(true);
    if (listA.ok) expect(listA.value.map(g => g.team)).toEqual(["team-a"]);
    if (listB.ok) expect(listB.value.map(g => g.team)).toEqual(["team-b"]);
  });

  it("resolve for one tenant never sees another tenant's token", async () => {
    const { redis } = createFakeRedis();
    const storeA = createRedisTokenStore(redis, TENANT, noopLogger);
    const storeB = createRedisTokenStore(redis, OTHER_TENANT, noopLogger);

    // Only tenant A stores the token; tenant B uses the same hash for lookup.
    await storeA.store("team-a", hash1, grant1);

    const fromB = await storeB.resolve(hash1);
    expect(fromB.ok).toBe(true);
    if (fromB.ok) expect(fromB.value).toBeNull(); // zero bytes of A's data

    const fromA = await storeA.resolve(hash1);
    expect(fromA.ok).toBe(true);
    if (fromA.ok) expect(fromA.value?.team).toBe("team-a");
  });

  it("revoke in one tenant does not remove the other tenant's identically-named team", async () => {
    const { redis, store } = createFakeRedis();
    const storeA = createRedisTokenStore(redis, TENANT, noopLogger);
    const storeB = createRedisTokenStore(redis, OTHER_TENANT, noopLogger);

    const sharedGrant: TokenGrant = { ...grant1, team: "shared-team" };
    await storeA.store("shared-team", hash1, sharedGrant);
    await storeB.store("shared-team", hash1, sharedGrant);

    await storeA.revoke("shared-team");

    // A's keys gone; B's keys untouched.
    expect(store.has(`fugue:${TENANT}:teams:shared-team`)).toBe(false);
    expect(store.has(`fugue:${TENANT}:tokens:${hash1}`)).toBe(false);
    expect(store.has(`fugue:${OTHER_TENANT}:teams:shared-team`)).toBe(true);
    expect(store.has(`fugue:${OTHER_TENANT}:tokens:${hash1}`)).toBe(true);

    const stillB = await storeB.resolve(hash1);
    expect(stillB.ok).toBe(true);
    if (stillB.ok) expect(stillB.value?.team).toBe("shared-team");
  });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("createRedisTokenStore", () => {
  describe("store — atomic via SETNX", () => {
    it("stores team token successfully", async () => {
      const { redis } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

      const result = await tokenStore.store("team-a", hash1, grant1);
      expect(result.ok).toBe(true);
    });

    it("rejects duplicate team creation atomically", async () => {
      const { redis } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

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
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

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
      const { redis, store } = createFakeRedis({ failSetOnKey: ":tokens:" });
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

      const result = await tokenStore.store("team-a", hash1, grant1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("redis-unavailable");
      }

      // Team key should be rolled back (deleted)
      expect(store.has(`fugue:${TENANT}:teams:team-a`)).toBe(false);
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
        failSetOnKey: ":tokens:",
        failDelOnKey: ":teams:",
      });
      const tokenStore = createRedisTokenStore(redis, TENANT, logger);

      const result = await tokenStore.store("team-a", hash1, grant1);
      expect(result.ok).toBe(false);

      // Should log CRITICAL about failed rollback
      expect(logs.some(l => l.msg.includes("CRITICAL"))).toBe(true);
    });

    it("returns error when SETNX itself fails (infra)", async () => {
      const { redis } = createFakeRedis({ failSetNxOnKey: ":teams:" });
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

      const result = await tokenStore.store("team-a", hash1, grant1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("redis-unavailable");
      }
    });
  });

  describe("listTeams — index-set-based (SMEMBERS, NOT SCAN)", () => {
    it("returns empty list when no teams exist", async () => {
      const { redis } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

      const result = await tokenStore.listTeams();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it("returns all teams after multiple stores", async () => {
      const { redis } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

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

    it("fails closed when any indexed team read fails instead of returning ok(partial)", async () => {
      const { redis } = createFakeRedis({ failGetOnKey: "team-a" });
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

      await tokenStore.store("team-a", hash1, grant1);
      await tokenStore.store("team-b", hash2, grant2);

      const result = await tokenStore.listTeams();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("redis-unavailable");
        if (result.error.kind === "redis-unavailable") {
          expect(result.error.operation).toContain("team-a");
        }
      }
    });

    it("uses SMEMBERS on the index — never SCAN or KEYS (the ACL denies them)", async () => {
      let sMembersCalled = false;
      let scanCalled = false;
      let keysCalled = false;

      const { redis: baseRedis } = createFakeRedis();
      const redis: RedisPort = {
        ...baseRedis,
        sMembers: async (...args) => {
          sMembersCalled = true;
          return baseRedis.sMembers(...args);
        },
        scan: async (...args) => {
          scanCalled = true;
          return baseRedis.scan(...args);
        },
        keys: async (...args) => {
          keysCalled = true;
          return baseRedis.keys(...args);
        },
      };
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

      await tokenStore.listTeams();
      expect(sMembersCalled).toBe(true);
      expect(scanCalled).toBe(false);
      expect(keysCalled).toBe(false);
    });

    it("reads the tenant-prefixed team-index key (fugue:<tenant>:teams-index)", async () => {
      const keys: string[] = [];
      const { redis: baseRedis } = createFakeRedis();
      const redis: RedisPort = {
        ...baseRedis,
        sMembers: async (key) => {
          keys.push(key);
          return baseRedis.sMembers(key);
        },
      };
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

      await tokenStore.listTeams();
      // The single key read is the per-tenant index SET — under ~fugue:<tenant>:*.
      expect(keys).toContain(`fugue:${TENANT}:teams-index`);
      // It is scoped to the tenant prefix the ACL grants.
      expect(keys.every(k => k.startsWith(`fugue:${TENANT}:`))).toBe(true);
    });

    it("store adds the team to the index SET (SADD), keyed by tenant", async () => {
      const { redis, sets } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

      await tokenStore.store("team-a", hash1, grant1);

      const index = sets.get(`fugue:${TENANT}:teams-index`);
      expect(index).toBeDefined();
      expect([...(index ?? [])]).toEqual(["team-a"]);
    });

    it("revoke removes the team from the index SET (SREM)", async () => {
      const { redis, sets } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

      await tokenStore.store("team-a", hash1, grant1);
      await tokenStore.store("team-b", hash2, grant2);
      await tokenStore.revoke("team-a");

      const index = sets.get(`fugue:${TENANT}:teams-index`);
      expect([...(index ?? [])]).toEqual(["team-b"]);

      // listTeams reflects the revocation.
      const result = await tokenStore.listTeams();
      if (result.ok) expect(result.value.map(g => g.team)).toEqual(["team-b"]);
    });

    it("skips index members whose team key is missing (best-effort, self-healing)", async () => {
      const { redis, store, sets } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

      await tokenStore.store("team-a", hash1, grant1);
      await tokenStore.store("team-b", hash2, grant2);

      // Simulate a torn state: index still names team-a but its key vanished.
      store.delete(`fugue:${TENANT}:teams:team-a`);

      const result = await tokenStore.listTeams();
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.map(g => g.team)).toEqual(["team-b"]);
      // The index still holds the stale member — it self-heals on next revoke.
      expect([...(sets.get(`fugue:${TENANT}:teams-index`) ?? [])].sort()).toEqual(["team-a", "team-b"]);
    });

    it.each([
      ["malformed JSON", "{not-json"],
      ["invalid record shape", JSON.stringify({ hash: hash1, grant: { team: "team-a" } })],
      ["mismatched indexed team", JSON.stringify({ hash: hash1, grant: grant2 })],
    ])("fails closed on %s instead of returning an ok(partial) listing", async (_label, corruptValue) => {
      const { redis, store } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);
      await tokenStore.store("team-a", hash1, grant1);
      await tokenStore.store("team-b", hash2, grant2);
      store.set(`fugue:${TENANT}:teams:team-a`, corruptValue);

      const result = await tokenStore.listTeams();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("redis-unavailable");
        if (result.error.kind === "redis-unavailable") {
          expect(result.error.operation).toContain("team-a");
        }
      }
    });

    it("fails closed when SMEMBERS errors (Redis unavailable)", async () => {
      const { redis } = createFakeRedis({ failSMembersOnKey: "teams-index" });
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

      const result = await tokenStore.listTeams();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("redis-unavailable");
    });

    it("fails closed (and rolls back) when the index SADD fails on store", async () => {
      const { redis, store } = createFakeRedis({ failSAddOnKey: "teams-index" });
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

      const result = await tokenStore.store("team-a", hash1, grant1);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("redis-unavailable");

      // Both data keys rolled back so the index, team key, and token key stay consistent.
      expect(store.has(`fugue:${TENANT}:teams:team-a`)).toBe(false);
      expect(store.has(`fugue:${TENANT}:tokens:${hash1}`)).toBe(false);
    });
  });

  describe("resolve", () => {
    it("returns grant for stored token", async () => {
      const { redis } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

      await tokenStore.store("team-a", hash1, grant1);
      const result = await tokenStore.resolve(hash1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value?.team).toBe("team-a");
      }
    });

    it("returns null for unknown hash", async () => {
      const { redis } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

      const result = await tokenStore.resolve(hash1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it.each([
      ["missing grant fields", JSON.stringify({ team: "team-a" })],
      ["non-canonical team", JSON.stringify({ ...grant1, team: " Team-A " })],
      ["non-finite timestamp", JSON.stringify({ ...grant1, createdAt: "NaN" })],
      ["non-object JSON", JSON.stringify([grant1])],
    ])("fails closed on a parseable persisted grant with %s", async (_label, persisted) => {
      const { redis, store } = createFakeRedis();
      store.set(`fugue:${TENANT}:tokens:${hash1}`, persisted);
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

      const result = await tokenStore.resolve(hash1);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("redis-unavailable");
    });

    it("contains a throwing corruption logger and preserves the typed resolve failure", async () => {
      const { redis, store } = createFakeRedis();
      store.set(`fugue:${TENANT}:tokens:${hash1}`, "{}");
      const throwingLogger: LogPort = {
        info: () => {},
        warn: () => { throw new Error("warn sink failed"); },
        error: () => { throw new Error("error sink failed"); },
      };
      const tokenStore = createRedisTokenStore(redis, TENANT, throwingLogger);

      const result = await tokenStore.resolve(hash1);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("redis-unavailable");
    });
  });

  describe("revoke", () => {
    it("removes both token and team keys", async () => {
      const { redis, store } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

      await tokenStore.store("team-a", hash1, grant1);
      expect(store.size).toBeGreaterThan(0);

      const result = await tokenStore.revoke("team-a");
      expect(result.ok).toBe(true);

      // Both keys should be gone
      expect(store.has(`fugue:${TENANT}:tokens:${hash1}`)).toBe(false);
      expect(store.has(`fugue:${TENANT}:teams:team-a`)).toBe(false);
    });

    it("is idempotent for non-existent team", async () => {
      const { redis } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

      const result = await tokenStore.revoke("nonexistent");
      expect(result.ok).toBe(true);
    });

    it("resolving a revoked token returns null", async () => {
      const { redis } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);

      await tokenStore.store("team-a", hash1, grant1);
      await tokenStore.revoke("team-a");

      const result = await tokenStore.resolve(hash1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it.each([
      ["missing hash", JSON.stringify({})],
      ["missing grant", JSON.stringify({ hash: hash1 })],
      ["mismatched grant team", JSON.stringify({ hash: hash1, grant: grant2 })],
    ])("fails closed before deleting anything when the reverse index has %s", async (_label, corruptRecord) => {
      const { redis, store, sets } = createFakeRedis();
      const tokenStore = createRedisTokenStore(redis, TENANT, noopLogger);
      await tokenStore.store("team-a", hash1, grant1);
      const teamRecordKey = `fugue:${TENANT}:teams:team-a`;
      const tokenRecordKey = `fugue:${TENANT}:tokens:${hash1}`;
      store.set(teamRecordKey, corruptRecord);

      const result = await tokenStore.revoke("team-a");

      expect(result.ok).toBe(false);
      expect(store.has(teamRecordKey)).toBe(true);
      expect(store.has(tokenRecordKey)).toBe(true);
      expect(sets.get(`fugue:${TENANT}:teams-index`)?.has("team-a")).toBe(true);
      const stillResolvable = await tokenStore.resolve(hash1);
      expect(stillResolvable.ok).toBe(true);
      if (stillResolvable.ok) expect(stillResolvable.value?.team).toBe("team-a");
    });
  });
});
