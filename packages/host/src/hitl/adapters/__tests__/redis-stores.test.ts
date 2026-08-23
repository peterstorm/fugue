// redis-stores.test.ts — RunStore + DecisionStore Redis adapters (ADR-0060),
// driven by an in-memory RedisPort fake (no Redis).

import { describe, it, expect } from "bun:test";
import { nonEmptyString, ok, err } from "@fuguejs/framework";
import type { Result, RunId, NodeId, DagId, HumanAction } from "@fuguejs/framework";
import type { HitlRedisPort, LogPort } from "../../../ports.js";
import type { HostError } from "../../../domain/host-error.js";
import { markTeam } from "../../../domain/auth.js";
import { tenantId } from "../../../domain/tenant.js";
import type { TenantId } from "../../../domain/tenant.js";
import { transitionRunStatus, tryRunTimestampMs } from "../../types.js";
import type { QueuedRunRecord, RunStatus, RunStatusUpdate, RunTimestampMs } from "../../types.js";
import { createInMemoryRunLeaseAuthority, createInMemoryRunStore, createRedisRunStore } from "../run-store.js";
import { createRedisDecisionStore } from "../decision-store.js";
import { issueRunLease } from "../../ports.js";
import type { RunLease } from "../../ports.js";

/** Build a `TenantId` for a test from a known-good literal via the canonical constructor. */
const mkTenant = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`test tenant id "${s}" is invalid (kind: ${r.error.kind})`);
  return r.value;
};

// Bound tenant used by the bulk of the suite. A second tenant exercises the
// cross-tenant isolation invariant (SC-001) at the HITL durable-store layer.
const TENANT = mkTenant("tenant-a");
const OTHER_TENANT = mkTenant("tenant-b");

/** A `set`/`setNx` opts record so a test can assert the TTL was passed (SET …EX). */
type WriteOpts = { expiresInSec?: number } | undefined;

/**
 * A minimal in-memory RedisPort honoring get/set/del/setNx that ALSO records the
 * opts each write was given, keyed by key. The store layer must pass
 * `{ expiresInSec: ttlSec }` on every key-creating write so a crash never leaves
 * a TTL-less key (mirrors the lock assertion in run-queue.test.ts).
 */
type RecordingRedis = HitlRedisPort & {
  readonly setOpts: Map<string, WriteOpts>;
  readonly setNxOpts: Map<string, WriteOpts>;
};
const fakeRedis = (): RecordingRedis => {
  const m = new Map<string, string>();
  const setOpts = new Map<string, WriteOpts>();
  const setNxOpts = new Map<string, WriteOpts>();
  return {
    setOpts,
    setNxOpts,
    async get(k): Promise<Result<string | null, HostError>> { return ok(m.get(k) ?? null); },
    async set(k, v, opts): Promise<Result<string | null, HostError>> { setOpts.set(k, opts); m.set(k, v); return ok("OK"); },
    async del(k, ...additionalKeys): Promise<Result<number, HostError>> {
      return ok([k, ...additionalKeys].reduce((count, key) => count + (m.delete(key) ? 1 : 0), 0));
    },
    async scan(): Promise<Result<{ cursor: string; keys: string[] }, HostError>> { return ok({ cursor: "0", keys: [...m.keys()] }); },
    async setNx(k, v, opts): Promise<Result<boolean, HostError>> { setNxOpts.set(k, opts); if (m.has(k)) return ok(false); m.set(k, v); return ok(true); },
    async compareAndDelete(k, expected): Promise<Result<boolean, HostError>> { if (m.get(k) !== expected) return ok(false); m.delete(k); return ok(true); },
    async compareAndExpire(k, expected): Promise<Result<boolean, HostError>> { return ok(m.get(k) === expected); },
    async setIfValue(guard, expected, key, value, opts): Promise<Result<boolean, HostError>> {
      if (m.get(guard) !== expected) return ok(false);
      setOpts.set(key, opts);
      m.set(key, value);
      return ok(true);
    },
    async setNxIfPresent(guard, key, value, opts): Promise<Result<"not-present" | "created" | "exists", HostError>> {
      if (!m.has(guard)) return ok("not-present");
      if (m.has(key)) return ok("exists");
      setNxOpts.set(key, opts);
      m.set(key, value);
      return ok("created");
    },
    async sAdd(): Promise<Result<number, HostError>> { return ok(1); },
    async sRem(): Promise<Result<number, HostError>> { return ok(1); },
    async sMembers(): Promise<Result<string[], HostError>> { return ok([]); },
  };
};

// A seedable RedisPort fake for the torn/corrupt-state branches: `seed` writes a
// raw value at an exact key, bypassing the adapter's own serialization.
const seedableRedis = (): { redis: HitlRedisPort; seed: (k: string, v: string) => void } => {
  const m = new Map<string, string>();
  const redis: HitlRedisPort = {
    async get(k) { return ok(m.get(k) ?? null); },
    async set(k, v) { m.set(k, v); return ok("OK"); },
    async del(k, ...additionalKeys) {
      return ok([k, ...additionalKeys].reduce((count, key) => count + (m.delete(key) ? 1 : 0), 0));
    },
    async scan() { return ok({ cursor: "0", keys: [...m.keys()] }); },
    async setNx(k, v) { if (m.has(k)) return ok(false); m.set(k, v); return ok(true); },
    async compareAndDelete(k, expected) { if (m.get(k) !== expected) return ok(false); m.delete(k); return ok(true); },
    async compareAndExpire(k, expected) { return ok(m.get(k) === expected); },
    async setIfValue(guard, expected, key, value) { if (m.get(guard) !== expected) return ok(false); m.set(key, value); return ok(true); },
    async setNxIfPresent(guard, key, value) { if (!m.has(guard)) return ok("not-present"); if (m.has(key)) return ok("exists"); m.set(key, value); return ok("created"); },
    async sAdd() { return ok(1); },
    async sRem() { return ok(1); },
    async sMembers() { return ok([]); },
  };
  return { redis, seed: (k, v) => m.set(k, v) };
};

const timestamp = (value: number): RunTimestampMs => {
  const parsed = tryRunTimestampMs(value);
  if (!parsed.ok) throw new Error(`invalid test timestamp: ${parsed.error}`);
  return parsed.value;
};

const acquireLease = async (
  redis: HitlRedisPort,
  runId: RunId,
  tenant: TenantId = TENANT,
  ownerToken = "test-owner",
): Promise<RunLease> => {
  const acquired = await redis.setNx(`fugue:${tenant}:hitl:lock:${runId}`, ownerToken, { expiresInSec: 60 });
  if (!acquired.ok || !acquired.value) throw new Error(`failed to acquire test lease for ${runId}`);
  return issueRunLease(runId, ownerToken, new AbortController().signal);
};

const record = (overrides: Partial<QueuedRunRecord> = {}): QueuedRunRecord => ({
  runId: "run-1" as RunId,
  dagId: "dag-1" as DagId,
  ownerTeam: markTeam("sales"),
  input: { x: 1 },
  identity: { kind: "admin" },
  status: { kind: "queued" },
  checkpoint: '{"state":{"kind":"pending"}}',
  createdAtMs: timestamp(100),
  updatedAtMs: timestamp(100),
  ...overrides,
});

