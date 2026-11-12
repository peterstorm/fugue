import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Redis from "ioredis";
import { z } from "zod";
import {
  DAG_INPUT, dagId, createFetchNode, createMapNode, createTransformNode, defineDag, err, fixedClock,
  fromJson, nodeId, ok, runDag, runId, tokensOnly,
  InMemoryCheckpointer, makeNodeContext, fanConcurrencyCap, formatFrameworkError,
} from "@fuguejs/framework";
import type {
  Capability, CapabilityBroker, DagDef, FanConcurrencyCap, FanEstimator, FrameworkError, Invocation, LlmClient,
  MintingAuthority, NodeContext, ObserverEvent, Result,
} from "@fuguejs/framework";
import { createNodeContextForDag } from "../../adapters/node-context-factory.js";
import { createRedisConnectivity } from "../../adapters/redis-connectivity.js";
import type { NodeContextForDag } from "../../domain/run-context.js";
import type { AuthIdentity } from "../../domain/auth.js";
import { buildCacheKey, buildCheckpointKey, buildCheckpointNodesKey, buildSpendKey } from "../../domain/cache-keys.js";
import { parseHostConfig } from "../../domain/config.js";
import type { RegisteredDag } from "../../domain/registry.js";
import { syncRunOptions } from "../../host.js";
import { mappedTestTenant, mappedHostInfra, registeredMapDag, RUN_RETENTION_SEC, CHECKPOINT_TTL_SEC } from "../fixtures/mapped-host.js";

interface MappedReader { readonly read: (n: number) => Promise<number> }
interface MappedLlm extends LlmClient { readonly critique: LlmClient["sendStructured"] }
declare module "@fuguejs/framework" {
  interface CapabilityRegistry {
    "mapped:read": MappedReader;
    "mapped:llm": MappedLlm;
  }
}

