// run-queue.test.ts — single-flight lock + wakeup delivery (ADR-0060).
//
// Covers the three durability properties of the lock that the service-level
// fakes can't (they use a lock-free fake queue):
//   C2  the lock is acquired atomically WITH its TTL (SET NX EX), never a
//       setNx-then-set that can strand a run on a crash in the gap.
//   C1  a wakeup that LOSES the lock (another worker mid-slice) is RE-ENQUEUED
//       (deferred), never dropped — otherwise a decided run parks forever.
//   A1  a host-infra error from processRun is THROWN (so the queue retries),
//       not swallowed, and the lock is released first.

import { describe, it, expect } from "bun:test";
import { ok, err } from "@fuguejs/framework";
import type { Result, RunId, QueueBackend, JobLike, WorkerHandle, EnqueueOpts, QueueOpts } from "@fuguejs/framework";
import type { RedisPort } from "../../../ports.js";
import type { HostError } from "../../../domain/host-error.js";
import { tenantId } from "../../../domain/tenant.js";
import type { TenantId } from "../../../domain/tenant.js";
import { createRunQueue } from "../run-queue.js";

/** Build a `TenantId` for a test from a known-good literal via the canonical constructor. */
const mkTenant = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`test tenant id "${s}" is invalid (kind: ${r.error.kind})`);
  return r.value;
};

const TENANT = mkTenant("tenant-a");
const OTHER_TENANT = mkTenant("tenant-b");

const RUN = "run-1" as RunId;
// The lock key is tenant-prefixed (AD-4 / FR-013 / SC-001) — assertions target
// the bound tenant's namespace.
const lockKey = (runId: string, tenant: TenantId = TENANT) => `fugue:${tenant}:hitl:lock:${runId}`;

// ── recording fake RedisPort ──────────────────────────────────────────────────
const fakeRedis = (preset: Record<string, string> = {}) => {
  const m = new Map<string, string>(Object.entries(preset));
  const calls = {
    setNx: [] as { key: string; value: string; opts?: { expiresInSec?: number } }[],
    set: [] as string[],
    del: [] as string[],
    compareAndDelete: [] as { key: string; expected: string }[],
  };
  const redis: RedisPort = {
    async get(k) { return ok(m.get(k) ?? null); },
    async set(k, v, _opts) { calls.set.push(k); m.set(k, v); return ok("OK"); },
    async del(k) { calls.del.push(k); const had = m.delete(k); return ok(had ? 1 : 0); },
    async scan() { return ok({ cursor: "0", keys: [...m.keys()] }); },
    async setNx(k, v, opts) { calls.setNx.push({ key: k, value: v, opts }); if (m.has(k)) return ok(false); m.set(k, v); return ok(true); },
    async compareAndDelete(k, expected) { calls.compareAndDelete.push({ key: k, expected }); if (m.get(k) !== expected) return ok(false); m.delete(k); return ok(true); },
    async compareAndExpire(k, expected) { return ok(m.get(k) === expected); },
    async sAdd() { return ok(1); },
    async sRem() { return ok(1); },
    async sMembers() { return ok([]); },
  };
  return { redis, calls, m };
};

// ── fake QueueBackend: captures the worker fn + records enqueues ───────────────
const fakeBackend = () => {
  let workerFn: ((job: JobLike<RunId, unknown, { readonly tenant: TenantId }>) => Promise<void>) | undefined;
  const enqueued: { id: string; delayMs?: number }[] = [];
  let queueOpts: QueueOpts | undefined;
  const backend: QueueBackend = {
    createQueue(_name, opts) {
      queueOpts = opts;
      return {
        async enqueue(id: string, _data: { state: RunId; context: { readonly tenant: TenantId } }, eo?: EnqueueOpts) { enqueued.push({ id, delayMs: eo?.delayMs }); },
        async drain() {},
        async close() {},
      } as never;
    },
    createWorker(_name, process, _opts) {
      workerFn = process as never;
      return { onFailed() {}, onExhausted() {}, onError() {}, async close() {} } as WorkerHandle;
    },
    async close() {},
  };
  const job = (state: RunId, tenant: TenantId = TENANT): JobLike<RunId, unknown, { readonly tenant: TenantId }> => ({ data: { state, context: { tenant } } } as never);
  return { backend, enqueued, job, getWorker: () => workerFn!, getQueueOpts: () => queueOpts };
};

