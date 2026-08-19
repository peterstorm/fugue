// redis-stores.test.ts — RunStore + DecisionStore Redis adapters (ADR-0060),
// driven by an in-memory RedisPort fake (no Redis).

import { describe, it, expect } from "bun:test";
import { ok, err } from "@fuguejs/framework";
import type { Result, RunId, NodeId, DagId, HumanAction } from "@fuguejs/framework";
import type { RedisPort, LogPort } from "../../../ports.js";
import type { HostError } from "../../../domain/host-error.js";
import { tenantId } from "../../../domain/tenant.js";
import type { TenantId } from "../../../domain/tenant.js";
import type { RunRecord } from "../../types.js";
import { createRedisRunStore } from "../run-store.js";
import { createRedisDecisionStore } from "../decision-store.js";

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
type RecordingRedis = RedisPort & {
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
    async del(k): Promise<Result<number, HostError>> { const had = m.delete(k); return ok(had ? 1 : 0); },
    async scan(): Promise<Result<{ cursor: string; keys: string[] }, HostError>> { return ok({ cursor: "0", keys: [...m.keys()] }); },
    async setNx(k, v, opts): Promise<Result<boolean, HostError>> { setNxOpts.set(k, opts); if (m.has(k)) return ok(false); m.set(k, v); return ok(true); },
    async sAdd(): Promise<Result<number, HostError>> { return ok(1); },
    async sRem(): Promise<Result<number, HostError>> { return ok(1); },
    async sMembers(): Promise<Result<string[], HostError>> { return ok([]); },
  };
};

// A seedable RedisPort fake for the torn/corrupt-state branches: `seed` writes a
// raw value at an exact key, bypassing the adapter's own serialization.
const seedableRedis = (): { redis: RedisPort; seed: (k: string, v: string) => void } => {
  const m = new Map<string, string>();
  const redis: RedisPort = {
    async get(k) { return ok(m.get(k) ?? null); },
    async set(k, v) { m.set(k, v); return ok("OK"); },
    async del(k) { const had = m.delete(k); return ok(had ? 1 : 0); },
    async scan() { return ok({ cursor: "0", keys: [...m.keys()] }); },
    async setNx(k, v) { if (m.has(k)) return ok(false); m.set(k, v); return ok(true); },
    async sAdd() { return ok(1); },
    async sRem() { return ok(1); },
    async sMembers() { return ok([]); },
  };
  return { redis, seed: (k, v) => m.set(k, v) };
};

