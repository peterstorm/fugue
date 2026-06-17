// run-executor.test.ts — production RunExecutor (ADR-0060). Drives the REAL
// `createRunExecutor` over the REAL framework resumable kernel with an in-memory
// SharedInfra + RegisteredDag (ports-and-adapters fakes, no Redis/BullMQ/network).
//
// Covers what the service-level fakes can't:
//   - the channel split: an UNKNOWN DAG is the `err` channel, but a genuine
//     run-FAILURE is `ok({ kind: "failed" })` so the service settles the run
//     (never the err channel, which is reserved for host infra faults);
//   - `toFrameworkError` cause-unwrapping (a thrown error carrying a
//     `FrameworkError` cause surfaces that cause verbatim);
//   - the AbortController slice-timeout wiring: the slice is bounded by
//     `registered.config.timeout`; an over-long slice aborts and maps to `failed`.

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  ok,
  err,
  toJson,
  defineDag,
  DAG_INPUT,
  noopTracer,
  gitSha,
  EXECUTOR_NODE_ID,
} from "@fuguejs/framework";
import { compileDagToMachine, stripNonPersistable } from "@fuguejs/framework/advanced";
import type {
  DagDef,
  DagId,
  NodeId,
  NodeContext,
  NodeDef,
  LlmClient,
  CapabilityBroker,
} from "@fuguejs/framework";
import type { RedisPort, SharedInfra } from "../../../ports.js";
import type { RegisteredDag } from "../../../domain/registry.js";
import type { RunRecord, RunStatus, PersistedIdentity } from "../../types.js";
import { makeRunStoreJobLike } from "../../run-store-job.js";
import { createInMemoryRunStore } from "../run-store.js";
import { createRunExecutor } from "../run-executor.js";

// ── in-memory SharedInfra ─────────────────────────────────────────────────────

const stubRedis = (): RedisPort => {
  const m = new Map<string, string>();
  return {
    async get(k) { return ok(m.get(k) ?? null); },
    async set(k, v) { m.set(k, v); return ok("OK"); },
    async del(k) { const had = m.delete(k); return ok(had ? 1 : 0); },
    async scan() { return ok({ cursor: "0", keys: [...m.keys()] }); },
    async setNx(k, v) { if (m.has(k)) return ok(false); m.set(k, v); return ok(true); },
  } as RedisPort;
};

const stubLlm: LlmClient = {
  chat: async () => ({ content: "", usage: { inputTokens: 0, outputTokens: 0 } }),
} as unknown as LlmClient;

const sharedInfra = (): SharedInfra => ({
  llm: stubLlm,
  redis: stubRedis(),
  tracer: noopTracer,
  contentFilter: null,
  prompts: null,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  capabilities: [],
});

// ── DAG + RegisteredDag fixtures ──────────────────────────────────────────────

const noopRun = async (_i: unknown, _c: NodeContext) => ok(undefined as unknown);

const makeNode = (id: string, overrides: Partial<NodeDef<unknown, unknown>> = {}): NodeDef<unknown, unknown> => ({
  // @ts-expect-error — branded id test fixture
  id,
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: noopRun as never,
  requires: [],
  sideEffects: { kind: "none" },
  confidence: { mode: "none" },
  ...overrides,
});

const singleNodeDag = (run: NodeDef<unknown, unknown>["run"]): DagDef =>
  defineDag({
    id: "exec-dag",
    nodes: { only: makeNode("only", { run }) },
    edges: [{ from: DAG_INPUT, to: "only" }],
    outputNodeId: "only",
  });

const registered = (dag: DagDef, timeout = 30_000): RegisteredDag => ({
  id: dag.id as DagId,
  team: "eng",
  route: "/dags/exec-dag/run",
  dag,
  inputSchema: z.unknown(),
  config: { timeout, maxConcurrency: 10, cacheTtlMs: 0, checkpointTtlMs: 0 },
  meta: { description: "t", version: "1.0.0" },
  loadedAt: 1,
  sha: gitSha("abc123"),
  status: { kind: "healthy" },
  modulePath: "/tmp/dags/eng/exec-dag/dag.ts",
  prompts: new Map(),
});

const ADMIN: PersistedIdentity = { kind: "admin" };

