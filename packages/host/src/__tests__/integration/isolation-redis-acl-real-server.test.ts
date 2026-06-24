/**
 * REAL-SERVER cross-tenant Redis-ACL isolation (US2 / SC-001, ADR-0067).
 *
 * The hermetic `isolation-cross-tenant-read.test.ts` proves the PURE spec
 * (`buildAclSpec`) is correct against a fake that ENFORCES it. It cannot prove a
 * real Redis/Valkey actually HONORS those `ACL SETUSER` tokens — and ADR-0067
 * flags exactly that risk (key-pattern ACLs historically do NOT constrain `SCAN`
 * across versions, which is WHY enumeration is denied outright). This test closes
 * that gap end-to-end: it provisions a per-tenant user through the PRODUCTION
 * `apply` provisioner over a REAL admin connection, then connects AS that scoped
 * user and asserts the live server refuses cross-tenant value access and all
 * keyspace enumeration with NOPERM, while allowing the tenant's OWN keyspace.
 *
 * GATED: runs only when `REDIS_URL` points at an ACL-capable server (the repo's
 * `bun run test:redis` spins up redis:7-alpine, which supports ACLs). With no
 * `REDIS_URL` the whole suite is skipped — CI without Redis is unaffected. The
 * suite PROBES ACL support (`ACL CAT`) before provisioning: a server that genuinely
 * lacks ACLs skips with a logged note, but on an ACL-capable server a provisioning
 * failure FAILS LOUDLY (it would be a regression in the production `apply` path —
 * the exact thing this test exists to catch — not an unsupported server).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { redisUnavailable } from "../../domain/host-error.js";
import type { HostError } from "../../domain/host-error.js";
import { tenantId } from "../../domain/tenant.js";
import type { TenantId } from "../../domain/tenant.js";
import { aclUsername } from "../../supervisor/secrets/redis-acl.js";
import { apply } from "../../supervisor/secrets/redis-acl-provisioner.js";
import type { RedisAclAdminPort } from "../../supervisor/secrets/redis-acl-provisioner.js";

const REDIS_URL = process.env.REDIS_URL;

/**
 * Probe ACL capability BEFORE the suite is declared, so a server that genuinely
 * lacks ACLs produces an explicit SKIP — not a green pass with zero assertions.
 * (Probing inside `beforeAll` forces per-`it` `return` guards, which Bun reports as
 * PASSING, overstating coverage: the suite would read all-green having asserted
 * nothing.) On an ACL-capable server, provisioning failures still FAIL LOUDLY
 * inside `beforeAll` — that path is a real `apply` regression, not an unsupported
 * server. `ACL CAT` exists on every ACL-capable server (Redis ≥6) and throws an
 * unknown-command error otherwise.
 */
const aclCapable: boolean = await (async (): Promise<boolean> => {
  if (REDIS_URL === undefined || REDIS_URL === "") return false;
  try {
    const { Redis } = await import("ioredis");
    const probe = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
    try {
      await probe.connect();
      await probe.call("ACL", "CAT");
      return true;
    } finally {
      await probe.quit().catch(() => {});
    }
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[acl-real-server] REDIS_URL is set but the server lacks ACL support (ACL CAT failed); skipping suite");
    return false;
  }
})();

// Distinct, test-scoped tenant ids so the derived ACL usernames + key prefixes
// never collide with real provisioned tenants on a shared dev Redis.
const tid = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`test tenant id '${s}' failed validation`);
  return r.value;
};
const ME = tid("acmeAclIsoTest");
const OTHER = tid("globexAclIsoTest");

const myKey = `fugue:${ME}:secret`;
const otherKey = `fugue:${OTHER}:secret`;
const mySetKey = `fugue:${ME}:idx`;

// A real ioredis-backed admin ACL port (mirrors main-supervisor.ts's aclAdmin),
// so provisioning runs through the SAME production `apply` code path.
const realAclAdmin = (client: import("ioredis").Redis): RedisAclAdminPort => ({
  setUser: async (username, rules): Promise<Result<void, HostError>> => {
    try {
      await client.call("ACL", "SETUSER", username, ...rules);
      return ok(undefined);
    } catch (e) {
      // Carry the server's actual rejection (e.g. a malformed rule token) so a
      // provisioning regression is diagnosable, not flattened to "unavailable".
      return err(redisUnavailable(`ACL SETUSER ${username}: ${e instanceof Error ? e.message : String(e)}`));
    }
  },
  delUser: async (username): Promise<Result<void, HostError>> => {
    try {
      await client.call("ACL", "DELUSER", username);
      return ok(undefined);
    } catch (e) {
      return err(redisUnavailable(`ACL DELUSER ${username}: ${e instanceof Error ? e.message : String(e)}`));
    }
  },
});