const record = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  runId: "run-1" as RunId,
  dagId: "dag-1" as DagId,
  input: { x: 1 },
  identity: { kind: "admin" },
  status: { kind: "queued" },
  checkpoint: '{"state":{"kind":"pending"}}',
  createdAtMs: 100,
  updatedAtMs: 100,
  ...overrides,
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
    // The checkpoint key is bounded too.
    expect(redis.setOpts.get("fugue:tenant-a:hitl:ckpt:run-1")).toEqual({ expiresInSec: 4242 });
  });

  it("saveCheckpoint and setStatus re-apply the TTL (sliding expiry, never a TTL-less write)", async () => {
    const redis = fakeRedis();
    const store = createRedisRunStore(redis, TENANT, { ttlSec: 7 });
    const r = record();
    await store.create(r);

    await store.saveCheckpoint(r.runId, '{"state":{"kind":"suspended"}}');
    expect(redis.setOpts.get("fugue:tenant-a:hitl:ckpt:run-1")).toEqual({ expiresInSec: 7 });

    await store.setStatus(r.runId, { kind: "completed", output: 1 });
    expect(redis.setOpts.get("fugue:tenant-a:hitl:run:run-1")).toEqual({ expiresInSec: 7 });
  });

  it("create is single-shot (duplicate run id errs)", async () => {
    const redis = fakeRedis();
    const store = createRedisRunStore(redis, TENANT, cfg);
    await store.create(record());
    const dup = await store.create(record());
    expect(dup.ok).toBe(false);
  });

  it("get returns null for an unknown run", async () => {
    const store = createRedisRunStore(fakeRedis(), TENANT, cfg);
    const got = await store.get("nope" as RunId);
    expect(got.ok && got.value).toBe(null);
  });

  it("saveCheckpoint updates only the checkpoint; setStatus only the status", async () => {
    const store = createRedisRunStore(fakeRedis(), TENANT, cfg);
    const r = record();
    await store.create(r);

    await store.saveCheckpoint(r.runId, '{"state":{"kind":"suspended"}}');
    await store.setStatus(r.runId, { kind: "suspended", nodeId: "review" as NodeId, prompt: "ok?" });

    const got = await store.get(r.runId);
    if (!got.ok || !got.value) throw new Error("expected record");
    expect(got.value.checkpoint).toBe('{"state":{"kind":"suspended"}}');
    expect(got.value.status.kind).toBe("suspended");
    // Unchanged fields survive.
    expect(got.value.dagId).toBe("dag-1" as DagId);
  });

  it("setStatus bumps updatedAtMs from the injected clock; createdAtMs is preserved", async () => {
    let t = 500;
    const store = createRedisRunStore(fakeRedis(), TENANT, { ...cfg, now: () => t });
    const r = record(); // createdAtMs/updatedAtMs = 100
    await store.create(r);
    t = 999;
    await store.setStatus(r.runId, { kind: "completed", output: 1 });
    const got = await store.get(r.runId);
    if (!got.ok || !got.value) throw new Error("expected record");
    expect(got.value.updatedAtMs).toBe(999);
    expect(got.value.createdAtMs).toBe(100);
  });

  it("setStatus on an unknown run errs run-not-found", async () => {
    const store = createRedisRunStore(fakeRedis(), TENANT, cfg);
    const res = await store.setStatus("ghost" as RunId, { kind: "completed", output: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("run-not-found");
  });

  it("propagates a Redis failure on get", async () => {
    const broken: RedisPort = { ...fakeRedis(), async get() { return err({ kind: "redis-unavailable", operation: "GET" }); } };
    const store = createRedisRunStore(broken, TENANT, cfg);
    const res = await store.get("run-1" as RunId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("redis-unavailable");
  });

  it("errs internal-invariant-violated on a torn record (metadata but no checkpoint)", async () => {
    const { redis, seed } = seedableRedis();
    // Seed only the meta key (e.g. the checkpoint key TTL-expired first).
    seed("fugue:tenant-a:hitl:run:run-1", JSON.stringify({ runId: "run-1", dagId: "d", input: {}, identity: { kind: "admin" }, status: { kind: "queued" }, createdAtMs: 1, updatedAtMs: 1 }));
    const store = createRedisRunStore(redis, TENANT, cfg);
    const res = await store.get("run-1" as RunId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("internal-invariant-violated");
  });

  it("errs internal-invariant-violated on corrupt (non-JSON) metadata", async () => {
    const { redis, seed } = seedableRedis();
    seed("fugue:tenant-a:hitl:run:run-1", "{not json");
    const store = createRedisRunStore(redis, TENANT, cfg);
    const res = await store.get("run-1" as RunId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("internal-invariant-violated");
  });

  it("errs internal-invariant-violated on structurally-invalid metadata (valid JSON, bad shape)", async () => {
    const { redis, seed } = seedableRedis();
    // Parses as JSON but the status discriminant is unknown — must be rejected
    // (parse-don't-validate) rather than flowing in to drive an exhaustive match.
    seed("fugue:tenant-a:hitl:run:run-1", JSON.stringify({
      runId: "run-1", dagId: "d", input: {}, identity: { kind: "admin" },
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

  it("markPending returns true once, false thereafter (dedups notifications)", async () => {
    const store = createRedisDecisionStore(fakeRedis(), TENANT, cfg);
    const first = await store.markPending(runId, nodeId);
    const second = await store.markPending(runId, nodeId);
    expect(first.ok && first.value).toBe(true);
    expect(second.ok && second.value).toBe(false);
  });

  it("markPending applies the configured TTL to the pending marker (SET NX EX)", async () => {
    const redis = fakeRedis();
    const store = createRedisDecisionStore(redis, TENANT, { ttlSec: 9001 });
    await store.markPending(runId, nodeId);
    // Pending marker can never exist without an expiry (crash-safe).
    expect(redis.setNxOpts.get(`fugue:tenant-a:hitl:pending:${runId}\x1f${nodeId}`)).toEqual({ expiresInSec: 9001 });
  });

  it("putDecision applies the configured TTL to the decision key", async () => {
    const redis = fakeRedis();
    const store = createRedisDecisionStore(redis, TENANT, { ttlSec: 1234 });
    await store.putDecision(runId, nodeId, approve);
    expect(redis.setOpts.get(`fugue:tenant-a:hitl:decision:${runId}\x1f${nodeId}`)).toEqual({ expiresInSec: 1234 });
  });

  it("putDecision then getDecision round-trips the action", async () => {
    const store = createRedisDecisionStore(fakeRedis(), TENANT, cfg);
    await store.putDecision(runId, nodeId, approve);
    const got = await store.getDecision(runId, nodeId);
    expect(got.ok && got.value).toEqual(approve);
  });

  it("getDecision returns null when none recorded", async () => {
    const store = createRedisDecisionStore(fakeRedis(), TENANT, cfg);
    const got = await store.getDecision(runId, nodeId);
    expect(got.ok && got.value).toBe(null);
  });

  it("clear removes pending marker and decision", async () => {
    const store = createRedisDecisionStore(fakeRedis(), TENANT, cfg);
    await store.markPending(runId, nodeId);
    await store.putDecision(runId, nodeId, approve);
    await store.clear(runId, nodeId);

    const got = await store.getDecision(runId, nodeId);
    expect(got.ok && got.value).toBe(null);
    // markPending fresh again after clear.
    const remark = await store.markPending(runId, nodeId);
    expect(remark.ok && remark.value).toBe(true);
  });

  it("round-trips a reroute action with fields", async () => {
    const store = createRedisDecisionStore(fakeRedis(), TENANT, cfg);
    const reroute: HumanAction = { kind: "reroute", targetNodeId: "draft" as NodeId, reason: "redo" };
    await store.putDecision(runId, nodeId, reroute);
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

  it("isPending reflects the marker: true while parked, false before/after clear", async () => {
    const store = createRedisDecisionStore(fakeRedis(), TENANT, cfg);
    const isPending = async (): Promise<boolean> => {
      const r = await store.isPending(runId, nodeId);
      if (!r.ok) throw new Error("isPending errored");
      return r.value;
    };
    expect(await isPending()).toBe(false);
    await store.markPending(runId, nodeId);
    expect(await isPending()).toBe(true);
    await store.clear(runId, nodeId);
    expect(await isPending()).toBe(false);
  });

  it("composite keys are injective — `:` in an id cannot alias a different gate", async () => {
    // With a `:` separator these two gates would collide (both → "...a:b:c");
    // the unit-separator key keeps them distinct.
    const store = createRedisDecisionStore(fakeRedis(), TENANT, cfg);
    const gateA = { runId: "a:b" as RunId, nodeId: "c" as NodeId };
    const gateB = { runId: "a" as RunId, nodeId: "b:c" as NodeId };
    await store.putDecision(gateA.runId, gateA.nodeId, { kind: "approve" });
    await store.putDecision(gateB.runId, gateB.nodeId, { kind: "reject", reason: "no" });

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
const sharedRedis = (): RedisPort & { readonly _keys: ReadonlyMap<string, string> } => {
  const m = new Map<string, string>();
  return {
    _keys: m,
    async get(k) { return ok(m.get(k) ?? null); },
    async set(k, v) { m.set(k, v); return ok("OK"); },
    async del(k) { const had = m.delete(k); return ok(had ? 1 : 0); },
    async scan() { return ok({ cursor: "0", keys: [...m.keys()] }); },
    async setNx(k, v) { if (m.has(k)) return ok(false); m.set(k, v); return ok(true); },
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
    await a.saveCheckpoint(recA.runId, '{"state":{"kind":"A-edited"}}');
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

    // SAME gate id in both tenants. markPending is per-tenant create-once, so
    // B's mark of the SAME gate is NOT deduped against A's.
    expect((await a.markPending(runId, nodeId)).ok).toBe(true);
    const aRemark = await a.markPending(runId, nodeId);
    expect(aRemark.ok && aRemark.value).toBe(false);
    const bMark = await b.markPending(runId, nodeId);
    expect(bMark.ok && bMark.value).toBe(true);

    await a.putDecision(runId, nodeId, { kind: "approve" });
    await b.putDecision(runId, nodeId, { kind: "reject", reason: "b-only" });

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
    const bPending = await b.isPending(runId, nodeId);
    expect(aGone.ok && aGone.value).toBe(null);
    expect(bStill.ok && bStill.value).toEqual({ kind: "reject", reason: "b-only" });
    expect(bPending.ok && bPending.value).toBe(true);

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
  const redis: RedisPort = {
    async get(k) { return ok(kv.get(k) ?? null); },
    async set(k, v) { kv.set(k, v); return ok("OK"); },
    async del(k) { const had = kv.delete(k); return ok(had ? 1 : 0); },
    async scan() { return ok({ cursor: "0", keys: [...kv.keys()] }); },
    async setNx(k, v) { if (kv.has(k)) return ok(false); kv.set(k, v); return ok(true); },
    async sAdd(k, m) { const s = sets.get(k) ?? new Set<string>(); const had = s.has(m); s.add(m); sets.set(k, s); return ok(had ? 0 : 1); },
    async sRem(k, m) { const s = sets.get(k); if (!s || !s.has(m)) return ok(0); s.delete(m); if (s.size === 0) sets.delete(k); return ok(1); },
    async sMembers(k) { return ok([...(sets.get(k) ?? [])]); },
  };
  // `expireRunKey` simulates a TTL-expired / hard-deleted run record while leaving
  // a stale entry in the active SET — the leak the self-heal must prune.
  return { redis, kv, sets, expireRunKey: (tenant: string, runId: string) => kv.delete(`fugue:${tenant}:hitl:run:${runId}`) };
};

describe("RedisRunStore — active-run index (ADR-0074)", () => {
  const cfg = { ttlSec: 3600 };

  it("create joins the active index; countActiveRuns reflects it", async () => {
    const { redis } = setBackedRedis();
    const store = createRedisRunStore(redis, TENANT, cfg);
    const c0 = await store.countActiveRuns();
    expect(c0.ok && c0.value).toBe(0);
    await store.create(record({ runId: "r1" as RunId }));
    await store.create(record({ runId: "r2" as RunId }));
    const c = await store.countActiveRuns();
    expect(c.ok && c.value).toBe(2);
  });

  it("a terminal status (completed/failed) leaves the index; a non-terminal status does not", async () => {
    const { redis } = setBackedRedis();
    const store = createRedisRunStore(redis, TENANT, cfg);
    await store.create(record({ runId: "r1" as RunId }));
    await store.create(record({ runId: "r2" as RunId }));
    await store.create(record({ runId: "r3" as RunId }));

    // suspended is NON-terminal — still occupies a slot.
    await store.setStatus("r1" as RunId, { kind: "suspended", nodeId: "g" as NodeId, prompt: "p" });
    const cSusp = await store.countActiveRuns();
    expect(cSusp.ok && cSusp.value).toBe(3);

    await store.setStatus("r2" as RunId, { kind: "completed", output: 1 });
    await store.setStatus("r3" as RunId, { kind: "failed", error: { kind: "node-crash", retriability: "retriable", nodeId: "n" as NodeId, message: "x" } });
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

  it("re-settling a terminal run is idempotent — the count never goes negative or drifts", async () => {
    const { redis } = setBackedRedis();
    const store = createRedisRunStore(redis, TENANT, cfg);
    await store.create(record({ runId: "r1" as RunId }));
    await store.setStatus("r1" as RunId, { kind: "completed", output: 1 });
    await store.setStatus("r1" as RunId, { kind: "completed", output: 1 }); // duplicate settle
    const c = await store.countActiveRuns();
    expect(c.ok && c.value).toBe(0);
  });

  it("self-heals a leaked index member whose run record expired (TTL) — pruned and excluded", async () => {
    const { redis, expireRunKey, sets } = setBackedRedis();
    const store = createRedisRunStore(redis, TENANT, cfg);
    await store.create(record({ runId: "r1" as RunId }));
    await store.create(record({ runId: "r2" as RunId }));
    // r1's run record TTLs out but its id is still in the active SET (the leak).
    expireRunKey("tenant-a", "r1");
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

    // Settle r1: writes the terminal meta AND issues the `sRem` (which lands here).
    await store.setStatus("r1" as RunId, { kind: "completed", output: 1 });
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
