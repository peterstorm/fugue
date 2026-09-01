// run-executor.test.ts — production RunExecutor (ADR-0060). Drives the REAL
// `createRunExecutor` over the REAL framework resumable kernel with an in-memory
// SharedInfra + RegisteredDag (ports-and-adapters fakes, no Redis/BullMQ/network).
//
// Covers what the service-level fakes can't:
//   - the channel split: permanent run failures and post-transition checkpoint
//     failures are `ok({ kind: "failed" })` so the service settles them without
//     replaying the prior durable checkpoint;
//   - `toFrameworkError` cause-unwrapping (a thrown error carrying a
//     `FrameworkError` cause surfaces that cause verbatim);
//   - the AbortController slice-timeout wiring: the slice is bounded by
//     `registered.config.timeout`; an over-long slice aborts and maps to `failed`.

import { describe, it, expect } from "bun:test";
import { createInMemorySpendLedger } from "../../../adapters/spend-ledger-memory.js";
import { z } from "zod";
import { markTeam } from "../../../domain/auth.js";
import {
  ok,
  err,
  toJson,
  defineDag,
  dagFingerprint,
  DAG_INPUT,
  noopTracer,
  gitSha,
  nodeId,
  EXECUTOR_NODE_ID,
  tokensOnly,
} from "@fuguejs/framework";
import { compileDagToMachine, persistDagContext } from "@fuguejs/framework/advanced";
import type {
  DagDef,
  DagId,
  NodeContext,
  NodeDef,
  LlmClient,
  Capability,
  FrameworkError,
  CapabilityBroker,
} from "@fuguejs/framework";
import type { RedisPort, SharedInfra } from "../../../ports.js";
import type { RegisteredDag } from "../../../domain/registry.js";
import { tryRunTimestampMs } from "../../types.js";
import type { PersistedIdentity, QueuedRunRecord, RunTimestampMs } from "../../types.js";
import type { RunExecutionJob } from "../../ports.js";
import { makeRunStoreJobLike } from "../../run-store-job.js";
import { createInMemoryRunLeaseAuthority, createInMemoryRunStore } from "../run-store.js";
import { createRunExecutor } from "../run-executor.js";

// ── in-memory SharedInfra ─────────────────────────────────────────────────────

const stubRedis = (m = new Map<string, string>()): RedisPort => {
  return {
    async get(k) { return ok(m.get(k) ?? null); },
    async set(k, v) { m.set(k, v); return ok("OK"); },
    async del(k) { const had = m.delete(k); return ok(had ? 1 : 0); },
    async scan() { return ok({ cursor: "0", keys: [...m.keys()] }); },
    async setNx(k, v) { if (m.has(k)) return ok(false); m.set(k, v); return ok(true); },
    async compareAndDelete(k, expected) { if (m.get(k) !== expected) return ok(false); m.delete(k); return ok(true); },
    async sAdd() { return ok(1); },
    async sRem() { return ok(1); },
    async sMembers() { return ok([]); },
  } as RedisPort;
};

const stubLlm: LlmClient = {
  chat: async () => ({ content: "", usage: { inputTokens: 0, outputTokens: 0 } }),
} as unknown as LlmClient;

const sharedInfra = (): SharedInfra => ({
  llm: stubLlm,
  llmPricingModel: { kind: "request" },
  redis: stubRedis(),
  spendLedger: createInMemorySpendLedger(),
  tracer: noopTracer,
  contentFilter: null,
  prompts: null,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  capabilities: [],
});

// ── DAG + RegisteredDag fixtures ──────────────────────────────────────────────

const noopRun = async (_i: unknown, _c: NodeContext) => ok(undefined as unknown);

type TestNodeDef = NodeDef<
  unknown,
  unknown,
  FrameworkError,
  readonly Capability[]
>;

