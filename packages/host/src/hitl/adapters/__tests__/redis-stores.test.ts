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
});
