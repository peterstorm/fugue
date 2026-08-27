/**
 * Unit tests for node-context-factory.ts
 *
 * Tests resolveTtl, createNamespacedCache (error degradation, corrupted JSON),
 * and createNamespacedCheckpointWriter (durability failures reject).
 */

import { describe, it, expect } from "bun:test";
import { createInMemorySpendLedger } from "../adapters/spend-ledger-memory.js";
import { fromJson, ok, err, isOk, dagId, runId as makeRunId, nodeId as makeNodeId, gitSha, noopTracer, createHttpCapability, systemClock, observedOf, usdToMicros, tokensOnly, NO_SPEND } from "@fuguejs/framework";
import type {
  Result,
  DagId,
  RunId,
  NodeId,
  LlmClient,
  LlmRequest,
  LlmResponse,
  SendWithToolsRequest,
  NodeContext,
  FrameworkError,
} from "@fuguejs/framework";
import type { HostError } from "../domain/host-error.js";
import type { RedisPort, LogPort, SharedInfra } from "../ports.js";
import type { SpendLedgerPort } from "../ports.js";
import type { RegisteredDag } from "../domain/registry.js";
import { z } from "zod";
import {
  resolveTtl,
  createNamespacedCache,
  createNamespacedCheckpointWriter,
  createNodeContextForDag,
  buildCacheKey,
  buildCheckpointKey,
} from "../adapters/node-context-factory.js";
import { subjectTokenForIdentity, invocationOriginForIdentity } from "../domain/run-context.js";
import { markSubjectToken, type AuthIdentity, type SubjectToken } from "../domain/auth.js";
import { tenantId } from "../domain/tenant.js";
import type { TenantId } from "../domain/tenant.js";

/** Build a `TenantId` for a test from a known-good literal via the canonical constructor. */
const mkTenant = (s: string): TenantId => {
  const r = tenantId(s);
  if (!isOk(r)) throw new Error(`test tenant id "${s}" is invalid (kind: ${r.error.kind})`);
  return r.value;
};

// Existing pass-through / wiring tests are identity-agnostic — an admin identity
// reproduces the prior `agent`-keyed origin (admin/team → agent placeholder), so
// their byte-identical assertions are unaffected.
const adminIdentity: AuthIdentity = { kind: "admin" };

// ── Helpers ────────────────────────────────────────────────────────────────

const testDagId = dagId("test-dag");
const testRunId = makeRunId("run-001");
const testNodeId = makeNodeId("node-a");
// Every key builder + namespaced adapter is now tenant-scoped. The unit tests
// here use a single fixed tenant; setup and assertion both go through the same
// constant, so the prefix is consistent regardless of its literal value.
const testTenant = mkTenant("eng");

// FR-040: map the test DAG to its real agent client so the origin resolves for
// the wiring/metering tests below (these exercise context construction, not the
// FR-040 fail-closed path, which has its own dedicated tests).
const FACTORY_AGENT_MAP = { [testDagId as string]: "fugue-agent-test" };

const makeDag = (overrides?: Partial<RegisteredDag["config"]>): RegisteredDag => ({
  id: testDagId,
  team: "eng",
  route: "/dags/test-dag/run",
  dag: { id: "test-dag", nodes: [], edges: [] } as any,
  inputSchema: z.any(),
  config: {
    route: "/dags/test-dag/run",
    timeout: 30_000,
    maxConcurrency: 10,
    ...overrides,
  },
  meta: { description: "test", version: "1.0.0" },
  loadedAt: 1000,
  sha: gitSha("abc123"),
  status: { kind: "healthy" },
  prompts: new Map(),
  modulePath: "/tmp/dags/eng/test-dag/dag.ts",
});

const createMockRedis = (store: Map<string, string> = new Map()): {
  redis: RedisPort;
  calls: { op: string; key: string }[];
} => {
  const calls: { op: string; key: string }[] = [];
  const redis: RedisPort = {
    get: async (key) => {
      calls.push({ op: "get", key });
      const val = store.get(key);
      return ok(val ?? null);
    },
    set: async (key, value) => {
      calls.push({ op: "set", key });
      store.set(key, value);
      return ok(null);
    },
    del: async (key) => {
      calls.push({ op: "del", key });
      store.delete(key);
      return ok(1);
    },
    keys: async (pattern) => {
      const prefix = pattern.replace(/\*$/, "");
      return ok([...store.keys()].filter(k => k.startsWith(prefix)));
    },
    scan: async (pattern, _cursor = "0") => {
      const prefix = pattern.replace(/\*$/, "");
      return ok({ cursor: "0", keys: [...store.keys()].filter(k => k.startsWith(prefix)) });
    },
    setNx: async (key, value) => {
      if (store.has(key)) return ok(false);
      store.set(key, value);
      return ok(true);
    },
    sAdd: async () => ok(1),
    sRem: async () => ok(1),
    sMembers: async () => ok([]),
  };
  return { redis, calls };
};

const failingRedis = (): RedisPort => ({
  get: async () => err({ kind: "redis-unavailable", operation: "get" } as HostError),
  set: async () => err({ kind: "redis-unavailable", operation: "set" } as HostError),
  del: async () => err({ kind: "redis-unavailable", operation: "del" } as HostError),
  keys: async () => err({ kind: "redis-unavailable", operation: "keys" } as HostError),
  scan: async () => err({ kind: "redis-unavailable", operation: "scan" } as HostError),
  setNx: async () => err({ kind: "redis-unavailable", operation: "setnx" } as HostError),
  sAdd: async () => err({ kind: "redis-unavailable", operation: "sadd" } as HostError),
  sRem: async () => err({ kind: "redis-unavailable", operation: "srem" } as HostError),
  sMembers: async () => err({ kind: "redis-unavailable", operation: "smembers" } as HostError),
});

const collectLogs = () => {
  const logs: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const logger: LogPort = {
    info: (msg, data) => logs.push({ level: "info", msg, data }),
    warn: (msg, data) => logs.push({ level: "warn", msg, data }),
    error: (msg, data) => logs.push({ level: "error", msg, data }),
  };
  return { logger, logs };
};

// ── resolveTtl ─────────────────────────────────────────────────────────────

/**
 * THE one shared-infra fixture. It was redefined verbatim in six places (plus
 * two parameterized-but-identical copies) — every copy carrying the same stub
 * llm/redis/tracer/logger — so a change to what `SharedInfra` requires had to be
 * remembered eight times. `capabilities` defaults to none; the tests that care
 * pass the handles they are actually asserting on.
 */
