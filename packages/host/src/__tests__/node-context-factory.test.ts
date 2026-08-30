/**
 * Unit tests for node-context-factory.ts
 *
 * Tests resolveTtl, createNamespacedCache (error degradation, corrupted JSON),
 * and createNamespacedCheckpointWriter (durability failures reject).
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  markSubjectToken,
  type AgentClientMap,
  type AuthIdentity,
  type SubjectToken,
} from "../domain/auth.js";
import { tenantId } from "../domain/tenant.js";
import type { TenantId } from "../domain/tenant.js";
import { createFileSpendLedger } from "../adapters/spend-ledger-file.js";

interface AugmentedLlmClient extends LlmClient {
  readonly sendAlias: LlmClient["sendStructured"];
}

declare module "@fuguejs/framework" {
  interface CapabilityRegistry {
    criticLlm: LlmClient;
    augmentedLlm: AugmentedLlmClient;
  }
}

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
const memoryLedgerMetadata = Object.freeze({
  role: "redis-fallback" as const,
  backend: "memory" as const,
  durability: "process" as const,
});

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

type TestContextOptions = {
  readonly shared?: SharedInfra;
  readonly dag?: RegisteredDag;
  readonly run?: RunId;
  readonly signal?: AbortSignal;
  readonly identity?: AuthIdentity;
  readonly agentClientMap?: AgentClientMap;
};

/** Defaults the run identity and wiring; focused cases vary only their seam. */
const createTestContext = (opts: TestContextOptions = {}) =>
  createNodeContextForDag(
    opts.shared ?? baseSharedInfra(),
    opts.dag ?? makeDag(),
    opts.run ?? testRunId,
    opts.signal ?? new AbortController().signal,
    opts.identity ?? adminIdentity,
    opts.agentClientMap ?? FACTORY_AGENT_MAP,
  );

/**
 * ONE client fake and ONE request shape for the file.
 *
 * These were defined three times in three describe blocks — the third copy
 * added while closing a round-2 finding, in a file whose own fixture comment
 * already flagged the duplication once. Nothing about them is block-specific.
 */
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

const structuredReq = (): LlmRequest<unknown> => ({
  system: "s",
  user: "u",
  model: "m",
  schema: z.unknown(),
  nodeId: testNodeId,
});

