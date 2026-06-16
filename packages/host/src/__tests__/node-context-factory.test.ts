/**
 * Unit tests for node-context-factory.ts
 *
 * Tests resolveTtl, createNamespacedCache (error degradation, corrupted JSON),
 * and createNamespacedCheckpointWriter (best-effort writes).
 */

import { describe, it, expect } from "bun:test";
import { ok, err, dagId, runId as makeRunId, nodeId as makeNodeId, gitSha, noopTracer, createHttpCapability, systemClock } from "@fuguejs/framework";
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
import type { RegisteredDag } from "../domain/registry.js";
import { z } from "zod";
import {
  resolveTtl,
  createNamespacedCache,
  createNamespacedCheckpointWriter,
  createNodeContextForDag,
  invocationOriginForIdentity,
  buildCacheKey,
  buildCheckpointKey,
} from "../adapters/node-context-factory.js";
import { subjectTokenForIdentity } from "../domain/run-context.js";
import { markSubjectToken, type AuthIdentity, type SubjectToken } from "../domain/auth.js";

// Existing pass-through / wiring tests are identity-agnostic — an admin identity
// reproduces the prior `agent`-keyed origin (admin/team → agent placeholder), so
// their byte-identical assertions are unaffected.
const adminIdentity: AuthIdentity = { kind: "admin" };

// ── Helpers ────────────────────────────────────────────────────────────────

const testDagId = dagId("test-dag");
const testRunId = makeRunId("run-001");
const testNodeId = makeNodeId("node-a");

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
    const cache = createNamespacedCache(redis, testDagId, undefined, logger);

    const result = await cache.get("my-key");
    expect(result).toEqual({ hit: false });
  });

  it("returns cache hit with deserialized value", async () => {
    const store = new Map([
      [buildCacheKey(testDagId, "my-key"), JSON.stringify({ data: 42 })],
    ]);
    const { redis } = createMockRedis(store);
    const { logger } = collectLogs();
    const cache = createNamespacedCache(redis, testDagId, undefined, logger);

    const result = await cache.get("my-key");
    expect(result).toEqual({ hit: true, value: { data: 42 } });
  });

  it("gracefully degrades to miss on Redis get failure", async () => {
    const { logger, logs } = collectLogs();
    const cache = createNamespacedCache(failingRedis(), testDagId, undefined, logger);

    const result = await cache.get("any-key");
    expect(result).toEqual({ hit: false });
    expect(logs.some(l => l.level === "warn" && l.msg.includes("Cache get failed"))).toBe(true);
  });

  it("treats corrupted JSON as cache miss", async () => {
    const store = new Map([
      [buildCacheKey(testDagId, "bad"), "not-json{{{"],
    ]);
    const { redis } = createMockRedis(store);
    const { logger, logs } = collectLogs();
    const cache = createNamespacedCache(redis, testDagId, undefined, logger);

    const result = await cache.get("bad");
    expect(result).toEqual({ hit: false });
    expect(logs.some(l => l.msg.includes("corrupted"))).toBe(true);
  });

  it("set writes serialized value to Redis", async () => {
    const store = new Map<string, string>();
    const { redis } = createMockRedis(store);
    const { logger } = collectLogs();
    const cache = createNamespacedCache(redis, testDagId, undefined, logger);

    await cache.set("k", { value: "hello" });
    const expectedKey = buildCacheKey(testDagId, "k");
    expect(store.get(expectedKey)).toBe(JSON.stringify({ value: "hello" }));
  });

  it("set is best-effort — returns ok on Redis failure", async () => {
    const { logger, logs } = collectLogs();
    const cache = createNamespacedCache(failingRedis(), testDagId, undefined, logger);

    const result = await cache.set("k", "v");
    expect(result.ok).toBe(true);
    expect(logs.some(l => l.level === "warn" && l.msg.includes("Cache set failed"))).toBe(true);
  });

  it("set handles non-serializable values gracefully", async () => {
    const { redis } = createMockRedis();
    const { logger, logs } = collectLogs();
    const cache = createNamespacedCache(redis, testDagId, undefined, logger);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = await cache.set("k", circular);
    expect(result.ok).toBe(true);
    expect(logs.some(l => l.msg.includes("not serializable"))).toBe(true);
  });

  it("escalates to error level after consecutive failures", async () => {
    const { logger, logs } = collectLogs();
    const cache = createNamespacedCache(failingRedis(), testDagId, undefined, logger);

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
    const writer = createNamespacedCheckpointWriter(redis, testDagId, testRunId, undefined, logger);

    await writer.write(testRunId, testNodeId, { output: "done" });

    const expectedKey = buildCheckpointKey(testDagId, testRunId, testNodeId);
    expect(store.get(expectedKey)).toBe(JSON.stringify({ output: "done" }));
  });

  it("best-effort — does not throw on Redis failure", async () => {
    const { logger, logs } = collectLogs();
    const writer = createNamespacedCheckpointWriter(failingRedis(), testDagId, testRunId, undefined, logger);

    // Should not throw
    await writer.write(testRunId, testNodeId, { data: 1 });
    expect(logs.some(l => l.msg.includes("Checkpoint write failed"))).toBe(true);
  });

  it("handles non-serializable values gracefully", async () => {
    const { redis } = createMockRedis();
    const { logger, logs } = collectLogs();
    const writer = createNamespacedCheckpointWriter(redis, testDagId, testRunId, undefined, logger);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await writer.write(testRunId, testNodeId, circular);
    expect(logs.some(l => l.msg.includes("not serializable"))).toBe(true);
  });
});