const baseSharedInfra = (
  capabilities: SharedInfra["capabilities"] = [],
): SharedInfra => ({
  llm: { chat: async () => ({ content: "", usage: { inputTokens: 0, outputTokens: 0 } }) } as any,
  redis: createMockRedis().redis,
  spendLedger: createInMemorySpendLedger(),
  tracer: noopTracer,
  contentFilter: null,
  prompts: null,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  capabilities,
});

describe("resolveTtl", () => {
  it("returns undefined for both when no TTL configured", () => {
    const dag = makeDag();
    const ttl = resolveTtl(dag);
    expect(ttl.cacheTtlSec).toBeUndefined();
    expect(ttl.checkpointTtlSec).toBeUndefined();
  });

  it("converts cacheTtlMs to seconds using Math.ceil", () => {
    const dag = makeDag({ cacheTtlMs: 1500 });
    const ttl = resolveTtl(dag);
    expect(ttl.cacheTtlSec).toBe(2); // ceil(1500/1000) = 2
  });

  it("converts checkpointTtlMs to seconds using Math.ceil", () => {
    const dag = makeDag({ checkpointTtlMs: 999 });
    const ttl = resolveTtl(dag);
    expect(ttl.checkpointTtlSec).toBe(1); // ceil(999/1000) = 1
  });

  it("handles exact second values without rounding up", () => {
    const dag = makeDag({ cacheTtlMs: 5000 });
    const ttl = resolveTtl(dag);
    expect(ttl.cacheTtlSec).toBe(5);
  });

  it("handles zero ms", () => {
    const dag = makeDag({ cacheTtlMs: 0 });
    const ttl = resolveTtl(dag);
    expect(ttl.cacheTtlSec).toBe(0);
  });
});

// ── createNamespacedCache ──────────────────────────────────────────────────

describe("createNamespacedCache", () => {
  it("returns cache miss when key not found", async () => {
    const { redis } = createMockRedis();
    const { logger } = collectLogs();
    const cache = createNamespacedCache(redis, testTenant, testDagId, undefined, logger);

    const result = await cache.get("my-key");
    expect(result).toEqual({ hit: false });
  });

  it("returns cache hit with deserialized value", async () => {
    const store = new Map([
      [buildCacheKey(testTenant, testDagId, "my-key"), JSON.stringify({ data: 42 })],
    ]);
    const { redis } = createMockRedis(store);
    const { logger } = collectLogs();
    const cache = createNamespacedCache(redis, testTenant, testDagId, undefined, logger);

    const result = await cache.get("my-key");
    expect(result).toEqual({ hit: true, value: { data: 42 } });
  });

  it("gracefully degrades to miss on Redis get failure", async () => {
    const { logger, logs } = collectLogs();
    const cache = createNamespacedCache(failingRedis(), testTenant, testDagId, undefined, logger);

    const result = await cache.get("any-key");
    expect(result).toEqual({ hit: false });
    expect(logs.some(l => l.level === "warn" && l.msg.includes("Cache get failed"))).toBe(true);
  });

  it("treats corrupted JSON as cache miss", async () => {
    const store = new Map([
      [buildCacheKey(testTenant, testDagId, "bad"), "not-json{{{"],
    ]);
    const { redis } = createMockRedis(store);
    const { logger, logs } = collectLogs();
    const cache = createNamespacedCache(redis, testTenant, testDagId, undefined, logger);

    const result = await cache.get("bad");
    expect(result).toEqual({ hit: false });
    expect(logs.some(l => l.msg.includes("corrupted"))).toBe(true);
  });

  it("set writes serialized value to Redis", async () => {
    const store = new Map<string, string>();
    const { redis } = createMockRedis(store);
    const { logger } = collectLogs();
    const cache = createNamespacedCache(redis, testTenant, testDagId, undefined, logger);

    await cache.set("k", { value: "hello" });
    const expectedKey = buildCacheKey(testTenant, testDagId, "k");
    expect(store.get(expectedKey)).toBe(JSON.stringify({ value: "hello" }));
  });

  it("set is best-effort — returns ok on Redis failure", async () => {
    const { logger, logs } = collectLogs();
    const cache = createNamespacedCache(failingRedis(), testTenant, testDagId, undefined, logger);

    const result = await cache.set("k", "v");
    expect(result.ok).toBe(true);
    expect(logs.some(l => l.level === "warn" && l.msg.includes("Cache set failed"))).toBe(true);
  });

  it("cache fallback outcomes survive a throwing diagnostic logger", async () => {
    const throwingLogger: LogPort = {
      info: () => {},
      warn: () => { throw new Error("logger failed"); },
      error: () => { throw new Error("logger failed"); },
    };
    const failed = createNamespacedCache(
      failingRedis(), testTenant, testDagId, undefined, throwingLogger,
    );
    expect(await failed.get("missing")).toEqual({ hit: false });
    expect((await failed.set("key", "value")).ok).toBe(true);

    const corruptedStore = new Map([
      [buildCacheKey(testTenant, testDagId, "corrupt"), "not-json{{{"],
    ]);
    const corrupted = createNamespacedCache(
      createMockRedis(corruptedStore).redis,
      testTenant,
      testDagId,
      undefined,
      throwingLogger,
    );
    expect(await corrupted.get("corrupt")).toEqual({ hit: false });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect((await corrupted.set("cyclic", cyclic)).ok).toBe(true);
  });

  it("set handles non-serializable values gracefully", async () => {
    const { redis } = createMockRedis();
    const { logger, logs } = collectLogs();
    const cache = createNamespacedCache(redis, testTenant, testDagId, undefined, logger);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = await cache.set("k", circular);
    expect(result.ok).toBe(true);
    expect(logs.some(l => l.msg.includes("not serializable"))).toBe(true);
  });

  it("escalates to error level after consecutive failures", async () => {
    const { logger, logs } = collectLogs();
    const cache = createNamespacedCache(failingRedis(), testTenant, testDagId, undefined, logger);

    // Trigger 10 failures to exceed threshold
    for (let i = 0; i < 10; i++) {
      await cache.set(`k${i}`, "v");
    }

    const errorLogs = logs.filter(l => l.level === "error");
    expect(errorLogs.length).toBeGreaterThan(0);
    expect(errorLogs[0].msg).toContain("exceeded threshold");
  });
});