/** Same request on a PRICED model, so a usd ceiling compares a real cost. */
const pricedReq = (): LlmRequest<unknown> => ({ ...structuredReq(), model: "gpt-4o" });

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

  it.each(["throw", "reject"] as const)(
    "gracefully degrades to miss when Redis get %ss",
    async (mode) => {
      const base = createMockRedis().redis;
      const redis: RedisPort = {
        ...base,
        get: mode === "throw"
          ? () => { throw new Error("get invocation escaped"); }
          : async () => Promise.reject(new Error("get await escaped")),
      };
      const { logger, logs } = collectLogs();
      const cache = createNamespacedCache(redis, testTenant, testDagId, undefined, logger);

      expect(await cache.get("hostile-get")).toEqual({ hit: false });
      const line = logs.find((entry) => entry.msg.includes("Cache get failed"));
      expect(line?.level).toBe("warn");
      expect(String(line?.data?.["error"])).toContain(mode === "throw" ? "invocation" : "await");
    },
  );

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

  it.each(["throw", "reject"] as const)(
    "keeps cache writes best-effort when Redis set %ss",
    async (mode) => {
      const base = createMockRedis().redis;
      const redis: RedisPort = {
        ...base,
        set: mode === "throw"
          ? () => { throw new Error("set invocation escaped"); }
          : async () => Promise.reject(new Error("set await escaped")),
      };
      const { logger, logs } = collectLogs();
      const cache = createNamespacedCache(redis, testTenant, testDagId, undefined, logger);

      expect(await cache.set("hostile-set", { safe: true })).toEqual(ok(undefined));
      const line = logs.find((entry) => entry.msg.includes("Cache set failed"));
      expect(line?.level).toBe("warn");
      expect(String(line?.data?.["error"])).toContain(mode === "throw" ? "invocation" : "await");
    },
  );

  it("cache fallback outcomes survive a throwing logger and report through guarded stderr", async () => {
    const diagnostics: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown): boolean => {
      diagnostics.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
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
      expect(diagnostics.some((line) => line.includes("[host diagnostic fallback]"))).toBe(true);
      expect(diagnostics.some((line) => line.includes("logger failed"))).toBe(true);
    } finally {
      process.stderr.write = originalWrite;
    }
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

  it("rejects top-level undefined, function, and symbol before calling Redis", async () => {
    const { redis, calls } = createMockRedis();
    const { logger, logs } = collectLogs();
    const cache = createNamespacedCache(redis, testTenant, testDagId, undefined, logger);

    for (const [key, value] of [
      ["undefined", undefined],
      ["function", () => "not-json"],
      ["symbol", Symbol("not-json")],
    ] as const) {
      expect((await cache.set(key, value)).ok).toBe(true);
    }

    expect(calls.filter((call) => call.op === "set")).toHaveLength(0);
    const diagnostics = logs.filter((line) => line.msg.includes("not serializable"));
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.every((line) => String(line.data?.["error"]).includes("returned undefined")))
      .toBe(true);
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
    const { ctx } = await createTestContext({ shared });

    expect(ctx.http).not.toBeNull();
    // The presence check `ctx.http != null` is exactly what
    // `validateCapabilities` gates a `requires: ["http"]` node on.
    expect(typeof ctx.http?.get).toBe("function");
    expect(typeof ctx.http?.post).toBe("function");
  });

  it("leaves http null when no http handle is wired (documents the gap the wiring closes)", async () => {
    const shared = baseSharedInfra([]);
    const { ctx } = await createTestContext({ shared });

    expect(ctx.http).toBeNull();
  });

  // Regression guard: main.ts wires `{ name: "clock", client: systemClock }`
  // into `sharedInfra.capabilities`. If that wiring is dropped, `ctx.clock` is
  // null and any `requires: ["clock"]` DAG (e.g. golden example 09) fails the
  // boot-time capability check — exactly the gap the prior pass left when it
  // migrated the clock from a factory seam to a capability without host wiring.
  it("surfaces a usable clock when the handle is wired into capabilities", async () => {
    const shared = baseSharedInfra([{ name: "clock", client: systemClock }]);
    const { ctx } = await createTestContext({ shared });

    expect(ctx.clock).not.toBeNull();
    // The presence check `ctx.clock != null` is what `validateCapabilities`
    // gates a `requires: ["clock"]` node on.
    expect(typeof ctx.clock?.now).toBe("function");
    expect(ctx.clock?.now()).toBeInstanceOf(Date);
  });

  it("leaves clock null when no clock handle is wired (documents the gap the wiring closes)", async () => {
    const shared = baseSharedInfra([]);
    const { ctx } = await createTestContext({ shared });

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
    ...baseSharedInfra(),
    redis: createMockRedis(store).redis,
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

  const sharedWithLlm = (llm: LlmClient): SharedInfra => ({ ...baseSharedInfra(), llm });


  it("wraps the shared LLM client — ctx.llm is the metered decorator, NOT the shared reference", async () => {
    const { llm } = fakeLlm(10, 5);
    const shared = sharedWithLlm(llm);

    const { ctx } = await createTestContext({ shared });

    // If the factory ever stops wrapping (handing the shared client through
    // unmetered), this reference check is the loudest possible regression guard.
    expect(ctx.llm).not.toBe(shared.llm);
    expect(ctx.llm).not.toBeNull();
  });

  it("threads dag.config.llmBudgetTokens into the decorator: a tiny budget refuses the SECOND call with llm-budget-exceeded", async () => {
    const { llm, calls } = fakeLlm(10, 5); // 15 tokens/call
    const shared = sharedWithLlm(llm);
    const dag = makeDag({ llmBudgetTokens: 1 }); // budget 1: call 1 is the single overshoot

    const { ctx } = await createTestContext({ shared, dag });
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

    const { ctx } = await createTestContext({ shared, dag });
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

    const { ctx } = await createTestContext({ shared, dag });
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

    const { ctx } = await createTestContext({ shared, dag });
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

    const { ctx } = await createTestContext({ shared });
    if (ctx.llm === null) throw new Error("expected wired llm");

    for (let i = 0; i < 3; i++) {
      expect((await ctx.llm.sendStructured(structuredReq())).ok).toBe(true);
    }
    expect(calls.length).toBe(3); // all delegated — no budget, no refusal
  });
});

