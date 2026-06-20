/**
 * Tests for `buildWorkerSpawn` (bun-spawn-adapter.ts) — the PURE argv + env
 * construction that is the seam where the supervisor's `WorkerSpawnSpec.extraEnv`
 * becomes the worker's `process.env`. Exercised directly (no Bun.spawn, no real
 * process), as the function's own doc intends.
 *
 * Covers the four invariants that would otherwise regress silently:
 *   1. Cross-tenant isolation: `extraEnv` is applied BEFORE the mandatory
 *      TENANT_ID/FUGUE_SECRETS_REF/WORKER_UDS_DIR bindings, so a stray/hostile
 *      `extraEnv` entry can NEVER override the tenant binding (security boundary).
 *   2. Socket consistency (C7): WORKER_UDS_DIR = dirname(spec.udsPath).
 *   3. Heap cap (AD-9): NODE_OPTIONS is APPENDED, not replaced.
 *   4. The `extraEnv` merge itself (FUGUE_MAX_QUEUED_RUNS + FUGUE_REDIS_ACL_*)
 *      lands in the child env, plus inherited-env passthrough.
 */

import { describe, test, expect } from "bun:test";
import { dirname } from "node:path";
import { tenantId, markSecretsRef } from "../../../domain/tenant.js";
import type { TenantId } from "../../../domain/tenant.js";
import { buildWorkerSpawn } from "../../../supervisor/lifecycle/bun-spawn-adapter.js";
import type { WorkerSpawnSpec } from "../../../supervisor/lifecycle/spawn-port.js";

const tid = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`bad tenant fixture ${s}`);
  return r.value;
};

const spec = (overrides: Partial<WorkerSpawnSpec> = {}): WorkerSpawnSpec => ({
  tenant: tid("acme"),
  secretsRef: markSecretsRef("vault://acme/env"),
  workerEntry: "/app/worker-main.ts",
  udsPath: "/run/fugue/acme.sock",
  ...overrides,
});

describe("buildWorkerSpawn — argv", () => {
  test("argv is bun run <workerEntry>", () => {
    const plan = buildWorkerSpawn(spec({ workerEntry: "/app/worker-main.ts" }), {});
    expect(plan.cmd).toEqual(["bun", "run", "/app/worker-main.ts"]);
  });
});

describe("buildWorkerSpawn — mandatory per-worker bindings", () => {
  test("sets TENANT_ID, FUGUE_SECRETS_REF (reference only), WORKER_UDS_DIR", () => {
    const plan = buildWorkerSpawn(spec(), {});
    expect(plan.env.TENANT_ID).toBe("acme");
    expect(plan.env.FUGUE_SECRETS_REF).toBe("vault://acme/env");
    expect(plan.env.WORKER_UDS_DIR).toBe("/run/fugue");
  });

  test("WORKER_UDS_DIR = dirname(udsPath) for a non-default nested socket dir (C7)", () => {
    const udsPath = "/var/lib/fugue/sockets/acme.sock";
    const plan = buildWorkerSpawn(spec({ udsPath }), {});
    expect(plan.env.WORKER_UDS_DIR).toBe(dirname(udsPath));
    expect(plan.env.WORKER_UDS_DIR).toBe("/var/lib/fugue/sockets");
  });
});

describe("buildWorkerSpawn — inherited env", () => {
  test("forwards inherited platform config and drops undefined values", () => {
    const plan = buildWorkerSpawn(spec(), {
      REDIS_URL: "redis://localhost:6379",
      ADMIN_TOKEN: "tok",
      UNSET: undefined,
    });
    expect(plan.env.REDIS_URL).toBe("redis://localhost:6379");
    expect(plan.env.ADMIN_TOKEN).toBe("tok");
    expect("UNSET" in plan.env).toBe(false);
  });

  test("mandatory bindings OVERRIDE a stale inherited TENANT_ID", () => {
    const plan = buildWorkerSpawn(spec({ tenant: tid("acme") }), {
      TENANT_ID: "stale-other-tenant",
    });
    expect(plan.env.TENANT_ID).toBe("acme");
  });
});

describe("buildWorkerSpawn — extraEnv merge", () => {
  test("merges FUGUE_MAX_QUEUED_RUNS and FUGUE_REDIS_ACL_* into the child env", () => {
    const plan = buildWorkerSpawn(
      spec({
        extraEnv: {
          FUGUE_MAX_QUEUED_RUNS: "7",
          FUGUE_REDIS_ACL_USERNAME: "fugue-tenant-acme",
          FUGUE_REDIS_ACL_PASSWORD: "minted-secret-256",
        },
      }),
      {},
    );
    expect(plan.env.FUGUE_MAX_QUEUED_RUNS).toBe("7");
    expect(plan.env.FUGUE_REDIS_ACL_USERNAME).toBe("fugue-tenant-acme");
    expect(plan.env.FUGUE_REDIS_ACL_PASSWORD).toBe("minted-secret-256");
  });

  test("SECURITY: a hostile extraEnv.TENANT_ID can NOT override the tenant binding", () => {
    const plan = buildWorkerSpawn(
      spec({ tenant: tid("acme"), extraEnv: { TENANT_ID: "victim" } }),
      {},
    );
    expect(plan.env.TENANT_ID).toBe("acme");
  });

  test("SECURITY: extraEnv can NOT override FUGUE_SECRETS_REF or WORKER_UDS_DIR", () => {
    const plan = buildWorkerSpawn(
      spec({
        secretsRef: markSecretsRef("vault://acme/env"),
        udsPath: "/run/fugue/acme.sock",
        extraEnv: {
          FUGUE_SECRETS_REF: "vault://victim/env",
          WORKER_UDS_DIR: "/tmp/attacker",
        },
      }),
      {},
    );
    expect(plan.env.FUGUE_SECRETS_REF).toBe("vault://acme/env");
    expect(plan.env.WORKER_UDS_DIR).toBe("/run/fugue");
  });
});

describe("buildWorkerSpawn — heap cap (AD-9)", () => {
  test("unset heapCapMb adds no NODE_OPTIONS", () => {
    const plan = buildWorkerSpawn(spec({ heapCapMb: undefined }), {});
    expect("NODE_OPTIONS" in plan.env).toBe(false);
  });

  test("sets --max-old-space-size when no NODE_OPTIONS inherited", () => {
    const plan = buildWorkerSpawn(spec({ heapCapMb: 512 }), {});
    expect(plan.env.NODE_OPTIONS).toBe("--max-old-space-size=512");
  });

  test("APPENDS the heap-cap flag, preserving inherited NODE_OPTIONS flags", () => {
    const plan = buildWorkerSpawn(spec({ heapCapMb: 512 }), {
      NODE_OPTIONS: "--enable-source-maps",
    });
    expect(plan.env.NODE_OPTIONS).toBe("--enable-source-maps --max-old-space-size=512");
  });

  test("does not double-add when inherited NODE_OPTIONS is empty string", () => {
    const plan = buildWorkerSpawn(spec({ heapCapMb: 256 }), { NODE_OPTIONS: "" });
    expect(plan.env.NODE_OPTIONS).toBe("--max-old-space-size=256");
  });
});