// ── createNamespacedCheckpointWriter ───────────────────────────────────────

describe("createNamespacedCheckpointWriter", () => {
  it("writes checkpoint with correct namespaced key", async () => {
    const store = new Map<string, string>();
    const { redis } = createMockRedis(store);
    const { logger } = collectLogs();
    const writer = createNamespacedCheckpointWriter(redis, testTenant, testDagId, testRunId, undefined, logger);

    await writer.write(testRunId, testNodeId, { output: "done" });

    const expectedKey = buildCheckpointKey(testTenant, testDagId, testRunId, testNodeId);
    expect(store.get(expectedKey)).toBe(JSON.stringify({ output: "done" }));
  });

  it("rejects on Redis failure so runDag can surface checkpoint-write-failed", async () => {
    const { logger, logs } = collectLogs();
    const writer = createNamespacedCheckpointWriter(failingRedis(), testTenant, testDagId, testRunId, undefined, logger);

    await expect(writer.write(testRunId, testNodeId, { data: 1 })).rejects.toThrow(/Checkpoint write failed/);
    expect(logs.some(l => l.msg.includes("Checkpoint write failed"))).toBe(true);
  });

  it.each([
    ["cyclic", (() => { const value: Record<string, unknown> = {}; value.self = value; return value; })()],
    ["BigInt", { amount: 1n }],
    ["non-finite number", { nested: { score: Number.NaN } }],
    ["function property", { nested: { run: () => 1 } }],
    ["symbol property", { nested: { marker: Symbol("x") } }],
    ["custom toJSON", { value: 1, toJSON: () => ({ value: 2 }) }],
  ])("rejects a %s checkpoint value as non-serializable", async (_label, value) => {
    const { redis } = createMockRedis();
    const { logger, logs } = collectLogs();
    const writer = createNamespacedCheckpointWriter(redis, testTenant, testDagId, testRunId, undefined, logger);

    await expect(writer.write(testRunId, testNodeId, value)).rejects.toThrow(/not serializable/);
    expect(logs.some(l => l.msg.includes("not serializable"))).toBe(true);
  });

  it("losslessly round-trips Map, Set, Date, and explicit undefined", async () => {
    const store = new Map<string, string>();
    const { redis } = createMockRedis(store);
    const { logger } = collectLogs();
    const writer = createNamespacedCheckpointWriter(
      redis, testTenant, testDagId, testRunId, undefined, logger,
    );
    const value = {
      byNode: new Map([[testNodeId, new Set(["approved"])]]),
      at: new Date("2026-08-23T07:00:00.000Z"),
      optional: undefined,
    };

    await writer.write(testRunId, testNodeId, value);

    const key = buildCheckpointKey(testTenant, testDagId, testRunId, testNodeId);
    expect(fromJson(store.get(key)!)).toEqual(value);
  });

  it("preserves the checkpoint failure when the logger throws", async () => {
    const throwingLogger: LogPort = {
      info: () => {},
      warn: () => { throw new Error("logger failed"); },
      error: () => { throw new Error("logger failed"); },
    };
    const writer = createNamespacedCheckpointWriter(
      failingRedis(), testTenant, testDagId, testRunId, undefined, throwingLogger,
    );

    await expect(writer.write(testRunId, testNodeId, { data: 1 })).rejects.toThrow(/Checkpoint write failed/);
  });
});

// ── Built-in http capability wiring (ADR-0051) ──────────────────────────────

describe("createNodeContextForDag — built-in http capability", () => {
  // Regression guard: main.ts wires `createHttpCapability()` into
  // `sharedInfra.capabilities`. If that wiring is dropped, `ctx.http` is null
  // and any `requires: ["http"]` DAG fails the boot-time capability check.
  it("surfaces a usable http client when the handle is wired into capabilities", async () => {
    const shared = baseSharedInfra([createHttpCapability()]);
    const { ctx } = await createNodeContextForDag(shared, makeDag(), testRunId, new AbortController().signal, adminIdentity, FACTORY_AGENT_MAP);

    expect(ctx.http).not.toBeNull();
    // The presence check `ctx.http != null` is exactly what
    // `validateCapabilities` gates a `requires: ["http"]` node on.
    expect(typeof ctx.http?.get).toBe("function");
    expect(typeof ctx.http?.post).toBe("function");
  });

  it("leaves http null when no http handle is wired (documents the gap the wiring closes)", async () => {
    const shared = baseSharedInfra([]);
    const { ctx } = await createNodeContextForDag(shared, makeDag(), testRunId, new AbortController().signal, adminIdentity, FACTORY_AGENT_MAP);

    expect(ctx.http).toBeNull();
  });

  // Regression guard: main.ts wires `{ name: "clock", client: systemClock }`
  // into `sharedInfra.capabilities`. If that wiring is dropped, `ctx.clock` is
  // null and any `requires: ["clock"]` DAG (e.g. golden example 09) fails the
  // boot-time capability check — exactly the gap the prior pass left when it
  // migrated the clock from a factory seam to a capability without host wiring.
  it("surfaces a usable clock when the handle is wired into capabilities", async () => {
    const shared = baseSharedInfra([{ name: "clock", client: systemClock }]);
    const { ctx } = await createNodeContextForDag(shared, makeDag(), testRunId, new AbortController().signal, adminIdentity, FACTORY_AGENT_MAP);

    expect(ctx.clock).not.toBeNull();
    // The presence check `ctx.clock != null` is what `validateCapabilities`
    // gates a `requires: ["clock"]` node on.
    expect(typeof ctx.clock?.now).toBe("function");
    expect(ctx.clock?.now()).toBeInstanceOf(Date);
  });

  it("leaves clock null when no clock handle is wired (documents the gap the wiring closes)", async () => {
    const shared = baseSharedInfra([]);
    const { ctx } = await createNodeContextForDag(shared, makeDag(), testRunId, new AbortController().signal, adminIdentity, FACTORY_AGENT_MAP);

    expect(ctx.clock).toBeNull();
  });
});

// ── Fail-closed tenant derivation (SECURITY: AD-4 / US2 / SC-001) ────────────
//
// createNodeContextForDag derives the tenant for EVERY Redis key from the DAG's
// owning `team` via the canonical `tenantId` smart constructor. A team that is
// not a valid tenant id (contains `:`, a glob metacharacter, or is over 64
// chars) would, if interpolated unchecked, ESCAPE the `fugue:<tenant>:` prefix
// and defeat the per-tenant Redis ACL. The factory REFUSES (throws) rather than
// emit an unscoped key — this is THE production seam that prevents an
// ACL-escaping key, so it must stay fail-closed.

