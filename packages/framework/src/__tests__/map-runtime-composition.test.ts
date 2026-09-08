import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { defineDag, runDag, runResumableDagJob } from "../executor/index.js";
import { createMapNode } from "../nodes/map.js";
import { createFetchNode } from "../nodes/fetch.js";
import { withHumanReview } from "../nodes/human-review.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import { InMemoryCheckpointer } from "../checkpoint/checkpointer.js";
import { DAG_INPUT, nodeId } from "../types/ids.js";
import { ok, err } from "../types/result.js";
import type { DagDef } from "../types/dag.js";
import type { NodeContext, Capability } from "../types/node.js";
import type { MappedChildScope } from "../types/mapped-child-scope.js";
import type { EvalJudgeNodeDef } from "../types/eval-judge.js";
import type { FreshnessIndex } from "../types/freshness.js";
import { resourceName, witness, witnessValue } from "../types/witness.js";
import { validateDagShape } from "../shared/validate-dag.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { SideEffectProfile } from "../types/side-effects.js";
import type { CapabilityBroker, Invocation, MintingAuthority } from "../types/capability-broker.js";
import type { ObserverEvent } from "../types/events.js";
import type { LlmClient } from "../types/llm.js";
import { NO_TOKENS } from "../types/token-usage.js";
import { stubSendWithTools } from "./_llm-mocks.js";
import { BufferedObserver } from "../observer/buffered.js";
import { errorOnly } from "../observer/policy.js";
import { compileDagToMachine } from "../dag-runtime/machine.js";
import { persistDagContext } from "../dag-runtime/persistence.js";
import { createInMemoryJob } from "../queue/in-memory-job.js";
import type { DagPhase, DagMachineContextPersisted } from "../dag-runtime/types.js";

declare module "../types/node.js" {
  interface CapabilityRegistry {
    readonly "map-test:read": { readonly read: (n: number) => number };
    readonly "map-test:llm": LlmClient;
  }
}

const itemsSchema = z.object({ items: z.array(z.number()) });
const child = (work: (n: number, ctx: NodeContext) => Promise<Result<number, FrameworkError>> = async n => ok(n * 2)) => defineDag({
  id: "child",
  nodes: { work: createFetchNode({ id: "work", inputSchema: z.number(), outputSchema: z.number(), fetch: work }) },
  edges: [{ from: DAG_INPUT, to: "work" }], outputNodeId: "work",
});
const fanConfig = (dag: DagDef) => ({
  id: "fan", inputSchema: itemsSchema, outputSchema: z.array(z.number()),
  widthFrom: "items", maxWidth: 10, child: dag, childOutputSchema: z.number(),
  reduce: (xs: readonly number[]) => ok([...xs]),
});
const fan = (dag: DagDef) => createMapNode(fanConfig(dag));
const wrap = (dag: DagDef) => defineDag({ id: "outer", nodes: { fan: fan(dag) }, edges: [{ from: DAG_INPUT, to: "fan" }], outputNodeId: "fan" });
const context = (cp = new InMemoryCheckpointer()) => makeNodeContext({ runId: "map-composition", dagId: "outer", capabilities: { checkpointer: cp } });

const rerouting = (replacement: number) => {
  const calls: number[] = [];
  let scopes = 0;
  const dag = defineDag({
    id: "outer",
    nodes: {
      scope: createFetchNode({ id: "scope", inputSchema: z.unknown(), outputSchema: itemsSchema, fetch: async () => ok({ items: [++scopes === 1 ? 1 : replacement] }) }),
      fan: fan(child(async n => { calls.push(n); return ok(n * 2); })),
      review: withHumanReview(createFetchNode({ id: "review", inputSchema: z.array(z.number()), outputSchema: z.array(z.number()), fetch: async xs => ok(xs) }), { prompt: "Review gathered result" }),
    },
    edges: [{ from: DAG_INPUT, to: "scope" }, { from: "scope", to: "fan" }, { from: "fan", to: "review" }], outputNodeId: "review",
  });
  return { dag, calls };
};

