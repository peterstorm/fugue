// redis-stores.test.ts — RunStore + DecisionStore Redis adapters (ADR-0060),
// driven by an in-memory RedisPort fake (no Redis).

import { describe, it, expect } from "bun:test";
import { ok, err } from "@fuguejs/framework";
import type { Result, RunId, NodeId, DagId, HumanAction } from "@fuguejs/framework";
import type { RedisPort } from "../../../ports.js";
import type { HostError } from "../../../domain/host-error.js";
import type { RunRecord } from "../../types.js";
import { createRedisRunStore } from "../run-store.js";
import { createRedisDecisionStore } from "../decision-store.js";

// A minimal in-memory RedisPort honoring get/set/del/setNx (TTL ignored).
const fakeRedis = (): RedisPort => {
  const m = new Map<string, string>();
  return {
    async get(k): Promise<Result<string | null, HostError>> { return ok(m.get(k) ?? null); },
    async set(k, v): Promise<Result<string | null, HostError>> { m.set(k, v); return ok("OK"); },
    async del(k): Promise<Result<number, HostError>> { const had = m.delete(k); return ok(had ? 1 : 0); },
    async scan(): Promise<Result<{ cursor: string; keys: string[] }, HostError>> { return ok({ cursor: "0", keys: [...m.keys()] }); },
    async setNx(k, v): Promise<Result<boolean, HostError>> { if (m.has(k)) return ok(false); m.set(k, v); return ok(true); },
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
    const store = createRedisRunStore(fakeRedis(), cfg);
    const r = record();
    expect((await store.create(r)).ok).toBe(true);

    const got = await store.get(r.runId);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toEqual(r);
  });

  it("create is single-shot (duplicate run id errs)", async () => {
    const redis = fakeRedis();
    const store = createRedisRunStore(redis, cfg);
    await store.create(record());
    const dup = await store.create(record());
    expect(dup.ok).toBe(false);
  });

  it("get returns null for an unknown run", async () => {
    const store = createRedisRunStore(fakeRedis(), cfg);
    const got = await store.get("nope" as RunId);
    expect(got.ok && got.value).toBe(null);
  });

  it("saveCheckpoint updates only the checkpoint; setStatus only the status", async () => {
    const store = createRedisRunStore(fakeRedis(), cfg);
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
    const store = createRedisRunStore(fakeRedis(), { ...cfg, now: () => t });
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
    const store = createRedisRunStore(fakeRedis(), cfg);
    const res = await store.setStatus("ghost" as RunId, { kind: "completed", output: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("run-not-found");
  });

  it("propagates a Redis failure on get", async () => {
    const broken: RedisPort = { ...fakeRedis(), async get() { return err({ kind: "redis-unavailable", operation: "GET" }); } };
    const store = createRedisRunStore(broken, cfg);
    const res = await store.get("run-1" as RunId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("redis-unavailable");
  });

  it("errs internal-invariant-violated on a torn record (metadata but no checkpoint)", async () => {
    const { redis, seed } = seedableRedis();
    // Seed only the meta key (e.g. the checkpoint key TTL-expired first).
    seed("fugue:hitl:run:run-1", JSON.stringify({ runId: "run-1", dagId: "d", input: {}, identity: { kind: "admin" }, status: { kind: "queued" }, createdAtMs: 1, updatedAtMs: 1 }));
    const store = createRedisRunStore(redis, cfg);
    const res = await store.get("run-1" as RunId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("internal-invariant-violated");
  });

  it("errs internal-invariant-violated on corrupt (non-JSON) metadata", async () => {
    const { redis, seed } = seedableRedis();
    seed("fugue:hitl:run:run-1", "{not json");
    const store = createRedisRunStore(redis, cfg);
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
    const store = createRedisDecisionStore(fakeRedis(), cfg);
    const first = await store.markPending(runId, nodeId);
    const second = await store.markPending(runId, nodeId);
    expect(first.ok && first.value).toBe(true);
    expect(second.ok && second.value).toBe(false);
  });

  it("putDecision then getDecision round-trips the action", async () => {
    const store = createRedisDecisionStore(fakeRedis(), cfg);
    await store.putDecision(runId, nodeId, approve);
    const got = await store.getDecision(runId, nodeId);
    expect(got.ok && got.value).toEqual(approve);
  });

  it("getDecision returns null when none recorded", async () => {
    const store = createRedisDecisionStore(fakeRedis(), cfg);
    const got = await store.getDecision(runId, nodeId);
    expect(got.ok && got.value).toBe(null);
  });

  it("clear removes pending marker and decision", async () => {
    const store = createRedisDecisionStore(fakeRedis(), cfg);
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
    const store = createRedisDecisionStore(fakeRedis(), cfg);
    const reroute: HumanAction = { kind: "reroute", targetNodeId: "draft" as NodeId, reason: "redo" };
    await store.putDecision(runId, nodeId, reroute);
    const got = await store.getDecision(runId, nodeId);
    expect(got.ok && got.value).toEqual(reroute);
  });

  it("errs internal-invariant-violated on a corrupt (non-JSON) stored decision", async () => {
    const { redis, seed } = seedableRedis();
    // decision key = fugue:hitl:decision:<runId>␟<nodeId> (US separator).
    seed(`fugue:hitl:decision:${runId}\x1f${nodeId}`, "{not json");
    const store = createRedisDecisionStore(redis, cfg);
    const got = await store.getDecision(runId, nodeId);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.kind).toBe("internal-invariant-violated");
  });

  it("composite keys are injective — `:` in an id cannot alias a different gate", async () => {
    // With a `:` separator these two gates would collide (both → "...a:b:c");
    // the unit-separator key keeps them distinct.
    const store = createRedisDecisionStore(fakeRedis(), cfg);
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