describe("createNodeContextForDag — fail-closed tenant derivation (AD-4 / US2 / SC-001)", () => {
  it("REFUSES (throws) when the DAG's owning team contains a colon — never emits a key that escapes the tenant prefix", async () => {
    // A team with a `:` cannot be a TenantId (`:` is the key-segment delimiter);
    // interpolating it unchecked would forge a sibling namespace
    // (`fugue:evil:ns:...`). The factory must throw before any key is built.
    const evilTeamDag: RegisteredDag = { ...makeDag(), team: "evil:ns" };
    const promise = createNodeContextForDag(
      baseSharedInfra(),
      evilTeamDag,
      testRunId,
      new AbortController().signal,
      adminIdentity,
      FACTORY_AGENT_MAP,
    );
    await expect(promise).rejects.toThrow(/invalid owning team/i);
  });
});

// ── Routed-tenant key namespacing (ADR-0067 / SC-001) ───────────────────────
//
// When the supervisor threads the resolved `Tenant.id` as `routedTenant`, it —
// NOT the DAG's owning `team` — is the authoritative tenant axis for EVERY Redis
// key the context produces, so cache/checkpoint keys share the SAME
// `fugue:<tenant>:` namespace as the token / HITL / run-lock stores (`host.ts`).
// A tenant whose `id` differs from a DAG's `team` must NOT split its keys across
// two namespaces. The `dag.team` derivation remains as a fallback for the
// single-tenant entrypoint that omits `routedTenant`.

describe("createNodeContextForDag — routed-tenant key namespacing (ADR-0067 / SC-001)", () => {
  const sharedWithStore = (store: Map<string, string>): SharedInfra => ({
    llm: { chat: async () => ({ content: "", usage: { inputTokens: 0, outputTokens: 0 } }) } as any,
    redis: createMockRedis(store).redis,
    spendLedger: createInMemorySpendLedger(),
    tracer: noopTracer,
    contentFilter: null,
    prompts: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    capabilities: [],
  });

  it("namespaces cache keys under `routedTenant` — never the DAG's owning team (id != team)", async () => {
    // DAG owned by team "eng"; worker routed for tenant "acme-prod" (id != team).
    const store = new Map<string, string>();
    const routed = mkTenant("acme-prod");
    const dag = makeDag(); // team: "eng"
    const { ctx } = await createNodeContextForDag(
      sharedWithStore(store),
      dag,
      testRunId,
      new AbortController().signal,
      adminIdentity,
      FACTORY_AGENT_MAP,
      false,
      undefined,
      routed,
    );

    const writeResult = await ctx.cache.set("k", { v: 1 });
    expect(writeResult.ok).toBe(true);

    // The exact key is under the routed tenant; nothing leaks under the team.
    expect(store.has(buildCacheKey(routed, dag.id, "k"))).toBe(true);
    expect([...store.keys()].every((key) => key.startsWith(`fugue:${routed}:`))).toBe(true);
    expect([...store.keys()].some((key) => key.startsWith("fugue:eng:"))).toBe(false);
  });

  it("falls back to the `dag.team` derivation when `routedTenant` is omitted (single-tenant path)", async () => {
    const store = new Map<string, string>();
    const dag = makeDag(); // team: "eng"
    const { ctx } = await createNodeContextForDag(
      sharedWithStore(store),
      dag,
      testRunId,
      new AbortController().signal,
      adminIdentity,
      FACTORY_AGENT_MAP,
    );

    await ctx.cache.set("k", { v: 1 });
    expect([...store.keys()].some((key) => key.startsWith("fugue:eng:"))).toBe(true);
  });
});

// ── Static client wiring (SC-005 zero-regression) ───────────────────────────

describe("createNodeContextForDag — static client wiring (SC-005)", () => {
  // Regression proof for the base-context wiring: the boot-scoped static client
  // must be reachable on the NodeContext BYTE-IDENTICAL to what `extractClients`
  // produces — the SAME reference, not a copy. Per-node minting layers OVER this
  // base; the static client itself is never copied (FR-W2-003 / SC-005).
  it("exposes the exact same capability client reference the handle wired in (byte-identical)", async () => {
    const httpHandle = createHttpCapability();
    const shared = baseSharedInfra([httpHandle]);

    const { ctx } = await createNodeContextForDag(
      shared,
      makeDag(),
      testRunId,
      new AbortController().signal,
      adminIdentity,
      FACTORY_AGENT_MAP,
    );

    // `extractClients([httpHandle]).http === httpHandle.client` — the factory
    // wires that exact reference onto the base NodeContext unchanged.
    expect(ctx.http).toBe(httpHandle.client);
  });
});

// ── Metered-LLM wiring (review gap: factory wraps shared.llm + threads budget) ─