describe("mapped execution belongs to its root Run", () => {
  for (const replacement of [9, 1]) it(`reroute replaces completed indices even for replacement input ${replacement}`, async () => {
    const { dag, calls } = rerouting(replacement);
    const reviews: unknown[] = [];
    const result = await runDag(dag, {}, context(), { onHumanReview: async req => {
      reviews.push(req.output);
      return reviews.length === 1 ? { kind: "reroute", targetNodeId: nodeId("scope") } : { kind: "approve" };
    } });
    expect(result).toEqual(ok([replacement * 2]));
    expect(reviews).toEqual([[2], [replacement * 2]]);
    expect(calls).toEqual([1, replacement]);
  });

  it("a replacement resumable executor restores the committed reroute epoch", async () => {
    const { dag, calls } = rerouting(9);
    const compiled = compileDagToMachine(dag, {});
    if (!compiled.ok) throw new Error("fixture compile failed");
    const firstJob = createInMemoryJob<DagPhase, DagMachineContextPersisted>({ state: compiled.value.initialState, context: persistDagContext(compiled.value.initialContext, dag) });
    const cp = new InMemoryCheckpointer();
    await expect(runResumableDagJob(dag, {}, context(cp), {
      jobLike: firstJob,
      onHumanReview: async () => ({ kind: "reroute", targetNodeId: nodeId("scope") }),
      beforeExecute: (_phase, ctx) => ctx.freshnessExecutionEpoch === 0,
    })).rejects.toThrow();
    expect(Number(firstJob.data.context.freshnessExecutionEpoch)).toBe(1);
    const replacement = createInMemoryJob<DagPhase, DagMachineContextPersisted>(firstJob.data);
    expect(await runResumableDagJob(dag, {}, context(cp), { jobLike: replacement, onHumanReview: async () => ({ kind: "approve" }) })).toEqual({ kind: "completed", output: [18] });
    expect(calls).toEqual([1, 9]);
  });

  for (const mode of ["success", "outer-failure", "child-failure", "empty"] as const) it(`errorOnly sampling encloses the whole fan: ${mode}`, async () => {
    const retained: ObserverEvent[] = [];
    const seen: ObserverEvent[] = [];
    const buffered = new BufferedObserver({ observe: e => retained.push(e) }, errorOnly(), { sweepIntervalMs: 0 });
    const work = createFetchNode({ id: "work", inputSchema: z.number(), outputSchema: z.number(), fetch: async n => n === 2 && mode === "child-failure" ? err({ kind: "rejected", nodeId: nodeId("work"), reason: "child failure" }) : ok(n * 2) });
    const dag = defineDag({ id: "outer", nodes: {
      fan: fan(defineDag({ id: "child", nodes: { work }, edges: [{ from: DAG_INPUT, to: "work" }], outputNodeId: "work" })),
      finish: createFetchNode({ id: "finish", inputSchema: z.array(z.number()), outputSchema: z.array(z.number()), fetch: async xs => mode === "outer-failure" ? err({ kind: "rejected", nodeId: nodeId("finish"), reason: "outer failure" }) : ok(xs) }),
    }, edges: [{ from: DAG_INPUT, to: "fan" }, { from: "fan", to: "finish" }], outputNodeId: "finish" });
    try {
      const result = await runDag(dag, { items: mode === "empty" ? [] : [1, 2] }, { ...context(), observer: { observe: e => { seen.push(e); buffered.observe(e); } } });
      expect(result.ok).toBe(mode === "success" || mode === "empty");
      expect(seen.filter(e => e.type === "run-start").map(e => String(e.dagId))).toEqual(["outer"]);
      expect(seen.filter(e => e.type === "run-end").map(e => String(e.dagId))).toEqual(["outer"]);
      expect(buffered.aggregates.runCount).toBe(1);
      if (!result.ok) {
        expect(retained[0]?.type).toBe("run-start");
        expect(retained.some(e => e.type === "node-end" && e.dagId === "child")).toBe(true);
        expect(retained.at(-1)?.type).toBe("run-end");
      } else expect(retained).toEqual([]);
    } finally { buffered.close(); }
  });

  it("inherits the run clock and resources while exposing the child's structural DAG identity", async () => {
    const observations: unknown[] = [];
    const events: ObserverEvent[] = [];
    const base = context();
    const controller = new AbortController();
    const result = await runDag(wrap(child(async (n, ctx) => {
      observations.push([ctx.dagId, ctx.eventTimestamp?.().getTime(), ctx.signal === controller.signal, ctx.logger === base.logger, ctx.cache === base.cache]);
      return ok(n);
    })), { items: [1, 2] }, { ...base, signal: controller.signal, observer: { observe: e => events.push(e) } }, { now: () => 12345 });
    expect(result).toEqual(ok([1, 2]));
    expect(observations).toEqual([["child", 12345, true, true, true], ["child", 12345, true, true, true]]);
    expect(events.every(e => e.timestamp.getTime() === 12345)).toBe(true);
  });
});