const okProcess = async (): Promise<Result<void, HostError>> => ok(undefined);

describe("createRunQueue — single-flight lock", () => {
  it("C2: acquires the lock atomically with its TTL (SET NX EX), not setNx-then-set", async () => {
    const { redis, calls } = fakeRedis();
    const fb = fakeBackend();
    const q = createRunQueue({
      backend: fb.backend,
      redis,
      tenant: TENANT,
      lockTtlSec: 300,
      newLockToken: () => "owner-1",
    });
    q.startWorker(okProcess, { concurrency: 2 });

    await fb.getWorker()(fb.job(RUN));

    // The single setNx carries the TTL atomically…
    expect(calls.setNx).toEqual([{ key: lockKey(RUN), value: "owner-1", opts: { expiresInSec: 300 } }]);
    // …and there is NO separate `set` on the lock key (the old crash-prone path).
    expect(calls.set).not.toContain(lockKey(RUN));
    // Release uses the same owner token in the atomic comparator.
    expect(calls.compareAndDelete).toEqual([{ key: lockKey(RUN), expected: "owner-1" }]);
  });

  it("an expired holder cannot delete a successor worker's lock", async () => {
    const { redis, calls, m } = fakeRedis();
    const fb = fakeBackend();
    const q = createRunQueue({
      backend: fb.backend,
      redis,
      tenant: TENANT,
      lockTtlSec: 1,
      newLockToken: () => "expired-owner",
    });
    q.startWorker(async () => {
      // Simulate this lease expiring and a successor acquiring before finally.
      m.set(lockKey(RUN), "successor-owner");
      return ok(undefined);
    });

    await fb.getWorker()(fb.job(RUN));

    expect(calls.compareAndDelete).toEqual([{ key: lockKey(RUN), expected: "expired-owner" }]);
    expect(m.get(lockKey(RUN))).toBe("successor-owner");
  });

  it("logs the typed Redis failure kind when ownership-checked release fails", async () => {
    const base = fakeRedis();
    const redis: RedisPort = {
      ...base.redis,
      async compareAndDelete() {
        return err({ kind: "redis-unavailable", operation: "WATCH/EXEC release" });
      },
    };
    const warnings: Array<Record<string, unknown>> = [];
    const fb = fakeBackend();
    const q = createRunQueue({
      backend: fb.backend,
      redis,
      tenant: TENANT,
      lockTtlSec: 300,
      logger: { info() {}, error() {}, warn(_message, data) { warnings.push(data ?? {}); } },
    });
    q.startWorker(okProcess);

    await fb.getWorker()(fb.job(RUN));

    expect(warnings).toEqual([{ runId: RUN, error: "redis-unavailable" }]);
  });

  it("C1: re-enqueues (deferred) a wakeup that loses the lock — never drops it", async () => {
    let processed = 0;
    // Lock already held by another worker.
    const { redis } = fakeRedis({ [lockKey(RUN)]: "1" });
    const fb = fakeBackend();
    const q = createRunQueue({ backend: fb.backend, redis, tenant: TENANT, lockTtlSec: 300, lockContentionDelayMs: 1500 });
    q.startWorker(async () => { processed++; return ok(undefined); }, { concurrency: 2 });

    await fb.getWorker()(fb.job(RUN));

    expect(processed).toBe(0); // did NOT run the slice (lock held)…
    expect(fb.enqueued).toEqual([{ id: RUN, delayMs: 1500 }]); // …but preserved the wakeup
  });

  it("C1: the preserved wakeup is processed once the lock frees (decision not lost)", async () => {
    let processed = 0;
    const { redis, m } = fakeRedis({ [lockKey(RUN)]: "1" });
    const fb = fakeBackend();
    const q = createRunQueue({ backend: fb.backend, redis, tenant: TENANT, lockTtlSec: 300 });
    q.startWorker(async () => { processed++; return ok(undefined); }, { concurrency: 2 });

    await fb.getWorker()(fb.job(RUN)); // contention → deferred
    expect(processed).toBe(0);
    expect(fb.enqueued).toHaveLength(1);

    m.delete(lockKey(RUN)); // the holding worker finishes (lock freed)
    await fb.getWorker()(fb.job(RUN)); // the deferred wakeup runs
    expect(processed).toBe(1);
  });

  it("A1: throws on a host-infra processRun error (so the queue retries) and releases the lock first", async () => {
    const { redis, calls } = fakeRedis();
    const fb = fakeBackend();
    const q = createRunQueue({ backend: fb.backend, redis, tenant: TENANT, lockTtlSec: 300 });
    q.startWorker(async () => err({ kind: "redis-unavailable", operation: "run-store get" }), { concurrency: 2 });

    await expect(fb.getWorker()(fb.job(RUN))).rejects.toThrow(/processRun failed for run-1/);
    // The finally attempted an ownership-checked release even though the slice threw.
    expect(calls.compareAndDelete).toHaveLength(1);
  });

  it("A1: configures the queue with a retry budget (defaultAttempts > 1)", () => {
    const { redis } = fakeRedis();
    const fb = fakeBackend();
    createRunQueue({ backend: fb.backend, redis, tenant: TENANT, lockTtlSec: 300, maxAttempts: 7 });
    expect(fb.getQueueOpts()?.defaultAttempts).toBe(7);
  });

  it("rejects a missing renewal capability before any worker can acquire a lease", async () => {
    const base = fakeRedis();
    const redis: RedisPort = { ...base.redis, compareAndExpire: undefined };
    const fb = fakeBackend();
    const queue = createRunQueue({ backend: fb.backend, redis, tenant: TENANT, lockTtlSec: 300 });
    queue.startWorker(okProcess);

    await expect(fb.getWorker()(fb.job(RUN))).rejects.toThrow("Redis lease renewal is unavailable");
    expect(base.calls.setNx).toHaveLength(0);
  });

  it("throws when the lock STORE is unavailable (wakeup retried, not acked-and-dropped)", async () => {
    const base = fakeRedis();
    const redis: RedisPort = { ...base.redis, async setNx() { return err({ kind: "redis-unavailable", operation: "SETNX" }); } };
    const fb = fakeBackend();
    const q = createRunQueue({ backend: fb.backend, redis, tenant: TENANT, lockTtlSec: 300 });
    q.startWorker(okProcess, { concurrency: 2 });

    await expect(fb.getWorker()(fb.job(RUN))).rejects.toThrow(/lock acquire failed/);
  });
});