describe("createNodeContextForDag — metered LLM wiring (FR-W0-001/FR-W1-001..006)", () => {
  /** A fake inner LlmClient reporting fixed usage per call — call-recording, no mocks. */
  const fakeLlm = (tokensIn: number, tokensOut: number) => {
    const calls: NodeId[] = [];
    const llm: LlmClient = {
      sendStructured: async <O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>> => {
        calls.push(req.nodeId);
        return ok({ output: {} as O, ...tokensOnly(tokensIn, tokensOut), rawText: "" });
      },
      sendWithTools: async <O>(req: SendWithToolsRequest<O>, _ctx: NodeContext): Promise<Result<LlmResponse<O>, FrameworkError>> => {
        calls.push(req.nodeId);
        return ok({ output: {} as O, ...tokensOnly(tokensIn, tokensOut), rawText: "" });
      },
    };
    return { llm, calls };
  };

  const sharedWithLlm = (llm: LlmClient): SharedInfra => ({
    llm,
    redis: createMockRedis().redis,
    spendLedger: createInMemorySpendLedger(),
    tracer: noopTracer,
    contentFilter: null,
    prompts: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    capabilities: [],
  });

  const structuredReq = (): LlmRequest<unknown> => ({
    system: "s",
    user: "u",
    model: "m",
    schema: z.unknown(),
    nodeId: testNodeId,
  });

  /** Same request on a PRICED model, so a usd ceiling compares a real cost. */
  const pricedReq = (): LlmRequest<unknown> => ({ ...structuredReq(), model: "gpt-4o" });

  it("wraps the shared LLM client — ctx.llm is the metered decorator, NOT the shared reference", async () => {
    const { llm } = fakeLlm(10, 5);
    const shared = sharedWithLlm(llm);

    const { ctx } = await createNodeContextForDag(shared, makeDag(), testRunId, new AbortController().signal, adminIdentity, FACTORY_AGENT_MAP);

    // If the factory ever stops wrapping (handing the shared client through
    // unmetered), this reference check is the loudest possible regression guard.
    expect(ctx.llm).not.toBe(shared.llm);
    expect(ctx.llm).not.toBeNull();
  });

  it("threads dag.config.llmBudgetTokens into the decorator: a tiny budget refuses the SECOND call with llm-budget-exceeded", async () => {
    const { llm, calls } = fakeLlm(10, 5); // 15 tokens/call
    const shared = sharedWithLlm(llm);
    const dag = makeDag({ llmBudgetTokens: 1 }); // budget 1: call 1 is the single overshoot

    const { ctx } = await createNodeContextForDag(shared, dag, testRunId, new AbortController().signal, adminIdentity, FACTORY_AGENT_MAP);
    if (ctx.llm === null) throw new Error("expected wired llm");

    const r1 = await ctx.llm.sendStructured(structuredReq()); // 0 < 1 → allowed, settles 15
    const r2 = await ctx.llm.sendStructured(structuredReq()); // 15 >= 1 → refused pre-call

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error.kind).toBe("llm-budget-exceeded");
      if (r2.error.kind === "llm-budget-exceeded") {
        expect(r2.error.cause.ceiling).toEqual({ kind: "tokens", limit: 1 }); // the dag.config value
        expect(r2.error.cause.basis).toBe("settled");
        expect(observedOf(r2.error.cause)).toBe(15); // settled tokens from call 1
        expect(r2.error.runId).toBe(testRunId);
      }
    }
    // The refused call never reached the inner client (no network round trip).
    expect(calls.length).toBe(1);
  });

  it("threads dag.config.llmBudget.usd into the decorator: a dollar ceiling refuses on COST", async () => {
    // The legacy `llmBudgetTokens` scalar is covered above. This is the axis F3
    // actually added, and the seam it crosses is the one nothing else pins:
    // `ceilingsOf` is unit-tested and `createMeteredLlm` is unit-tested with
    // hand-built ceilings, but only this proves that what an operator writes in
    // `fugue.yaml` is what the decorator ends up enforcing.
    //
    // 400k prompt tokens on gpt-4o = $1.00. Budget $1.50: call 1 settles at
    // $1.00, call 2 is the single overshoot at $2.00, call 3 is refused.
    const { llm, calls } = fakeLlm(400_000, 0);
    const shared = sharedWithLlm(llm);
    const dag = makeDag({ llmBudget: { usd: 1.5 } });

    const { ctx } = await createNodeContextForDag(shared, dag, testRunId, new AbortController().signal, adminIdentity, FACTORY_AGENT_MAP);
    if (ctx.llm === null) throw new Error("expected wired llm");

    expect((await ctx.llm.sendStructured(pricedReq())).ok).toBe(true);
    expect((await ctx.llm.sendStructured(pricedReq())).ok).toBe(true);
    const refused = await ctx.llm.sendStructured(pricedReq());

    expect(refused.ok).toBe(false);
    if (!refused.ok && refused.error.kind === "llm-budget-exceeded") {
      expect(refused.error.cause.ceiling.kind).toBe("usd");
      expect(refused.error.cause.ceiling.limit).toBe(usdToMicros(1.5));
      expect(observedOf(refused.error.cause)).toBe(usdToMicros(2));
    } else {
      throw new Error("expected a usd budget refusal");
    }
    expect(calls.length).toBe(2); // the refused call never reached the client
  });

  it("threads dag.config.llmBudget.calls: a call ceiling refuses on ROUND TRIPS, not size", async () => {
    // The cheap circuit-breaker axis. Two tiny calls trip it where neither a
    // token nor a dollar ceiling would notice.
    const { llm, calls } = fakeLlm(1, 1);
    const shared = sharedWithLlm(llm);
    const dag = makeDag({ llmBudget: { calls: 2 } });

    const { ctx } = await createNodeContextForDag(shared, dag, testRunId, new AbortController().signal, adminIdentity, FACTORY_AGENT_MAP);
    if (ctx.llm === null) throw new Error("expected wired llm");

    expect((await ctx.llm.sendStructured(pricedReq())).ok).toBe(true);
    expect((await ctx.llm.sendStructured(pricedReq())).ok).toBe(true);
    const refused = await ctx.llm.sendStructured(pricedReq());

    expect(refused.ok).toBe(false);
    if (!refused.ok && refused.error.kind === "llm-budget-exceeded") {
      expect(refused.error.cause.ceiling.kind).toBe("calls");
    } else {
      throw new Error("expected a calls budget refusal");
    }
    expect(calls.length).toBe(2);
  });

  it("takes the TIGHTER limit when both the legacy scalar and the block declare tokens", async () => {
    // `ceilings()` collapses duplicate axes to their minimum, so the two
    // spellings compose rather than one winning by declaration order. Pinned
    // through the factory because that is where both reach the same value.
    const { llm, calls } = fakeLlm(10, 5); // 15 tokens/call
    const shared = sharedWithLlm(llm);
    const dag = makeDag({ llmBudgetTokens: 100_000, llmBudget: { tokens: 1 } });

    const { ctx } = await createNodeContextForDag(shared, dag, testRunId, new AbortController().signal, adminIdentity, FACTORY_AGENT_MAP);
    if (ctx.llm === null) throw new Error("expected wired llm");

    expect((await ctx.llm.sendStructured(structuredReq())).ok).toBe(true); // the overshoot
    const refused = await ctx.llm.sendStructured(structuredReq());
    expect(refused.ok).toBe(false);
    if (!refused.ok && refused.error.kind === "llm-budget-exceeded") {
      expect(refused.error.cause.ceiling).toEqual({ kind: "tokens", limit: 1 });
    } else {
      throw new Error("expected a tokens budget refusal");
    }
    expect(calls.length).toBe(1);
  });

  it("with llmBudgetTokens unset, the decorator meters but never refuses (FR-W1-006) — budget comes ONLY from dag.config", async () => {
    const { llm, calls } = fakeLlm(1_000_000, 0);
    const shared = sharedWithLlm(llm);

    const { ctx } = await createNodeContextForDag(shared, makeDag(), testRunId, new AbortController().signal, adminIdentity, FACTORY_AGENT_MAP);
    if (ctx.llm === null) throw new Error("expected wired llm");

    for (let i = 0; i < 3; i++) {
      expect((await ctx.llm.sendStructured(structuredReq())).ok).toBe(true);
    }
    expect(calls.length).toBe(3); // all delegated — no budget, no refusal
  });
});

