/**
 * Multi-tenant single-host config additions (T6, AD-1/AD-3).
 *
 * Covers ONLY the worker/supervisor fields and the `workerSocketPath` helper
 * added for the multi-tenant work. The pre-existing broad HostConfig coverage
 * lives in `src/__tests__/config.test.ts`; this file asserts the new invariants
 * without re-testing the legacy surface (beyond confirming it still parses).
 */

import { describe, it, expect } from "bun:test";
import { parseHostConfig, workerSocketPath } from "../../domain/config.js";

const baseEnv = {
  DAGS_REPO_URL: "https://github.com/org/dags.git",
  REDIS_URL: "redis://localhost:6379",
  ADMIN_TOKEN: "test-admin-token-long-enough",
  ANTHROPIC_API_KEY: "sk-ant-test-key",
};

describe("HostConfig — worker mode (TENANT_ID / FUGUE_SECRETS_REF pairing)", () => {
  it("legacy single-tenant / supervisor config (neither set) still parses (FR-035)", () => {
    const result = parseHostConfig(baseEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.TENANT_ID).toBeUndefined();
    expect(result.value.FUGUE_SECRETS_REF).toBeUndefined();
  });

  it("accepts a worker config with BOTH TENANT_ID and FUGUE_SECRETS_REF (FR-007)", () => {
    const result = parseHostConfig({
      ...baseEnv,
      TENANT_ID: "acme-corp",
      FUGUE_SECRETS_REF: "/run/secrets/acme-corp.env",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.TENANT_ID).toBe("acme-corp");
    expect(result.value.FUGUE_SECRETS_REF).toBe("/run/secrets/acme-corp.env");
  });

  it("rejects TENANT_ID without FUGUE_SECRETS_REF (half-wired worker fails closed)", () => {
    const result = parseHostConfig({ ...baseEnv, TENANT_ID: "acme-corp" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    expect((result.error as { message: string }).message).toContain("FUGUE_SECRETS_REF");
  });

  it("rejects FUGUE_SECRETS_REF without TENANT_ID", () => {
    const result = parseHostConfig({ ...baseEnv, FUGUE_SECRETS_REF: "/run/secrets/x.env" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    expect((result.error as { message: string }).message).toContain("TENANT_ID");
  });
});

describe("HostConfig — worker/supervisor defaults + bounds", () => {
  it("defaults WORKER_UDS_DIR to /run/fugue and WORKER_IDLE_EVICT_MS to 900000", () => {
    const result = parseHostConfig(baseEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.WORKER_UDS_DIR).toBe("/run/fugue");
    expect(result.value.WORKER_IDLE_EVICT_MS).toBe(900_000);
  });

  it("leaves optional caps undefined when unset (no implicit cap)", () => {
    const result = parseHostConfig(baseEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.WORKER_HEAP_CAP_MB).toBeUndefined();
    expect(result.value.SUPERVISOR_MAX_LIVE_WORKERS).toBeUndefined();
    expect(result.value.FUGUE_SUPERVISOR_HMAC_KEY).toBeUndefined();
  });

  it("coerces numeric caps from env strings (T8 imports these)", () => {
    const result = parseHostConfig({
      ...baseEnv,
      WORKER_HEAP_CAP_MB: "512",
      SUPERVISOR_MAX_LIVE_WORKERS: "8",
      WORKER_IDLE_EVICT_MS: "60000",
      WORKER_UDS_DIR: "/var/run/fugue",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.WORKER_HEAP_CAP_MB).toBe(512);
    expect(result.value.SUPERVISOR_MAX_LIVE_WORKERS).toBe(8);
    expect(result.value.WORKER_IDLE_EVICT_MS).toBe(60_000);
    expect(result.value.WORKER_UDS_DIR).toBe("/var/run/fugue");
  });

  it("parses FUGUE_SUPERVISOR_HMAC_KEY (T7 signing key)", () => {
    const result = parseHostConfig({ ...baseEnv, FUGUE_SUPERVISOR_HMAC_KEY: "super-secret-internal-key" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.FUGUE_SUPERVISOR_HMAC_KEY).toBe("super-secret-internal-key");
  });

  it("rejects a non-positive WORKER_HEAP_CAP_MB", () => {
    const result = parseHostConfig({ ...baseEnv, WORKER_HEAP_CAP_MB: "0" });
    expect(result.ok).toBe(false);
  });

  it("rejects a zero SUPERVISOR_MAX_LIVE_WORKERS", () => {
    const result = parseHostConfig({ ...baseEnv, SUPERVISOR_MAX_LIVE_WORKERS: "0" });
    expect(result.ok).toBe(false);
  });
});

describe("workerSocketPath (SHARED CONTRACT — T7 derives the same path)", () => {
  it("builds /run/fugue/<tenant>.sock", () => {
    expect(workerSocketPath("/run/fugue", "acme-corp")).toBe("/run/fugue/acme-corp.sock");
  });

  it("strips a trailing slash on the dir so it never doubles", () => {
    expect(workerSocketPath("/run/fugue/", "acme")).toBe("/run/fugue/acme.sock");
    expect(workerSocketPath("/run/fugue///", "acme")).toBe("/run/fugue/acme.sock");
  });

  it("uses the parsed WORKER_UDS_DIR default by default", () => {
    const result = parseHostConfig(baseEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(workerSocketPath(result.value.WORKER_UDS_DIR, "t1")).toBe("/run/fugue/t1.sock");
  });
});
