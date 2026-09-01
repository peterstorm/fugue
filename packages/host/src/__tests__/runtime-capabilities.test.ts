import { describe, expect, it } from "bun:test";
import { ok } from "@fuguejs/framework";
import {
  buildRuntimeCapabilities,
  buildRuntimeDeps,
} from "../adapters/runtime-capabilities.js";
import { makeConfig } from "./fixtures/host-boot-fakes.js";
import type { RedisPort } from "../ports.js";

const redis: RedisPort = {
  get: async () => ok(null),
  set: async () => ok("OK"),
  del: async () => ok(0),
  scan: async () => ok({ cursor: "0", keys: [] }),
  setNx: async () => ok(true),
  compareAndDelete: async () => ok(true),
  sAdd: async () => ok(1),
  sRem: async () => ok(1),
  sMembers: async () => ok([]),
};
const logger = { info: () => {}, warn: () => {}, error: () => {} };

describe("runtime capability diagnostics", () => {
  it("keeps optional capability wiring successful when selection logging throws", async () => {
    const config = makeConfig({
      CDRATOR_URL: "https://cdrator.example.test",
      CDRATOR_AUTH_URL: "https://auth.example.test/token",
      CDRATOR_BRAND_KEY: "brand",
      CDRATOR_USERNAME: "operator",
      CDRATOR_PASSWORD: "secret",
    });
    const throwingLogger = {
      info: () => { throw new Error("logger transport unavailable"); },
      warn: () => { throw new Error("logger transport unavailable"); },
      error: () => { throw new Error("logger transport unavailable"); },
    };

    const capabilities = await buildRuntimeCapabilities(config, throwingLogger, { tenant: "acme" });

    expect(capabilities.map((handle) => handle.name)).toEqual(["http", "clock", "authedHttp"]);
  });
});

describe("buildRuntimeDeps composition", () => {
  it("selects local Git behavior and assembles pricing, ledger, Redis, and capabilities", async () => {
    const config = makeConfig({ DAGS_LOCAL_PATH: "/tmp/local-dags" });
    const built = await buildRuntimeDeps(config, redis, logger, { tenant: "acme" });

    expect(await built.git.clone("not-a-url", "/not-created")).toEqual(ok(undefined));
    expect(await built.git.hasLockfileChanged("/ignored", "a", "b")).toEqual(ok(false));
    expect(built.sharedInfra.redis).toBe(redis);
    expect(built.sharedInfra.llmPricingModel).toEqual({ kind: "request" });
    expect(built.sharedInfra.spendLedger.metadata).toEqual({
      role: "redis-fallback",
      backend: "memory",
      durability: "process",
    });
    expect(built.sharedInfra.capabilities.map((handle) => handle.name)).toEqual([
      "http",
      "clock",
    ]);
  });

  it("selects remote Git behavior when DAGS_LOCAL_PATH is absent", async () => {
    const built = await buildRuntimeDeps(
      makeConfig({ DAGS_LOCAL_PATH: undefined }),
      redis,
      logger,
    );
    const pulled = await built.git.pull("/definitely/not/a/git/repository");
    expect(pulled.ok).toBe(false);
  });
});