describe("mapped capability preparation and dispatch", () => {
  it("snapshots child claims, origin and mint receiver once; children never inherit the map overlay", async () => {
    const baseCp = new InMemoryCheckpointer();
    const scopedCp = new InMemoryCheckpointer();
    const seen: Invocation[] = [];
    const claims: string[] = [];
    const origin = { kind: "user" as const, sub: "alice", agentClientId: "root-agent" };
    const client = { read: (n: number) => n * 2 };
    const broker: CapabilityBroker = {
      provides: cap => { claims.push(cap); return cap === "checkpointer" || cap === "map-test:read"; },
      async mintFor(inv, requires) {
        expect(this).toBe(broker);
        seen.push(inv);
        if (requires.includes("checkpointer")) return ok({ checkpointer: { clientKind: "non-llm", client: scopedCp } });
        if (requires.includes("map-test:read")) return ok({ "map-test:read": { clientKind: "non-llm", client } });
        return ok({});
      },
    };
    const work = createFetchNode({ id: "work", inputSchema: z.number(), outputSchema: z.number(), requires: ["map-test:read"], fetch: async (n, ctx) => {
      expect(Reflect.get(ctx, "checkpointer")).toBe(baseCp);
      return ok(ctx["map-test:read"].read(n));
    } });
    const c = defineDag({ id: "child", nodes: { work }, edges: [{ from: DAG_INPUT, to: "work" }], outputNodeId: "work" });
    const dag = defineDag({ id: "outer", nodes: {
      pre: createFetchNode({ id: "pre", inputSchema: itemsSchema, outputSchema: itemsSchema, fetch: async x => {
        origin.sub = "mallory";
        Reflect.set(broker, "provides", () => false);
        Reflect.set(broker, "mintFor", () => { throw new Error("mutated broker must not execute"); });
        return ok(x);
      } }), fan: fan(c),
    }, edges: [{ from: DAG_INPUT, to: "pre" }, { from: "pre", to: "fan" }], outputNodeId: "fan" });
    expect(await runDag(dag, { items: [1, 2] }, context(baseCp), { minting: { broker, origin, meterLlm: (_cap, binding) => ok(binding.client) } })).toEqual(ok([2, 4]));
    expect(claims.sort()).toEqual(["checkpointer", "map-test:read"]);
    expect(seen.map(inv => inv.origin)).toEqual(Array.from({ length: 4 }, () => ({ kind: "user", sub: "alice", agentClientId: "root-agent" })));
    const loaded = await scopedCp.load(context(baseCp).runId);
    expect(loaded.ok && Object.keys(loaded.value?.nodes ?? {})).toEqual(["dag@fan@0@0", "dag@fan@1@0"]);
  });

  it("every broker-delivered child LLM goes through the original host meter, including replay skips", async () => {
    let egress = 0;
    let meteredCalls = 0;
    const decoratedNodes: string[] = [];
    const provider: LlmClient = {
      sendStructured: async req => { egress++; return ok({ ...NO_TOKENS, output: req.schema.parse(7), rawText: "7" }); },
      sendWithTools: stubSendWithTools,
    };
    const work = createFetchNode({ id: "work", inputSchema: z.number(), outputSchema: z.number(), requires: ["map-test:llm"], fetch: async (_n, ctx) => {
      const result = await ctx["map-test:llm"].sendStructured({ nodeId: nodeId("work"), schema: z.number(), system: "s", user: "u", model: "model" });
      return result.ok ? ok(result.value.output) : result;
    } });
    const c = defineDag({ id: "child", nodes: { work }, edges: [{ from: DAG_INPUT, to: "work" }], outputNodeId: "work" });
    const minting: MintingAuthority = {
      origin: { kind: "agent", agentClientId: "root-agent" },
      broker: { provides: cap => cap === "map-test:llm", mintFor: async (_inv, requires) => requires.includes("map-test:llm")
        ? ok({ "map-test:llm": { clientKind: "llm", client: provider, pricingModel: { kind: "request" }, runScopedOperations: {} } }) : ok({}) },
      meterLlm: (cap, binding, node) => {
        expect(String(cap)).toBe("map-test:llm"); decoratedNodes.push(String(node));
        return ok({ ...binding.client, sendStructured: req => { meteredCalls++; return binding.client.sendStructured(req); } });
      },
    };
    const cp = new InMemoryCheckpointer();
    const dag = wrap(c);
    for (let attempt = 0; attempt < 2; attempt++) expect(await runDag(dag, { items: [1, 2] }, context(cp), { minting })).toEqual(ok([7, 7]));
    expect(decoratedNodes).toEqual(["work", "work"]);
    expect(meteredCalls).toBe(2);
    expect(egress).toBe(2);
  });

  for (const width of [0, 1]) it(`missing child capabilities fail before predecessors even at width ${width}`, async () => {
    let predecessors = 0;
    const work = createFetchNode({ id: "work", inputSchema: z.number(), outputSchema: z.number(), requires: ["map-test:read"], fetch: async (n, ctx) => ok(ctx["map-test:read"].read(n)) });
    const c = defineDag({ id: "child", nodes: { work }, edges: [{ from: DAG_INPUT, to: "work" }] });
    const dag = defineDag({ id: "outer", nodes: {
      pre: createFetchNode({ id: "pre", inputSchema: itemsSchema, outputSchema: itemsSchema, fetch: async x => { predecessors++; return ok(x); } }), fan: fan(c),
    }, edges: [{ from: DAG_INPUT, to: "pre" }, { from: "pre", to: "fan" }] });
    const events: ObserverEvent[] = [];
    const result = await runDag(dag, { items: Array.from({ length: width }, () => 1) }, { ...context(), observer: { observe: e => events.push(e) } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("missing-capability");
    expect(predecessors).toBe(0);
    expect(events.map(e => e.type)).toEqual(["run-start", "run-end"]);
  });
  for (const mode of ["broker-only", "static-denial", "missing-static"] as const) it(mode, async () => {
    const minted: { inv: Invocation; requires: readonly Capability[] }[] = [];
    let uses = 0;
    let predecessors = 0;
    const client = { read: (n: number) => { uses++; return n * 2; } };
    const work = createFetchNode({ id: "work", inputSchema: z.number(), outputSchema: z.number(), requires: ["map-test:read"], fetch: async (n, ctx) => ok(ctx["map-test:read"].read(n)) });
    const dag = defineDag({ id: "outer", nodes: {
      pre: createFetchNode({ id: "pre", inputSchema: itemsSchema, outputSchema: itemsSchema, fetch: async x => { predecessors++; return ok(x); } }),
      fan: fan(defineDag({ id: "child", nodes: { work }, edges: [{ from: DAG_INPUT, to: "work" }], outputNodeId: "work" })),
    }, edges: [{ from: DAG_INPUT, to: "pre" }, { from: "pre", to: "fan" }], outputNodeId: "fan" });
    const minting: MintingAuthority = {
      origin: { kind: "user", sub: "alice", agentClientId: "root-agent" }, meterLlm: (_cap, binding) => ok(binding.client),
      broker: { provides: cap => cap === "map-test:read", mintFor: async (inv, requires) => {
        minted.push({ inv, requires });
        if (!requires.includes("map-test:read")) return ok({});
        return mode === "static-denial" ? err({ kind: "downstream-denied", resource: "map-test:read", reason: "denied" }) : ok({ "map-test:read": { clientKind: "non-llm", client } });
      } },
    };
    const ctx = makeNodeContext({ runId: "authority", dagId: "outer", capabilities: { checkpointer: new InMemoryCheckpointer(), ...(mode === "static-denial" ? { "map-test:read": client } : {}) } });
    const result = await runDag(dag, { items: [3] }, ctx, mode === "missing-static" ? {} : { minting });
    if (mode === "broker-only") {
      expect(result).toEqual(ok([6]));
      expect(uses).toBe(1);
      expect(minted.map(x => [String(x.inv.nodeId), String(x.inv.dagId), x.requires])).toEqual([["pre", "outer", []], ["fan", "outer", ["checkpointer"]], ["work", "child", ["map-test:read"]]]);
      expect(minted.every(x => x.inv.origin.kind === "user" && x.inv.origin.sub === "alice" && x.inv.origin.agentClientId === "root-agent")).toBe(true);
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe(mode === "static-denial" ? "downstream-denied" : "missing-capability");
      expect(uses).toBe(0);
      if (mode === "missing-static") expect(predecessors).toBe(0);
    }
  });
});

describe("mapped persistence and option ownership", () => {
  for (const items of [[1], [1, 2]]) it(`abort during a successful child preserves its completion but refuses the ${items.length}-wide fan`, async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const calls: number[] = [];
    const c = child(async n => { calls.push(n); entered.resolve(); await release.promise; return ok(n * 2); });
    const cp = new InMemoryCheckpointer();
    const ctx = { ...context(cp), signal: controller.signal };
    const running = runDag(wrap(c), { items }, ctx);
    await entered.promise;
    controller.abort();
    release.resolve();
    expect(await running).toEqual(err({ kind: "aborted", reason: "signal" }));
    expect(calls).toEqual([1]);
    const completed = await cp.load(ctx.runId);
    expect(completed.ok && Object.keys(completed.value?.nodes ?? {})).toEqual(["dag@fan@0@0"]);
    // A new slice with a live signal reuses the acknowledged completion.
    expect(await runDag(wrap(c), { items }, context(cp))).toEqual(ok(items.map(n => n * 2)));
    expect(calls).toEqual(items);
  });

  it("an already-aborted empty fan never runs its reducer or touches persistence", async () => {
    let reductions = 0;
    const configured = fanConfig(child());
    const mapped = createMapNode({ ...configured, reduce: () => { reductions++; return ok([]); } });
    const dag = defineDag({ id: "outer", nodes: { fan: mapped }, edges: [{ from: DAG_INPUT, to: "fan" }], outputNodeId: "fan" });
    const cp = new InMemoryCheckpointer();
    const ctx = { ...context(cp), signal: AbortSignal.abort() };
    expect(await runDag(dag, { items: [] }, ctx)).toEqual(err({ kind: "aborted", reason: "signal" }));
    expect(reductions).toBe(0);
    expect(await cp.load(ctx.runId)).toEqual(ok(null));
  });
  it("replacement in a partially completed NEW epoch reuses only that epoch's prefix", async () => {
    const storage = new InMemoryCheckpointer();
    const calls: number[] = [];
    let resumed = false;
    let scopes = 0;
    const dag = defineDag({ id: "outer", nodes: {
      scope: createFetchNode({ id: "scope", inputSchema: z.unknown(), outputSchema: itemsSchema, fetch: async () => ok({ items: ++scopes === 1 ? [1, 2] : [9, 10] }) }),
      fan: fan(child(async n => {
        calls.push(n);
        if (n === 10 && !resumed) return err({ kind: "aborted", reason: "simulated interruption after acknowledged new-epoch prefix" });
        return ok(n * 2);
      })),
      review: withHumanReview(createFetchNode({ id: "review", inputSchema: z.array(z.number()), outputSchema: z.array(z.number()), fetch: async x => ok(x) }), { prompt: "Review" }),
    }, edges: [{ from: DAG_INPUT, to: "scope" }, { from: "scope", to: "fan" }, { from: "fan", to: "review" }], outputNodeId: "review" });
    const compiled = compileDagToMachine(dag, {});
    if (!compiled.ok) throw new Error("fixture compile failed");
    const job = createInMemoryJob<DagPhase, DagMachineContextPersisted>({ state: compiled.value.initialState, context: persistDagContext(compiled.value.initialContext, dag) });
    const checkpointBeforeFan = Promise.withResolvers<typeof job.data>();
    const ctx = () => makeNodeContext({ runId: "epoch-prefix", dagId: "outer", capabilities: { checkpointer: storage } });
    await expect(runResumableDagJob(dag, {}, ctx(), {
      jobLike: job,
      onHumanReview: async () => ({ kind: "reroute", targetNodeId: nodeId("scope") }),
      beforeExecute: (phase, state) => {
        if (phase.kind === "running" && phase.wave === 1 && state.freshnessExecutionEpoch === 1) checkpointBeforeFan.resolve(job.data);
        return true;
      },
    })).rejects.toThrow();
    const loaded = await storage.load(ctx().runId);
    expect(loaded.ok && Object.keys(loaded.value?.nodes ?? {}).sort()).toEqual(["dag@fan@0@0", "dag@fan@0@1", "dag@fan@1@0"]);
    // Model the last committed root checkpoint before a process interrupted
    // the fan, not its later in-process error checkpoint. Host integration owns
    // the real process-kill proof; here the kernel/port contract is the oracle.
    const replacement = createInMemoryJob<DagPhase, DagMachineContextPersisted>(await checkpointBeforeFan.promise);
    resumed = true;
    expect(await runResumableDagJob(dag, {}, ctx(), { jobLike: replacement, onHumanReview: async () => ({ kind: "approve" }) })).toEqual({ kind: "completed", output: [18, 20] });
    expect(calls).toEqual([1, 2, 9, 10, 10]);
    expect(scopes).toBe(2);
  });
  it("an ordinary map retry reuses its completed prefix in the same generation", async () => {
    const calls: number[] = [];
    let failed = false;
    const mapped = fan(child(async n => {
      calls.push(n);
      if (n === 2 && !failed) { failed = true; return err({ kind: "transient", nodeId: nodeId("work"), message: "retry" }); }
      return ok(n * 2);
    }));
    const dag = defineDag({ id: "outer", nodes: { fan: { ...mapped, retry: { backoffMs: [0], jitterRatio: 0 } } },
      edges: [{ from: DAG_INPUT, to: "fan" }], outputNodeId: "fan", defaultRetryLimit: 1 });
    expect(await runDag(dag, { items: [1, 2, 3] }, context(), { suppressRoutingWarnings: true })).toEqual(ok([2, 4, 6]));
    expect(calls).toEqual([1, 2, 2, 3]);
  });

  it("scopes actual child writer calls by map, index and reroute epoch; root writes stay canonical", async () => {
    const shared = child();
    const a = createMapNode({ ...fanConfig(shared), id: "a" });
    const b = createMapNode({ ...fanConfig(shared), id: "b" });
    const dag = defineDag({ id: "outer", nodes: {
      a, b,
      review: withHumanReview(createFetchNode({ id: "review", inputSchema: z.object({ a: z.array(z.number()), b: z.array(z.number()) }),
        outputSchema: z.object({ a: z.array(z.number()), b: z.array(z.number()) }), fetch: async x => ok(x) }), { prompt: "Review" }),
    }, edges: [{ from: DAG_INPUT, to: "a" }, { from: DAG_INPUT, to: "b" }, { from: "a", to: "review" }, { from: "b", to: "review" }], outputNodeId: "review" });
    const writes: { node: string; output: unknown; scope: MappedChildScope | undefined }[] = [];
    let reviews = 0;
    const ctx = { ...context(), checkpointWriter: { write: async (_run: unknown, node: string, output: unknown, scope?: MappedChildScope) => { writes.push({ node, output, scope }); } } };
    const result = await runDag(dag, { items: [1, 2] }, ctx, { onHumanReview: async () => ++reviews === 1 ? { kind: "reroute", targetNodeId: nodeId("a") } : { kind: "approve" } });
    expect(result).toEqual(ok({ a: [2, 4], b: [2, 4] }));
    const childWrites = writes.filter(w => w.node === "work");
    expect(childWrites).toHaveLength(8);
    expect(childWrites.map(w => `${w.scope?.mapNodeId}/${w.scope?.index}/${w.scope?.executionEpoch}`).sort()).toEqual([
      "a/0/0", "a/0/1", "a/1/0", "a/1/1", "b/0/0", "b/0/1", "b/1/0", "b/1/1",
    ]);
    expect(writes.filter(w => w.node !== "work").every(w => w.scope === undefined)).toBe(true);
  });

  it("keeps root replay/overrides/trace hooks out of child machines and shares retry randomness", async () => {
    let calls = 0;
    let randomReads = 0;
    const childDag = defineDag({ id: "child", outputNodeId: "work", nodes: { work: { ...createFetchNode({ id: "work", inputSchema: z.number(), outputSchema: z.number(), fetch: async n => {
      if (++calls === 1) return err({ kind: "transient", nodeId: nodeId("work"), message: "child retry" });
      return ok(n * 2);
    } }), retry: { backoffMs: [0], jitterRatio: 0.5 } } }, edges: [{ from: DAG_INPUT, to: "work" }], defaultRetryLimit: 1 });
    const tracedNodes: string[] = [];
    const result = await runDag(wrap(childDag), { items: [3] }, context(), {
      retryLimits: { fan: 2 },
      resume: { runId: "map-composition", checkpoint: new Map([["work", 999]]) },
      random: () => { randomReads++; return 0; },
      beforeExecute: (_phase, ctx) => { expect(String(ctx.dag.id)).toBe("outer"); return true; },
      onTrace: t => { if (t.event?.type === "wave-done") tracedNodes.push(...[...t.event.outputs.keys()].map(String)); },
      suppressRoutingWarnings: true,
    });
    expect(result).toEqual(ok([6]));
    expect(calls).toBe(2);
    expect(randomReads).toBe(1);
    expect(tracedNodes).toEqual(["fan"]);
  });

  it("a child finalizer failure stays typed and preserves earlier child history until root failure", async () => {
    const retained: ObserverEvent[] = [];
    const buffered = new BufferedObserver({ observe: e => retained.push(e) }, errorOnly(), { sweepIntervalMs: 0 });
    let judged = 0;
    const passed = { outcome: "passed" as const, score: 1, criteriaScores: {}, failedCriteria: [], reason: "passed" };
    const hostile = Object.defineProperty({ ...passed }, "outcome", { get: () => { throw new Error("hostile child judge result"); } });
    const judge: EvalJudgeNodeDef = { id: nodeId("judge"), kind: "eval-judge", config: { id: "judge", criteria: ["accuracy"] }, run: async (_input, _output, ctx) => {
      expect(ctx.eventTimestamp?.().getTime()).toBe(12345);
      return ++judged === 1 ? passed : hostile;
    } };
    const c = child();
    const childDag = defineDag({ ...c, nodes: Object.fromEntries(c.nodes.map(n => [n.id, n])), evalJudges: [judge] });
    const cp = new InMemoryCheckpointer();
    const ctx = { ...context(cp), observer: buffered };
    try {
      const result = await runDag(wrap(childDag), { items: [1, 2] }, ctx, { now: () => 12345 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("node-crash");
      expect(retained[0]?.type).toBe("run-start");
      expect(retained.filter(e => e.type === "node-end" && e.dagId === "child")).toHaveLength(2);
      expect(retained.at(-1)).toMatchObject({ type: "run-end", status: "error" });
      expect(buffered.aggregates.runCount).toBe(1);
      const loaded = await cp.load(ctx.runId);
      expect(loaded.ok && Object.keys(loaded.value?.nodes ?? {})).toEqual(["dag@fan@0@0"]);
    } finally { buffered.close(); }
  });

  it("child finalization completes before durable fan save and root background finalization", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const judge: EvalJudgeNodeDef = { id: nodeId("judge"), kind: "eval-judge", config: { id: "judge", criteria: ["accuracy"] }, run: async () => {
      entered.resolve(); await release.promise;
      return { outcome: "passed", score: 1, criteriaScores: {}, failedCriteria: [], reason: "passed" };
    } };
    const c = child();
    const judged = defineDag({ ...c, nodes: Object.fromEntries(c.nodes.map(n => [n.id, n])), evalJudges: [judge] });
    const cp = new InMemoryCheckpointer();
    const ctx = context(cp);
    const backgrounds: Promise<unknown>[] = [];
    const pending = runDag(wrap(judged), { items: [2] }, ctx, { onBackground: p => { backgrounds.push(p); } });
    await entered.promise;
    const during = await cp.load(ctx.runId);
    expect(during.ok && Object.keys(during.value?.nodes ?? {})).toEqual([]);
    expect(backgrounds).toEqual([]);
    release.resolve();
    expect(await pending).toEqual(ok([4]));
    expect(backgrounds).toHaveLength(1);
    await Promise.all(backgrounds);
    const after = await cp.load(ctx.runId);
    expect(after.ok && Object.keys(after.value?.nodes ?? {})).toEqual(["dag@fan@0@0"]);
  });
});

describe("map construction snapshots", () => {
  const resource = resourceName("orders");
  const freshnessProfiles = [
    { kind: "reads", resource, extractWitness: () => witnessValue("version", "1") },
    { kind: "writes", resource, extractConditionedOn: () => witness("version", resource, "1"), extractNewWitness: () => witnessValue("version", "2") },
  ] satisfies readonly SideEffectProfile[];
  for (const sideEffects of freshnessProfiles) it(`rejects child ${sideEffects.kind} freshness extractors at construction AND DAG snapshot`, () => {
    const work = createFetchNode({ id: "work", inputSchema: z.number(), outputSchema: z.number(), fetch: async n => ok(n), sideEffects });
    const invalid = defineDag({ id: "child", nodes: { work }, edges: [{ from: DAG_INPUT, to: "work" }], outputNodeId: "work" });
    expect(() => fan(invalid)).toThrow("indexed/epoch witness identity");
    const valid = fan(child());
    const forged = { ...valid, mapping: { ...valid.mapping, child: invalid } };
    const result = validateDagShape({ id: "outer", nodes: { fan: forged }, edges: [{ from: DAG_INPUT, to: "fan" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("validation");
  });

  it("normal child reads/writes without extractors remain valid with a configured freshness resource", async () => {
    const index: FreshnessIndex = {
      findConflict: async () => { throw new Error("no extractor should query freshness"); },
      hasRecordedWrite: async () => { throw new Error("no extractor should acknowledge freshness"); },
      recordWrite: async () => { throw new Error("no extractor should record freshness"); },
    };
    const read = createFetchNode({ id: "read", inputSchema: z.number(), outputSchema: z.number(), fetch: async n => ok(n) });
    const write = createFetchNode({ id: "write", inputSchema: z.number(), outputSchema: z.number(), fetch: async n => ok(n * 2), sideEffects: { kind: "writes", resource } });
    const c = defineDag({ id: "child", nodes: { read, write }, edges: [{ from: DAG_INPUT, to: "read" }, { from: "read", to: "write" }], outputNodeId: "write" });
    expect(await runDag(wrap(c), { items: [1, 2] }, context(), { freshnessIndex: index })).toEqual(ok([2, 4]));
  });

  it("validateDag refuses an ordinary callable fabricated as kind map", () => {
    const node = createFetchNode({ id: "fan", inputSchema: itemsSchema, outputSchema: itemsSchema, fetch: async x => ok(x) });
    Reflect.set(node, "kind", "map");
    Reflect.set(node, "requires", ["checkpointer"]);
    const result = validateDagShape({ id: "outer", nodes: { fan: node }, edges: [{ from: DAG_INPUT, to: "fan" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("validation");
  });

  it("fabricated map requirement containers and descriptor accessors fail typed", () => {
    const revoked = Proxy.revocable(["checkpointer"], {});
    revoked.revoke();
    for (const requires of [undefined, null, {}, revoked.proxy]) {
      const node = { ...fan(child()) };
      Reflect.set(node, "requires", requires);
      const result = validateDagShape({ id: "outer", nodes: { fan: node }, edges: [{ from: DAG_INPUT, to: "fan" }] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("validation");
    }
    const node = { ...fan(child()) };
    Object.defineProperty(node, "mapping", { get: () => { throw new Error("hostile descriptor"); } });
    const result = validateDagShape({ id: "outer", nodes: { fan: node }, edges: [{ from: DAG_INPUT, to: "fan" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("validation");
  });

  it("validateDag refuses a missing descriptor and a replaced nested child", () => {
    const original = fan(child());
    const missing = { ...original };
    Reflect.deleteProperty(missing, "mapping");
    const nested = { ...original, mapping: { ...original.mapping, child: wrap(child()) } };
    for (const node of [missing, nested]) {
      const result = validateDagShape({ id: "outer", nodes: { fan: node }, edges: [{ from: DAG_INPUT, to: "fan" }] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("validation");
    }
  });

  it("child node and requirement authoring aliases cannot change an accepted definition", async () => {
    const requires: Capability[] = [];
    const work = createFetchNode({ id: "work", inputSchema: z.number(), outputSchema: z.number(), requires, fetch: async n => ok(n * 2) });
    const c = defineDag({ id: "child", nodes: { work }, edges: [{ from: DAG_INPUT, to: "work" }], outputNodeId: "work" });
    const mapped = fan(c);
    requires.push("map-test:read");
    Reflect.set(work, "run", async () => ok(999));
    expect(Object.isFrozen(mapped.mapping)).toBe(true);
    expect(Object.isFrozen(mapped.mapping.child.nodes)).toBe(true);
    expect(Object.isFrozen(mapped.mapping.child.nodes[0]?.requires)).toBe(true);
    const dag = defineDag({ id: "outer", nodes: { fan: mapped }, edges: [{ from: DAG_INPUT, to: "fan" }], outputNodeId: "fan" });
    expect(await runDag(dag, { items: [3] }, context())).toEqual(ok([6]));
  });

  it("rejects a nested map at construction rather than aliasing indexed completions", () => {
    expect(() => fan(wrap(child()))).toThrow("nested");
  });

  for (const afterDefine of [false, true]) it(`captures child/schema/reducer once (mutate after define: ${afterDefine})`, async () => {
    const calls: number[] = [];
    const config = fanConfig(child(async n => { calls.push(n); return ok(n * 2); }));
    const node = createMapNode(config);
    const define = () => defineDag({ id: "outer", nodes: { fan: node }, edges: [{ from: DAG_INPUT, to: "fan" }], outputNodeId: "fan" });
    const before = afterDefine ? define() : undefined;
    config.child = child(async n => ok(n * 100));
    config.childOutputSchema = z.number().min(1000);
    config.reduce = () => ok([999]);
    expect(await runDag(before ?? define(), { items: [2] }, context())).toEqual(ok([4]));
    expect(calls).toEqual([2]);
  });
});