/** Seed a real checkpoint for `dag`+`input` and wrap it in a run-store-backed jobLike. */
const seedJobLike = async (dag: DagDef, input: unknown) => {
  const compiled = compileDagToMachine(dag, input);
  if (!compiled.ok) throw new Error("compile failed");
  const checkpoint = toJson({
    state: compiled.value.initialState,
    context: stripNonPersistable(compiled.value.initialContext),
  });
  const store = createInMemoryRunStore();
  const record: RunRecord = {
    runId: "run-1" as never,
    dagId: dag.id as DagId,
    input,
    identity: ADMIN,
    status: { kind: "running" } as RunStatus,
    checkpoint,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  await store.create(record);
  const jl = makeRunStoreJobLike(store, "run-1" as never, checkpoint);
  if (!jl.ok) throw new Error("jobLike build failed");
  return jl.value;
};

const runReq = (dag: DagDef, jobLike: Awaited<ReturnType<typeof seedJobLike>>, input: unknown) => ({
  runId: "run-1" as never,
  dagId: dag.id as DagId,
  input,
  identity: ADMIN,
  jobLike,
  onHumanReview: async () => ({ kind: "approve" }) as never,
  onDecisionConsumed: async () => {},
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("createRunExecutor — channel split (err vs failed)", () => {
  it("an UNKNOWN dag uses the `err` channel (host infra fault), not `failed`", async () => {
    const exec = createRunExecutor({ sharedInfra: sharedInfra(), getRegisteredDag: () => undefined });
    const dag = singleNodeDag(noopRun as never);
    const jobLike = await seedJobLike(dag, null);
    const res = await exec.run(runReq(dag, jobLike, null));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("dag-not-found");
  });

  it("a known dag that COMPLETES returns ok({ kind: 'completed' }) with the output", async () => {
    const dag = singleNodeDag((async () => ok("done")) as never);
    const reg = registered(dag);
    const exec = createRunExecutor({ sharedInfra: sharedInfra(), getRegisteredDag: () => reg, agentClientMap: { "exec-dag": "fugue-agent-exec" } });
    const jobLike = await seedJobLike(dag, null);
    const res = await exec.run(runReq(dag, jobLike, null));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.kind).toBe("completed");
      if (res.value.kind === "completed") expect(res.value.output).toBe("done");
    }
  });

  it("a genuine run-FAILURE is the `failed` outcome on the OK channel (service settles it)", async () => {
    // A node that throws a bare Error → the kernel wraps it; the executor maps the
    // thrown failure onto `ok({ kind: "failed" })`, NOT the `err` channel.
    const dag = singleNodeDag((async () => { throw new Error("boom in node"); }) as never);
    const reg = registered(dag);
    const exec = createRunExecutor({ sharedInfra: sharedInfra(), getRegisteredDag: () => reg, agentClientMap: { "exec-dag": "fugue-agent-exec" } });
    const jobLike = await seedJobLike(dag, null);
    const res = await exec.run(runReq(dag, jobLike, null));
    expect(res.ok).toBe(true); // host infra is fine — the RUN failed, not the host
    if (res.ok) {
      expect(res.value.kind).toBe("failed");
      if (res.value.kind === "failed") {
        expect(res.value.error).toBeDefined();
        expect(typeof res.value.error.kind).toBe("string");
      }
    }
  });

  it("toFrameworkError surfaces the kernel's FrameworkError cause verbatim (cause-unwrap branch)", async () => {
    // `runResumableDagJob` throws an Error whose `cause` is the real FrameworkError
    // (here a node throw → kernel `retry-exhausted` after its retry budget). The
    // executor's `toFrameworkError` takes the `cause` branch and surfaces that
    // framework error verbatim — NOT the synthetic `node-crash`/EXECUTOR_NODE_ID
    // fallback it would emit if the cause were missing.
    const dag = singleNodeDag((async () => { throw new Error("node blew up"); }) as never);
    const reg = registered(dag);
    const exec = createRunExecutor({ sharedInfra: sharedInfra(), getRegisteredDag: () => reg, agentClientMap: { "exec-dag": "fugue-agent-exec" } });
    const jobLike = await seedJobLike(dag, null);
    const res = await exec.run(runReq(dag, jobLike, null));
    expect(res.ok && res.value.kind).toBe("failed");
    if (res.ok && res.value.kind === "failed") {
      const e = res.value.error;
      // A genuine framework discriminant came through (the cause was unwrapped)…
      expect(e.kind).toBe("retry-exhausted");
      // …rather than the host's fallback wrapper (which only appears if `cause`
      // were absent): that fallback is always `node-crash` on the EXECUTOR node.
      expect(e.kind === "node-crash" && e.nodeId === EXECUTOR_NODE_ID).toBe(false);
    }
  });

  it("falls back to node-crash on EXECUTOR_NODE_ID when a thrown error carries NO framework cause", async () => {
    // The executor's `getRegisteredDag` is fine, but `createNodeContextForDag` is
    // exercised with a context-build throw (a non-FrameworkError, no `.cause`):
    // the slice-timeout setTimeout still arms, and the bare throw maps to the
    // host's fallback FrameworkError. We provoke it via a SharedInfra whose redis
    // throws synchronously during context construction.
    const dag = singleNodeDag((async () => ok("x")) as never);
    const reg = registered(dag);
    const throwingInfra: SharedInfra = {
      ...sharedInfra(),
      // makeNodeContext reads capabilities/redis lazily; a getter that throws
      // surfaces as a bare (no-cause) error out of createNodeContextForDag.
      get capabilities(): never { throw new Error("infra exploded"); },
    };
    const exec = createRunExecutor({ sharedInfra: throwingInfra, getRegisteredDag: () => reg, agentClientMap: { "exec-dag": "fugue-agent-exec" } });
    const jobLike = await seedJobLike(dag, null);
    const res = await exec.run(runReq(dag, jobLike, null));
    expect(res.ok && res.value.kind).toBe("failed");
    if (res.ok && res.value.kind === "failed") {
      const e = res.value.error;
      expect(e.kind).toBe("node-crash");
      if (e.kind === "node-crash") expect(e.nodeId).toBe(EXECUTOR_NODE_ID);
    }
  });
});

describe("createRunExecutor — fail-closed on an empty AGENT_CLIENT_MAP (FR-040)", () => {
  // A trivial broker makes per-node minting ACTIVE so the FR-040 fail-closed
  // origin check fires. The broker itself is never reached: the factory refuses
  // (throws) BEFORE any minting when the DAG has no agent-client mapping.
  const mintingBroker: CapabilityBroker = {
    mintFor: async () => { throw new Error("unreachable — fail-closed fires before minting"); },
    provides: (c) => (c as string).includes(":"),
  };

  it("a known DAG with NO agent-client mapping (minting active) resolves to `failed` (no fabricated identity), not `completed`", async () => {
    // The DAG IS registered and the node would succeed — but the worker has no
    // `agentClientMap` entry for it, so `createNodeContextForDag` refuses to
    // build an origin (FR-040 fail-closed) and the slice settles as `failed`. The
    // run never executes under a fabricated/absent agent identity.
    const dag = singleNodeDag((async () => ok("would-succeed")) as never);
    const reg = registered(dag);
    // agentClientMap omitted → defaults to `{}` (every DAG unmapped → fail closed).
    const exec = createRunExecutor({ sharedInfra: sharedInfra(), getRegisteredDag: () => reg, broker: mintingBroker });
    const jobLike = await seedJobLike(dag, null);
    const res = await exec.run(runReq(dag, jobLike, null));

    // Host infra is fine (ok channel), but the RUN is refused → `failed`.
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.kind).toBe("failed");
      // It must NOT have silently completed under a fabricated identity.
      expect(res.value.kind).not.toBe("completed");
    }
  });

  it("an EMPTY agentClientMap object behaves identically to omitting it (explicit {} → fail closed) when minting is active", async () => {
    const dag = singleNodeDag((async () => ok("would-succeed")) as never);
    const reg = registered(dag);
    const exec = createRunExecutor({ sharedInfra: sharedInfra(), getRegisteredDag: () => reg, agentClientMap: {}, broker: mintingBroker });
    const jobLike = await seedJobLike(dag, null);
    const res = await exec.run(runReq(dag, jobLike, null));
    expect(res.ok && res.value.kind).toBe("failed");
  });

  it("zero-regression: with NO broker wired (minting inactive), an unmapped DAG COMPLETES — the no-realm static path must not fail closed", async () => {
    // No broker → `origin` is never consumed → an unmapped DAG runs the static
    // path byte-identically to today (SC-001/SC-005) instead of being refused.
    const dag = singleNodeDag((async () => ok("would-succeed")) as never);
    const reg = registered(dag);
    const exec = createRunExecutor({ sharedInfra: sharedInfra(), getRegisteredDag: () => reg, agentClientMap: {} });
    const jobLike = await seedJobLike(dag, null);
    const res = await exec.run(runReq(dag, jobLike, null));
    expect(res.ok && res.value.kind).toBe("completed");
  });
});