// ── Identity → Invocation.origin threading (FR-W3-007) ──────────────────────
//
// Before this fix the user identity dead-ended: every run built
// `origin: { kind: "agent", agentClientId: dagId }`, so an OIDC user's `sub`
// never reached the NodeContext and the run was mis-attributed as `agent`.
// `invocationOriginForIdentity` is the seam the factory now uses to build the
// origin; these tests prove the user `sub`/`azp` actually land and that the
// admin/team placeholder is unchanged (byte-for-byte the prior behaviour).

describe("invocationOriginForIdentity — user sub threading + real-client resolution (FR-W3-007, FR-040)", () => {
  // FR-040: the DAG id resolves to its REAL Keycloak agent client via the map,
  // not the dag-id placeholder. `test-dag` → `fugue-agent-test`.
  const AGENT_MAP = { [testDagId as string]: "fugue-agent-test" };

  it("a user identity produces origin { kind: 'user', sub, agentClientId: <REAL client> } — sub lands, agent client is the mapped client, NOT the dagId nor the frontend azp (I3, FR-040)", () => {
    const userIdentity: AuthIdentity = { kind: "user", sub: "user-abc-123", azp: "fugue-frontend", canRunDag: () => true };

    const origin = invocationOriginForIdentity(AGENT_MAP, userIdentity, testDagId);

    // agentClientId is the AGENT the user acts through — the DAG's REAL agent-type
    // Keycloak client resolved from AGENT_CLIENT_MAP — NOT the inbound token's
    // frontend `azp`, and NOT the dagId placeholder. The broker gates the user
    // hop with `assignedScopes(agentClientId)`, which must consult the AGENT's
    // realm policy keyed on the real client id (I3, FR-040).
    expect(origin).toEqual({
      kind: "user",
      sub: "user-abc-123",
      agentClientId: "fugue-agent-test",
    });
    expect((origin as { agentClientId: string }).agentClientId).not.toBe("fugue-frontend");
    expect((origin as { agentClientId: string }).agentClientId).not.toBe(testDagId);
  });

  it("a team identity maps to the agent origin keyed on the REAL client id (FR-040)", () => {
    const teamIdentity: AuthIdentity = { kind: "team", team: "eng", label: "ci" };

    const origin = invocationOriginForIdentity(AGENT_MAP, teamIdentity, testDagId);

    expect(origin).toEqual({ kind: "agent", agentClientId: "fugue-agent-test" });
  });

  it("an admin identity maps to the agent origin keyed on the REAL client id (FR-040)", () => {
    const origin = invocationOriginForIdentity(AGENT_MAP, adminIdentity, testDagId);

    expect(origin).toEqual({ kind: "agent", agentClientId: "fugue-agent-test" });
  });

  it("FR-040 fail-closed: an UNMAPPED dag id resolves to `undefined` (no identity passthrough) for EVERY identity kind", () => {
    // Empty map → no DAG has an agent client → origin resolution is first-class
    // ABSENCE, never the dag-id-as-client placeholder.
    const userIdentity: AuthIdentity = { kind: "user", sub: "u", azp: "fugue-frontend", canRunDag: () => true };
    expect(invocationOriginForIdentity({}, userIdentity, testDagId)).toBeUndefined();
    expect(invocationOriginForIdentity({}, { kind: "team", team: "eng", label: "ci" }, testDagId)).toBeUndefined();
    expect(invocationOriginForIdentity({}, adminIdentity, testDagId)).toBeUndefined();
    // A map that maps a DIFFERENT dag still fails closed for the unmapped one.
    expect(invocationOriginForIdentity({ "other-dag": "fugue-agent-other" }, adminIdentity, testDagId)).toBeUndefined();
  });

  it("the factory accepts a user identity and produces a usable NodeContext (sub threaded, no throw)", async () => {
    const userIdentity: AuthIdentity = { kind: "user", sub: "user-xyz", azp: "fugue-frontend", canRunDag: () => true };
    const shared = baseSharedInfra();

    const { ctx, origin } = await createNodeContextForDag(
      shared,
      makeDag(),
      testRunId,
      new AbortController().signal,
      userIdentity,
      // FR-040: map the DAG to its real agent client so the origin resolves.
      { [testDagId as string]: "fugue-agent-test" },
    );

    // The run path no longer dead-ends the user identity: a base NodeContext is
    // produced and the origin the factory built from this identity carries the
    // user's sub (threaded into per-node minting by the framework) AND the REAL
    // resolved agent client (FR-040).
    expect(ctx).toBeDefined();
    expect(origin).toMatchObject({ kind: "user", sub: "user-xyz", agentClientId: "fugue-agent-test" });
  });

  it("FR-040 fail-closed: the factory REFUSES (throws) a DAG with no agent client mapping when minting is ACTIVE — never mints an absent identity", async () => {
    const shared = baseSharedInfra();
    // Empty map + minting ACTIVE (broker wired) → the DAG has no agent client →
    // fail closed (the origin WOULD be consumed by per-node minting).
    const promise = createNodeContextForDag(
      shared,
      makeDag(),
      testRunId,
      new AbortController().signal,
      adminIdentity,
      {},
      true,
    );
    await expect(promise).rejects.toThrow(/no agent client mapping/);
  });

  it("zero-regression no-realm baseline (SC-001/SC-005): an UNMAPPED dag with minting INACTIVE does NOT throw and yields origin `undefined` — a no-realm deployment must not 500 every run", async () => {
    const shared = baseSharedInfra();
    // Empty map (the default) + minting INACTIVE (no broker) → origin is never
    // consumed, so the run proceeds on the static path with origin === undefined.
    const { ctx, origin } = await createNodeContextForDag(
      shared,
      makeDag(),
      testRunId,
      new AbortController().signal,
      adminIdentity,
      {},
      false,
    );
    expect(ctx).toBeDefined();
    expect(origin).toBeUndefined();
  });

  it("FR-040 + NFR-014 ordering: a user run carrying a subject token on an UNMAPPED dag (minting active) throws BEFORE binding the token — no JWT retained under a non-proceeding run", async () => {
    const shared = baseSharedInfra();
    const bound: RunId[] = [];
    const userWithProof: AuthIdentity = {
      kind: "user",
      sub: "user-xyz",
      azp: "fugue-frontend",
      canRunDag: () => true,
      subjectToken: markSubjectToken("verified.user.jwt"),
    };
    const promise = createNodeContextForDag(
      shared,
      makeDag(),
      testRunId,
      new AbortController().signal,
      userWithProof,
      {},
      true,
      (rid) => { bound.push(rid); },
    );
    await expect(promise).rejects.toThrow(/no agent client mapping/);
    // The fail-closed throw fires BEFORE the bind, so nothing is retained.
    expect(bound).toEqual([]);
  });
});