describe("createNodeContextForDag — one authority across main/judge/custom LLM clients", () => {
  it("accumulates every marked client into one budget view and one ceiling", async () => {
    const main = fakeLlm(10, 5);
    const judge = fakeLlm(10, 5);
    const critic = fakeLlm(10, 5);
    const captured = collectLogs();
    const shared: SharedInfra = {
      ...baseSharedInfra([
        { name: "judgeLlm", client: judge.llm, clientKind: "llm" },
        { name: "criticLlm", client: critic.llm, clientKind: "llm" },
      ]),
      llm: main.llm,
      logger: captured.logger,
    };
    const { ctx } = await createNodeContextForDag(
      shared,
      makeDag({ llmBudgetTokens: 45 }),
      testRunId,
      new AbortController().signal,
      adminIdentity,
      FACTORY_AGENT_MAP,
    );
    if (ctx.llm === null || ctx.judgeLlm === null || ctx.budget === null) {
      throw new Error("expected all built-in clients");
    }
    const criticClient = (ctx as NodeContext & { readonly criticLlm: LlmClient }).criticLlm;

    expect(ctx.judgeLlm).not.toBe(judge.llm);
    expect(criticClient).not.toBe(critic.llm);
    expect((await ctx.llm.sendStructured(structuredReq())).ok).toBe(true);
    expect((await ctx.judgeLlm.sendStructured(structuredReq())).ok).toBe(true);
    expect((await criticClient.sendStructured(structuredReq())).ok).toBe(true);
    expect(ctx.budget.spent().tokens).toBe(45);
    expect(ctx.budget.remaining()).toEqual({
      kind: "budgeted",
      basis: "projected",
      headroom: [{
        kind: "available",
        unit: "tokens",
        ceiling: { kind: "tokens", limit: 45 },
        amount: 0,
      }],
    });

    const refused = await ctx.llm.sendStructured(structuredReq());
    expect(refused.ok).toBe(false);
    expect(main.calls).toHaveLength(1);
    expect(judge.calls).toHaveLength(1);
    expect(critic.calls).toHaveLength(1);
    expect(
      captured.logs
        .filter((line) => line.msg === "llm.metered")
        .map((line) => line.data?.clientKey),
    ).toEqual(["llm", "judgeLlm", "criticLlm"]);
  });

  it("composes an augmented alias from the metered surface and enforces the shared gate", async () => {
    let providerCalls = 0;
    const augmented: AugmentedLlmClient = {
      sendStructured: async <O>(): Promise<Result<LlmResponse<O>, FrameworkError>> => {
        providerCalls += 1;
        return ok({ output: {} as O, ...tokensOnly(3, 2), rawText: "" });
      },
      sendWithTools: async <O>(): Promise<Result<LlmResponse<O>, FrameworkError>> => {
        providerCalls += 1;
        return ok({ output: {} as O, ...tokensOnly(3, 2), rawText: "" });
      },
      // This boot-scoped self-call is exactly what a transparent target-bound
      // Proxy failed to intercept. The run facade below must not expose it.
      sendAlias(req) { return this.sendStructured(req); },
    };
    const shared = baseSharedInfra([{
      name: "augmentedLlm",
      client: augmented,
      clientKind: "llm",
      composeRunClient: (metered): AugmentedLlmClient => ({
        sendStructured: (req) => metered.sendStructured(req),
        sendWithTools: (req, ctx) => metered.sendWithTools(req, ctx),
        sendAlias: (req) => metered.sendStructured(req),
      }),
    }]);
    const captured = collectLogs();
    const { ctx } = await createTestContext({
      shared: { ...shared, logger: captured.logger },
      dag: makeDag({ llmBudget: { tokens: 5 } }),
    });
    const runClient = (ctx as NodeContext & { readonly augmentedLlm: AugmentedLlmClient })
      .augmentedLlm;

    expect(runClient).not.toBe(augmented);
    expect((await runClient.sendAlias(structuredReq())).ok).toBe(true);
    const refused = await runClient.sendAlias(structuredReq());
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.kind).toBe("llm-budget-exceeded");
    expect(providerCalls).toBe(1);
    expect(ctx.budget?.spent().tokens).toBe(5);
    expect(
      captured.logs.filter((line) => line.msg === "llm.metered")[0]?.data?.["clientKey"],
    ).toBe("augmentedLlm");
  });

  it("rehydrates a main+judge total from a fresh file ledger/context and refuses the next call", async () => {
    const root = mkdtempSync(join(tmpdir(), "fugue-context-file-ledger-"));
    try {
      const fileLedger = createFileSpendLedger(root);
      if (!fileLedger.ok) throw new Error("expected file ledger");
      const main = fakeLlm(10, 5);
      const judge = fakeLlm(10, 5);
      const shared: SharedInfra = {
        ...baseSharedInfra([{ name: "judgeLlm", client: judge.llm, clientKind: "llm" }]),
        llm: main.llm,
        spendLedger: fileLedger.value,
      };
      const dag = makeDag({ llmBudgetTokens: 30 });
      const first = await createNodeContextForDag(
        shared,
        dag,
        testRunId,
        new AbortController().signal,
        adminIdentity,
        FACTORY_AGENT_MAP,
      );
      if (first.ctx.llm === null || first.ctx.judgeLlm === null) throw new Error("expected LLMs");
      expect((await first.ctx.llm.sendStructured(structuredReq())).ok).toBe(true);
      expect((await first.ctx.judgeLlm.sendStructured(structuredReq())).ok).toBe(true);

      const freshLedger = createFileSpendLedger(root);
      if (!freshLedger.ok) throw new Error("expected fresh file ledger");
      const resumed = await createNodeContextForDag(
        { ...shared, spendLedger: freshLedger.value },
        dag,
        testRunId,
        new AbortController().signal,
        adminIdentity,
        FACTORY_AGENT_MAP,
      );
      if (resumed.ctx.llm === null || resumed.ctx.budget === null) throw new Error("expected context");
      expect(resumed.ctx.budget.spent().tokens).toBe(30);
      expect((await resumed.ctx.llm.sendStructured(structuredReq())).ok).toBe(false);
      expect(main.calls).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("always injects an unbudgeted read view when no ceilings are declared", async () => {
    const main = fakeLlm(2, 1);
    const { ctx } = await createNodeContextForDag(
      { ...baseSharedInfra(), llm: main.llm },
      makeDag(),
      testRunId,
      new AbortController().signal,
      adminIdentity,
      FACTORY_AGENT_MAP,
    );
    if (ctx.llm === null || ctx.budget === null) throw new Error("expected metered context");
    expect(ctx.budget.remaining()).toEqual({ kind: "unbudgeted" });
    await ctx.llm.sendStructured(structuredReq());
    expect(ctx.budget.spent().tokens).toBe(3);
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
  const sharedWith = (llm: LlmClient, ledger: SpendLedgerPort): SharedInfra => ({
    ...baseSharedInfra(),
    llm,
    spendLedger: ledger,
  });

  const ledgerFailureFixture = (behavior: {
    readonly read?: SpendLedgerPort["read"];
    readonly add?: SpendLedgerPort["add"];
  }): SpendLedgerPort => ({
    metadata: memoryLedgerMetadata,
    read: behavior.read ?? (async () => ok(NO_SPEND)),
    add: behavior.add ?? (async () => ok(undefined)),
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
    const broken = ledgerFailureFixture({
      read: async () => err({ kind: "redis-unavailable", operation: "spend-ledger read" }),
    });
    const { llm } = fakeLlm(10, 5);
    const shared = sharedWith(llm, broken);

    await expect(
      sliceFor(shared, makeDag({ llmBudget: { tokens: 1000 } })),
    ).rejects.toThrow(/could not be read/);
  });

  it("REFUSES a BUDGETED slice when the ledger rejects across its Result boundary", async () => {
    const rejecting = ledgerFailureFixture({
      read: async () => { throw new Error("ledger transport rejected"); },
    });
    const { llm } = fakeLlm(10, 5);

    await expect(
      sliceFor(sharedWith(llm, rejecting), makeDag({ llmBudget: { tokens: 1000 } })),
    ).rejects.toThrow(/SpendLedgerPort\.read threw.*ledger transport rejected/);
  });

  it("RUNS an UNBUDGETED run whose ledger cannot be read", async () => {
    // There is no ceiling to protect, so failing the slice would turn a
    // metering outage into an availability outage. Metering degrades; the run
    // proceeds.
    const broken = ledgerFailureFixture({
      read: async () => err({ kind: "redis-unavailable", operation: "spend-ledger read" }),
    });
    const { llm, calls } = fakeLlm(10, 5);
    const captured = collectLogs();
    const shared = { ...sharedWith(llm, broken), logger: captured.logger };

    const slice = await sliceFor(shared, makeDag());
    expect((await slice.sendStructured(structuredReq())).ok).toBe(true);

    // Degrading is not the same as staying quiet. This is the fail-OPEN branch
    // of FR-B-007, and it was the last diagnostic in this feature that nothing
    // asserted — a future refactor could have dropped it silently.
    const warned = captured.logs.find((l) => l.msg.includes("Spend ledger unreadable"));
    expect(warned).toBeDefined();
    expect(warned?.level).toBe("warn");
    expect(warned?.data?.["runId"]).toBe(testRunId as string);
    expect(String(warned?.data?.["error"] ?? "")).toContain("spend-ledger read");
    expect(calls.length).toBe(1);
  });

  it("RUNS an UNBUDGETED slice when the ledger rejects and reports metering-from-zero", async () => {
    const rejecting = ledgerFailureFixture({
      read: async () => { throw new Error("ledger transport rejected"); },
    });
    const { llm, calls } = fakeLlm(10, 5);
    const captured = collectLogs();
    const shared = { ...sharedWith(llm, rejecting), logger: captured.logger };

    const slice = await sliceFor(shared, makeDag());
    expect((await slice.sendStructured(structuredReq())).ok).toBe(true);
    expect(calls).toHaveLength(1);

    const warned = captured.logs.find((line) => line.msg.includes("Spend ledger unreadable"));
    expect(warned?.level).toBe("warn");
    expect(String(warned?.data?.["error"] ?? "")).toContain("SpendLedgerPort.read threw");
    expect(String(warned?.data?.["error"] ?? "")).toContain("ledger transport rejected");
  });

  it("does not fail a call when the ledger APPEND fails — the tokens are already spent", async () => {
    // Refusing the result would waste the call and lose the output too. What is
    // lost is durability, and that is what gets logged.
    const writeOnlyFailure = ledgerFailureFixture({
      add: async () => err({ kind: "redis-unavailable", operation: "spend-ledger add" }),
    });
    const { llm, calls } = fakeLlm(10, 5);
    const shared = sharedWith(llm, writeOnlyFailure);

    const slice = await sliceFor(shared, makeDag({ llmBudget: { tokens: 1000 } }));
    expect((await slice.sendStructured(structuredReq())).ok).toBe(true);
    expect(calls.length).toBe(1);
  });
});

// ── Spend-ledger backend authority and fallback invariants ──────────────────
//
// An explicitly injected authoritative ledger is never displaced. Stock memory
// wiring selects Redis when its complete append surface is available; otherwise
// it remains an honest process-local fallback and emits the durability loss.
describe("createNodeContextForDag — which spend ledger a run actually gets", () => {
  /**
   * A `RedisPort` that CAN back the ledger. The default `createMockRedis`
   * deliberately cannot, so the two fixtures together cover both branches.
   */
  const capableRedis = () => {
    const hashes = new Map<string, Map<string, number>>();
    const sets = new Map<string, Set<string>>();
    const seen: string[] = [];
    const base = createMockRedis().redis;
    const redis = {
      ...base,
      hIncrBy: async (key: string, field: string, by: number) => {
        seen.push(key);
        const hash = hashes.get(key) ?? new Map<string, number>();
        hash.set(field, (hash.get(field) ?? 0) + by);
        hashes.set(key, hash);
        return ok(hash.get(field) ?? 0);
      },
      hGetAll: async (key: string) =>
        ok(Object.fromEntries([...(hashes.get(key) ?? new Map())].map(([f, v]) => [f, String(v)]))),
      expire: async () => ok(true),
      sAdd: async (key: string, member: string) => {
        const set = sets.get(key) ?? new Set<string>();
        set.add(member);
        sets.set(key, set);
        return ok(1);
      },
      sMembers: async (key: string) => ok([...(sets.get(key) ?? new Set<string>())]),
    } as unknown as RedisPort;
    return { redis, hashes, seen };
  };

  const sharedWithRedis = (llm: LlmClient, redis: RedisPort, logger: LogPort): SharedInfra => ({
    ...baseSharedInfra(),
    llm,
    redis,
    logger,
  });

  it("DOWNGRADES loudly when the Redis adapter cannot back the ledger", async () => {
    // A durability downgrade is observable through exactly one asserted error log.
    const { llm } = fakeLlm(10, 5);
    const captured = collectLogs();
    const shared = sharedWithRedis(llm, createMockRedis().redis, captured.logger);

    await createNodeContextForDag(
      shared, makeDag(), testRunId, new AbortController().signal, adminIdentity, FACTORY_AGENT_MAP,
    );

    const line = captured.logs.find((l) => l.msg.includes("Spend ledger is NOT durable"));
    expect(line).toBeDefined();
    expect(line?.level).toBe("error");
    const reason = String(line?.data?.["reason"] ?? "");
    for (const primitive of ["hIncrBy", "hGetAll", "expire"]) {
      expect(reason).toContain(primitive);
    }
    expect(String(line?.data?.["consequence"] ?? "")).toContain("restart");
    expect(line?.data?.["dagId"]).toBe(testDagId as string);
  });

  it("keeps an explicitly injected file ledger authoritative even when Redis is capable", async () => {
    const root = mkdtempSync(join(tmpdir(), "fugue-authoritative-file-ledger-"));
    try {
      const fileLedger = createFileSpendLedger(root);
      if (!fileLedger.ok) throw new Error("expected file ledger");
      const { llm } = fakeLlm(10, 5);
      const captured = collectLogs();
      const capable = capableRedis();
      const shared: SharedInfra = {
        ...sharedWithRedis(llm, capable.redis, captured.logger),
        spendLedger: fileLedger.value,
      };

      const { ctx } = await createNodeContextForDag(
        shared, makeDag(), testRunId, new AbortController().signal, adminIdentity, FACTORY_AGENT_MAP,
      );
      if (ctx.llm === null) throw new Error("expected wired llm");
      expect((await ctx.llm.sendStructured(structuredReq())).ok).toBe(true);

      expect(capable.seen).toHaveLength(0);
      expect(captured.logs.some((line) => line.msg.includes("NOT durable"))).toBe(false);
      const recorded = await fileLedger.value.read(testRunId);
      expect(recorded.ok).toBe(true);
      if (recorded.ok) expect(recorded.value.tokens).toBe(15);
      expect(fileLedger.value.metadata).toEqual({
        role: "authoritative",
        backend: "file",
        durability: "restart",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the REDIS-backed ledger when the adapter offers the primitives", async () => {
    // The `ok` branch, previously reached by no test anywhere. Asserting the
    // spend lands in Redis also proves the tenant/dag namespace was threaded
    // correctly into `createRedisSpendLedger` — a swapped argument there would
    // be invisible to every other test in this file.
    const { llm } = fakeLlm(10, 5);
    const captured = collectLogs();
    const capable = capableRedis();
    const shared = sharedWithRedis(llm, capable.redis, captured.logger);

    const { ctx } = await createNodeContextForDag(
      shared, makeDag(), testRunId, new AbortController().signal, adminIdentity, FACTORY_AGENT_MAP,
    );
    if (ctx.llm === null) throw new Error("expected wired llm");
    await ctx.llm.sendStructured(structuredReq());

    expect(captured.logs.some((l) => l.msg.includes("NOT durable"))).toBe(false);
    // The spend reached REDIS, not the SharedInfra fallback.
    expect(capable.seen.length).toBeGreaterThan(0);
    for (const key of capable.seen) {
      expect(key.startsWith("fugue:eng:test-dag:")).toBe(true);
      expect(key.endsWith("$spend")).toBe(true);
    }
    // And NOT the fallback: an in-memory ledger's `read` never errs, so
    // asserting `.ok` here would have been vacuous. What distinguishes the two
    // backends is the VALUE — the fallback must still hold NO_SPEND, because
    // every append went to Redis.
    const fallback = await shared.spendLedger.read(testRunId);
    expect(fallback.ok).toBe(true);
    if (!fallback.ok) return;
    expect(fallback.value).toEqual(NO_SPEND);
  });

  it("hydrates a resumed slice from the REDIS ledger, not from zero", async () => {
    // The park/resume guarantee, over the durable backend rather than the
    // in-process stand-in the other durability tests use.
    const { llm, calls } = fakeLlm(10, 5); // 15 tokens/call
    const capable = capableRedis();
    const shared = sharedWithRedis(llm, capable.redis, collectLogs().logger);
    const dag = makeDag({ llmBudget: { tokens: 40 } });

    const slice = async () => {
      const { ctx } = await createNodeContextForDag(
        shared, dag, testRunId, new AbortController().signal, adminIdentity, FACTORY_AGENT_MAP,
      );
      if (ctx.llm === null) throw new Error("expected wired llm");
      return ctx.llm;
    };

    const first = await slice();
    expect((await first.sendStructured(structuredReq())).ok).toBe(true);
    expect((await first.sendStructured(structuredReq())).ok).toBe(true);
    expect((await first.sendStructured(structuredReq())).ok).toBe(true); // 45, the overshoot
    expect(calls.length).toBe(3);

    const second = await slice();
    const refused = await second.sendStructured(structuredReq());
    expect(refused.ok).toBe(false);
    if (!refused.ok && refused.error.kind === "llm-budget-exceeded") {
      expect(observedOf(refused.error.cause)).toBe(45);
    } else {
      throw new Error("expected the resumed slice to refuse from Redis-held spend");
    }
    expect(calls.length).toBe(3);
  });
});