// ── Built-in http capability wiring (ADR-0051) ──────────────────────────────

describe("createNodeContextForDag — built-in http capability", () => {
  const baseSharedInfra = (
    capabilities: SharedInfra["capabilities"],
  ): SharedInfra => ({
    llm: { chat: async () => ({ content: "", usage: { inputTokens: 0, outputTokens: 0 } }) } as any,
    redis: createMockRedis().redis,
    tracer: noopTracer,
    contentFilter: null,
    prompts: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    capabilities,
  });

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

// ── Static client wiring (SC-005 zero-regression) ───────────────────────────

describe("createNodeContextForDag — static client wiring (SC-005)", () => {
  const baseSharedInfra = (
    capabilities: SharedInfra["capabilities"],
  ): SharedInfra => ({
    llm: { chat: async () => ({ content: "", usage: { inputTokens: 0, outputTokens: 0 } }) } as any,
    redis: createMockRedis().redis,
    tracer: noopTracer,
    contentFilter: null,
    prompts: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    capabilities,
  });

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
        return ok({ output: {} as O, tokensIn, tokensOut, rawText: "" });
      },
      sendWithTools: async <O>(req: SendWithToolsRequest<O>, _ctx: NodeContext): Promise<Result<LlmResponse<O>, FrameworkError>> => {
        calls.push(req.nodeId);
        return ok({ output: {} as O, tokensIn, tokensOut, rawText: "" });
      },
    };
    return { llm, calls };
  };

  const sharedWithLlm = (llm: LlmClient): SharedInfra => ({
    llm,
    redis: createMockRedis().redis,
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
        expect(r2.error.budget).toBe(1); // the dag.config value, threaded through
        expect(r2.error.cumulative).toBe(15); // settled tokens from call 1
        expect(r2.error.runId).toBe(testRunId);
      }
    }
    // The refused call never reached the inner client (no network round trip).
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
    const baseSharedInfra = (): SharedInfra => ({
      llm: { chat: async () => ({ content: "", usage: { inputTokens: 0, outputTokens: 0 } }) } as any,
      redis: createMockRedis().redis,
      tracer: noopTracer,
      contentFilter: null,
      prompts: null,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      capabilities: [],
    });
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

  it("FR-040 fail-closed: the factory REFUSES (throws) a DAG with no agent client mapping — never mints an absent identity", async () => {
    const baseSharedInfra = (): SharedInfra => ({
      llm: { chat: async () => ({ content: "", usage: { inputTokens: 0, outputTokens: 0 } }) } as any,
      redis: createMockRedis().redis,
      tracer: noopTracer,
      contentFilter: null,
      prompts: null,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      capabilities: [],
    });
    const shared = baseSharedInfra();
    // Empty map (the safe default) → the DAG has no agent client → fail closed.
    const promise = createNodeContextForDag(
      shared,
      makeDag(),
      testRunId,
      new AbortController().signal,
      adminIdentity,
      {},
    );
    await expect(promise).rejects.toThrow(/no agent client mapping/);
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
  const baseSharedInfra = (): SharedInfra => ({
    llm: { chat: async () => ({ content: "", usage: { inputTokens: 0, outputTokens: 0 } }) } as any,
    redis: createMockRedis().redis,
    tracer: noopTracer,
    contentFilter: null,
    prompts: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    capabilities: [],
  });

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
      (rid) => bound.push(rid),
    );
    // No token to bind → the broker's user exchange fails closed for this run.
    expect(bound).toEqual([]);
  });
});