describe("transitionRunStatus — lifecycle state machine", () => {
  const completed = { kind: "completed", output: "done" } as const;
  const failed = { kind: "failed", error: { kind: "aborted", reason: "test" } } as const;
  const currentStates: readonly RunStatus[] = [
    { kind: "queued" },
    { kind: "running" },
    { kind: "suspended", nodeId: "review" as NodeId, prompt: nonEmptyString("Approve?") },
    completed,
    failed,
  ];
  const updates: readonly RunStatusUpdate[] = [
    { kind: "running" },
    { kind: "suspended", nodeId: "review" as NodeId, prompt: nonEmptyString("Approve?") },
    completed,
    failed,
  ];

  it("accepts exactly the legal lifecycle transitions", () => {
    for (const current of currentStates) {
      for (const next of updates) {
        const expected = current.kind === "running"
          || ((current.kind === "queued" || current.kind === "suspended") && next.kind === "running")
          || (current.kind === "completed" && next === completed)
          || (current.kind === "failed" && next === failed);
        expect(
          transitionRunStatus(current, next).ok,
          `${current.kind} -> ${next.kind}`,
        ).toBe(expected);
      }
    }
  });
});

describe("InMemoryRunStore — lease parity", () => {
  it("rejects still-live stale-owner writes after a successor acquires the run", async () => {
    const leases = createInMemoryRunLeaseAuthority();
    const store = createInMemoryRunStore(leases, () => 200);
    const run = record();
    await store.create(run);
    const stale = leases.acquire(run.runId, "stale-owner");
    const successor = leases.acquire(run.runId, "successor-owner");
    expect((await store.setStatus(successor, { kind: "running" })).ok).toBe(true);

    expect(await store.saveCheckpoint(stale, "stale-checkpoint")).toEqual(
      err({ kind: "run-lease-lost", runId: run.runId }),
    );
    expect(await store.setStatus(stale, { kind: "completed", output: "stale" })).toEqual(
      err({ kind: "run-lease-lost", runId: run.runId }),
    );
    expect((await store.setStatus(successor, { kind: "completed", output: "successor" })).ok).toBe(true);

    const persisted = await store.get(run.runId);
    expect(persisted.ok && persisted.value?.checkpoint).toBe(run.checkpoint);
    expect(persisted.ok && persisted.value?.status).toEqual({ kind: "completed", output: "successor" });
  });
});

describe("InMemoryRunStore — active-index parity", () => {
  it("count and list both self-heal a leaked terminal member", async () => {
    const leases = createInMemoryRunLeaseAuthority();
    const store = createInMemoryRunStore(leases, () => 200);
    const run = record();
    await store.create(run);
    const lease = leases.acquire(run.runId);
    await store.setStatus(lease, { kind: "running" });
    await store.setStatus(lease, { kind: "completed", output: "done" });
    (store._active as Set<string>).add(run.runId); // model a stale persisted index member

    expect(await store.countActiveRuns()).toEqual(ok(0));
    expect(await store.listActiveRunIds()).toEqual(ok([]));
    expect(store._active.has(run.runId)).toBe(false);
  });
});

