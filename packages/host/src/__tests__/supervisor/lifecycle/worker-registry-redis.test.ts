/**
 * Tests for the Redis worker registry (worker-registry-redis.ts) and the PURE
 * spawn-plan builder (bun-spawn-adapter.ts `buildWorkerSpawn`).
 *
 * Registry: put/get/remove round-trip, fail-closed on Redis error (+ degraded
 * hook), corrupt-record handling, and the SC-006 `reconcileReadopt` — adopts
 * probe-live workers, prunes probe-dead + corrupt entries, returns adopted set,
 * resumes routing even if a prune del fails.
 *
 * Spawn plan: argv shape, mandatory tenant/secrets-ref env, heap-cap NODE_OPTIONS
 * flag (AD-9), env precedence (tenant binding wins over inherited/extra env).
 */

import { ok, err } from "@fuguejs/framework";
import { describe, test, expect } from "bun:test";
import { tenantId, markSecretsRef } from "../../../domain/tenant.js";
import type { TenantId } from "../../../domain/tenant.js";
import { redisUnavailable } from "../../../domain/host-error.js";
import type { LogPort, RedisPort } from "../../../ports.js";
import {
  createWorkerRegistry,
  createInMemoryWorkerRedisFake,
  WORKER_KEY_PREFIX,
  type WorkerRecord,
  type UdsLivenessProbe,
} from "../../../supervisor/lifecycle/worker-registry-redis.js";
import { buildWorkerSpawn } from "../../../supervisor/lifecycle/bun-spawn-adapter.js";
import type { WorkerSpawnSpec } from "../../../supervisor/lifecycle/spawn-port.js";

const tid = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`bad tenant fixture ${s}`);
  return r.value;
};

const rec = (
  tenant: string,
  pid: number,
  health: "live" | "draining" = "live",
  eagerPin = false,
): WorkerRecord => ({
  tenant: tid(tenant),
  pid,
  udsPath: `/run/fugue/${tenant}.sock`,
  startedAt: 1000,
  health,
  eagerPin,
});

const alwaysLive: UdsLivenessProbe = async () => true;
const alwaysDead: UdsLivenessProbe = async () => false;

/** A LogPort that records every call so tests can assert observability. */
interface CapturedLog {
  readonly level: "info" | "warn" | "error";
  readonly msg: string;
  readonly data?: Record<string, unknown>;
}
const capturingLogPort = (): { logger: LogPort; logs: CapturedLog[] } => {
  const logs: CapturedLog[] = [];
  return {
    logs,
    logger: {
      info: (msg, data) => logs.push({ level: "info", msg, data }),
      warn: (msg, data) => logs.push({ level: "warn", msg, data }),
      error: (msg, data) => logs.push({ level: "error", msg, data }),
    },
  };
};

// ── Round-trip ─────────────────────────────────────────────────────────────

describe("worker-registry: put / get / remove", () => {
  test("put then get round-trips the record", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, alwaysLive);

    expect((await reg.put(rec("acme", 42))).ok).toBe(true);
    const got = await reg.get(tid("acme"));
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.value).not.toBeNull();
      expect(got.value?.pid).toBe(42);
      expect(got.value?.udsPath).toBe("/run/fugue/acme.sock");
      expect(got.value?.health).toBe("live");
    }
    // Stored under the AD-2 key layout.
    expect(fake.store.has(`${WORKER_KEY_PREFIX}acme`)).toBe(true);
  });

  test("get returns null for an unknown tenant", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, alwaysLive);
    const got = await reg.get(tid("nobody"));
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toBeNull();
  });

  test("remove is idempotent", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, alwaysLive);
    await reg.put(rec("acme", 1));
    expect((await reg.remove(tid("acme"))).ok).toBe(true);
    expect((await reg.remove(tid("acme"))).ok).toBe(true); // again — still ok
    const got = await reg.get(tid("acme"));
    if (got.ok) expect(got.value).toBeNull();
  });

  test("a corrupt record reads back as null (fail-closed)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    fake.store.set(`${WORKER_KEY_PREFIX}acme`, "{ not json");
    const reg = createWorkerRegistry(fake.redis, alwaysLive);
    const got = await reg.get(tid("acme"));
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toBeNull();
  });

  test("eagerPin round-trips (AD-7 belt-and-suspenders, C3)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, alwaysLive);
    await reg.put(rec("acme", 7, "live", true));
    const got = await reg.get(tid("acme"));
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value?.eagerPin).toBe(true);
  });

  test("a record missing eagerPin coerces to false (older record stays adoptable)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    fake.store.set(`${WORKER_KEY_PREFIX}acme`, JSON.stringify({ pid: 9, udsPath: "/run/fugue/acme.sock", startedAt: 1000, health: "live" }));
    const reg = createWorkerRegistry(fake.redis, alwaysLive);
    const got = await reg.get(tid("acme"));
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.value).not.toBeNull();
      expect(got.value?.eagerPin).toBe(false);
    }
  });

  test("deserialize rejects pid <= 0 (corrupt → null)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    fake.store.set(`${WORKER_KEY_PREFIX}acme`, JSON.stringify({ pid: 0, udsPath: "/run/fugue/acme.sock", startedAt: 1000, health: "live", eagerPin: false }));
    const reg = createWorkerRegistry(fake.redis, alwaysLive);
    const got = await reg.get(tid("acme"));
    if (got.ok) expect(got.value).toBeNull();
  });

  test("deserialize rejects negative / non-finite startedAt (corrupt → null)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    fake.store.set(`${WORKER_KEY_PREFIX}neg`, JSON.stringify({ pid: 1, udsPath: "/run/fugue/neg.sock", startedAt: -5, health: "live", eagerPin: false }));
    const reg = createWorkerRegistry(fake.redis, alwaysLive);
    const got = await reg.get(tid("neg"));
    if (got.ok) expect(got.value).toBeNull();
  });
});