// ── Subject token: host-side only, never on the framework origin (T7/FR-032) ─
//
// The user's verified `subject_token` (FR-030 proof) MUST be threaded HOST-SIDE
// and MUST NEVER appear on the framework `InvocationOrigin` (which stays
// string-only). These tests pin both halves: the pure seam extracts the token off
// the identity, and the factory binds it to the run via the side-channel sink
// WITHOUT it ever crossing into the origin.

describe("subjectTokenForIdentity — pure host-side extraction (FR-030/FR-032)", () => {
  const proof: SubjectToken = markSubjectToken("verified.user.jwt");

  it("returns the verified token for a user identity that carries one", () => {
    const userIdentity: AuthIdentity = {
      kind: "user",
      sub: "user-xyz",
      azp: "fugue-frontend",
      canRunDag: () => true,
      subjectToken: proof,
    };
    expect(subjectTokenForIdentity(userIdentity)).toBe(proof);
  });

  it("returns undefined for a user identity with no token (durable reconstruction) — broker then fails closed", () => {
    const reconstructed: AuthIdentity = { kind: "user", sub: "user-xyz", azp: "fugue-frontend", canRunDag: () => false };
    expect(subjectTokenForIdentity(reconstructed)).toBeUndefined();
  });

  it("returns undefined for admin and team identities (they have no end-user subject token)", () => {
    expect(subjectTokenForIdentity({ kind: "admin" })).toBeUndefined();
    expect(subjectTokenForIdentity({ kind: "team", team: "eng", label: "ci" })).toBeUndefined();
  });
});

describe("createNodeContextForDag — binds the subject token host-side, NEVER on the origin (FR-032)", () => {
  it("binds runId → subject token via the sink for a user run; the token is ABSENT from the string-only origin", async () => {
    const proof = markSubjectToken("verified.user.jwt-FR032");
    const userIdentity: AuthIdentity = {
      kind: "user",
      sub: "user-xyz",
      azp: "fugue-frontend",
      canRunDag: () => true,
      subjectToken: proof,
    };
    const bound: { runId: RunId; token: SubjectToken }[] = [];

    const { origin } = await createNodeContextForDag(
      baseSharedInfra(),
      makeDag(),
      testRunId,
      new AbortController().signal,
      userIdentity,
      FACTORY_AGENT_MAP,
      true,
      (rid, token) => bound.push({ runId: rid, token }),
    );

    // The token went through the HOST-SIDE sink, keyed on the run id.
    expect(bound).toEqual([{ runId: testRunId, token: proof }]);
    // FR-032: the origin is string-only — the raw token appears NOWHERE on it.
    expect(JSON.stringify(origin)).not.toContain("verified.user.jwt-FR032");
    expect((origin as Record<string, unknown>).subjectToken).toBeUndefined();
    expect((origin as Record<string, unknown>).token).toBeUndefined();
    // The origin still carries only the string sub + the REAL resolved agent client.
    expect(origin).toEqual({ kind: "user", sub: "user-xyz", agentClientId: "fugue-agent-test" });
  });

  it("binds NOTHING for an admin run (no subject token) — the sink is never called", async () => {
    const bound: RunId[] = [];
    await createNodeContextForDag(
      baseSharedInfra(),
      makeDag(),
      testRunId,
      new AbortController().signal,
      adminIdentity,
      FACTORY_AGENT_MAP,
      true,
      (rid) => bound.push(rid),
    );
    expect(bound).toEqual([]);
  });

  it("binds NOTHING for a user run with no resolvable token (durable reconstruction)", async () => {
    const reconstructed: AuthIdentity = { kind: "user", sub: "user-xyz", azp: "fugue-frontend", canRunDag: () => false };
    const bound: RunId[] = [];
    await createNodeContextForDag(
      baseSharedInfra(),
      makeDag(),
      testRunId,
      new AbortController().signal,
      reconstructed,
      FACTORY_AGENT_MAP,
      true,
      (rid) => bound.push(rid),
    );
    // No token to bind → the broker's user exchange fails closed for this run.
    expect(bound).toEqual([]);
  });
});

