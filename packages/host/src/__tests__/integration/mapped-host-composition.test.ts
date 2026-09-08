import { describe, expect, it } from "bun:test";
import Redis from "ioredis";
import { z } from "zod";
import {
  DAG_INPUT, dagId, createFetchNode, createMapNode, createTransformNode, defineDag, err, fixedClock,
  fromJson, nodeId, ok, runDag, runId, tokensOnly,
} from "@fuguejs/framework";
import type { Capability, CapabilityBroker, DagDef, Invocation, LlmClient, MintingAuthority, NodeContext, ObserverEvent } from "@fuguejs/framework";
import { createNodeContextForDag } from "../../adapters/node-context-factory.js";
import { createRedisConnectivity } from "../../adapters/redis-connectivity.js";
import type { NodeContextForDag } from "../../domain/run-context.js";
import type { AuthIdentity } from "../../domain/auth.js";
import { buildCacheKey, buildCheckpointKey, buildSpendKey } from "../../domain/cache-keys.js";
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