// ── Corrupt-record observability (contract parity with reconcileReadopt) ─────────

describe("worker-registry: corrupt-record observability", () => {
  test("a corrupt record reads as null AND is pruned + WARN-logged (distinguishable from never-registered)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    fake.store.set(`${WORKER_KEY_PREFIX}acme`, "{ not json");
    const { logger, logs } = capturingLogPort();
    const reg = createWorkerRegistry(fake.redis, alwaysLive, {}, logger);
    const got = await reg.get(tid("acme"));
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toBeNull();
    // The corrupt entry is pruned (the same self-healing as reconcileReadopt).
    expect(fake.store.has(`${WORKER_KEY_PREFIX}acme`)).toBe(false);
    // The operator signal that distinguishes corrupt from absent — without it,
    // a truncation/allocator fault reading as "absent" is a silent failure.
    const warn = logs.find((l) => l.level === "warn");
    expect(warn).toBeDefined();
    expect(warn?.msg).toContain("corrupt worker record");
    expect(warn?.data).toMatchObject({ tenant: tid("acme") });
  });

  test("a prune failure does NOT fail the read — get still returns null and the record is left for reconcile", async () => {
    const fake = createInMemoryWorkerRedisFake();
    fake.store.set(`${WORKER_KEY_PREFIX}acme`, "{ not json");
    const { logger, logs } = capturingLogPort();
    // A RedisPort over the same store whose del FAILS (result-level failure, no throw).
    const delFailing: RedisPort = {
      ...fake.redis,
      del: async () => err(redisUnavailable("del")),
    };
    const reg = createWorkerRegistry(delFailing, alwaysLive, {}, logger);
    const got = await reg.get(tid("acme"));
    // Fail-closed read: null (lazy-spawn path), NOT an error.
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toBeNull();
    // The corrupt record SURVIVES the failed prune — reconcile prunes it later.
    expect(fake.store.has(`${WORKER_KEY_PREFIX}acme`)).toBe(true);
    // Both facts are surfaced: the corrupt read AND the prune that could not run.
    // The prune failure is ONE line whichever way it failed (result-level `!ok`
    // here, a throw on the other path), with the manner in `reason` — so a
    // single fault can never read as two in an operator's log.
    const warns = logs.filter((l) => l.level === "warn");
    expect(warns.some((l) => l.msg.includes("corrupt worker record"))).toBe(true);
    const pruneWarns = warns.filter((l) => l.msg.includes("corrupt-record prune failed"));
    expect(pruneWarns).toHaveLength(1);
    expect((pruneWarns[0]!.data as { reason?: string }).reason).toBe("reported unavailable");
  });
});

// ── Fail-closed ──────────────────────────────────────────────────────────────

