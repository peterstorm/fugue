import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err } from "@fuguejs/framework";
import type { QueueBackend, WorkerHandle } from "@fuguejs/framework";
import { createHost, type HostInstance } from "../host.js";
import {
  fakeGit,
  fakeInfra,
  fakeLoader,
  fakeRedis,
  makeConfig,
  mkTenant,
  testLogger,
} from "./fixtures/host-boot-fakes.js";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const lifecycleQueue = (
  events: string[],
  options: { readonly failWorkerClose?: boolean } = {},
): QueueBackend => ({
  createQueue() {
    return {
      async enqueue() {},
      async drain() {},
      async close() {},
    } as never;
  },
  createWorker() {
    events.push("worker-started");
    return {
      onFailed() {},
      onExhausted() {},
      onError() {},
      async close() {
        events.push("worker-closed");
        if (options.failWorkerClose === true) {
          throw new Error("HITL worker refused to close");
        }
      },
    } as WorkerHandle;
  },
  async close() {},
});

describe("createHost — HITL reconciliation lifecycle", () => {
  let host: HostInstance | undefined;
  let socketPath: string | undefined;

  afterEach(async () => {
    if (host !== undefined) await host.shutdown();
    host = undefined;
    if (socketPath !== undefined && existsSync(socketPath)) rmSync(socketPath, { force: true });
    socketPath = undefined;
  });

  /**
   * A Redis whose `SMEMBERS <tenant>:hitl:active` fails — the one condition both
   * reconciliation-failure tests need. Everything else behaves normally.
   */
  const redisWithFailingActiveSet = () => {
    const base = fakeRedis();
    const redis = {
      ...base.redis,
      async sMembers(key: string) {
        if (key.endsWith(":hitl:active")) {
          return err({ kind: "redis-unavailable" as const, operation: "SMEMBERS active" });
        }
        return base.redis.sMembers(key);
      },
    };
    return { base, redis };
  };

  it("logs a typed reconciliation error without aborting host startup", async () => {
    socketPath = join(tmpdir(), `fugue-hitl-reconcile-error-${crypto.randomUUID()}.sock`);
    const { base, redis } = redisWithFailingActiveSet();
    const logger = testLogger();
    const booted = await createHost({
      config: makeConfig({ TEAMS_WEBHOOK_URL: "https://teams.example.test/hook" }),
      git: fakeGit(),
      loader: fakeLoader(),
      redis: base.port,
      sharedInfra: fakeInfra(redis),
      logger,
      tenant: mkTenant("acme"),
      bind: { unix: socketPath },
      queueBackend: lifecycleQueue([]),
    });

    expect(booted.ok).toBe(true);
    if (!booted.ok) return;
    host = booted.value;
    expect(logger.logs.some((entry) => entry.msg === "HITL active-run reconciliation failed")).toBe(true);
  });

  it("a throwing reconciliation logger cannot reject host startup", async () => {
    socketPath = join(tmpdir(), `fugue-hitl-reconcile-logger-${crypto.randomUUID()}.sock`);
    const { base, redis } = redisWithFailingActiveSet();
    const logger = testLogger();
    const booted = await createHost({
      config: makeConfig({ TEAMS_WEBHOOK_URL: "https://teams.example.test/hook" }),
      git: fakeGit(),
      loader: fakeLoader(),
      redis: base.port,
      sharedInfra: fakeInfra(redis),
      logger: {
        ...logger,
        error: () => { throw new Error("diagnostic sink failed"); },
      },
      tenant: mkTenant("acme"),
      bind: { unix: socketPath },
      queueBackend: lifecycleQueue([]),
    });

    expect(booted.ok).toBe(true);
    if (!booted.ok) return;
    host = booted.value;
  });

  it("continues all teardown when the HTTP listener stop throws", async () => {
    socketPath = join(tmpdir(), `fugue-stop-throws-${crypto.randomUUID()}.sock`);
    const base = fakeRedis();
    const logger = testLogger();
    let infrastructureClosed = 0;
    const booted = await createHost({
      config: makeConfig(),
      git: fakeGit(),
      loader: fakeLoader(),
      redis: base.port,
      sharedInfra: fakeInfra(base.redis),
      logger,
      tenant: mkTenant("acme"),
      bind: { unix: socketPath },
      onShutdown: async () => { infrastructureClosed += 1; },
    });

    expect(booted.ok).toBe(true);
    if (!booted.ok) return;
    host = booted.value;
    const listener = host.server;
    if (listener === null) throw new Error("expected a bound listener");
    const realStop = listener.stop;
    Object.defineProperty(listener, "stop", {
      value: () => {
        realStop();
        throw new Error("listener stop acknowledgement failed");
      },
    });

    await expect(host.shutdown()).rejects.toThrow("Host shutdown completed with failures");

    expect(host.getState().phase).toBe("stopped");
    expect(host.server).toBeNull();
    expect(infrastructureClosed).toBe(1);
    expect(logger.logs.some(
      (entry) => entry.level === "error" && entry.msg.includes("stop HTTP server"),
    )).toBe(true);
    host = undefined;
  });

  it("continues teardown and rejects when the HITL worker refuses to close", async () => {
    socketPath = join(tmpdir(), `fugue-hitl-close-fails-${crypto.randomUUID()}.sock`);
    const base = fakeRedis();
    const events: string[] = [];
    let infrastructureClosed = 0;
    const booted = await createHost({
      config: makeConfig({ TEAMS_WEBHOOK_URL: "https://teams.example.test/hook" }),
      git: fakeGit(),
      loader: fakeLoader(),
      redis: base.port,
      sharedInfra: fakeInfra(base.redis),
      logger: testLogger(),
      tenant: mkTenant("acme"),
      bind: { unix: socketPath },
      queueBackend: lifecycleQueue(events, { failWorkerClose: true }),
      onShutdown: async () => { infrastructureClosed += 1; },
    });

    expect(booted.ok).toBe(true);
    if (!booted.ok) return;
    host = booted.value;
    let failure: unknown;
    try {
      await host.shutdown();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors).toHaveLength(1);
    expect((aggregate.errors[0] as Error).message).toContain("HITL worker");
    expect((aggregate.errors[0] as Error).message).toContain("refused to close");
    expect(events).toContain("worker-closed");
    expect(infrastructureClosed).toBe(1);
    expect(host.getState().phase).toBe("stopped");
    host = undefined;
  });

  it("reconciles after worker startup, repeats, and clears the interval on shutdown", async () => {
    socketPath = join(tmpdir(), `fugue-hitl-reconcile-${crypto.randomUUID()}.sock`);
    const base = fakeRedis();
    const events: string[] = [];
    let reconciliations = 0;
    const redis = {
      ...base.redis,
      async sMembers(key: string) {
        if (key.endsWith(":hitl:active")) {
          events.push("reconciled");
          reconciliations++;
        }
        return base.redis.sMembers(key);
      },
    };

    const booted = await createHost({
      config: makeConfig({
        TEAMS_WEBHOOK_URL: "https://teams.example.test/hook",
        HITL_RECONCILE_INTERVAL_MS: "1000",
      }),
      git: fakeGit(),
      loader: fakeLoader(),
      redis: base.port,
      sharedInfra: fakeInfra(redis),
      logger: testLogger(),
      tenant: mkTenant("acme"),
      bind: { unix: socketPath },
      queueBackend: lifecycleQueue(events),
    });

    expect(booted.ok).toBe(true);
    if (!booted.ok) return;
    host = booted.value;
    expect(events.slice(0, 2)).toEqual(["worker-started", "reconciled"]);

    await wait(1_100);
    expect(reconciliations).toBeGreaterThanOrEqual(2);

    await host.shutdown();
    host = undefined;
    const afterShutdown = reconciliations;
    expect(events).toContain("worker-closed");
    await wait(1_100);
    expect(reconciliations).toBe(afterShutdown);
  });
});