describe.skipIf(!aclCapable)(
  "REAL Redis honors buildAclSpec — cross-tenant NOPERM (SC-001, ADR-0067)",
  () => {
    // ioredis is imported lazily so the module load doesn't require it when skipped.
    type RedisCtor = typeof import("ioredis").Redis;
    let RedisClass: RedisCtor;
    let admin: import("ioredis").Redis;
    let scoped: import("ioredis").Redis | undefined;

    beforeAll(async () => {
      const { Redis } = await import("ioredis");
      RedisClass = Redis;
      admin = new Redis(REDIS_URL!, { maxRetriesPerRequest: 1, lazyConnect: true });
      await admin.connect();

      // Clean slate: drop any prior test users + keys.
      await admin.call("ACL", "DELUSER", aclUsername(ME)).catch(() => {});
      await admin.call("ACL", "DELUSER", aclUsername(OTHER)).catch(() => {});
      await admin.del(myKey, otherKey, mySetKey).catch(() => {});

      // Seed one key in MY keyspace and one in the OTHER tenant's keyspace.
      await admin.set(myKey, "mine");
      await admin.set(otherKey, "theirs");
      await admin.sadd(mySetKey, "a", "b");

      // ACL support is already confirmed (the module-level `aclCapable` probe gates
      // this suite via `describe.skipIf`), so a failure here is a REGRESSION in the
      // production `apply` provisioner — FAIL LOUDLY, the exact thing this test exists
      // to catch — not an unsupported server.
      const applied = await apply(realAclAdmin(admin), ME, {
        generateRandomBytes: () => crypto.getRandomValues(new Uint8Array(32)),
      });
      expect(applied.ok).toBe(true);
      if (!applied.ok) return; // unreachable on success; narrows the union below.

      // Connect AS the scoped user — the worker's posture. `enableReadyCheck` is
      // OFF because the scoped user is (correctly) denied `INFO` — ioredis's ready
      // probe runs INFO and would otherwise log a spurious NOPERM warning. The
      // worker connects the same way (it never runs INFO).
      scoped = new RedisClass(REDIS_URL!, {
        username: applied.value.username,
        password: applied.value.password,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        enableReadyCheck: false,
      });
      await scoped.connect();
    });

    afterAll(async () => {
      await scoped?.quit().catch(() => {});
      if (admin) {
        await admin.call("ACL", "DELUSER", aclUsername(ME)).catch(() => {});
        await admin.del(myKey, otherKey, mySetKey).catch(() => {});
        await admin.quit().catch(() => {});
      }
    });

    it("ALLOWS reads within the tenant's OWN keyspace", () => {
      return expect(scoped!.get(myKey)).resolves.toBe("mine");
    });

    it("ALLOWS the tenant's own index SET read (SMEMBERS) — the sanctioned enumeration path", async () => {
      const members = await scoped!.smembers(mySetKey);
      expect(members.sort()).toEqual(["a", "b"]);
    });

    it("REFUSES a cross-tenant value read with NOPERM", async () => {
      await expect(scoped!.get(otherKey)).rejects.toThrow(/NOPERM/i);
    });

    it("REFUSES a cross-tenant WRITE (SET) with NOPERM — isolation is not read-only", async () => {
      // A worker that could WRITE another tenant's keyspace would break isolation
      // just as badly as reading it (tamper, not just disclose). The key ACL must
      // deny the write, and the victim's value must remain untouched.
      await expect(scoped!.set(otherKey, "tampered")).rejects.toThrow(/NOPERM/i);
      // Confirm via the admin connection that the cross-tenant value is unchanged.
      await expect(admin.get(otherKey)).resolves.toBe("theirs");
    });

    it("REFUSES a cross-tenant index SET read (SMEMBERS) with NOPERM — the sanctioned enumeration path is OWN-keyspace only", async () => {
      // SMEMBERS is the allowed enumeration path, but ONLY within the tenant's own
      // keyspace (asserted above). Against ANOTHER tenant's index it must be NOPERM,
      // or a scoped worker could enumerate a peer's teams/tokens via its index SET.
      const otherSetKey = `fugue:${OTHER}:idx`;
      await expect(scoped!.smembers(otherSetKey)).rejects.toThrow(/NOPERM/i);
    });

    it("REFUSES keyspace enumeration: SCAN is NOPERM (the version-dependent leak the design denies)", async () => {
      await expect(scoped!.scan("0", "MATCH", "fugue:*", "COUNT", "100")).rejects.toThrow(/NOPERM/i);
    });

    it("REFUSES KEYS / RANDOMKEY / DBSIZE — all keyspace-enumeration commands are NOPERM", async () => {
      await expect(scoped!.keys("fugue:*")).rejects.toThrow(/NOPERM/i);
      await expect(scoped!.randomkey()).rejects.toThrow(/NOPERM/i);
      await expect(scoped!.dbsize()).rejects.toThrow(/NOPERM/i);
    });

    it("REFUSES admin/dangerous commands — CONFIG and FLUSHALL are NOPERM", async () => {
      await expect(scoped!.config("GET", "maxmemory")).rejects.toThrow(/NOPERM/i);
      await expect(scoped!.flushall()).rejects.toThrow(/NOPERM/i);
    });
  },
);