const redisUrl = process.env.REDIS_URL;
const numbers = z.array(z.number());
const items = z.object({ items: numbers });
const fanOf = (child: DagDef) => createMapNode({
  id: "fan", inputSchema: items, outputSchema: numbers,
  widthFrom: "items", maxWidth: 4, child, childOutputSchema: z.number(), reduce: (xs) => ok([...xs]),
});
const outerOf = (child: DagDef) => defineDag({
  id: "mapped-root", nodes: { fan: fanOf(child) }, edges: [{ from: DAG_INPUT, to: "fan" }], outputNodeId: "fan",
});
const mintingFor = (built: NodeContextForDag, broker: CapabilityBroker): MintingAuthority => {
  if (built.origin === undefined) throw new Error("Host failed to select root origin");
  return { origin: built.origin, broker, meterLlm: built.meterMintedLlm };
};
const live = async (test: (resources: {
  readonly infra: ReturnType<typeof mappedHostInfra>;
  readonly redis: Redis;
  readonly tenant: ReturnType<typeof mappedTestTenant>;
}) => Promise<void>) => {
  const connected = await createRedisConnectivity(redisUrl!);
  if (!connected.ok) throw new Error(JSON.stringify(connected.error));
  const redis = new Redis(redisUrl!);
  const tenant = mappedTestTenant(`map-host-${crypto.randomUUID()}`);
  try { await test({ infra: mappedHostInfra(connected.value.redis), redis, tenant }); }
  finally {
    const keys = await redis.keys(`fugue:${tenant}:*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
    await connected.value.disconnect();
  }
};

describe.skipIf(!redisUrl)("mapped child composition — actual host factory + runtime + Redis", () => {
  const identities: readonly AuthIdentity[] = [
    { kind: "admin" },
    { kind: "user", sub: "alice", azp: "frontend-must-not-become-agent", canRunDag: () => true },
  ];
  for (const identity of identities) {
    for (const policy of ["deliver", "deny-static"] as const) {
      it(`${identity.kind}/${policy}: direct and mapped child dispatch retain root origin without widening map requirements`, async () => live(async ({ infra, tenant }) => {
        const egress: number[] = [];
        const reader: MappedReader = { read: async (n) => { egress.push(n); return n * 2; } };
        const child = defineDag({
          id: "mapped-child", nodes: { read: createFetchNode({
            id: "read", inputSchema: z.number(), outputSchema: z.number(), requires: ["mapped:read"] as const,
            fetch: async (n, ctx) => ok(await ctx["mapped:read"].read(n)),
          }) }, edges: [{ from: DAG_INPUT, to: "read" }], outputNodeId: "read",
        });
        const outer = outerOf(child);
        const calls: { readonly inv: Invocation; readonly requires: readonly Capability[] }[] = [];
        const broker: CapabilityBroker = {
          provides: (cap) => cap === "mapped:read",
          mintFor: async (inv, requires) => {
            calls.push({ inv, requires });
            if (!requires.includes("mapped:read")) return ok({});
            return policy === "deny-static"
              ? err({ kind: "downstream-denied", resource: "mapped-reader", reason: "fixture policy" })
              : ok({ "mapped:read": { clientKind: "non-llm", client: reader } });
          },
        };
        const shared = policy === "deny-static"
          ? { ...infra, capabilities: [{ name: "mapped:read" as const, client: reader }] }
          : infra;
        for (const shape of ["direct", "mapped"] as const) {
          const dag = shape === "direct" ? child : outer;
          const id = runId(`${shape}-${crypto.randomUUID()}`);
          const built = await createNodeContextForDag(shared, registeredMapDag(dag, tenant), id, new AbortController().signal, identity, {
            routedTenant: tenant, mintingActive: true, agentClientMap: { [dag.id]: "host-root-agent" },
          });
          if (policy === "deliver") expect(Object.hasOwn(built.ctx, "mapped:read")).toBe(false);
          const start = calls.length;
          const result = await runDag(dag, shape === "direct" ? 3 : { items: [3, 4] }, built.ctx, { minting: mintingFor(built, broker) });
          if (policy === "deliver") expect(result).toMatchObject({ ok: true, value: shape === "direct" ? 6 : [6, 8] });
          else expect(result).toMatchObject({ ok: false, error: { kind: "downstream-denied" } });
          const invocations = calls.slice(start);
          const childCalls = invocations.filter(({ inv }) => inv.nodeId === "read");
          expect(childCalls).toHaveLength(shape === "mapped" && policy === "deliver" ? 2 : 1);
          for (const { inv, requires } of childCalls) {
            expect(inv).toEqual({ runId: id, dagId: dagId("mapped-child"), nodeId: nodeId("read"), origin: identity.kind === "user"
              ? { kind: "user", sub: "alice", agentClientId: "host-root-agent" }
              : { kind: "agent", agentClientId: "host-root-agent" } });
            expect(requires).toEqual(["mapped:read"]);
          }
          expect(invocations.filter(({ inv }) => inv.nodeId === "fan").map(({ requires }) => requires))
            .toEqual(shape === "mapped" ? [["checkpointer"]] : []);
          if (shape === "mapped" && policy === "deliver") {
            const replay = await runDag(dag, { items: [3, 4] }, built.ctx, { minting: mintingFor(built, broker) });
            expect(replay).toMatchObject({ ok: true, value: [6, 8] });
            expect(calls.slice(start).filter(({ inv }) => inv.nodeId === "read")).toHaveLength(2);
          }
        }
        expect(egress).toEqual(policy === "deliver" ? [3, 3, 4] : []);
      }));
    }
  }

  it("missing child capability fails before the outer predecessor, even for an empty fan", async () => live(async ({ infra, tenant }) => {
    let predecessorCalls = 0;
    const child = defineDag({
      id: "missing-child", nodes: { read: createFetchNode({
        id: "read", inputSchema: z.number(), outputSchema: z.number(), requires: ["mapped:read"] as const,
        fetch: async (n, ctx) => ok(await ctx["mapped:read"].read(n)),
      }) }, edges: [{ from: DAG_INPUT, to: "read" }], outputNodeId: "read",
    });
    const scope = createFetchNode({ id: "scope", inputSchema: items, outputSchema: items, fetch: async (input) => { predecessorCalls++; return ok(input); } });
    const dag = defineDag({ id: "missing-root", nodes: { scope, fan: fanOf(child) }, edges: [{ from: DAG_INPUT, to: "scope" }, { from: "scope", to: "fan" }], outputNodeId: "fan" });
    for (const input of [{ items: [] }, { items: [1] }]) {
      const built = await createNodeContextForDag(infra, registeredMapDag(dag, tenant), runId(crypto.randomUUID()), new AbortController().signal, { kind: "admin" });
      expect(await runDag(dag, input, built.ctx)).toMatchObject({ ok: false, error: { kind: "missing-capability" } });
      expect(predecessorCalls).toBe(0);
    }
  }));

  it("main and broker-delivered aliased child LLMs share one budget and hydrate the same Redis ledger", async () => live(async ({ infra, redis, tenant }) => {
    const egress: string[] = [];
    const provider: LlmClient = {
      sendStructured: async (req) => { egress.push(req.nodeId); return ok({ output: req.schema.parse(7), rawText: "7", ...tokensOnly(10, 5) }); },
      sendWithTools: async (req) => { egress.push(req.nodeId); return ok({ output: req.schema.parse(7), rawText: "7", ...tokensOnly(10, 5) }); },
    };
    const custom: MappedLlm = { ...provider, critique: provider.sendStructured };
    const budgets: NodeContext["budget"][] = [];
    const child = defineDag({ id: "llm-child", nodes: { critique: createFetchNode({
      id: "critique", inputSchema: z.number(), outputSchema: z.number(), requires: ["mapped:llm", "budget"] as const,
      fetch: async (_n, ctx) => {
        budgets.push(ctx.budget);
        const response = await ctx["mapped:llm"].critique({ system: "s", user: "u", model: "gpt-4o", nodeId: nodeId("critique"), schema: z.number() });
        return response.ok ? ok(response.value.output) : response;
      },
    }) }, edges: [{ from: DAG_INPUT, to: "critique" }], outputNodeId: "critique" });
    const main = createFetchNode({ id: "main", inputSchema: z.object({}), outputSchema: items, requires: ["llm", "budget"] as const,
      fetch: async (_input, ctx) => {
        budgets.push(ctx.budget);
        const response = await ctx.llm.sendStructured({ system: "s", user: "u", model: "gpt-4o", nodeId: nodeId("main"), schema: z.number() });
        return response.ok ? ok({ items: [1, 2] }) : response;
      },
    });
    const dag = defineDag({ id: "llm-root", nodes: { main, fan: fanOf(child) }, edges: [{ from: DAG_INPUT, to: "main" }, { from: "main", to: "fan" }], outputNodeId: "fan" });
    const registered = registeredMapDag(dag, tenant);
    const budgeted = { ...registered, config: { ...registered.config, llmBudget: { calls: 3 } } };
    const id = runId(crypto.randomUUID());
    const shared = { ...infra, llm: provider };
    const broker: CapabilityBroker = {
      provides: (cap) => cap === "mapped:llm",
      mintFor: async (_inv, requires) => ok(requires.includes("mapped:llm") ? {
        "mapped:llm": { clientKind: "llm", client: custom, pricingModel: { kind: "request" }, runScopedOperations: { critique: "sendStructured" } },
      } : {}),
    };
    const options = { routedTenant: tenant, resumableRunTtlSec: RUN_RETENTION_SEC, mintingActive: true, agentClientMap: { "llm-root": "host-root-agent" } };
    const built = await createNodeContextForDag(shared, budgeted, id, new AbortController().signal, { kind: "admin" }, options);
    expect(Object.hasOwn(built.ctx, "mapped:llm")).toBe(false);
    expect(await runDag(dag, {}, built.ctx, { minting: mintingFor(built, broker) })).toMatchObject({ ok: true, value: [7, 7] });
    expect(egress).toEqual(["main", "critique", "critique"]);
    expect(budgets).toHaveLength(3);
    for (const budget of budgets) expect(budget).toBe(built.ctx.budget);
    expect(built.ctx.budget?.spent()).toMatchObject({ calls: 3, tokens: 45 });
    const hydrated = await createNodeContextForDag(shared, budgeted, id, new AbortController().signal, { kind: "admin" }, options);
    expect(hydrated.ctx.budget).not.toBe(built.ctx.budget);
    expect(hydrated.ctx.budget?.spent()).toEqual(built.ctx.budget?.spent());
    expect(await runDag(child, 1, hydrated.ctx, { minting: mintingFor(hydrated, broker) })).toMatchObject({ ok: false, error: { kind: "llm-budget-exceeded" } });
    expect(egress).toHaveLength(3);
    const spendKey = buildSpendKey(tenant, registered.id, id);
    expect(await redis.hget(spendKey, "calls")).toBe("3");
    expect(await redis.ttl(spendKey)).toBeGreaterThan(CHECKPOINT_TTL_SEC);
    expect(await redis.ttl(spendKey)).toBeLessThanOrEqual(RUN_RETENTION_SEC);
  }));

  it("child structural identity keeps root cache/prompts/clock/signal closures and disjoint writer keys across two maps", async () => live(async ({ infra, redis, tenant }) => {
    const signal = new AbortController().signal;
    const clock = fixedClock(new Date(1234));
    const contexts: NodeContext[] = [];
    const child = defineDag({ id: "structural-child", nodes: { step: createFetchNode({
      id: "step", inputSchema: z.number(), outputSchema: z.number(), requires: ["cache", "prompts", "clock"] as const,
      fetch: async (n, ctx) => { contexts.push(ctx); await ctx.cache.set("child-key", n); return ok(n * 2); },
    }) }, edges: [{ from: DAG_INPUT, to: "step" }], outputNodeId: "step" });
    const a = createMapNode({ id: "a", inputSchema: items, outputSchema: items, widthFrom: "items", maxWidth: 2, child, childOutputSchema: z.number(), reduce: (xs) => ok({ items: [...xs] }) });
    const b = createMapNode({ id: "b", inputSchema: items, outputSchema: numbers, widthFrom: "items", maxWidth: 2, child, childOutputSchema: z.number(), reduce: (xs) => ok([...xs]) });
    const step = createTransformNode({ id: "step", inputSchema: items, outputSchema: items, transform: (input) => ok(input) });
    const dag = defineDag({ id: "resource-root", nodes: { step, a, b }, edges: [{ from: DAG_INPUT, to: "step" }, { from: "step", to: "a" }, { from: "a", to: "b" }], outputNodeId: "b" });
    const registered = registeredMapDag(dag, tenant);
    const id = runId(crypto.randomUUID());
    const built = await createNodeContextForDag({ ...infra, capabilities: [{ name: "clock", client: clock }] }, registered, id, signal, { kind: "admin" });
    const events: ObserverEvent[] = [];
    const observer = { observe: (event: ObserverEvent) => { events.push(event); } };
    expect(await runDag(dag, { items: [1, 2] }, { ...built.ctx, observer }, { now: () => 4321 })).toMatchObject({ ok: true, value: [4, 8] });
    expect(contexts).toHaveLength(4);
    for (const ctx of contexts) {
      expect(ctx.dagId).toBe(dagId("structural-child"));
      expect(ctx.runId).toBe(id);
      expect(ctx.signal).toBe(signal);
      expect(ctx.clock).toBe(clock);
      expect(ctx.clock?.now().getTime()).toBe(1234);
      expect(ctx.cache).toBe(built.ctx.cache);
      expect(ctx.prompts).toBe(built.ctx.prompts);
      expect(ctx.prompts?.get("root-prompt")).toBe("root-owned");
      expect(ctx.tracer).toBe(built.ctx.tracer);
      expect(ctx.contentFilter).toBe(built.ctx.contentFilter);
      expect(ctx.budget).toBe(built.ctx.budget);
    }
    expect(events.filter((e) => e.type === "run-start" || e.type === "run-end").map((e) => e.dagId)).toEqual([dagId("resource-root"), dagId("resource-root")]);
    expect(events.filter((e) => e.dagId === "structural-child").length).toBeGreaterThan(0);
    for (const event of events) expect(event.timestamp.getTime()).toBe(4321);
    expect(await redis.get(buildCacheKey(tenant, registered.id, "child-key"))).toBe("4");
    expect(await redis.keys(`fugue:${tenant}:structural-child:*`)).toEqual([]);
    expect(fromJson((await redis.get(buildCheckpointKey(tenant, registered.id, id, nodeId("step"))))!)).toEqual({ items: [1, 2] });
    for (const [map, outputs] of [["a", [2, 4]], ["b", [4, 8]]] as const) {
      for (const [index, output] of outputs.entries()) {
        const key = `fugue:${tenant}:resource-root:${id}:${map}@step@${index}@0`;
        expect(fromJson((await redis.get(key))!)).toBe(output);
        expect(await redis.ttl(key)).toBeGreaterThan(0);
      }
    }
  }));

  it("aborting the root signal during a child prevents later child egress", async () => live(async ({ infra, tenant }) => {
    const abort = new AbortController();
    const entered = Promise.withResolvers<void>();
    const calls: number[] = [];
    const child = defineDag({ id: "abort-child", nodes: { step: createFetchNode({
      id: "step", inputSchema: z.number(), outputSchema: z.number(),
      fetch: async (n, ctx) => {
        calls.push(n);
        expect(ctx.signal).toBe(abort.signal);
        entered.resolve();
        if (!ctx.signal?.aborted) {
          await new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => resolve(), { once: true }));
        }
        return ok(n);
      },
    }) }, edges: [{ from: DAG_INPUT, to: "step" }], outputNodeId: "step" });
    const dag = outerOf(child);
    const built = await createNodeContextForDag(infra, registeredMapDag(dag, tenant), runId(crypto.randomUUID()), abort.signal, { kind: "admin" });
    const running = runDag(dag, { items: [1, 2] }, built.ctx);
    await Promise.race([entered.promise, running.then((result) => { throw new Error(`Run ended before child abort barrier: ${JSON.stringify(result)}`); })]);
    abort.abort();
    expect((await running).ok).toBe(false);
    expect(calls).toEqual([1]);
  }));
});

// ---------------------------------------------------------------------------
// F1 PR-D: fan scheduling through the host (FR-030..FR-035, AD-11 end to end)
// ---------------------------------------------------------------------------
//
// The operator cap travels: env → `parseHostConfig` (startup validation) →
// `fanConcurrencyCap` → `syncRunOptions` → the kernel's root `FanRuntime`.
// The first block runs that real chain over an in-memory store, so it holds
// with or without Redis; the second runs it over the host's own context
// factory and the Redis checkpointer, including the refusal seed's lifecycle
// across a process restart and a budget-raising redeploy.

const HOST_ENV = {
  DAGS_REPO_URL: "https://github.com/org/dags.git",
  REDIS_URL: "redis://localhost:6379",
  ADMIN_TOKEN: "test-admin-token-long-enough",
  ANTHROPIC_API_KEY: "sk-ant-test-key",
};

/** The operator cap exactly as the host derives it at startup; an invalid setting never gets this far. */
const operatorCap = (env: Readonly<Record<string, string>> = {}): FanConcurrencyCap => {
  const parsed = parseHostConfig({ ...HOST_ENV, ...env });
  if (!parsed.ok) throw new Error(`host config rejected: ${JSON.stringify(parsed.error)}`);
  return fanConcurrencyCap(parsed.value.FAN_CHILD_CONCURRENCY_MAX);
};

/**
 * A map fan whose children record when they start and finish and hold for a
 * timer tick, so every child the shell admits is in flight together. The
 * shell starts a step's dispatches in one microtask burst, and no child can
 * finish before a timer fires, so `maxInFlight` is exactly the effective
 * concurrency whenever the width allows it.
 */
const occupancyFan = (scheduling: Readonly<{ childConcurrency?: number; estimator?: FanEstimator }>) => {
  const log: string[] = [];
  let inFlight = 0;
  const stats = { maxInFlight: 0 };
  const child = defineDag({ id: "occupancy-child", nodes: { hold: createFetchNode({
    id: "hold", inputSchema: z.number(), outputSchema: z.number(),
    fetch: async (n) => {
      log.push(`start:${n}`);
      inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      log.push(`end:${n}`);
      return ok(n * 2);
    },
  }) }, edges: [{ from: DAG_INPUT, to: "hold" }], outputNodeId: "hold" });
  const fan = createMapNode({
    id: "fan", inputSchema: items, outputSchema: numbers, widthFrom: "items", maxWidth: 32,
    child, childOutputSchema: z.number(), reduce: (xs) => ok([...xs]), ...scheduling,
  });
  const dag = defineDag({ id: "occupancy-root", nodes: { fan }, edges: [{ from: DAG_INPUT, to: "fan" }], outputNodeId: "fan" });
  return { dag, log, stats };
};

/** Observe a run: every observer event and every logger warning the kernel emits. */
const watched = (ctx: NodeContext) => {
  const events: ObserverEvent[] = [];
  const warnings: string[] = [];
  return {
    events, warnings,
    ctx: { ...ctx, observer: { observe: (e: ObserverEvent) => { events.push(e); } },
      logger: { warn: (m: string) => { warnings.push(m); }, error: () => {} } },
    fanStarts: () => events.filter((e): e is Extract<ObserverEvent, { type: "fan-start" }> => e.type === "fan-start"),
  };
};

const inMemoryCtx = (): NodeContext =>
  makeNodeContext({ runId: runId(`fan-host-${crypto.randomUUID()}`), dagId: "occupancy-root", capabilities: { checkpointer: new InMemoryCheckpointer() } });

const width = (n: number) => ({ items: Array.from({ length: n }, (_, i) => i) });
const doubled = (n: number) => Array.from({ length: n }, (_, i) => i * 2);

describe("host fan cap composition — env → startup config → kernel (FR-030..FR-035)", () => {
  it("AS-025: with no FAN_CHILD_CONCURRENCY_MAX configured, the host caps a fan at 8", async () => {
    const { dag, stats } = occupancyFan({ childConcurrency: 12 });
    const run = watched(inMemoryCtx());
    expect(await runDag(dag, width(20), run.ctx, syncRunOptions(operatorCap(), undefined))).toEqual(ok(doubled(20)));
    expect(run.fanStarts()).toEqual([expect.objectContaining({ authored: 12, cap: 8, effective: 8, clamped: true })]);
    expect(stats.maxInFlight).toBe(8);
  });

  it("AS-028: FAN_CHILD_CONCURRENCY_MAX=1 makes every fan sequential, whatever the author asked for (FR-031)", async () => {
    const { dag, log, stats } = occupancyFan({ childConcurrency: 6 });
    const run = watched(inMemoryCtx());
    expect(await runDag(dag, width(5), run.ctx, syncRunOptions(operatorCap({ FAN_CHILD_CONCURRENCY_MAX: "1" }), undefined)))
      .toEqual(ok(doubled(5)));
    expect(stats.maxInFlight).toBe(1);
    // Strictly one child at a time, in index order: start i, end i, start i+1, …
    expect(log).toEqual([0, 1, 2, 3, 4].flatMap((i) => [`start:${i}`, `end:${i}`]));
    expect(run.fanStarts()).toEqual([expect.objectContaining({ authored: 6, cap: 1, effective: 1, clamped: true })]);
  });

  for (const [authored, max] of [[3, 5], [5, 3], [1, 8], [8, 8]] as const) {
    it(`AS-026: authored ${authored} under host maximum ${max} runs at min(${authored}, ${max})`, async () => {
      const { dag, stats } = occupancyFan({ childConcurrency: authored });
      const run = watched(inMemoryCtx());
      expect(await runDag(dag, width(12), run.ctx, syncRunOptions(operatorCap({ FAN_CHILD_CONCURRENCY_MAX: String(max) }), undefined)))
        .toEqual(ok(doubled(12)));
      expect(stats.maxInFlight).toBe(Math.min(authored, max));
      expect(run.fanStarts()).toEqual([expect.objectContaining({ effective: Math.min(authored, max), clamped: authored > max })]);
      expect(run.warnings).toHaveLength(authored > max ? 1 : 0);
    });
  }

  it("AS-027: a clamp produces exactly one visible warning and one fan-start{clamped} event naming fan, authored and effective (SC-010)", async () => {
    const { dag } = occupancyFan({ childConcurrency: 6 });
    const run = watched(inMemoryCtx());
    expect(await runDag(dag, width(9), run.ctx, syncRunOptions(operatorCap({ FAN_CHILD_CONCURRENCY_MAX: "2" }), undefined)))
      .toEqual(ok(doubled(9)));
    expect(run.warnings).toHaveLength(1);
    expect(run.warnings[0]).toContain("'fan'");
    expect(run.warnings[0]).toContain("childConcurrency 6");
    expect(run.warnings[0]).toContain("FAN_CHILD_CONCURRENCY_MAX=2");
    expect(run.warnings[0]).toContain("clamped to 2");
    expect(run.fanStarts()).toEqual([expect.objectContaining({
      nodeId: nodeId("fan"), authored: 6, cap: 2, effective: 2, clamped: true,
    })]);
  });

  it("FR-034: the operator cap is the only run input — the kernel options carry nothing per-run", () => {
    expect(Object.keys(syncRunOptions(operatorCap(), undefined)).sort()).toEqual(["fanConcurrencyCap", "minting"]);
  });

  for (const bad of ["0", "-2", "1.5", "eight", ""]) {
    it(`AS-030: FAN_CHILD_CONCURRENCY_MAX=${JSON.stringify(bad)} fails host startup with an error naming the setting`, () => {
      const parsed = parseHostConfig({ ...HOST_ENV, FAN_CHILD_CONCURRENCY_MAX: bad });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error).toMatchObject({ kind: "config-invalid" });
      expect(JSON.stringify(parsed.error)).toContain("FAN_CHILD_CONCURRENCY_MAX");
    });
  }

  it("AS-031: errors and warnings name the per-fan child setting, never the run-level limits, and vice versa", async () => {
    const fanError = parseHostConfig({ ...HOST_ENV, FAN_CHILD_CONCURRENCY_MAX: "0" });
    const runError = parseHostConfig({ ...HOST_ENV, MAX_GLOBAL_CONCURRENCY: "0" });
    if (fanError.ok || runError.ok) throw new Error("both settings must reject 0");
    expect(JSON.stringify(fanError.error)).not.toMatch(/MAX_GLOBAL_CONCURRENCY|DEFAULT_DAG_CONCURRENCY/);
    expect(JSON.stringify(runError.error)).not.toContain("FAN_CHILD_CONCURRENCY_MAX");
    // Tightening the run-level limits never moves the fan cap.
    expect(operatorCap({ MAX_GLOBAL_CONCURRENCY: "1", DEFAULT_DAG_CONCURRENCY: "1" })).toBe(fanConcurrencyCap(8));

    const { dag } = occupancyFan({ childConcurrency: 4 });
    const run = watched(inMemoryCtx());
    await runDag(dag, width(4), run.ctx, syncRunOptions(operatorCap({ FAN_CHILD_CONCURRENCY_MAX: "2" }), undefined));
    expect(run.warnings[0]).toContain("childConcurrency");
    expect(run.warnings[0]).not.toMatch(/MAX_GLOBAL_CONCURRENCY|DEFAULT_DAG_CONCURRENCY|maxConcurrency/);
  });

  it("AS-031: the host docs document the per-fan child setting as its own child-level row, apart from the run-level limit", () => {
    const docs = join(import.meta.dir, "..", "..", "..");
    const deployment = readFileSync(join(docs, "docs", "deployment.md"), "utf8").split("\n");
    expect(deployment.some((l) => /^\| `FAN_CHILD_CONCURRENCY_MAX` \| `8` \| child \|/.test(l))).toBe(true);
    expect(deployment.some((l) => /^\| `MAX_GLOBAL_CONCURRENCY` \| `50` \| run \|/.test(l))).toBe(true);
    const readme = readFileSync(join(docs, "README.md"), "utf8").split("\n");
    expect(readme.some((l) => /^\| `childConcurrency` on the map node \| child \| DAG author \|/.test(l))).toBe(true);
    expect(readme.some((l) => /^\| `FAN_CHILD_CONCURRENCY_MAX` \| child \| operator/.test(l))).toBe(true);
    expect(readme.some((l) => /^\| `MAX_GLOBAL_CONCURRENCY` \| run \| operator/.test(l))).toBe(true);
  });

  /** Define a map node with a forged scheduling field, exactly as a DAG module would at load. */
  const defineWith = (field: "childConcurrency" | "estimator", value: unknown) => () => createMapNode({
    id: "fan", inputSchema: items, outputSchema: numbers, widthFrom: "items", maxWidth: 4,
    child: occupancyFan({}).dag, childOutputSchema: z.number(), reduce: (xs) => ok([...xs]),
    [field]: value,
  } as Parameters<typeof createMapNode>[0]);

  for (const value of [0, -1, 2.5]) {
    it(`AS-029: a DAG authoring childConcurrency=${value} is rejected at definition, naming the node and the value`, () => {
      expect(defineWith("childConcurrency", value)).toThrow(/fan/);
      expect(defineWith("childConcurrency", value)).toThrow(String(value));
    });
  }

  for (const value of ["p99", "average"]) {
    it(`AS-051: a DAG authoring estimator=${JSON.stringify(value)} is rejected at definition, naming the node and the value`, () => {
      expect(defineWith("estimator", value)).toThrow(/fan/);
      expect(defineWith("estimator", value)).toThrow(value);
    });
  }
});

/** A fan whose every child makes exactly one metered LLM call through the host's root client. */
const meteredFan = (childConcurrency?: number) => {
  const child = defineDag({ id: "metered-child", nodes: { ask: createFetchNode({
    id: "ask", inputSchema: z.number(), outputSchema: z.number(), requires: ["llm"] as const,
    fetch: async (_n, ctx) => {
      const response = await ctx.llm.sendStructured({ system: "s", user: "u", model: "gpt-4o", nodeId: nodeId("ask"), schema: z.number() });
      return response.ok ? ok(response.value.output) : response;
    },
  }) }, edges: [{ from: DAG_INPUT, to: "ask" }], outputNodeId: "ask" });
  const fan = createMapNode({
    id: "fan", inputSchema: items, outputSchema: numbers, widthFrom: "items", maxWidth: 8,
    child, childOutputSchema: z.number(), reduce: (xs) => ok([...xs]),
    ...(childConcurrency !== undefined ? { childConcurrency } : {}),
  });
  return defineDag({ id: "metered-root", nodes: { fan }, edges: [{ from: DAG_INPUT, to: "fan" }], outputNodeId: "fan" });
};

const withCallBudget = (registered: RegisteredDag, calls: number): RegisteredDag =>
  ({ ...registered, config: { ...registered.config, llmBudget: { calls } } });

const refusalOf = (result: Result<unknown, FrameworkError>) => {
  if (result.ok || result.error.kind !== "fan-budget-refused") throw new Error(`expected fan-budget-refused, got ${JSON.stringify(result)}`);
  return result.error.refusal;
};

describe.skipIf(!redisUrl)("fan scheduling through the host factory + Redis checkpointer (AD-11 end to end)", () => {
  it("AS-025: the default host maximum (8) applies to a fan whose children save to the Redis $nodes hash", async () => live(async ({ infra, redis, tenant }) => {
    const { dag, stats } = occupancyFan({ childConcurrency: 12 });
    const registered = registeredMapDag(dag, tenant);
    const id = runId(crypto.randomUUID());
    const built = await createNodeContextForDag(infra, registered, id, new AbortController().signal, { kind: "admin" });
    const run = watched(built.ctx);
    expect(await runDag(dag, width(16), run.ctx, syncRunOptions(operatorCap(), undefined))).toEqual(ok(doubled(16)));
    expect(stats.maxInFlight).toBe(8);
    expect(run.fanStarts()).toEqual([expect.objectContaining({ cap: 8, effective: 8, clamped: true })]);
    const saved = Object.keys(await redis.hgetall(buildCheckpointNodesKey(tenant, registered.id, id))).filter((k) => k.startsWith("dag@fan@"));
    expect(saved.sort()).toEqual(Array.from({ length: 16 }, (_, i) => `dag@fan@${i}@0`).sort());
  }));

  it("AS-014 / AS-056 / AS-015: refusal → seed in the $nodes hash → sticky refusal after a restart → a raised-budget redeploy completes", async () => live(async ({ infra, redis, tenant }) => {
    const egress: string[] = [];
    const counting = (base: typeof infra): typeof infra => ({
      ...base,
      llm: {
        sendStructured: async (req) => { egress.push(req.nodeId); return ok({ output: req.schema.parse(7), rawText: "7", ...tokensOnly(10, 5) }); },
        sendWithTools: async (req) => { egress.push(req.nodeId); return ok({ output: req.schema.parse(7), rawText: "7", ...tokensOnly(10, 5) }); },
      },
    });
    const v1 = meteredFan();
    const registered = withCallBudget(registeredMapDag(v1, tenant), 2);
    const id = runId(crypto.randomUUID());
    const input = width(4);
    const options = { routedTenant: tenant, resumableRunTtlSec: RUN_RETENTION_SEC };

    // Slice 1: the probe (index 0) spends 1 of 2 calls; 3 × 1 > 1 left ⇒ refused.
    const first = await createNodeContextForDag(counting(infra), registered, id, new AbortController().signal, { kind: "admin" }, options);
    const refusal = refusalOf(await runDag(v1, input, first.ctx, syncRunOptions(operatorCap(), undefined)));
    expect(refusal).toMatchObject({ axis: "calls", ceiling: { kind: "calls", limit: 2 }, completed: 1, remaining: 3, effectiveConcurrency: 1 });
    expect(egress).toHaveLength(1);
    const nodesKey = buildCheckpointNodesKey(tenant, registered.id, id);
    const stored = await redis.hgetall(nodesKey);
    expect(Object.keys(stored).sort()).toEqual(["dag@fan@0@0", "fan-seed@fan@0@0"]);
    expect(fromJson(stored["fan-seed@fan@0@0"]!)).toMatchObject({
      output: { version: 1, estimator: "largest-seen", ceilings: [{ kind: "calls", limit: 2 }], refusal: { completed: 1, remaining: 3 } },
    });

    // A process restart: a new Redis connection, new host infra, a context rebuilt from Redis alone.
    const reconnected = await createRedisConnectivity(redisUrl!);
    if (!reconnected.ok) throw new Error(JSON.stringify(reconnected.error));
    try {
      const restarted = counting(mappedHostInfra(reconnected.value.redis));
      const second = await createNodeContextForDag(restarted, registered, id, new AbortController().signal, { kind: "admin" }, options);
      const again = refusalOf(await runDag(v1, input, second.ctx, syncRunOptions(operatorCap(), undefined)));
      expect(again).toEqual(refusal);
      expect(egress).toHaveLength(1);

      // The redeploy: a retuned fan AND a larger budget. Every saved index is reused.
      const v2 = meteredFan(2);
      const redeployed = withCallBudget(registeredMapDag(v2, tenant), 10);
      const third = await createNodeContextForDag(restarted, redeployed, id, new AbortController().signal, { kind: "admin" }, options);
      expect(await runDag(v2, input, third.ctx, syncRunOptions(operatorCap(), undefined))).toEqual(ok([7, 7, 7, 7]));
      expect(egress).toHaveLength(4);
      expect(Object.keys(await redis.hgetall(nodesKey)).filter((k) => k.startsWith("dag@fan@")).sort())
        .toEqual(["dag@fan@0@0", "dag@fan@1@0", "dag@fan@2@0", "dag@fan@3@0"]);
    } finally {
      await reconnected.value.disconnect();
    }
  }));

  it("AS-006: a corrupt refusal-seed row in Redis refuses the whole fan before any child is dispatched", async () => live(async ({ infra, redis, tenant }) => {
    const v1 = meteredFan();
    const registered = withCallBudget(registeredMapDag(v1, tenant), 2);
    const id = runId(crypto.randomUUID());
    const first = await createNodeContextForDag(infra, registered, id, new AbortController().signal, { kind: "admin" });
    refusalOf(await runDag(v1, width(4), first.ctx, syncRunOptions(operatorCap(), undefined)));
    await redis.hset(buildCheckpointNodesKey(tenant, registered.id, id), "fan-seed@fan@0@0", "{ not a node state");

    const raised = withCallBudget(registered, 100);
    const resumed = await createNodeContextForDag(infra, raised, id, new AbortController().signal, { kind: "admin" });
    const run = watched(resumed.ctx);
    const result = await runDag(v1, width(4), run.ctx, syncRunOptions(operatorCap(), undefined));
    // The kernel reports the fan's refusal through its retry envelope; the root cause is the corruption.
    expect(result).toMatchObject({ ok: false, error: { nodeId: "fan", rootErrorKind: "checkpoint-corrupt" } });
    if (!result.ok) expect(formatFrameworkError(result.error)).toContain("fan-seed@fan@0@0");
    expect(run.fanStarts()).toEqual([]);
    expect(resumed.ctx.budget?.spent().calls).toBe(1);
  }));
});