describe("worker-registry: fail-closed on Redis error", () => {
  test("put/get/remove return redis-unavailable + fire onRedisDead", async () => {
    const fake = createInMemoryWorkerRedisFake();
    let deadCalls = 0;
    const reg = createWorkerRegistry(fake.redis, alwaysLive, { onRedisDead: () => { deadCalls++; } });
    fake.setFail(true);

    const p = await reg.put(rec("acme", 1));
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error.kind).toBe("redis-unavailable");

    const g = await reg.get(tid("acme"));
    expect(g.ok).toBe(false);

    const r = await reg.remove(tid("acme"));
    expect(r.ok).toBe(false);

    expect(deadCalls).toBe(3);
  });

  test("a throwing failure logger cannot replace the typed Redis error", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const throwingRedis: RedisPort = {
      ...fake.redis,
      get: async () => { throw Object.create(null); },
    };
    const reg = createWorkerRegistry(throwingRedis, alwaysLive, {}, {
      info() {},
      warn() { throw new Error("logger transport failed"); },
      error() {},
    });

    const result = await reg.get(tid("acme"));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("redis-unavailable");
  });

  test("reconcileReadopt fails closed if scan errors", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, alwaysLive);
    fake.setFail(true);
    const r = await reg.reconcileReadopt();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("redis-unavailable");
  });

  test("a successful op fires onRedisAlive", async () => {
    const fake = createInMemoryWorkerRedisFake();
    let aliveCalls = 0;
    const reg = createWorkerRegistry(fake.redis, alwaysLive, { onRedisAlive: () => { aliveCalls++; } });
    await reg.put(rec("acme", 1));
    expect(aliveCalls).toBe(1);
  });
});

// ── reconcileReadopt (SC-006) ──────────────────────────────────────────────────

describe("worker-registry: reconcileReadopt (SC-006, FR-019/FR-020)", () => {
  test("adopts probe-live workers and resumes routing", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, alwaysLive);
    await reg.put(rec("acme", 1));
    await reg.put(rec("globex", 2));

    const r = await reg.reconcileReadopt();
    expect(r.ok).toBe(true);
    if (r.ok) {
      const tenants = r.value.adopted.map((a) => a.record.tenant).sort();
      expect(tenants).toEqual([tid("acme"), tid("globex")].sort());
      expect(r.value.pruned).toEqual([]);
      // adopted records preserve original pid + startedAt (uptime).
      const acme = r.value.adopted.find((a) => a.record.tenant === tid("acme"));
      expect(acme?.record.pid).toBe(1);
      expect(acme?.record.startedAt).toBe(1000);
    }
    // Live entries are NOT pruned.
    expect(fake.store.has(`${WORKER_KEY_PREFIX}acme`)).toBe(true);
  });

  test("prunes probe-dead workers and deletes their entries", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, alwaysDead);
    await reg.put(rec("acme", 1));
    await reg.put(rec("globex", 2));

    const r = await reg.reconcileReadopt();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.adopted).toEqual([]);
      expect(r.value.pruned.sort()).toEqual([tid("acme"), tid("globex")].sort());
    }
    // Dead entries are pruned from Redis (self-healing registry).
    expect(fake.store.has(`${WORKER_KEY_PREFIX}acme`)).toBe(false);
    expect(fake.store.has(`${WORKER_KEY_PREFIX}globex`)).toBe(false);
  });

  test("a throwing prune logger cannot abort best-effort reconciliation", async () => {
    const fake = createInMemoryWorkerRedisFake();
    await createWorkerRegistry(fake.redis, alwaysLive).put(rec("acme", 1));
    const pruneFailing: RedisPort = {
      ...fake.redis,
      del: async () => err(redisUnavailable("del")),
    };
    const reg = createWorkerRegistry(pruneFailing, alwaysDead, {}, {
      info() {},
      warn() { throw new Error("logger transport failed"); },
      error() {},
    });

    const result = await reg.reconcileReadopt();

    expect(result).toEqual(ok({ adopted: [], pruned: [tid("acme")] }));
    expect(fake.store.has(`${WORKER_KEY_PREFIX}acme`)).toBe(true);
  });

  test("partitions mixed live/dead deterministically", async () => {
    const fake = createInMemoryWorkerRedisFake();
    // Probe: acme is live, everyone else is dead.
    const probe: UdsLivenessProbe = async (record) => record.tenant === tid("acme");
    const reg = createWorkerRegistry(fake.redis, probe);
    await reg.put(rec("acme", 1));
    await reg.put(rec("globex", 2));

    const r = await reg.reconcileReadopt();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.adopted.map((a) => a.record.tenant)).toEqual([tid("acme")]);
      expect(r.value.pruned).toEqual([tid("globex")]);
    }
    expect(fake.store.has(`${WORKER_KEY_PREFIX}acme`)).toBe(true);
    expect(fake.store.has(`${WORKER_KEY_PREFIX}globex`)).toBe(false);
  });

  test("prunes corrupt records", async () => {
    const fake = createInMemoryWorkerRedisFake();
    fake.store.set(`${WORKER_KEY_PREFIX}acme`, "garbage{");
    const reg = createWorkerRegistry(fake.redis, alwaysLive);
    const r = await reg.reconcileReadopt();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.adopted).toEqual([]);
    }
    expect(fake.store.has(`${WORKER_KEY_PREFIX}acme`)).toBe(false);
  });

  test("a probe that throws is treated as dead (fail-closed)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const throwingProbe: UdsLivenessProbe = async () => { throw new Error("connection refused"); };
    const reg = createWorkerRegistry(fake.redis, throwingProbe);
    await reg.put(rec("acme", 1));
    const r = await reg.reconcileReadopt();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.adopted).toEqual([]);
      expect(r.value.pruned).toEqual([tid("acme")]);
    }
  });
});

