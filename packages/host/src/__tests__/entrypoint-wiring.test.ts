import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHostConfig } from "../domain/config.js";
import {
  createHostLlmClient,
  createJsonConsoleLogger,
  disconnectRedisClients,
  hostLlmPricingModel,
  planHostLlm,
  redisOperationFailure,
  redisUrlRedactions,
} from "../entrypoint-wiring.js";
import {
  createFetchNode,
  DAG_INPUT,
  defineDagFromArray,
  gitSha,
  ok,
  tokensOnly,
} from "@fuguejs/framework";
import type {
  CapabilityBroker,
  DagId,
  FrameworkError,
  LlmClient,
  LlmResponse,
  Result,
} from "@fuguejs/framework";
import { z } from "zod";
import { createHost, type HostInstance } from "../host.js";
import type { DagRegistration } from "../domain/dag-registration.js";
import type { BulkLoadResult, LoadResult, ModuleLoaderPort } from "../ports.js";
import {
  fakeGit,
  fakeInfra,
  fakeLoader,
  fakeRedis,
  makeConfig,
  mkTenant,
  testLogger,
} from "./fixtures/host-boot-fakes.js";

/** A promise plus its resolver — parks a node so a request stays in flight. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

declare module "@fuguejs/framework" {
  interface CapabilityRegistry {
    shellBrokerLlm: LlmClient;
  }
}

const redisFailureTypePin = (): void => {
  // @ts-expect-error -- callers must explicitly supply configured secret spellings.
  redisOperationFailure("PING", new Error("secret-bearing diagnostic"));
};
void redisFailureTypePin;

const config = (provider: "anthropic" | "openai" | "azure") => {
  const result = parseHostConfig({
    DAGS_REPO_URL: "https://github.com/test/dags.git",
    REDIS_URL: "redis://localhost:6379",
    ADMIN_TOKEN: "test-admin-token-long-enough",
    LLM_PROVIDER: provider,
    ANTHROPIC_API_KEY: "anthropic-key",
    OPENAI_API_KEY: "openai-key",
    AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com/",
    AZURE_OPENAI_DEPLOYMENT: "deployment-a",
    AZURE_OPENAI_MODEL: "gpt-4o-mini",
    AZURE_OPENAI_API_KEY: "azure-key",
  });
  if (!result.ok) throw new Error("invalid test configuration");
  return result.value;
};

describe("createJsonConsoleLogger", () => {
  it("emits the shared JSON envelope through the selected sink", () => {
    const lines: string[] = [];
    const logger = createJsonConsoleLogger(
      {
        info: (line) => lines.push(`info:${line}`),
        warn: (line) => lines.push(`warn:${line}`),
        error: (line) => lines.push(`error:${line}`),
      },
      () => new Date("2026-08-20T05:00:00.000Z"),
    );

    logger.info("boot", { tenant: "acme" });
    expect(lines).toEqual([
      'info:{"level":"info","msg":"boot","tenant":"acme","ts":"2026-08-20T05:00:00.000Z"}',
    ]);
  });

  it("preserves level and message when contextual data is unserializable", () => {
    const lines: string[] = [];
    const logger = createJsonConsoleLogger(
      {
        info: (line) => lines.push(line),
        warn: (line) => lines.push(line),
        error: (line) => lines.push(line),
      },
      () => new Date("2026-08-20T05:00:00.000Z"),
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    logger.error("failed", cyclic);
    expect(JSON.parse(lines[0]!)).toEqual({
      level: "error",
      msg: "failed",
      ts: null,
      logSerializationError: "log payload could not be serialized",
    });
  });
});

describe("Redis entrypoint cleanup", () => {
  it("attempts every quit and rejects with every cleanup failure", async () => {
    const attempted: string[] = [];

    const cleanup = disconnectRedisClients([
      {
        name: "command",
        quit: async () => {
          attempted.push("command");
          throw new Error("socket closed");
        },
      },
      {
        name: "subscriber",
        quit: async () => {
          attempted.push("subscriber");
          throw new Error("ACL denied");
        },
      },
    ]);

    await expect(cleanup).rejects.toThrow(
      "Redis disconnect failed: command: socket closed; subscriber: ACL denied",
    );
    expect(attempted).toEqual(["command", "subscriber"]);
  });

  it("preserves each original cleanup rejection as Error.cause", async () => {
    const original = new Error("socket closed");
    try {
      await disconnectRedisClients([{
        name: "command",
        quit: async () => { throw original; },
      }]);
      throw new Error("expected disconnect failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) return;
      expect(error.errors).toHaveLength(1);
      expect(error.errors[0]).toBeInstanceOf(Error);
      expect((error.errors[0] as Error).cause).toBe(original);
    }
  });

  it("still attempts later clients when an earlier quit throws synchronously", async () => {
    const attempted: string[] = [];

    await expect(disconnectRedisClients([
      {
        name: "command",
        quit: () => {
          attempted.push("command");
          throw new Error("sync failure");
        },
      },
      {
        name: "subscriber",
        quit: async () => {
          attempted.push("subscriber");
        },
      },
    ])).rejects.toThrow("Redis disconnect failed: command: sync failure");

    expect(attempted).toEqual(["command", "subscriber"]);
  });

  it("keeps Redis command diagnostics while redacting configured secrets", () => {
    const redisUrl = "redis://user:p%40ssword@redis:6379";
    const failure = redisOperationFailure(
      "GET fugue:key",
      new Error(`NOAUTH password p@ssword from ${redisUrl}`),
      redisUrlRedactions(redisUrl),
    );

    expect(failure).toEqual({
      kind: "redis-unavailable",
      operation: "GET fugue:key (NOAUTH password [redacted] from [redacted])",
    });
  });
});

describe("host LLM entrypoint wiring", () => {
  it("plans OpenAI and Azure endpoints once for both entrypoints", () => {
    expect(planHostLlm(config("openai"))).toEqual({
      provider: "openai",
      apiKey: "openai-key",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(planHostLlm(config("azure"))).toEqual({
      provider: "azure",
      apiKey: "azure-key",
      baseUrl: "https://example.openai.azure.com/openai/deployments/deployment-a",
      apiVersion: "2025-03-01-preview",
      deployment: "deployment-a",
      model: "gpt-4o-mini",
    });
  });

  it("binds Azure pricing to its fixed provider override", () => {
    expect(hostLlmPricingModel(config("azure"))).toEqual({
      kind: "fixed",
      model: "gpt-4o-mini",
    });
    expect(hostLlmPricingModel(config("openai"))).toEqual({ kind: "request" });
    expect(hostLlmPricingModel(config("anthropic"))).toEqual({ kind: "request" });
  });

  it("keeps the Anthropic SDK behind the injected lazy loader", async () => {
    const fake = { chat: async () => ({ content: "ok", usage: { inputTokens: 0, outputTokens: 0 } }) } as LlmClient;
    const keys: Array<string | undefined> = [];
    const client = await createHostLlmClient(config("anthropic"), async (apiKey) => {
      keys.push(apiKey);
      return fake;
    });

    expect(client).toBe(fake);
    expect(keys).toEqual(["anthropic-key"]);
  });
});

describe("createHost broker-LLM composition", () => {
  let host: HostInstance | undefined;
  let socketPath: string | undefined;

  afterEach(async () => {
    if (host !== undefined) await host.shutdown();
    host = undefined;
    if (socketPath !== undefined && existsSync(socketPath)) rmSync(socketPath, { force: true });
    socketPath = undefined;
  });

  it("attempts every teardown step and rejects when shutdown is not clean", async () => {
    const redis = fakeRedis();
    const baseLogger = testLogger();
    let infrastructureCleanupCalls = 0;
    const logger = {
      ...baseLogger,
      info: (message: string, data?: Record<string, unknown>) => {
        if (message.startsWith("Shutdown initiated")) {
          throw new Error("shutdown logger unavailable");
        }
        baseLogger.info(message, data);
      },
    };
    socketPath = join(tmpdir(), `fugue-shutdown-${crypto.randomUUID()}.sock`);
    const booted = await createHost({
      config: makeConfig(),
      git: fakeGit(),
      loader: fakeLoader(),
      redis: redis.port,
      sharedInfra: fakeInfra(redis.redis),
      logger,
      tenant: mkTenant("acme"),
      bind: { unix: socketPath },
      onShutdown: async () => {
        infrastructureCleanupCalls += 1;
        throw new Error("Redis disconnect failed");
      },
    });
    expect(booted.ok).toBe(true);
    if (!booted.ok) return;
    host = booted.value;

    const firstShutdown = host.shutdown();
    let firstFailure: unknown;
    try {
      await firstShutdown;
    } catch (error) {
      firstFailure = error;
    }
    expect(firstFailure).toBeInstanceOf(AggregateError);
    const failures = (firstFailure as AggregateError).errors as readonly Error[];
    expect(failures.map((failure) => failure.message)).toEqual([
      "Shutdown step failed: log shutdown start",
      "Infrastructure cleanup failed during shutdown — resources may be leaked: Redis disconnect failed",
    ]);
    expect(failures[0]?.cause).toBeInstanceOf(Error);
    expect((failures[0]?.cause as Error).message).toBe("shutdown logger unavailable");
    expect(failures[1]?.cause).toBeInstanceOf(Error);
    expect((failures[1]?.cause as Error).message).toBe("Redis disconnect failed");
    expect(infrastructureCleanupCalls).toBe(1);
    expect(host.server).toBeNull();

    const secondShutdown = host.shutdown();
    expect(secondShutdown).toBe(firstShutdown);
    await expect(secondShutdown).rejects.toBeInstanceOf(AggregateError);
    expect(infrastructureCleanupCalls).toBe(1);
    host = undefined;
  });

  it("threads the run spend meter into synchronous broker dispatch", async () => {
    let providerCalls = 0;
    const provider: LlmClient = {
      sendStructured: async <O>(): Promise<Result<LlmResponse<O>, FrameworkError>> => {
        providerCalls += 1;
        return ok({ output: {} as O, rawText: "", ...tokensOnly(1, 0) });
      },
      sendWithTools: async <O>(): Promise<Result<LlmResponse<O>, FrameworkError>> => {
        providerCalls += 1;
        return ok({ output: {} as O, rawText: "", ...tokensOnly(1, 0) });
      },
    };
    const broker: CapabilityBroker = {
      mintFor: async () => ok({
        shellBrokerLlm: {
          clientKind: "llm",
          client: provider,
          pricingModel: { kind: "fixed", model: "gpt-4o" },
          runScopedOperations: {},
        },
      }),
      provides: (capability) => capability === "shellBrokerLlm",
    };
    const node = createFetchNode({
      id: "call-broker" as never,
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ done: z.boolean() }),
      requires: ["shellBrokerLlm"] as const,
      fetch: async (_input, ctx) => {
        const request = {
          system: "s",
          user: "u",
          model: "gpt-4o",
          schema: z.object({}),
          nodeId: "call-broker" as never,
        };
        const first = await ctx.shellBrokerLlm.sendStructured(request);
        if (!first.ok) return first;
        const second = await ctx.shellBrokerLlm.sendStructured(request);
        return second.ok ? ok({ done: true }) : second;
      },
    });
    const dag = defineDagFromArray({
      id: "shell-meter-dag",
      nodes: [node],
      edges: [{ from: DAG_INPUT, to: "call-broker" }],
      outputNodeId: "call-broker",
    });
    const registration: DagRegistration = {
      dag,
      inputSchema: z.object({ query: z.string() }),
      config: {
        timeoutMs: 5_000,
        maxConcurrent: 2,
        llmBudget: { calls: 1 },
      },
      meta: { description: "shell meter", version: "1.0.0" },
    };
    const loaded: LoadResult = {
      id: dag.id as DagId,
      registration,
      modulePath: "/tmp/test-dags/dags/eng/shell-meter-dag/dag.ts",
      prompts: new Map(),
      team: "eng",
    };
    const loader: ModuleLoaderPort = {
      loadDagModule: async () => ok(loaded),
      discoverDagPaths: async () => ok([loaded.modulePath]),
      loadAll: async (): Promise<BulkLoadResult> => ({ loaded: [loaded], errors: [] }),
    };
    const redis = fakeRedis();
    const hostConfig = makeConfig({
      AGENT_CLIENT_MAP: JSON.stringify({ "shell-meter-dag": "fugue-agent-shell" }),
    });
    socketPath = join(tmpdir(), `fugue-shell-meter-${crypto.randomUUID()}.sock`);
    const booted = await createHost({
      config: hostConfig,
      git: fakeGit(),
      loader,
      redis: redis.port,
      sharedInfra: fakeInfra(redis.redis),
      logger: testLogger(),
      tenant: mkTenant("acme"),
      bind: { unix: socketPath },
      capabilityBroker: broker,
    });
    expect(booted.ok).toBe(true);
    if (!booted.ok) return;
    host = booted.value;

    const executed = await fetch("http://uds.fugue.internal/dags/shell-meter-dag/run", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hostConfig.ADMIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "go" }),
      unix: socketPath,
    } as RequestInit & { unix: string });

    expect(executed.status).toBe(429);
    expect(providerCalls).toBe(1);
  });

  it("waits for in-flight requests and warns when the drain deadline passes", async () => {
    // FR-060's drain is the difference between a rolling deploy and a dropped
    // request: shutdown must not stop the listener out from under work already
    // admitted. The timeout branch is the other half — an unbounded wait would
    // turn one stuck handler into a host that never exits, so the drain gives
    // up and says so rather than hanging silently.
    const gate = deferred<void>();
    const node = createFetchNode({
      id: "slow" as never,
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ done: z.boolean() }),
      requires: [] as const,
      fetch: async () => { await gate.promise; return ok({ done: true }); },
    });
    const dag = defineDagFromArray({
      id: "drain-dag",
      nodes: [node],
      edges: [{ from: DAG_INPUT, to: "slow" }],
      outputNodeId: "slow",
    });
    const loaded: LoadResult = {
      id: dag.id as DagId,
      registration: {
        dag,
        inputSchema: z.object({ query: z.string() }),
        config: { timeoutMs: 30_000, maxConcurrent: 2 },
        meta: { description: "drain", version: "1.0.0" },
      },
      modulePath: "/tmp/test-dags/dags/eng/drain-dag/dag.ts",
      prompts: new Map(),
      team: "eng",
    };
    const loader: ModuleLoaderPort = {
      loadDagModule: async () => ok(loaded),
      discoverDagPaths: async () => ok([loaded.modulePath]),
      loadAll: async (): Promise<BulkLoadResult> => ({ loaded: [loaded], errors: [] }),
    };
    const redis = fakeRedis();
    const logger = testLogger();
    const hostConfig = makeConfig({ DRAIN_TIMEOUT_MS: "1000" });
    socketPath = join(tmpdir(), `fugue-drain-${crypto.randomUUID()}.sock`);
    const booted = await createHost({
      config: hostConfig,
      git: fakeGit(),
      loader,
      redis: redis.port,
      sharedInfra: fakeInfra(redis.redis),
      logger,
      tenant: mkTenant("acme"),
      bind: { unix: socketPath },
    });
    expect(booted.ok).toBe(true);
    if (!booted.ok) return;
    host = booted.value;

    // Fire the request and DO NOT await it — the handler parks inside the node.
    const inFlight = fetch("http://uds.fugue.internal/dags/drain-dag/run", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hostConfig.ADMIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "go" }),
      unix: socketPath,
    } as RequestInit & { unix: string }).catch(() => undefined);

    // Wait until the request has actually taken a concurrency slot; without
    // this the drain loop would find nothing in flight and prove nothing.
    const admittedBy = Date.now() + 5_000;
    while (host.getConcurrency().global.current === 0 && Date.now() < admittedBy) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(host.getConcurrency().global.current).toBeGreaterThan(0);

    const shutdownStartedAt = Date.now();
    await host.shutdown();
    const drainedFor = Date.now() - shutdownStartedAt;

    // It WAITED (rather than stopping the listener immediately) …
    expect(drainedFor).toBeGreaterThanOrEqual(1_000);
    // … and it gave up rather than waiting forever, naming what is still stuck.
    const warning = logger.logs.find((entry) =>
      entry.level === "warn" && entry.msg.startsWith("Drain timeout"),
    );
    expect(warning).toBeDefined();
    expect(warning?.msg).toContain("requests still in-flight");

    host = undefined;
    gate.resolve();
    await inFlight;
  }, 20_000);

  it("warns and leaves HITL off when a notifier is configured with no queue backend", async () => {
    // A transport is necessary but NOT sufficient. Booting with a webhook and
    // no queue would otherwise look configured while every `humanReview` DAG
    // silently answered 501 — so the boot log has to say which half is missing.
    // Distinct from the no-transport-at-all case, which is a silent, expected
    // opt-out and must NOT warn.
    const redis = fakeRedis();
    const logger = testLogger();
    socketPath = join(tmpdir(), `fugue-hitl-noqueue-${crypto.randomUUID()}.sock`);
    const booted = await createHost({
      config: makeConfig({ TEAMS_WEBHOOK_URL: "https://example.invalid/hook" }),
      git: fakeGit(),
      loader: fakeLoader(),
      redis: redis.port,
      sharedInfra: fakeInfra(redis.redis),
      logger,
      tenant: mkTenant("acme"),
      bind: { unix: socketPath },
      // queueBackend deliberately omitted.
    });
    expect(booted.ok).toBe(true);
    if (!booted.ok) return;
    host = booted.value;

    expect(logger.logs).toContainEqual(expect.objectContaining({
      level: "warn",
      msg: "A HITL notifier is configured but no queue backend was wired — HITL is disabled",
    }));
    // The enabled-path line must NOT have been logged.
    expect(logger.logs.some((entry) => entry.msg.startsWith("HITL durable run engine enabled")))
      .toBe(false);
  });

  it("stays silent about HITL when no notifier transport is configured at all", async () => {
    const redis = fakeRedis();
    const logger = testLogger();
    socketPath = join(tmpdir(), `fugue-hitl-none-${crypto.randomUUID()}.sock`);
    const booted = await createHost({
      config: makeConfig(),
      git: fakeGit(),
      loader: fakeLoader(),
      redis: redis.port,
      sharedInfra: fakeInfra(redis.redis),
      logger,
      tenant: mkTenant("acme"),
      bind: { unix: socketPath },
    });
    expect(booted.ok).toBe(true);
    if (!booted.ok) return;
    host = booted.value;

    expect(logger.logs.some((entry) => entry.msg.includes("HITL"))).toBe(false);
  });
});