const makeNode = (id: string, overrides: Partial<TestNodeDef> = {}): TestNodeDef => ({
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

const singleNodeDag = (run: TestNodeDef["run"]): DagDef =>
  defineDag({
    id: "exec-dag",
    nodes: { only: makeNode("only", { run }) },
    edges: [{ from: DAG_INPUT, to: "only" }],
    outputNodeId: "only",
  });

const registered = (dag: DagDef, timeout = 30_000): RegisteredDag => ({
  id: dag.id as DagId,
  team: markTeam("eng"),
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

const timestamp = (value: number): RunTimestampMs => {
  const parsed = tryRunTimestampMs(value);
  if (!parsed.ok) throw new Error(`invalid test timestamp: ${parsed.error}`);
  return parsed.value;
};

/** Seed a real checkpoint for `dag`+`input` and wrap it in a run-store-backed jobLike. */
const seedJobLike = async (
  dag: DagDef,
  input: unknown,
  opts: {
    readonly failCheckpoint?: boolean;
    readonly beforeCheckpointCommit?: () => Promise<void>;
  } = {},
) => {
  const compiled = compileDagToMachine(dag, input);
  if (!compiled.ok) throw new Error("compile failed");
  const checkpoint = toJson({
    state: compiled.value.initialState,
    context: persistDagContext(compiled.value.initialContext, dag),
  });
  const leases = createInMemoryRunLeaseAuthority();
  const store = createInMemoryRunStore(leases);
  const record: QueuedRunRecord = {
    runId: "run-1" as never,
    dagId: dag.id as DagId,
    ownerTeam: markTeam("eng"),
    input,
    identity: ADMIN,
    status: { kind: "queued" },
    checkpoint,
    createdAtMs: timestamp(1),
    updatedAtMs: timestamp(1),
  };
  await store.create(record);
  const lease = leases.acquire(record.runId, "test-owner");
  const runStore = opts.failCheckpoint
    ? { ...store, saveCheckpoint: async () => err({ kind: "redis-unavailable" as const, operation: "saveCheckpoint" }) }
    : opts.beforeCheckpointCommit !== undefined
      ? {
          ...store,
          saveCheckpoint: async (...args: Parameters<typeof store.saveCheckpoint>) => {
            await opts.beforeCheckpointCommit?.();
            return store.saveCheckpoint(...args);
          },
        }
      : store;
  const jl = makeRunStoreJobLike(runStore, lease, checkpoint);
  if (!jl.ok) throw new Error("jobLike build failed");
  return {
    ...jl.value,
    persistedCheckpoint: () => store._runs.get(record.runId)?.checkpoint ?? "",
  };
};

const runReq = (dag: DagDef, jobLike: RunExecutionJob, input: unknown) => ({
  runId: "run-1" as never,
  dagId: dag.id as DagId,
  input,
  identity: ADMIN,
  signal: new AbortController().signal,
  job: jobLike,
  onHumanReview: async () => ({ kind: "approve" }) as never,
  onDecisionConsumed: async () => {},
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("createRunExecutor — channel split (err vs failed)", () => {
  it("a DAG removed after durable acceptance settles as a non-retriable failed outcome", async () => {
    const exec = createRunExecutor({ sharedInfra: sharedInfra(), getRegisteredDag: () => undefined });
    const dag = singleNodeDag(noopRun as never);
    const jobLike = await seedJobLike(dag, null);

    const result = await exec.run(runReq(dag, jobLike, null));

    expect(result.ok && result.value.kind).toBe("failed");
    if (result.ok && result.value.kind === "failed") {
      expect(result.value.error.kind).toBe("node-crash");
      if (result.value.error.kind === "node-crash") {
        expect(result.value.error.retriability).toBe("non-retriable");
        expect(result.value.error.message).toContain("no longer registered");
      }
    }
  });

  it("rejects topology drift between initial seed and the first worker slice", async () => {
    const v1 = singleNodeDag((async () => ok("v1")) as never);
    let v2Runs = 0;
    const v2 = defineDag({
      id: "exec-dag",
      nodes: {
        first: makeNode("first", { run: (async () => { v2Runs += 1; return ok("first"); }) as never }),
        second: makeNode("second", { run: (async () => { v2Runs += 1; return ok("second"); }) as never }),
      },
      edges: [{ from: DAG_INPUT, to: "first" }, { from: "first", to: "second" }],
      outputNodeId: "second",
    });
    let live = registered(v1);
    const exec = createRunExecutor({
      sharedInfra: sharedInfra(),
      getRegisteredDag: () => live,
      agentClientMap: { "exec-dag": "fugue-agent-exec" },
    });
    const seeded = await exec.seedCheckpoint(v1.id as DagId, null);
    if (!seeded.ok) throw new Error("seed failed");
    expect(seeded.value).toContain(dagFingerprint(v1));

    const leases = createInMemoryRunLeaseAuthority();
    const store = createInMemoryRunStore(leases);
    const record: QueuedRunRecord = {
      runId: "run-1" as never,
      dagId: v1.id as DagId,
      ownerTeam: markTeam("eng"),
      input: null,
      identity: ADMIN,
      status: { kind: "queued" },
      checkpoint: seeded.value,
      createdAtMs: timestamp(1),
      updatedAtMs: timestamp(1),
    };
    await store.create(record);
    const job = makeRunStoreJobLike(store, leases.acquire(record.runId), seeded.value);
    if (!job.ok) throw new Error("job build failed");
    live = registered(v2);

    const result = await exec.run(runReq(v2, job.value, null));

    expect(result.ok && result.value.kind).toBe("failed");
    if (result.ok && result.value.kind === "failed") {
      expect(result.value.error.kind).toBe("checkpoint-version-mismatch");
    }
    expect(v2Runs).toBe(0);
  });

  it("contains a throwing startSlice port inside the never-throw run boundary", async () => {
    const dag = singleNodeDag((async () => ok("unreachable")) as never);
    const reg = registered(dag);
    const exec = createRunExecutor({
      sharedInfra: sharedInfra(),
      getRegisteredDag: () => reg,
      agentClientMap: { "exec-dag": "fugue-agent-exec" },
    });
    const jobLike = await seedJobLike(dag, null);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const throwingJob: RunExecutionJob = {
      ...jobLike,
      startSlice: async () => { throw revoked.proxy; },
    };

    const result = await exec.run(runReq(dag, throwingJob, null));

    expect(result.ok && result.value.kind).toBe("failed");
    if (result.ok && result.value.kind === "failed" && result.value.error.kind === "node-crash") {
      expect(result.value.error.nodeId).toBe(EXECUTOR_NODE_ID);
      expect(typeof result.value.error.message).toBe("string");
    }
  });

  it("preserves the slice failure when checkpointFailure inspection also throws", async () => {
    const dag = singleNodeDag((async () => ok("unreachable")) as never);
    const reg = registered(dag);
    const throwingInfra: SharedInfra = {
      ...sharedInfra(),
      get capabilities(): never { throw new Error("original context failure"); },
    };
    const exec = createRunExecutor({
      sharedInfra: throwingInfra,
      getRegisteredDag: () => reg,
      agentClientMap: { "exec-dag": "fugue-agent-exec" },
    });
    const job = await seedJobLike(dag, null);
    const hostileJob: RunExecutionJob = {
      ...job,
      checkpointFailure: () => { throw new Error("checkpoint inspection failure"); },
    };

    const result = await exec.run(runReq(dag, hostileJob, null));

    expect(result.ok && result.value.kind).toBe("failed");
    if (result.ok && result.value.kind === "failed" && result.value.error.kind === "node-crash") {
      expect(result.value.error.retriability).toBe("non-retriable");
      expect(result.value.error.message).toContain("original context failure");
      expect(result.value.error.message).toContain("checkpoint inspection failure");
    }
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

  it("a checkpoint persistence failure fails closed instead of replaying the prior checkpoint", async () => {
    const dag = singleNodeDag((async () => ok("done")) as never);
    const reg = registered(dag);
    const exec = createRunExecutor({ sharedInfra: sharedInfra(), getRegisteredDag: () => reg, agentClientMap: { "exec-dag": "fugue-agent-exec" } });
    const jobLike = await seedJobLike(dag, null, { failCheckpoint: true });

    const result = await exec.run(runReq(dag, jobLike, null));

    expect(result.ok && result.value.kind).toBe("failed");
    if (result.ok && result.value.kind === "failed") {
      expect(result.value.error).toMatchObject({
        kind: "node-crash",
        retriability: "non-retriable",
        nodeId: EXECUTOR_NODE_ID,
      });
      if (result.value.error.kind === "node-crash") {
        expect(result.value.error.message).toContain("stopped to avoid replaying side effects");
        expect(result.value.error.message).toContain("saveCheckpoint");
      }
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
    // (here a deterministic node throw → non-retriable node-crash). The executor's
    // `toFrameworkError` takes the `cause` branch and surfaces that framework error
    // verbatim — NOT the synthetic node-crash on EXECUTOR_NODE_ID it would emit
    // if the cause were missing.
    const dag = singleNodeDag((async () => { throw new Error("node blew up"); }) as never);
    const reg = registered(dag);
    const exec = createRunExecutor({ sharedInfra: sharedInfra(), getRegisteredDag: () => reg, agentClientMap: { "exec-dag": "fugue-agent-exec" } });
    const jobLike = await seedJobLike(dag, null);
    const res = await exec.run(runReq(dag, jobLike, null));
    expect(res.ok && res.value.kind).toBe("failed");
    if (res.ok && res.value.kind === "failed") {
      const e = res.value.error;
      // A genuine node-scoped framework error came through (cause unwrapped)…
      expect(e.kind).toBe("node-crash");
      if (e.kind === "node-crash") {
        expect(e.nodeId).toBe(nodeId("only"));
        expect(e.retriability).toBe("non-retriable");
        expect(e.message).toBe("node blew up");
      }
      // …rather than the host's fallback wrapper on the executor sentinel.
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

  it("a hostile caught value cannot escape while diagnostics are rendered", async () => {
    const dag = singleNodeDag((async () => ok("x")) as never);
    const reg = registered(dag);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const throwingInfra: SharedInfra = {
      ...sharedInfra(),
      get capabilities(): never { throw revoked.proxy; },
    };
    const exec = createRunExecutor({
      sharedInfra: throwingInfra,
      getRegisteredDag: () => reg,
      agentClientMap: { "exec-dag": "fugue-agent-exec" },
    });
    const jobLike = await seedJobLike(dag, null);

    const result = await exec.run(runReq(dag, jobLike, null));

    expect(result.ok && result.value.kind).toBe("failed");
    if (result.ok && result.value.kind === "failed" && result.value.error.kind === "node-crash") {
      expect(result.value.error.nodeId).toBe(EXECUTOR_NODE_ID);
      expect(typeof result.value.error.message).toBe("string");
    }
  });

  it("a context-build throw settles as `failed` carrying the wiring fault's message (the durable diagnostic)", async () => {
    // The setup phase is host wiring (context build), not an in-DAG node crash.
    // Whatever channel settles it, the recorded FrameworkError must carry the
    // factory's actual message — the operator's only durable diagnostic (the
    // service's err-channel mapping would drop it), and the log line must be
    // findable at error level with the message attached.
    const dag = singleNodeDag((async () => ok("x")) as never);
    const reg = registered(dag);
    const throwingInfra: SharedInfra = {
      ...sharedInfra(),
      get capabilities(): never { throw new Error("infra exploded"); },
    };
    const exec = createRunExecutor({ sharedInfra: throwingInfra, getRegisteredDag: () => reg, agentClientMap: { "exec-dag": "fugue-agent-exec" } });
    const jobLike = await seedJobLike(dag, null);
    const res = await exec.run(runReq(dag, jobLike, null));
    expect(res.ok && res.value.kind).toBe("failed");
    if (res.ok && res.value.kind === "failed") {
      const e = res.value.error;
      if (e.kind !== "node-crash") {
        throw new Error(`expected the node-crash fallback, got ${e.kind}`);
      }
      // The factory's actual message survives into the recorded error.
      expect(e.message).toContain("infra exploded");
    }
  });

  it("a throwing failure logger cannot replace the original failed outcome", async () => {
    const dag = singleNodeDag((async () => ok("x")) as never);
    const reg = registered(dag);
    const throwingInfra: SharedInfra = {
      ...sharedInfra(),
      get capabilities(): never { throw new Error("original setup failure"); },
    };
    const exec = createRunExecutor({
      sharedInfra: throwingInfra,
      getRegisteredDag: () => reg,
      agentClientMap: { "exec-dag": "fugue-agent-exec" },
      logger: {
        info: () => {},
        warn: () => {},
        error: () => { throw new Error("logger transport failed"); },
      },
    });
    const jobLike = await seedJobLike(dag, null);

    const result = await exec.run(runReq(dag, jobLike, null));

    expect(result.ok && result.value.kind).toBe("failed");
    if (result.ok && result.value.kind === "failed" && result.value.error.kind === "node-crash") {
      expect(result.value.error.message).toContain("original setup failure");
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

describe("createRunExecutor — broker LLM metering survives HITL resume", () => {
  it("hydrates the first slice's broker call and refuses provider egress after approval", async () => {
    let providerCalls = 0;
    const brokerLlm: LlmClient = {
      sendStructured: async <O>() => {
        providerCalls += 1;
        return ok({ output: "ok" as O, rawText: "", ...tokensOnly(1, 0) });
      },
      sendWithTools: async <O>() => {
        providerCalls += 1;
        return ok({ output: "ok" as O, rawText: "", ...tokensOnly(1, 0) });
      },
    };
    const capability = "resumeBrokerLlm" as Capability;
    const broker: CapabilityBroker = {
      mintFor: async () => ok({
        [capability]: {
          clientKind: "llm",
          client: brokerLlm,
          pricingModel: { kind: "fixed", model: "gpt-4o" },
          runScopedOperations: {},
        },
      } as never),
      provides: (candidate) => candidate === capability,
    };
    const callBroker = (async (_input: unknown, ctx: NodeContext) => {
      const client = (ctx as unknown as Record<string, LlmClient>)[capability];
      if (client === undefined) throw new Error("broker LLM was not merged");
      const result = await client.sendStructured({
        system: "s",
        user: "u",
        model: "gpt-4o",
        schema: z.string(),
        nodeId: nodeId("broker-call"),
      });
      return result.ok ? ok(result.value.output) : result;
    }) as never;
    const dag = defineDag({
      id: "exec-dag",
      nodes: {
        beforeReview: makeNode("beforeReview", {
          run: callBroker,
          requires: [capability],
          humanReview: { prompt: "Approve?" } as never,
        }),
        afterReview: makeNode("afterReview", {
          run: callBroker,
          requires: [capability],
        }),
      },
      edges: [
        { from: DAG_INPUT, to: "beforeReview" },
        { from: "beforeReview", to: "afterReview" },
      ],
      outputNodeId: "afterReview",
    });
    const baseRegistration = registered(dag);
    const reg: RegisteredDag = {
      ...baseRegistration,
      config: { ...baseRegistration.config, llmBudget: { calls: 1 } },
    };
    const exec = createRunExecutor({
      sharedInfra: sharedInfra(),
      getRegisteredDag: () => reg,
      broker,
      agentClientMap: { "exec-dag": "fugue-agent-exec" },
    });
    const job = await seedJobLike(dag, null);

    const parked = await exec.run({
      ...runReq(dag, job, null),
      onHumanReview: async () => ({ kind: "pending" }),
    });
    expect(parked.ok && parked.value.kind).toBe("suspended");
    expect(providerCalls).toBe(1);

    const resumed = await exec.run({
      ...runReq(dag, job, null),
      onHumanReview: async () => ({ kind: "approve" }),
    });
    expect(resumed.ok && resumed.value.kind).toBe("failed");
    if (resumed.ok && resumed.value.kind === "failed") {
      expect(resumed.value.error.kind).toBe("llm-budget-exceeded");
    }
    expect(providerCalls).toBe(1);
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

  it("hard-bounds an abort-insensitive node and fences late durable progress", async () => {
    const dag = singleNodeDag((async () => {
      await Bun.sleep(40); // deliberately ignores ctx.signal
      return ok("late-success");
    }) as never);
    const reg = registered(dag, 5);
    const exec = createRunExecutor({
      sharedInfra: sharedInfra(),
      getRegisteredDag: () => reg,
      agentClientMap: { "exec-dag": "fugue-agent-exec" },
    });
    const job = await seedJobLike(dag, null);

    const result = await Promise.race([
      exec.run(runReq(dag, job, null)),
      Bun.sleep(250).then(() => { throw new Error("worker slice remained wedged"); }),
    ]);

    expect(result.ok && result.value.kind).toBe("failed");
    if (result.ok && result.value.kind === "failed") {
      expect(result.value.error.kind).toBe("aborted");
    }
    const checkpointAtTimeout = job.persistedCheckpoint();
    await Bun.sleep(60);
    expect(job.persistedCheckpoint()).toBe(checkpointAtTimeout);
  });

  it("rejects a checkpoint write that started before but reaches commit after the deadline", async () => {
    const dag = singleNodeDag((async () => ok("done")) as never);
    const reg = registered(dag, 5);
    let markWriteStarted!: () => void;
    let releaseWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    const writeBlocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const job = await seedJobLike(dag, null, {
      beforeCheckpointCommit: async () => {
        markWriteStarted();
        await writeBlocked;
      },
    });
    const exec = createRunExecutor({
      sharedInfra: sharedInfra(),
      getRegisteredDag: () => reg,
      agentClientMap: { "exec-dag": "fugue-agent-exec" },
    });
    const checkpointBefore = job.persistedCheckpoint();

    const execution = exec.run(runReq(dag, job, null));
    await writeStarted;
    const result = await execution;
    expect(result.ok && result.value.kind).toBe("failed");

    releaseWrite();
    await Bun.sleep(20);
    expect(job.persistedCheckpoint()).toBe(checkpointBefore);
  });

  it("does not consume a decision when its post-gate checkpoint reaches commit after timeout", async () => {
    const dag = defineDag({
      id: "exec-dag",
      nodes: {
        only: makeNode("only", {
          humanReview: { prompt: "Approve?" } as never,
          run: (async () => ok("reviewed")) as never,
        }),
      },
      edges: [{ from: DAG_INPUT, to: "only" }],
      outputNodeId: "only",
    });
    let blockCheckpoint = false;
    let markWriteStarted!: () => void;
    let releaseWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    const writeBlocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const job = await seedJobLike(dag, null, {
      beforeCheckpointCommit: async () => {
        if (!blockCheckpoint) return;
        markWriteStarted();
        await writeBlocked;
      },
    });
    let live = registered(dag, 60_000);
    const exec = createRunExecutor({
      sharedInfra: sharedInfra(),
      getRegisteredDag: () => live,
      agentClientMap: { "exec-dag": "fugue-agent-exec" },
    });

    const parked = await exec.run({
      ...runReq(dag, job, null),
      onHumanReview: async () => ({ kind: "pending" }),
    });
    expect(parked.ok && parked.value.kind).toBe("suspended");

    live = registered(dag, 5);
    blockCheckpoint = true;
    let consumed = 0;
    const resumed = exec.run({
      ...runReq(dag, job, null),
      onHumanReview: async () => ({ kind: "approve" }),
      onDecisionConsumed: async () => { consumed += 1; },
    });
    await writeStarted;
    const timedOut = await resumed;
    expect(timedOut.ok && timedOut.value.kind).toBe("failed");

    releaseWrite();
    await Bun.sleep(20);
    expect(consumed).toBe(0);
  });

  it("aborts the node context immediately when the queue lease signal aborts", async () => {
    let observedAbort = false;
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const dag = singleNodeDag((async (_i: unknown, ctx: NodeContext) => {
      markStarted();
      await new Promise<void>((resolve) => {
        ctx.signal?.addEventListener("abort", () => {
          observedAbort = true;
          resolve();
        }, { once: true });
      });
      throw new Error("lease aborted");
    }) as never);
    const reg = registered(dag, 60_000);
    const exec = createRunExecutor({ sharedInfra: sharedInfra(), getRegisteredDag: () => reg, agentClientMap: { "exec-dag": "fugue-agent-exec" } });
    const jobLike = await seedJobLike(dag, null);
    const leaseController = new AbortController();
    const execution = exec.run({ ...runReq(dag, jobLike, null), signal: leaseController.signal });

    await started;
    leaseController.abort("ownership-lost");
    const result = await execution;

    expect(observedAbort).toBe(true);
    expect(result.ok && result.value.kind).toBe("failed");
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

// ── Routed-tenant forwarding on the HITL resume path (ADR-0067 / SC-001) ──────
//
// The factory's routedTenant→namespace precedence is proven in
// node-context-factory.test.ts; THESE tests prove the executor actually FORWARDS
// its `deps.tenant` into the factory's `routedTenant` (a regression dropping it
// would silently namespace a resumed run's cache/checkpoint keys under the
// dag.team fallback — an SC-001 escape when the tenant id != the DAG's team).

import { tenantId } from "../../../domain/tenant.js";

const mkTenant = (s: string) => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`bad test tenant: ${s}`);
  return r.value;
};

describe("createRunExecutor — forwards deps.tenant as routedTenant (SC-001)", () => {
  it("namespaces a resumed run's keys under deps.tenant, NEVER the DAG's owning team (id != team)", async () => {
    // The DAG is owned by team "eng" (see `registered`); the worker is routed for
    // tenant "acme-prod". A node writes a cache key during the run — it must land
    // under fugue:acme-prod:, proving deps.tenant flowed into the node context.
    const store = new Map<string, string>();
    const infra: SharedInfra = { ...sharedInfra(), redis: stubRedis(store) };
    const dag = singleNodeDag((async (_i: unknown, ctx: NodeContext) => {
      if (!ctx.cache) throw new Error("expected a namespaced cache on the node context");
      await ctx.cache.set("probe", { v: 1 });
      return ok("done");
    }) as never);
    const reg = registered(dag);
    const exec = createRunExecutor({
      sharedInfra: infra,
      getRegisteredDag: () => reg,
      agentClientMap: { "exec-dag": "fugue-agent-exec" },
      tenant: mkTenant("acme-prod"),
    });
    const jobLike = await seedJobLike(dag, null);
    const res = await exec.run(runReq(dag, jobLike, null));
    expect(res.ok && res.value.kind).toBe("completed");

    const keys = [...store.keys()];
    const namespaced = keys.filter((k) => k.startsWith("fugue:"));
    expect(namespaced.length).toBeGreaterThan(0); // non-vacuous: the node DID write
    expect(namespaced.every((k) => k.startsWith("fugue:acme-prod:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("fugue:eng:"))).toBe(false);
  });

  it("OMITTING deps.tenant falls back to the dag.team derivation (single-tenant parity)", async () => {
    const store = new Map<string, string>();
    const infra: SharedInfra = { ...sharedInfra(), redis: stubRedis(store) };
    const dag = singleNodeDag((async (_i: unknown, ctx: NodeContext) => {
      if (!ctx.cache) throw new Error("expected a namespaced cache on the node context");
      await ctx.cache.set("probe", { v: 1 });
      return ok("done");
    }) as never);
    const reg = registered(dag);
    // No `tenant` → the factory derives the namespace from dag.team ("eng").
    const exec = createRunExecutor({ sharedInfra: infra, getRegisteredDag: () => reg, agentClientMap: { "exec-dag": "fugue-agent-exec" } });
    const jobLike = await seedJobLike(dag, null);
    const res = await exec.run(runReq(dag, jobLike, null));
    expect(res.ok && res.value.kind).toBe("completed");
    expect([...store.keys()].some((k) => k.startsWith("fugue:eng:"))).toBe(true);
  });
});

describe("createRunExecutor — resume does not depend on a re-presented subject token", () => {
  it("a USER-identity run resumes and completes on the no-broker static path (no subject token rebound)", async () => {
    // The executor passes `bindSubjectToken: undefined` on resume: a user run's
    // verified subject_token is bound at INITIATION, never re-presented across a
    // park/resume. With no broker wired, the run completes on the static path —
    // proving resume needs no subject token (and so cannot reuse a stale one). A
    // regression that started REQUIRING a re-presented token on resume would break
    // this user-path completion.
    const user: PersistedIdentity = { kind: "user", sub: "user-123", azp: "fugue-platform" };
    const dag = singleNodeDag((async () => ok("done")) as never);
    const reg = registered(dag);
    const exec = createRunExecutor({ sharedInfra: sharedInfra(), getRegisteredDag: () => reg, agentClientMap: { "exec-dag": "fugue-agent-exec" } });
    const jobLike = await seedJobLike(dag, null);
    const res = await exec.run({ ...runReq(dag, jobLike, null), identity: user });
    expect(res.ok && res.value.kind).toBe("completed");
  });
});
