/**
 * Worker bootstrap planner (T6) — the pure env→tenant→secrets→config→socket
 * pipeline, exercised with an in-memory `SecretsSource` stub (no filesystem, no
 * Redis, no real socket). Asserts the wiring + every fail-closed branch.
 */

import { describe, it, expect } from "bun:test";
import { buildWorkerBootstrap } from "../worker-main.js";
import type { SecretsSource, ResolvedSecrets } from "../supervisor/secrets/secrets-source.js";
import { ok, err } from "@fuguejs/framework";
import type { SecretsRef } from "../domain/tenant.js";

const baseEnv = {
  DAGS_REPO_URL: "https://github.com/org/dags.git",
  REDIS_URL: "redis://localhost:6379",
  ADMIN_TOKEN: "test-admin-token-long-enough",
};

/** A stub source that returns a fixed secrets map regardless of ref. */
const fixedSource = (secrets: ResolvedSecrets): SecretsSource => () => ok(secrets);

/** A stub source that always fails (simulates a missing/unreadable file). */
const failingSource: SecretsSource = (ref: SecretsRef) =>
  err({ kind: "config-invalid", message: `env-file secrets source '${ref as string}': unreadable (ENOENT)` });

describe("buildWorkerBootstrap — happy path", () => {
  it("resolves tenant, merges secrets, parses config, computes UDS path", () => {
    const env = { ...baseEnv, TENANT_ID: "acme-corp", FUGUE_SECRETS_REF: "/run/secrets/acme.env" };
    // The LLM key arrives via the tenant's resolved secrets, not the base env.
    const result = buildWorkerBootstrap(env, fixedSource({ ANTHROPIC_API_KEY: "sk-ant-from-secret" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tenant).toBe("acme-corp");
    expect(result.value.socketPath).toBe("/run/fugue/acme-corp.sock");
    expect(result.value.config.ANTHROPIC_API_KEY).toBe("sk-ant-from-secret");
    expect(result.value.config.TENANT_ID).toBe("acme-corp");
  });

  it("honors WORKER_UDS_DIR override in the socket path", () => {
    const env = { ...baseEnv, TENANT_ID: "t1", FUGUE_SECRETS_REF: "/x.env", WORKER_UDS_DIR: "/var/run/fugue" };
    const result = buildWorkerBootstrap(env, fixedSource({ ANTHROPIC_API_KEY: "k" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.socketPath).toBe("/var/run/fugue/t1.sock");
  });
});

describe("buildWorkerBootstrap — fail closed", () => {
  it("fails when TENANT_ID is absent", () => {
    const result = buildWorkerBootstrap({ ...baseEnv, FUGUE_SECRETS_REF: "/x.env" }, fixedSource({}));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as { message: string }).message).toContain("TENANT_ID");
  });

  it("fails when FUGUE_SECRETS_REF is absent", () => {
    const result = buildWorkerBootstrap({ ...baseEnv, TENANT_ID: "t1" }, fixedSource({}));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as { message: string }).message).toContain("FUGUE_SECRETS_REF");
  });

  it("rejects a tenant id with a Redis-key delimiter (no ':')", () => {
    const env = { ...baseEnv, TENANT_ID: "bad:tenant", FUGUE_SECRETS_REF: "/x.env" };
    const result = buildWorkerBootstrap(env, fixedSource({ ANTHROPIC_API_KEY: "k" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
  });

  it("rejects a tenant id with a glob metacharacter", () => {
    const env = { ...baseEnv, TENANT_ID: "ten*", FUGUE_SECRETS_REF: "/x.env" };
    const result = buildWorkerBootstrap(env, fixedSource({ ANTHROPIC_API_KEY: "k" }));
    expect(result.ok).toBe(false);
  });

  it("propagates a secrets-source resolution failure (fail-closed, never partial)", () => {
    const env = { ...baseEnv, TENANT_ID: "t1", FUGUE_SECRETS_REF: "/missing.env" };
    const result = buildWorkerBootstrap(env, failingSource);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as { message: string }).message).toContain("unreadable");
  });

  it("fails config validation when no LLM key is provided anywhere", () => {
    const env = { ...baseEnv, TENANT_ID: "t1", FUGUE_SECRETS_REF: "/x.env" };
    // No ANTHROPIC_API_KEY in base env nor in resolved secrets → superRefine fails.
    const result = buildWorkerBootstrap(env, fixedSource({}));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as { message: string }).message).toContain("ANTHROPIC_API_KEY");
  });

  it("does not let a secrets file rebind the worker to a different tenant", () => {
    const env = { ...baseEnv, TENANT_ID: "tenant-a", FUGUE_SECRETS_REF: "/x.env" };
    // The malicious secrets file tries to set TENANT_ID=tenant-b.
    const result = buildWorkerBootstrap(env, fixedSource({ ANTHROPIC_API_KEY: "k", TENANT_ID: "tenant-b" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as { message: string }).message).toContain("rebind");
  });

  it("never leaks a resolved secret value in an error message", () => {
    const env = { ...baseEnv, TENANT_ID: "t1", FUGUE_SECRETS_REF: "/x.env" };
    // Force a downstream config failure while a secret value is present.
    const result = buildWorkerBootstrap(env, fixedSource({ MAX_DAG_TIMEOUT_MS: "500", ANTHROPIC_API_KEY: "TOP-SECRET-VALUE" }));
    // MAX < min(1000) → config invalid; the secret value must not appear.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as { message: string }).message).not.toContain("TOP-SECRET-VALUE");
  });
});
