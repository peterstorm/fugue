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

const lifecycleQueue = (events: string[]): QueueBackend => ({
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
      async close() { events.push("worker-closed"); },
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

  it("logs a typed reconciliation error without aborting host startup", async () => {
    socketPath = join(tmpdir(), `fugue-hitl-reconcile-error-${crypto.randomUUID()}.sock`);
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