describe("RedisRunStore", () => {
  const cfg = { ttlSec: 3600 };

  it("create then get round-trips the full record", async () => {
    const store = createRedisRunStore(fakeRedis(), TENANT, cfg);
    const r = record();
    expect((await store.create(r)).ok).toBe(true);

    const got = await store.get(r.runId);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toEqual(r);
  });

  it("create applies the configured TTL to both the meta (SET NX EX) and checkpoint keys", async () => {
    const redis = fakeRedis();
    const store = createRedisRunStore(redis, TENANT, { ttlSec: 4242 });
    const r = record();
    await store.create(r);
    // Meta is created atomically WITH its TTL (never a TTL-less key on a crash).
    expect(redis.setNxOpts.get("fugue:tenant-a:hitl:run:run-1")).toEqual({ expiresInSec: 4242 });
    // The checkpoint is also create-once with TTL, so a duplicate publication
    // attempt cannot overwrite an existing run before metadata NX rejects it.
    expect(redis.setNxOpts.get("fugue:tenant-a:hitl:ckpt:run-1")).toEqual({ expiresInSec: 4242 });
  });

  it("rejects a run input containing a literal reserved serializer tag without publishing metadata", async () => {
    const store = createRedisRunStore(fakeRedis(), TENANT, cfg);
    const run = record({ input: { __date__: "2026-08-22T18:30:00.000Z" } });

    const created = await store.create(run);

    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.kind).toBe("internal-invariant-violated");
    expect(await store.get(run.runId)).toEqual(ok(null));
  });

  it("rejects a completed output containing a literal reserved serializer tag without changing status", async () => {
    const redis = fakeRedis();
    const store = createRedisRunStore(redis, TENANT, cfg);
    const run = record();
    await store.create(run);
    const lease = await acquireLease(redis, run.runId);

    const settled = await store.setStatus(lease, {
      kind: "completed",
      output: { __undefined__: true },
    });

    expect(settled.ok).toBe(false);
    if (!settled.ok) expect(settled.error.kind).toBe("internal-invariant-violated");
    const persisted = await store.get(run.runId);
    expect(persisted.ok && persisted.value?.status).toEqual({ kind: "queued" });
  });

  it("completed output round-trips Map, Set, and Date without adapter drift", async () => {
    const redis = fakeRedis();
    const store = createRedisRunStore(redis, TENANT, cfg);
    const run = record();
    await store.create(run);
    const lease = await acquireLease(redis, run.runId);
    const output = {
      byNode: new Map([["review", new Set(["approved", "audited"])]]),
      completedAt: new Date("2026-08-22T18:30:00.000Z"),
    };

    expect((await store.setStatus(lease, { kind: "running" })).ok).toBe(true);
    expect((await store.setStatus(lease, { kind: "completed", output })).ok).toBe(true);
    const persisted = await store.get(run.runId);

    expect(persisted.ok && persisted.value?.status).toEqual({ kind: "completed", output });
  });

  it("saveCheckpoint and setStatus re-apply the TTL (sliding expiry, never a TTL-less write)", async () => {
    const redis = fakeRedis();
    const store = createRedisRunStore(redis, TENANT, { ttlSec: 7 });
    const r = record();
    await store.create(r);
    const lease = await acquireLease(redis, r.runId);

    await store.saveCheckpoint(lease, '{"state":{"kind":"suspended"}}');
    expect(redis.setOpts.get("fugue:tenant-a:hitl:ckpt:run-1")).toEqual({ expiresInSec: 7 });

    await store.setStatus(lease, { kind: "running" });
    await store.setStatus(lease, { kind: "completed", output: 1 });
    expect(redis.setOpts.get("fugue:tenant-a:hitl:run:run-1")).toEqual({ expiresInSec: 7 });
  });

  it("rejects checkpoint and terminal writes from an expired owner after a successor acquires", async () => {
    const redis = fakeRedis();
    const store = createRedisRunStore(redis, TENANT, cfg);
    const r = record();
    await store.create(r);
    const stale = await acquireLease(redis, r.runId, TENANT, "stale-owner");
    await store.setStatus(stale, { kind: "running" });
    await redis.set(`fugue:${TENANT}:hitl:lock:${r.runId}`, "successor-owner", { expiresInSec: 60 });

    const checkpoint = await store.saveCheckpoint(stale, '{"state":{"kind":"succeeded"}}');
    const terminal = await store.setStatus(stale, { kind: "completed", output: "stale" });

    expect(checkpoint).toEqual(err({ kind: "run-lease-lost", runId: r.runId }));
    expect(terminal).toEqual(err({ kind: "run-lease-lost", runId: r.runId }));
    const unchanged = await store.get(r.runId);
    expect(unchanged.ok && unchanged.value?.checkpoint).toBe(r.checkpoint);
    expect(unchanged.ok && unchanged.value?.status.kind).toBe("running");
  });

  it("create is single-shot (duplicate run id errs)", async () => {
    const redis = fakeRedis();
    const store = createRedisRunStore(redis, TENANT, cfg);
    await store.create(record({ checkpoint: "original" }));
    const dup = await store.create(record({ checkpoint: "replacement" }));
    expect(dup.ok).toBe(false);
    const original = await store.get("run-1" as RunId);
    expect(original.ok && original.value?.checkpoint).toBe("original");
  });

  it("get returns null for an unknown run", async () => {
    const store = createRedisRunStore(fakeRedis(), TENANT, cfg);
    const got = await store.get("nope" as RunId);
    expect(got.ok && got.value).toBe(null);
  });

  it("saveCheckpoint updates only the checkpoint; setStatus only the status", async () => {
    const redis = fakeRedis();
    const store = createRedisRunStore(redis, TENANT, cfg);
    const r = record();
    await store.create(r);
    const lease = await acquireLease(redis, r.runId);

    await store.saveCheckpoint(lease, '{"state":{"kind":"suspended"}}');
    await store.setStatus(lease, { kind: "running" });
    await store.setStatus(lease, { kind: "suspended", nodeId: "review" as NodeId, prompt: nonEmptyString("ok?") });

    const got = await store.get(r.runId);
    if (!got.ok || !got.value) throw new Error("expected record");
    expect(got.value.checkpoint).toBe('{"state":{"kind":"suspended"}}');
    expect(got.value.status.kind).toBe("suspended");
    // Unchanged fields survive.
    expect(got.value.dagId).toBe("dag-1" as DagId);
  });

  it("setStatus bumps updatedAtMs from the injected clock; createdAtMs is preserved", async () => {
    let t = 500;
    const redis = fakeRedis();
    const store = createRedisRunStore(redis, TENANT, { ...cfg, now: () => t });
    const r = record(); // createdAtMs/updatedAtMs = 100
    await store.create(r);
    const lease = await acquireLease(redis, r.runId);
    await store.setStatus(lease, { kind: "running" });
    t = 999;
    await store.setStatus(lease, { kind: "completed", output: 1 });
    const got = await store.get(r.runId);
    if (!got.ok || !got.value) throw new Error("expected record");
    expect(got.value.updatedAtMs).toBe(timestamp(999));
    expect(got.value.createdAtMs).toBe(timestamp(100));
  });

  it("setStatus on an unknown run errs run-not-found", async () => {
    const redis = fakeRedis();
    const store = createRedisRunStore(redis, TENANT, cfg);
    const lease = await acquireLease(redis, "ghost" as RunId);
    const res = await store.setStatus(lease, { kind: "completed", output: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("run-not-found");
  });

  it("propagates a Redis failure on get", async () => {
    const broken: HitlRedisPort = { ...fakeRedis(), async get() { return err({ kind: "redis-unavailable", operation: "GET" }); } };
    const store = createRedisRunStore(broken, TENANT, cfg);
    const res = await store.get("run-1" as RunId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("redis-unavailable");
  });

  it("errs internal-invariant-violated on a torn execution record (metadata but no checkpoint)", async () => {
    const { redis, seed } = seedableRedis();
    // Seed only the meta key (e.g. the checkpoint key TTL-expired first).
    seed("fugue:tenant-a:hitl:run:run-1", JSON.stringify({ runId: "run-1", dagId: "d", ownerTeam: "sales", input: {}, identity: { kind: "admin" }, status: { kind: "queued" }, createdAtMs: 1, updatedAtMs: 1 }));
    const store = createRedisRunStore(redis, TENANT, cfg);
    const res = await store.get("run-1" as RunId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("internal-invariant-violated");
  });

  it("reads terminal lifecycle metadata after checkpoint expiry", async () => {
    const { redis, seed } = seedableRedis();
    seed("fugue:tenant-a:hitl:run:run-1", JSON.stringify({
      runId: "run-1",
      dagId: "d",
      ownerTeam: "sales",
      input: {},
      identity: { kind: "admin" },
      status: { kind: "completed", output: { answer: 42 } },
      createdAtMs: 1,
      updatedAtMs: 2,
    }));
    const store = createRedisRunStore(redis, TENANT, cfg);

    const metadata = await store.getMetadata("run-1" as RunId);

    expect(metadata.ok && metadata.value?.status).toEqual({
      kind: "completed",
      output: { answer: 42 },
    });
    expect((await store.get("run-1" as RunId)).ok).toBe(false);
  });

  it("errs internal-invariant-violated on corrupt (non-JSON) metadata", async () => {
    const { redis, seed } = seedableRedis();
    seed("fugue:tenant-a:hitl:run:run-1", "{not json");
    const store = createRedisRunStore(redis, TENANT, cfg);
    const res = await store.get("run-1" as RunId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("internal-invariant-violated");
  });

  it("rejects failed metadata whose FrameworkError is missing required fields", async () => {
    const { redis, seed } = seedableRedis();
    seed("fugue:tenant-a:hitl:run:run-1", JSON.stringify({
      runId: "run-1", dagId: "d", ownerTeam: "sales", input: {}, identity: { kind: "admin" },
      status: { kind: "failed", error: { kind: "node-crash" } }, createdAtMs: 1, updatedAtMs: 1,
    }));
    const store = createRedisRunStore(redis, TENANT, cfg);

    const result = await store.get("run-1" as RunId);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("internal-invariant-violated");
  });

  it("rejects a persisted suspended status with an empty prompt", async () => {
    const { redis, seed } = seedableRedis();
    seed("fugue:tenant-a:hitl:run:run-1", JSON.stringify({
      runId: "run-1", dagId: "d", ownerTeam: "sales", input: {}, identity: { kind: "admin" },
      status: { kind: "suspended", nodeId: "review", prompt: "   " }, createdAtMs: 1, updatedAtMs: 1,
    }));
    const store = createRedisRunStore(redis, TENANT, cfg);

    expect((await store.get("run-1" as RunId)).ok).toBe(false);
  });

  it("errs internal-invariant-violated on structurally-invalid metadata (valid JSON, bad shape)", async () => {
    const { redis, seed } = seedableRedis();
    // Parses as JSON but the status discriminant is unknown — must be rejected
    // (parse-don't-validate) rather than flowing in to drive an exhaustive match.
    seed("fugue:tenant-a:hitl:run:run-1", JSON.stringify({
      runId: "run-1", dagId: "d", ownerTeam: "sales", input: {}, identity: { kind: "admin" },
      status: { kind: "teleported" }, createdAtMs: 1, updatedAtMs: 1,
    }));
    const store = createRedisRunStore(redis, TENANT, cfg);
    const res = await store.get("run-1" as RunId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("internal-invariant-violated");
  });
});

describe("RedisDecisionStore", () => {
  const cfg = { ttlSec: 3600 };
  const runId = "run-1" as RunId;
  const nodeId = "review" as NodeId;
  const approve: HumanAction = { kind: "approve" };

  it("persists notification delivery so successful re-parks are deduplicated", async () => {
    const store = createRedisDecisionStore(fakeRedis(), TENANT, cfg);
    const first = await store.preparePending(runId, nodeId);
    expect(first.ok && first.value.kind).toBe("notification-required");
    if (!first.ok || first.value.kind !== "notification-required") return;
    // A delivery failure leaves the same durable state retriable.
    expect(await store.preparePending(runId, nodeId)).toEqual(first);
    expect(await store.markNotified(runId, nodeId, first.value.marker)).toEqual(ok(true));
    const second = await store.preparePending(runId, nodeId);
    expect(second).toEqual(ok({ kind: "notified" }));
  });

  it("preparePending applies the configured TTL to the pending marker (SET NX EX)", async () => {
    const redis = fakeRedis();
    const store = createRedisDecisionStore(redis, TENANT, { ttlSec: 9001 });
    await store.preparePending(runId, nodeId);
    // Pending marker can never exist without an expiry (crash-safe).
    expect(redis.setNxOpts.get(`fugue:tenant-a:hitl:pending:${runId}\x1f${nodeId}`)).toEqual({ expiresInSec: 9001 });
  });

  it("resolvePending atomically creates the decision with TTL and preserves the first writer", async () => {
    const redis = fakeRedis();
    const store = createRedisDecisionStore(redis, TENANT, { ttlSec: 1234 });
    await store.preparePending(runId, nodeId);

    const [first, second] = await Promise.all([
      store.resolvePending(runId, nodeId, approve),
      store.resolvePending(runId, nodeId, { kind: "reject", reason: "too late" }),
    ]);

    expect(first).toEqual(ok({ kind: "accepted" }));
    expect(second).toEqual(ok({ kind: "already-resolved" }));
    expect(redis.setNxOpts.get(`fugue:tenant-a:hitl:decision:${runId}\x1f${nodeId}`)).toEqual({ expiresInSec: 1234 });
    const got = await store.getDecision(runId, nodeId);
    expect(got.ok && got.value).toEqual(approve);
  });

  it("losslessly round-trips approve-with-edit output with Map and undefined", async () => {
    const store = createRedisDecisionStore(fakeRedis(), TENANT, cfg);
    const action: HumanAction = {
      kind: "approve-with-edit",
      newOutput: { values: new Map([["review", new Set(["ok"])]]), optional: undefined },
    };
    await store.preparePending(runId, nodeId);

    expect(await store.resolvePending(runId, nodeId, action)).toEqual(ok({ kind: "accepted" }));
    expect(await store.getDecision(runId, nodeId)).toEqual(ok(action));
  });

  it("rejects a non-lossless approve-with-edit without throwing or publishing", async () => {
    const store = createRedisDecisionStore(fakeRedis(), TENANT, cfg);
    await store.preparePending(runId, nodeId);

    const resolved = await store.resolvePending(runId, nodeId, {
      kind: "approve-with-edit",
      newOutput: { score: Number.NaN },
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.kind).toBe("internal-invariant-violated");
    expect(await store.getDecision(runId, nodeId)).toEqual(ok(null));
  });

  it("getDecision returns null when none recorded", async () => {
    const store = createRedisDecisionStore(fakeRedis(), TENANT, cfg);
    const got = await store.getDecision(runId, nodeId);
    expect(got.ok && got.value).toBe(null);
  });

  it("clear atomically removes the pending marker and decision", async () => {
    const base = fakeRedis();
    const deleteCalls: string[][] = [];
    const redis: HitlRedisPort = {
      ...base,
      async del(key, ...additionalKeys) {
        deleteCalls.push([key, ...additionalKeys]);
        return base.del(key, ...additionalKeys);
      },
    };
    const store = createRedisDecisionStore(redis, TENANT, cfg);
    await store.preparePending(runId, nodeId);
    await store.resolvePending(runId, nodeId, approve);
    await store.clear(runId, nodeId);

    expect(deleteCalls).toEqual([[
      `fugue:tenant-a:hitl:pending:${runId}\x1f${nodeId}`,
      `fugue:tenant-a:hitl:decision:${runId}\x1f${nodeId}`,
    ]]);
    const got = await store.getDecision(runId, nodeId);
    expect(got.ok && got.value).toBe(null);
    // preparePending is fresh again after clear.
    const remark = await store.preparePending(runId, nodeId);
    expect(remark.ok && remark.value.kind).toBe("notification-required");
  });

  it("round-trips a reroute action with fields", async () => {
    const store = createRedisDecisionStore(fakeRedis(), TENANT, cfg);
    const reroute: HumanAction = { kind: "reroute", targetNodeId: "draft" as NodeId, reason: "redo" };
    await store.preparePending(runId, nodeId);
    await store.resolvePending(runId, nodeId, reroute);
    const got = await store.getDecision(runId, nodeId);
    expect(got.ok && got.value).toEqual(reroute);
  });

  it("errs internal-invariant-violated on a corrupt (non-JSON) stored decision", async () => {
    const { redis, seed } = seedableRedis();
    // decision key = fugue:tenant-a:hitl:decision:<runId>␟<nodeId> (US separator).
    seed(`fugue:tenant-a:hitl:decision:${runId}\x1f${nodeId}`, "{not json");
    const store = createRedisDecisionStore(redis, TENANT, cfg);
    const got = await store.getDecision(runId, nodeId);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.kind).toBe("internal-invariant-violated");
  });

  it("errs internal-invariant-violated on a structurally-invalid decision (valid JSON, bad shape)", async () => {
    const { redis, seed } = seedableRedis();
    // A `reject` missing its required `reason` parses as JSON but is not a valid
    // HumanAction — never resume a run on a malformed decision.
    seed(`fugue:tenant-a:hitl:decision:${runId}\x1f${nodeId}`, JSON.stringify({ kind: "reject" }));
    const store = createRedisDecisionStore(redis, TENANT, cfg);
    const got = await store.getDecision(runId, nodeId);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.kind).toBe("internal-invariant-violated");
  });

  it("a throwing corruption logger cannot escape the typed decision error", async () => {
    const logger: LogPort = {
      info() {},
      warn() {},
      error() { throw new Error("logger transport failed"); },
    };
    const malformed = seedableRedis();
    malformed.seed(`fugue:tenant-a:hitl:decision:${runId}\x1f${nodeId}`, "{not json");
    const invalid = seedableRedis();
    invalid.seed(
      `fugue:tenant-a:hitl:decision:${runId}\x1f${nodeId}`,
      JSON.stringify({ kind: "reject" }),
    );

    const malformedResult = await createRedisDecisionStore(malformed.redis, TENANT, cfg, logger)
      .getDecision(runId, nodeId);
    const invalidResult = await createRedisDecisionStore(invalid.redis, TENANT, cfg, logger)
      .getDecision(runId, nodeId);

    expect(malformedResult.ok).toBe(false);
    expect(invalidResult.ok).toBe(false);
    if (!malformedResult.ok) expect(malformedResult.error.kind).toBe("internal-invariant-violated");
    if (!invalidResult.ok) expect(invalidResult.error.kind).toBe("internal-invariant-violated");
  });

  it("resolvePending returns not-pending before a park and after clear", async () => {
    const store = createRedisDecisionStore(fakeRedis(), TENANT, cfg);
    expect(await store.resolvePending(runId, nodeId, approve)).toEqual(ok({ kind: "not-pending" }));
    await store.preparePending(runId, nodeId);
    expect(await store.resolvePending(runId, nodeId, approve)).toEqual(ok({ kind: "accepted" }));
    await store.clear(runId, nodeId);
    expect(await store.resolvePending(runId, nodeId, approve)).toEqual(ok({ kind: "not-pending" }));
  });

  it("composite keys are injective — `:` in an id cannot alias a different gate", async () => {
    // With a `:` separator these two gates would collide (both → "...a:b:c");
    // the unit-separator key keeps them distinct.
    const store = createRedisDecisionStore(fakeRedis(), TENANT, cfg);
    const gateA = { runId: "a:b" as RunId, nodeId: "c" as NodeId };
    const gateB = { runId: "a" as RunId, nodeId: "b:c" as NodeId };
    await store.preparePending(gateA.runId, gateA.nodeId);
    await store.preparePending(gateB.runId, gateB.nodeId);
    await store.resolvePending(gateA.runId, gateA.nodeId, { kind: "approve" });
    await store.resolvePending(gateB.runId, gateB.nodeId, { kind: "reject", reason: "no" });

    const a = await store.getDecision(gateA.runId, gateA.nodeId);
    const b = await store.getDecision(gateB.runId, gateB.nodeId);
    expect(a.ok && a.value).toEqual({ kind: "approve" });
    expect(b.ok && b.value).toEqual({ kind: "reject", reason: "no" });
  });
});

// ── Cross-tenant isolation (SECURITY: AD-4 / FR-013 / SC-001) ────────────────
//
// Two stores bound to DIFFERENT tenants over ONE shared in-memory Redis fake.
// SC-001 ("zero bytes of another tenant's cache/checkpoint data") at the HITL
// layer: a store bound to tenant A can never read/write a run/checkpoint/
// decision/pending key written by a store bound to tenant B, even when both use
// the SAME runId/nodeId. The keyspace is the enforcement seam the per-tenant
// Redis ACL (`~fugue:<tenant>:*`) relies on.

/** A shared in-memory Redis exposing its key map so a test can prove no overlap. */
const sharedRedis = (): HitlRedisPort & { readonly _keys: ReadonlyMap<string, string> } => {
  const m = new Map<string, string>();
  return {
    _keys: m,
    async get(k) { return ok(m.get(k) ?? null); },
    async set(k, v) { m.set(k, v); return ok("OK"); },
    async del(k, ...additionalKeys) {
      return ok([k, ...additionalKeys].reduce((count, key) => count + (m.delete(key) ? 1 : 0), 0));
    },
    async scan() { return ok({ cursor: "0", keys: [...m.keys()] }); },
    async setNx(k, v) { if (m.has(k)) return ok(false); m.set(k, v); return ok(true); },
    async compareAndDelete(k, expected) { if (m.get(k) !== expected) return ok(false); m.delete(k); return ok(true); },
    async compareAndExpire(k, expected) { return ok(m.get(k) === expected); },
    async setIfValue(guard, expected, key, value) { if (m.get(guard) !== expected) return ok(false); m.set(key, value); return ok(true); },
    async setNxIfPresent(guard, key, value) { if (!m.has(guard)) return ok("not-present"); if (m.has(key)) return ok("exists"); m.set(key, value); return ok("created"); },
    async sAdd() { return ok(1); },
    async sRem() { return ok(1); },
    async sMembers() { return ok([]); },
  };
};

describe("HITL stores — cross-tenant isolation (SECURITY: AD-4 / FR-013 / SC-001)", () => {
  const cfg = { ttlSec: 3600 };

  it("two run stores over one Redis never collide and cannot read each other's run/checkpoint", async () => {
    const redis = sharedRedis();
    const a = createRedisRunStore(redis, TENANT, cfg);
    const b = createRedisRunStore(redis, OTHER_TENANT, cfg);

    // SAME runId in both tenants — only the tenant prefix keeps them disjoint.
    const recA = record({ checkpoint: '{"state":{"kind":"A"}}', input: { who: "a" } });
    const recB = record({ checkpoint: '{"state":{"kind":"B"}}', input: { who: "b" } });
    expect((await a.create(recA)).ok).toBe(true);
    // No collision: create-once is per-tenant, so B's create of the SAME runId
    // succeeds rather than colliding with A's run.
    expect((await b.create(recB)).ok).toBe(true);

    // Each store reads back ONLY its own tenant's record — never the other's.
    const gotA = await a.get(recA.runId);
    const gotB = await b.get(recB.runId);
    if (!gotA.ok || !gotA.value) throw new Error("expected A");
    if (!gotB.ok || !gotB.value) throw new Error("expected B");
    expect(gotA.value.checkpoint).toBe('{"state":{"kind":"A"}}');
    expect(gotA.value.input).toEqual({ who: "a" });
    expect(gotB.value.checkpoint).toBe('{"state":{"kind":"B"}}');
    expect(gotB.value.input).toEqual({ who: "b" });

    // A mutation in one tenant is invisible to the other.
    const leaseA = await acquireLease(redis, recA.runId, TENANT);
    await a.saveCheckpoint(leaseA, '{"state":{"kind":"A-edited"}}');
    const stillB = await b.get(recB.runId);
    expect(stillB.ok && stillB.value?.checkpoint).toBe('{"state":{"kind":"B"}}');

    // Every persisted key is under its OWN tenant prefix — no shared bytes.
    const keys = [...redis._keys.keys()];
    const aKeys = keys.filter((k) => k.startsWith("fugue:tenant-a:hitl:"));
    const bKeys = keys.filter((k) => k.startsWith("fugue:tenant-b:hitl:"));
    expect(aKeys.length).toBeGreaterThan(0);
    expect(bKeys.length).toBeGreaterThan(0);
    // No key escapes a tenant prefix, and the two sets are disjoint.
    expect(keys.every((k) => k.startsWith("fugue:tenant-a:hitl:") || k.startsWith("fugue:tenant-b:hitl:"))).toBe(true);
    expect(aKeys.some((k) => bKeys.includes(k))).toBe(false);
  });

  it("two decision stores over one Redis never collide on the same (runId, nodeId)", async () => {
    const redis = sharedRedis();
    const a = createRedisDecisionStore(redis, TENANT, cfg);
    const b = createRedisDecisionStore(redis, OTHER_TENANT, cfg);
    const runId = "run-1" as RunId;
    const nodeId = "review" as NodeId;

    // SAME gate id in both tenants. Pending state is per-tenant, so B's gate
    // cannot be deduplicated against A's matching ids.
    const aFirst = await a.preparePending(runId, nodeId);
    expect(aFirst.ok && aFirst.value.kind).toBe("notification-required");
    if (!aFirst.ok || aFirst.value.kind !== "notification-required") return;
    expect(await a.markNotified(runId, nodeId, aFirst.value.marker)).toEqual(ok(true));
    expect(await a.preparePending(runId, nodeId)).toEqual(ok({ kind: "notified" }));
    const bMark = await b.preparePending(runId, nodeId);
    expect(bMark.ok && bMark.value.kind).toBe("notification-required");

    await a.resolvePending(runId, nodeId, { kind: "approve" });
    await b.resolvePending(runId, nodeId, { kind: "reject", reason: "b-only" });

    // Each store reads ONLY its own tenant's decision.
    const gotA = await a.getDecision(runId, nodeId);
    const gotB = await b.getDecision(runId, nodeId);
    expect(gotA.ok && gotA.value).toEqual({ kind: "approve" });
    expect(gotB.ok && gotB.value).toEqual({ kind: "reject", reason: "b-only" });

    // Snapshot the keyspace while BOTH tenants have keys: disjoint and each fully
    // under its own tenant prefix — no shared bytes (SC-001).
    const before = [...redis._keys.keys()];
    expect(before.every((k) => k.startsWith("fugue:tenant-a:hitl:") || k.startsWith("fugue:tenant-b:hitl:"))).toBe(true);
    expect(before.some((k) => k.startsWith("fugue:tenant-a:hitl:"))).toBe(true);
    expect(before.some((k) => k.startsWith("fugue:tenant-b:hitl:"))).toBe(true);

    // Clearing one tenant's gate leaves the other's pending marker + decision intact.
    await a.clear(runId, nodeId);
    const aGone = await a.getDecision(runId, nodeId);
    const bStill = await b.getDecision(runId, nodeId);
    const bStillPending = await b.preparePending(runId, nodeId);
    expect(aGone.ok && aGone.value).toBe(null);
    expect(bStill.ok && bStill.value).toEqual({ kind: "reject", reason: "b-only" });
    expect(bStillPending.ok && bStillPending.value.kind).toBe("notification-required");

    // A's clear deleted ONLY A's keys; every surviving key is tenant B's.
    const after = [...redis._keys.keys()];
    expect(after.some((k) => k.startsWith("fugue:tenant-a:hitl:"))).toBe(false);
    expect(after.every((k) => k.startsWith("fugue:tenant-b:hitl:"))).toBe(true);
    expect(after.length).toBeGreaterThan(0);
  });
});

// ── Active-run index + countActiveRuns (ADR-0074) ────────────────────────────
//
// A SET-backed RedisPort fake (the suite's other fakes stub set ops) so the real
// `createRedisRunStore` exercises SADD-on-create / SREM-on-terminal / the
// self-healing `sMembers`-based count — proving `maxQueuedRuns` can be enforced
// without `scan` (denied by the per-tenant ACL, ADR-0067).
const setBackedRedis = () => {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const redis: HitlRedisPort = {
    async get(k) { return ok(kv.get(k) ?? null); },
    async set(k, v) { kv.set(k, v); return ok("OK"); },
    async del(k, ...additionalKeys) {
      return ok([k, ...additionalKeys].reduce((count, key) => count + (kv.delete(key) ? 1 : 0), 0));
    },
    async scan() { return ok({ cursor: "0", keys: [...kv.keys()] }); },
    async setNx(k, v) { if (kv.has(k)) return ok(false); kv.set(k, v); return ok(true); },
    async compareAndDelete(k, expected) { if (kv.get(k) !== expected) return ok(false); kv.delete(k); return ok(true); },
    async compareAndExpire(k, expected) { return ok(kv.get(k) === expected); },
    async setIfValue(guard, expected, key, value) { if (kv.get(guard) !== expected) return ok(false); kv.set(key, value); return ok(true); },
    async setNxIfPresent(guard, key, value) { if (!kv.has(guard)) return ok("not-present"); if (kv.has(key)) return ok("exists"); kv.set(key, value); return ok("created"); },
    async sAdd(k, m) { const s = sets.get(k) ?? new Set<string>(); const had = s.has(m); s.add(m); sets.set(k, s); return ok(had ? 0 : 1); },
    async sRem(k, m) { const s = sets.get(k); if (!s || !s.has(m)) return ok(0); s.delete(m); if (s.size === 0) sets.delete(k); return ok(1); },
    async sMembers(k) { return ok([...(sets.get(k) ?? [])]); },
  };
  // `expireRunKey` simulates a TTL-expired / hard-deleted run record while leaving
  // a stale entry in the active SET — the leak the self-heal must prune.
  return {
    redis,
    kv,
    sets,
    expireRunKey: (tenant: string, runId: string) => kv.delete(`fugue:${tenant}:hitl:run:${runId}`),
    expireCheckpointKey: (tenant: string, runId: string) => kv.delete(`fugue:${tenant}:hitl:ckpt:${runId}`),
  };
};

describe("RedisRunStore — active-run index (ADR-0074)", () => {
  const cfg = { ttlSec: 3600 };

  it("publishes metadata last: checkpoint failure leaves no visible run or index intent", async () => {
    const base = setBackedRedis();
    const redis: HitlRedisPort = {
      ...base.redis,
      async setNx(key, value, opts) {
        if (key.includes(":hitl:ckpt:")) return err({ kind: "redis-unavailable", operation: "checkpoint" });
        return base.redis.setNx(key, value, opts);
      },
    };
    const store = createRedisRunStore(redis, TENANT, cfg);

    expect((await store.create(record())).ok).toBe(false);
    expect(base.kv.has("fugue:tenant-a:hitl:run:run-1")).toBe(false);
    expect(base.sets.get("fugue:tenant-a:hitl:active")?.has("run-1") ?? false).toBe(false);
  });

  it("compensates an index failure by removing the prepared checkpoint", async () => {
    const base = setBackedRedis();
    const redis: HitlRedisPort = {
      ...base.redis,
      async sAdd() { return err({ kind: "redis-unavailable", operation: "active index" }); },
    };
    const store = createRedisRunStore(redis, TENANT, cfg);

    expect((await store.create(record())).ok).toBe(false);
    expect(base.kv.has("fugue:tenant-a:hitl:ckpt:run-1")).toBe(false);
    expect(base.kv.has("fugue:tenant-a:hitl:run:run-1")).toBe(false);
  });

  it("a throwing compensation logger cannot replace the original create failure", async () => {
    const base = setBackedRedis();
    const original: HostError = { kind: "redis-unavailable", operation: "active index" };
    const redis: HitlRedisPort = {
      ...base.redis,
      async sAdd() { return err(original); },
      async sRem() { return err({ kind: "redis-unavailable", operation: "compensate index" }); },
      async compareAndDelete() { return err({ kind: "redis-unavailable", operation: "compensate checkpoint" }); },
    };
    const logger: LogPort = {
      info() {},
      warn() { throw new Error("logger transport failed"); },
      error() {},
    };
    const store = createRedisRunStore(redis, TENANT, cfg, logger);

    const result = await store.create(record());

    expect(result).toEqual(err(original));
  });

  it("a concurrent active-index sweep cannot prune an in-flight metadata publication", async () => {
    const base = setBackedRedis();
    let store!: ReturnType<typeof createRedisRunStore>;
    let observedDuringPublication: readonly RunId[] | undefined;
    const redis: HitlRedisPort = {
      ...base.redis,
      async sAdd(key, member) {
        const added = await base.redis.sAdd(key, member);
        const during = await store.listActiveRunIds();
        if (!during.ok) throw new Error("unexpected active-index read failure");
        observedDuringPublication = during.value;
        return added;
      },
    };
    store = createRedisRunStore(redis, TENANT, cfg);

    expect((await store.create(record())).ok).toBe(true);
    expect(observedDuringPublication).toEqual([]); // unpublished is not runnable
    expect(await store.listActiveRunIds()).toEqual(ok(["run-1" as RunId]));
  });

  it("compensates an ambiguously committed metadata publication after write-then-error", async () => {
    const base = setBackedRedis();
    const redis: HitlRedisPort = {
      ...base.redis,
      async setNx(key, value, opts) {
        if (!key.includes(":hitl:run:")) return base.redis.setNx(key, value, opts);
        const committed = await base.redis.setNx(key, value, opts);
        if (!committed.ok || !committed.value) return committed;
        return err({ kind: "redis-unavailable", operation: "metadata response lost" });
      },
    };
    const store = createRedisRunStore(redis, TENANT, cfg);

    expect((await store.create(record())).ok).toBe(false);
    expect(base.kv.has("fugue:tenant-a:hitl:run:run-1")).toBe(false);
    expect(base.kv.has("fugue:tenant-a:hitl:ckpt:run-1")).toBe(false);
    expect(base.sets.get("fugue:tenant-a:hitl:active")?.has("run-1") ?? false).toBe(false);
  });

  it("acknowledges publication uncertainty when committed metadata cannot be removed", async () => {
    const base = setBackedRedis();
    const redis: HitlRedisPort = {
      ...base.redis,
      async setNx(key, value, opts) {
        if (!key.includes(":hitl:run:")) return base.redis.setNx(key, value, opts);
        const committed = await base.redis.setNx(key, value, opts);
        if (!committed.ok || !committed.value) return committed;
        return err({ kind: "redis-unavailable", operation: "metadata response lost" });
      },
      async sRem() { return err({ kind: "redis-unavailable", operation: "compensate index" }); },
      async compareAndDelete() {
        return err({ kind: "redis-unavailable", operation: "compensation unavailable" });
      },
    };
    const store = createRedisRunStore(redis, TENANT, cfg);

    const created = await store.create(record());

    expect(created).toEqual(ok({ kind: "publication-uncertain" }));
    expect((await store.get("run-1" as RunId)).ok).toBe(true);
    expect(await store.listActiveRunIds()).toEqual(ok(["run-1" as RunId]));
  });

  it("keeps an accepted run discoverable when metadata never committed and compensation is unavailable", async () => {
    const base = setBackedRedis();
    const redis: HitlRedisPort = {
      ...base.redis,
      async setNx(key, value, opts) {
        if (key.includes(":hitl:run:")) {
          return err({ kind: "redis-unavailable", operation: "metadata publish before commit" });
        }
        return base.redis.setNx(key, value, opts);
      },
      async compareAndDelete(key, expected) {
        if (key.includes(":hitl:run:")) {
          return err({ kind: "redis-unavailable", operation: "metadata compensation" });
        }
        return base.redis.compareAndDelete(key, expected);
      },
    };
    const store = createRedisRunStore(redis, TENANT, cfg);
    const expected = record();

    const created = await store.create(expected);

    expect(created).toEqual(ok({ kind: "publication-uncertain" }));
    expect(base.kv.has("fugue:tenant-a:hitl:run:run-1")).toBe(false);
    expect(await store.get(expected.runId)).toEqual(ok(expected));
    expect(await store.getMetadata(expected.runId)).toEqual(ok({
      runId: expected.runId,
      dagId: expected.dagId,
      ownerTeam: expected.ownerTeam,
      input: expected.input,
      identity: expected.identity,
      status: expected.status,
      createdAtMs: expected.createdAtMs,
      updatedAtMs: expected.updatedAtMs,
    }));
    expect(await store.listActiveRunIds()).toEqual(ok([expected.runId]));
  });

  it("compensates metadata publication failure without consuming a quota slot", async () => {
    const base = setBackedRedis();
    const redis: HitlRedisPort = {
      ...base.redis,
      async setNx(key, value, opts) {
        if (key.includes(":hitl:run:")) return err({ kind: "redis-unavailable", operation: "metadata publish" });
        return base.redis.setNx(key, value, opts);
      },
    };
    const store = createRedisRunStore(redis, TENANT, cfg);

    expect((await store.create(record())).ok).toBe(false);
    expect(base.kv.has("fugue:tenant-a:hitl:ckpt:run-1")).toBe(false);
    expect(base.kv.has("fugue:tenant-a:hitl:run:run-1")).toBe(false);
    expect((await store.listActiveRunIds())).toEqual(ok([]));
    expect(base.sets.get("fugue:tenant-a:hitl:active")?.has("run-1") ?? false).toBe(false);
  });

  it("create joins the active index; countActiveRuns reflects it", async () => {
    const { redis } = setBackedRedis();
    const store = createRedisRunStore(redis, TENANT, cfg);
    const c0 = await store.countActiveRuns();
    expect(c0.ok && c0.value).toBe(0);
    await store.create(record({ runId: "r1" as RunId }));
    await store.create(record({ runId: "r2" as RunId }));
    const c = await store.countActiveRuns();
    expect(c.ok && c.value).toBe(2);
    expect(await store.listActiveRunIds()).toEqual(ok(["r1" as RunId, "r2" as RunId]));
  });

  it("a terminal status (completed/failed) leaves the index; a non-terminal status does not", async () => {
    const { redis } = setBackedRedis();
    const store = createRedisRunStore(redis, TENANT, cfg);
    await store.create(record({ runId: "r1" as RunId }));
    await store.create(record({ runId: "r2" as RunId }));
    await store.create(record({ runId: "r3" as RunId }));
    const l1 = await acquireLease(redis, "r1" as RunId);
    const l2 = await acquireLease(redis, "r2" as RunId);
    const l3 = await acquireLease(redis, "r3" as RunId);
    await store.setStatus(l1, { kind: "running" });
    await store.setStatus(l2, { kind: "running" });
    await store.setStatus(l3, { kind: "running" });

    // suspended is NON-terminal — still occupies a slot.
    await store.setStatus(l1, { kind: "suspended", nodeId: "g" as NodeId, prompt: nonEmptyString("p") });
    const cSusp = await store.countActiveRuns();
    expect(cSusp.ok && cSusp.value).toBe(3);

    await store.setStatus(l2, { kind: "completed", output: 1 });
    await store.setStatus(l3, { kind: "failed", error: { kind: "node-crash", retriability: "retriable", nodeId: "n" as NodeId, message: "x" } });
    const c = await store.countActiveRuns();
    expect(c.ok && c.value).toBe(1); // only the suspended r1 remains
  });

  it("an unparseable run-meta (corrupt JSON) is counted live with exactly one bounded warn (round-20 fix pin)", async () => {
    const { redis, kv } = setBackedRedis();
    const warns: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const logger: LogPort = {
      info() {},
      warn(msg, fields) {
        warns.push({ msg, fields: fields ?? {} });
      },
      error() {},
    };
    const store = createRedisRunStore(redis, TENANT, cfg, logger);
    await store.create(record({ runId: "r1" as RunId }));
    await store.create(record({ runId: "r2" as RunId }));
    // Corrupt r1's meta bytes directly (torn write / out-of-band mutation).
    kv.set("fugue:tenant-a:hitl:run:r1", "not-json{{{");

    const c = await store.countActiveRuns();
    // The corrupt entry is treated as LIVE — a conservative over-count,
    // never an under-count that would free a slot on unreadable evidence.
    expect(c.ok && c.value).toBe(2);
    // Exactly one bounded warn naming the corrupt key + parse error.
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toContain("unparseable run meta treated as live");
    expect(warns[0]?.fields.runId).toBe("r1");
    // The corrupt key is NOT pruned — the corruption keeps a trail.
    expect(kv.has("fugue:tenant-a:hitl:run:r1")).toBe(true);
  });

  it("enumerates a valid run id whose published metadata is corrupt", async () => {
    const { redis, kv } = setBackedRedis();
    const store = createRedisRunStore(redis, TENANT, cfg);
    await store.create(record({ runId: "r1" as RunId }));
    await store.create(record({ runId: "r2" as RunId }));
    kv.set("fugue:tenant-a:hitl:run:r1", "not-json{{{");

    const active = await store.listActiveRunIds();

    expect(active).toEqual(ok(["r1" as RunId, "r2" as RunId]));
  });

  it("re-settling a terminal run is idempotent — the count never goes negative or drifts", async () => {
    const { redis } = setBackedRedis();
    const store = createRedisRunStore(redis, TENANT, cfg);
    await store.create(record({ runId: "r1" as RunId }));
    const lease = await acquireLease(redis, "r1" as RunId);
    await store.setStatus(lease, { kind: "running" });
    await store.setStatus(lease, { kind: "completed", output: 1 });
    await store.setStatus(lease, { kind: "completed", output: 1 }); // duplicate settle
    const c = await store.countActiveRuns();
    expect(c.ok && c.value).toBe(0);
  });

  it("rejects terminal resurrection and cross-terminal rewrites without index drift", async () => {
    const { redis } = setBackedRedis();
    const store = createRedisRunStore(redis, TENANT, cfg);
    await store.create(record({ runId: "r1" as RunId }));
    const lease = await acquireLease(redis, "r1" as RunId);
    await store.setStatus(lease, { kind: "running" });
    await store.setStatus(lease, { kind: "completed", output: 1 });

    const resurrected = await store.setStatus(lease, { kind: "running" });
    const rewritten = await store.setStatus(lease, {
      kind: "failed",
      error: { kind: "aborted", reason: "rewrite" },
    });

    expect(resurrected.ok).toBe(false);
    expect(rewritten.ok).toBe(false);
    const metadata = await store.getMetadata("r1" as RunId);
    expect(metadata.ok && metadata.value?.status).toEqual({ kind: "completed", output: 1 });
    expect(await store.countActiveRuns()).toEqual(ok(0));
  });

  it("self-heals a leaked index member whose run record expired (TTL) — pruned and excluded", async () => {
    const { redis, expireRunKey, expireCheckpointKey, sets } = setBackedRedis();
    const store = createRedisRunStore(redis, TENANT, cfg);
    await store.create(record({ runId: "r1" as RunId }));
    await store.create(record({ runId: "r2" as RunId }));
    // r1's run record TTLs out but its id is still in the active SET (the leak).
    expireRunKey("tenant-a", "r1");
    expireCheckpointKey("tenant-a", "r1");
    const c = await store.countActiveRuns();
    expect(c.ok && c.value).toBe(1); // only r2 is backed by a live record
    // The stale member was pruned from the SET (not merely skipped).
    expect([...(sets.get("fugue:tenant-a:hitl:active") ?? [])]).toEqual(["r2"]);
  });

  it("self-heals a TERMINAL-but-indexed member whose settle-time sRem failed — pruned and excluded", async () => {
    // CONTRAST with the meta-absent case above: here the run is settled (terminal)
    // and its run-meta key is still PRESENT (status completed). The settle-time
    // `sRem` failed (a transient Redis blip after the terminal meta write), so r1
    // remains in the active SET. The missing-meta prune cannot catch this (the meta
    // key exists), so without pruning on the persisted terminal status r1 would leak
    // a `maxQueuedRuns` slot for up to the run TTL.
    const { redis, sets } = setBackedRedis();
    const store = createRedisRunStore(redis, TENANT, cfg);
    await store.create(record({ runId: "r1" as RunId }));
    await store.create(record({ runId: "r2" as RunId }));
    const lease = await acquireLease(redis, "r1" as RunId);

    // Settle r1: writes the terminal meta AND issues the `sRem` (which lands here).
    await store.setStatus(lease, { kind: "running" });
    await store.setStatus(lease, { kind: "completed", output: 1 });
    // Model the leak: the settle-time `sRem` having NO-OPped — re-add r1 to the
    // active SET while its terminal meta key is still PRESENT in `kv`.
    await redis.sAdd("fugue:tenant-a:hitl:active", "r1");
    // Precondition: the leaked terminal member is in the SET.
    expect([...(sets.get("fugue:tenant-a:hitl:active") ?? [])].sort()).toEqual(["r1", "r2"]);

    const c = await store.countActiveRuns();
    expect(c.ok && c.value).toBe(1); // r1 is terminal → excluded; only r2 is live
    // The terminal member was pruned from the SET (not merely skipped).
    expect([...(sets.get("fugue:tenant-a:hitl:active") ?? [])]).toEqual(["r2"]);
  });

  it("the active index is tenant-scoped — one tenant's count never sees another's runs (SC-001)", async () => {
    const { redis } = setBackedRedis();
    const a = createRedisRunStore(redis, TENANT, cfg);
    const b = createRedisRunStore(redis, OTHER_TENANT, cfg);
    await a.create(record({ runId: "r1" as RunId }));
    await b.create(record({ runId: "r2" as RunId }));
    await b.create(record({ runId: "r3" as RunId }));
    const ca = await a.countActiveRuns();
    const cb = await b.countActiveRuns();
    expect(ca.ok && ca.value).toBe(1);
    expect(cb.ok && cb.value).toBe(2);
  });
});