describe("createRunExecutor — slice timeout (AbortController wiring)", () => {
  it("aborts a slice that outruns config.timeout and maps the abort to `failed`", async () => {
    // The node hangs until the injected signal fires — proving the slice is bounded
    // by `registered.config.timeout`, NOT by the (unbounded) human wait. A tiny
    // timeout makes the abort the reason the slice settles.
    const dag = singleNodeDag((async (_i: unknown, ctx: NodeContext) => {
      await new Promise<void>((_resolve, reject) => {
        if (!ctx.signal) return reject(new Error("no signal wired into ctx"));
        ctx.signal.addEventListener("abort", () => {
          const e = new Error("aborted") as Error & { name: string };
          e.name = "AbortError";
          reject(e);
        });
      });
      return ok(undefined as unknown);
    }) as never);
    const reg = registered(dag, 5); // 5ms slice budget
    const exec = createRunExecutor({ sharedInfra: sharedInfra(), getRegisteredDag: () => reg, agentClientMap: { "exec-dag": "fugue-agent-exec" } });
    const jobLike = await seedJobLike(dag, null);

    const res = await exec.run(runReq(dag, jobLike, null));
    // Never throws: the abort surfaces as a settled `failed` outcome.
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.kind).toBe("failed");
  });

  it("a fast slice under config.timeout completes normally (timeout does not fire)", async () => {
    const dag = singleNodeDag((async () => ok("fast")) as never);
    const reg = registered(dag, 60_000);
    const exec = createRunExecutor({ sharedInfra: sharedInfra(), getRegisteredDag: () => reg, agentClientMap: { "exec-dag": "fugue-agent-exec" } });
    const jobLike = await seedJobLike(dag, null);
    const res = await exec.run(runReq(dag, jobLike, null));
    expect(res.ok && res.value.kind).toBe("completed");
  });
});