describe("createRunQueue — cross-tenant wakeup isolation (SECURITY: AD-4 / FR-013 / SC-001)", () => {
  it("rejects a trigger carrying another tenant before it can acquire that tenant's lock", async () => {
    const { redis, calls } = fakeRedis();
    const fb = fakeBackend();
    const queue = createRunQueue({ backend: fb.backend, redis, tenant: TENANT, lockTtlSec: 300 });
    queue.startWorker(okProcess);

    await expect(fb.getWorker()(fb.job(RUN, OTHER_TENANT))).rejects.toThrow("cross-tenant wakeup");
    expect(calls.setNx).toHaveLength(0);
  });

  it("two queues bound to different tenants do NOT contend on the same runId's lock", async () => {
    // ONE shared Redis, two queues for different tenants. Tenant A holds its lock
    // for RUN; tenant B's worker must NOT see it as contended — its lock key lives
    // under a DIFFERENT tenant prefix, so it acquires and runs its own slice.
    const { redis, calls, m } = fakeRedis({ [lockKey(RUN, TENANT)]: "1" });
    const fb = fakeBackend();
    let bProcessed = 0;
    const qB = createRunQueue({ backend: fb.backend, redis, tenant: OTHER_TENANT, lockTtlSec: 300 });
    qB.startWorker(async () => { bProcessed++; return ok(undefined); }, { concurrency: 2 });

    await fb.getWorker()(fb.job(RUN, OTHER_TENANT));

    // Tenant B ran its slice (no false contention against tenant A's lock)…
    expect(bProcessed).toBe(1);
    // …acquiring and releasing ONLY its own tenant-prefixed lock key.
    expect(calls.setNx).toHaveLength(1);
    expect(calls.setNx[0]?.key).toBe(lockKey(RUN, OTHER_TENANT));
    expect(calls.compareAndDelete[0]?.key).toBe(lockKey(RUN, OTHER_TENANT));
    // Tenant A's lock key is untouched (B physically cannot name it).
    expect(m.get(lockKey(RUN, TENANT))).toBe("1");
    expect(calls.compareAndDelete.some((c) => c.key === lockKey(RUN, TENANT))).toBe(false);
  });
});