// ── Pure spawn-plan builder (AD-9 heap cap) ────────────────────────────────────

describe("buildWorkerSpawn: argv + env + heap cap (AD-9)", () => {
  const baseSpec = (overrides: Partial<WorkerSpawnSpec> = {}): WorkerSpawnSpec => ({
    tenant: tid("acme"),
    secretsRef: markSecretsRef("vault://acme/env"),
    workerEntry: "/app/worker-main.ts",
    udsPath: "/run/fugue/acme.sock",
    ...overrides,
  });

  test("argv is `bun run <entry>`", () => {
    const plan = buildWorkerSpawn(baseSpec(), {});
    expect(plan.cmd).toEqual(["bun", "run", "/app/worker-main.ts"]);
  });

  test("sets TENANT_ID and FUGUE_SECRETS_REF (reference only)", () => {
    const plan = buildWorkerSpawn(baseSpec(), {});
    expect(plan.env.TENANT_ID).toBe("acme");
    expect(plan.env.FUGUE_SECRETS_REF).toBe("vault://acme/env");
  });

  test("forwards WORKER_UDS_DIR = dirname(spec.udsPath) so the worker binds spec.udsPath (C7)", async () => {
    const { workerSocketPath } = await import("../../../domain/config.js");
    // Non-default dir: the bug was that WORKER_UDS_DIR was never set, so the
    // worker bound the default /run/fugue while the supervisor targeted /custom.
    const plan = buildWorkerSpawn(baseSpec({ udsPath: "/custom/uds/acme.sock" }), {});
    expect(plan.env.WORKER_UDS_DIR).toBe("/custom/uds");
    // The worker reconstructs its socket from WORKER_UDS_DIR + tenant — it MUST
    // equal exactly the supervisor-chosen spec.udsPath (structural FR-004 match).
    expect(workerSocketPath(plan.env.WORKER_UDS_DIR, "acme")).toBe("/custom/uds/acme.sock");
  });

  test("WORKER_UDS_DIR override wins over a stale inherited value", () => {
    const plan = buildWorkerSpawn(baseSpec({ udsPath: "/run/fugue/acme.sock" }), { WORKER_UDS_DIR: "/WRONG" });
    expect(plan.env.WORKER_UDS_DIR).toBe("/run/fugue");
  });

  test("heap cap → NODE_OPTIONS --max-old-space-size (AD-9)", () => {
    const plan = buildWorkerSpawn(baseSpec({ heapCapMb: 512 }), {});
    expect(plan.env.NODE_OPTIONS).toBe("--max-old-space-size=512");
  });

  test("heap cap APPENDS to inherited NODE_OPTIONS (preserves platform flags)", () => {
    const plan = buildWorkerSpawn(baseSpec({ heapCapMb: 256 }), { NODE_OPTIONS: "--enable-source-maps" });
    expect(plan.env.NODE_OPTIONS).toBe("--enable-source-maps --max-old-space-size=256");
  });

  test("no heap cap → no NODE_OPTIONS injection", () => {
    const plan = buildWorkerSpawn(baseSpec(), {});
    expect(plan.env.NODE_OPTIONS).toBeUndefined();
  });

  test("tenant binding WINS over a stale inherited TENANT_ID", () => {
    const plan = buildWorkerSpawn(baseSpec(), { TENANT_ID: "WRONG", FUGUE_SECRETS_REF: "WRONG" });
    expect(plan.env.TENANT_ID).toBe("acme");
    expect(plan.env.FUGUE_SECRETS_REF).toBe("vault://acme/env");
  });

  test("tenant binding WINS over extraEnv (extraEnv cannot override the tenant)", () => {
    const plan = buildWorkerSpawn(baseSpec({ extraEnv: { TENANT_ID: "evil", REDIS_URL: "redis://x" } }), {});
    expect(plan.env.TENANT_ID).toBe("acme");
    expect(plan.env.REDIS_URL).toBe("redis://x"); // unrelated extra env is preserved
  });

  test("undefined inherited env values are dropped", () => {
    const plan = buildWorkerSpawn(baseSpec(), { FOO: undefined, BAR: "keep" });
    expect("FOO" in plan.env).toBe(false);
    expect(plan.env.BAR).toBe("keep");
  });
});