// ── Durability across execution slices (FR-B-006 / FR-B-007) ────────────────
//
// The hole this closes: `createNodeContextForDag` is called ONCE PER EXECUTION
// SLICE by the HITL run executor, and the meter it builds starts empty. Before
// the ledger, a run that parked for a human decision and resumed came back with
// its budget refilled — five parks, six budgets.
//
// Every case below drives the REAL factory twice against ONE ledger, which is
// exactly the shape of a park/resume. The first of them fails on a build
// without the ledger.
describe("createNodeContextForDag — spend survives a park/resume (FR-B-006)", () => {
  /**
   * A client that always reports the same usage, and records who called it.
   * Local to this block: the equivalent helper in the metered-wiring describe
   * above is scoped to it, and duplicating four lines beats widening that
   * scope for one consumer.
   */
  const fakeLlm = (tokensIn: number, tokensOut: number) => {
    const calls: NodeId[] = [];
    const respond = <O,>(req: { nodeId: NodeId }) => {
      calls.push(req.nodeId);
      return ok({ output: {} as O, ...tokensOnly(tokensIn, tokensOut), rawText: "" });
    };
    const llm = {
      sendStructured: async <O,>(req: LlmRequest<O>) => respond<O>(req),
      sendWithTools: async <O,>(req: SendWithToolsRequest<O>) => respond<O>(req),
    } as unknown as LlmClient;
    return { llm, calls };
  };

  const structuredReq = (): LlmRequest<unknown> => ({
    system: "s",
    user: "u",
    model: "m",
    schema: z.unknown(),
    nodeId: testNodeId,
  });

  const sharedWith = (llm: LlmClient, ledger: SpendLedgerPort): SharedInfra => ({
    llm,
    redis: createMockRedis().redis,
    spendLedger: ledger,
    tracer: noopTracer,
    contentFilter: null,
    prompts: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    capabilities: [],
  });

  const sliceFor = async (shared: SharedInfra, dag: RegisteredDag) => {
    const { ctx } = await createNodeContextForDag(
      shared, dag, testRunId, new AbortController().signal, adminIdentity, FACTORY_AGENT_MAP,
    );
    if (ctx.llm === null) throw new Error("expected wired llm");
    return ctx.llm;
  };

  it("does NOT refill the budget when a run resumes in a new slice", async () => {
    // 15 tokens/call, budget 40. Slice 1 admits three calls (0, 15, 30) and the
    // third settles at 45. Slice 2 must start from 45 — already over — and
    // refuse immediately. Without the ledger it would start from 0 and admit
    // three more.
    const ledger = createInMemorySpendLedger();
    const { llm, calls } = fakeLlm(10, 5);
    const shared = sharedWith(llm, ledger);
    const dag = makeDag({ llmBudget: { tokens: 40 } });

    const first = await sliceFor(shared, dag);
    expect((await first.sendStructured(structuredReq())).ok).toBe(true);
    expect((await first.sendStructured(structuredReq())).ok).toBe(true);
    expect((await first.sendStructured(structuredReq())).ok).toBe(true); // the overshoot
    expect((await first.sendStructured(structuredReq())).ok).toBe(false);
    expect(calls.length).toBe(3);

    // ── the run parks here, and resumes into a FRESH NodeContext ──
    const second = await sliceFor(shared, dag);
    const refused = await second.sendStructured(structuredReq());

    expect(refused.ok).toBe(false);
    if (!refused.ok && refused.error.kind === "llm-budget-exceeded") {
      expect(refused.error.cause.basis).toBe("settled");
      expect(observedOf(refused.error.cause)).toBe(45); // carried across the slice
    } else {
      throw new Error("expected the resumed slice to refuse");
    }
    expect(calls.length).toBe(3); // the resumed slice reached the provider zero times
  });

  it("carries a partly-spent budget across a resume without refusing early", async () => {
    // The other direction: durability must not make a resumed slice refuse a
    // run that still has headroom.
    const ledger = createInMemorySpendLedger();
    const { llm, calls } = fakeLlm(10, 5);
    const shared = sharedWith(llm, ledger);
    const dag = makeDag({ llmBudget: { tokens: 1000 } });

    const first = await sliceFor(shared, dag);
    expect((await first.sendStructured(structuredReq())).ok).toBe(true);

    const second = await sliceFor(shared, dag);
    expect((await second.sendStructured(structuredReq())).ok).toBe(true);
    expect(calls.length).toBe(2);

    const carried = await ledger.read(testRunId);
    expect(carried.ok).toBe(true);
    if (!carried.ok) return;
    expect(carried.value.tokens).toBe(30); // both slices, one ledger
    expect(carried.value.calls).toBe(2);
  });

  it("records a FAILED call's burned tokens durably too", async () => {
    // Otherwise a crash-looping run could bypass its budget by never settling
    // a successful call.
    const ledger = createInMemorySpendLedger();
    const failing: LlmClient = {
      sendStructured: async () =>
        err({ kind: "node-crash", nodeId: testNodeId, message: "boom", retriability: "non-retriable", usage: tokensOnly(600, 0) }),
      sendWithTools: async () =>
        err({ kind: "node-crash", nodeId: testNodeId, message: "boom", retriability: "non-retriable", usage: tokensOnly(600, 0) }),
    } as unknown as LlmClient;
    const shared = sharedWith(failing, ledger);

    const first = await sliceFor(shared, makeDag({ llmBudget: { tokens: 500 } }));
    expect((await first.sendStructured(structuredReq())).ok).toBe(false);

    const carried = await ledger.read(testRunId);
    expect(carried.ok).toBe(true);
    if (!carried.ok) return;
    expect(carried.value.tokens).toBe(600);
  });

  it("REFUSES the slice when a BUDGETED run's ledger cannot be read (FR-B-007)", async () => {
    // An unreadable ledger is indistinguishable from a spent one. Assuming zero
    // would be the refill bug, deliberately reintroduced.
    const broken: SpendLedgerPort = {
      read: async () => err({ kind: "redis-unavailable", operation: "spend-ledger read" }),
      add: async () => ok(undefined),
    };
    const { llm } = fakeLlm(10, 5);
    const shared = sharedWith(llm, broken);

    await expect(
      sliceFor(shared, makeDag({ llmBudget: { tokens: 1000 } })),
    ).rejects.toThrow(/could not be read/);
  });

  it("RUNS an UNBUDGETED run whose ledger cannot be read", async () => {
    // There is no ceiling to protect, so failing the slice would turn a
    // metering outage into an availability outage. Metering degrades; the run
    // proceeds.
    const broken: SpendLedgerPort = {
      read: async () => err({ kind: "redis-unavailable", operation: "spend-ledger read" }),
      add: async () => ok(undefined),
    };
    const { llm, calls } = fakeLlm(10, 5);
    const shared = sharedWith(llm, broken);

    const slice = await sliceFor(shared, makeDag());
    expect((await slice.sendStructured(structuredReq())).ok).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("does not fail a call when the ledger APPEND fails — the tokens are already spent", async () => {
    // Refusing the result would waste the call and lose the output too. What is
    // lost is durability, and that is what gets logged.
    const writeOnlyFailure: SpendLedgerPort = {
      read: async () => ok(NO_SPEND),
      add: async () => err({ kind: "redis-unavailable", operation: "spend-ledger add" }),
    };
    const { llm, calls } = fakeLlm(10, 5);
    const shared = sharedWith(llm, writeOnlyFailure);

    const slice = await sliceFor(shared, makeDag({ llmBudget: { tokens: 1000 } }));
    expect((await slice.sendStructured(structuredReq())).ok).toBe(true);
    expect(calls.length).toBe(1);
  });
});
