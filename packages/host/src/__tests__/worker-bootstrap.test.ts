/**
 * Worker bootstrap planner (T6) — the pure env→tenant→secrets→config→socket
 * pipeline, exercised with an in-memory `SecretsSource` stub (no filesystem, no
 * Redis, no real socket). Asserts the wiring + every fail-closed branch.
 */

import { describe, it, expect } from "bun:test";
import { buildWorkerBootstrap } from "../worker-main.js";
import type { SecretsSource, ResolvedSecrets } from "../supervisor/secrets/secrets-source.js";
import {
  WORKER_REDIS_ACL_USERNAME_ENV,
  WORKER_REDIS_ACL_PASSWORD_ENV,
  parseAclCredential,
} from "../supervisor/secrets/redis-acl.js";
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

  it("does not let a secrets file move the worker socket (WORKER_UDS_DIR)", () => {
    const env = { ...baseEnv, TENANT_ID: "tenant-a", FUGUE_SECRETS_REF: "/x.env", WORKER_UDS_DIR: "/run/fugue" };
    // The secrets file tries to redirect the bound socket off the supervisor's
    // proxy/probe target — must be refused (fail-closed), not silently honored.
    const result = buildWorkerBootstrap(env, fixedSource({ ANTHROPIC_API_KEY: "k", WORKER_UDS_DIR: "/tmp/evil" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    expect((result.error as { message: string }).message).toContain("WORKER_UDS_DIR");
  });

  it("does not let a secrets file rebind the per-tenant ACL username (isolation handoff)", () => {
    const env = { ...baseEnv, TENANT_ID: "tenant-a", FUGUE_SECRETS_REF: "/x.env" };
    // A tenant secrets file that rebinds FUGUE_REDIS_ACL_USERNAME could connect the
    // worker to Redis as a different/unscoped user — reject it (fail-closed).
    const result = buildWorkerBootstrap(
      env,
      fixedSource({ ANTHROPIC_API_KEY: "k", [WORKER_REDIS_ACL_USERNAME_ENV]: "fugue-tenant-evil" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    expect((result.error as { message: string }).message).toContain(WORKER_REDIS_ACL_USERNAME_ENV);
  });

  it("does not let a secrets file rebind the per-tenant ACL password (isolation handoff)", () => {
    const env = { ...baseEnv, TENANT_ID: "tenant-a", FUGUE_SECRETS_REF: "/x.env" };
    const result = buildWorkerBootstrap(
      env,
      fixedSource({ ANTHROPIC_API_KEY: "k", [WORKER_REDIS_ACL_PASSWORD_ENV]: "stolen-password" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    expect((result.error as { message: string }).message).toContain(WORKER_REDIS_ACL_PASSWORD_ENV);
    // The forbidden VALUE must never leak into the rejection message.
    expect((result.error as { message: string }).message).not.toContain("stolen-password");
  });
});

describe("parseAclCredential — per-tenant ACL pairing (ADR-0067, fail-closed)", () => {
  it("BOTH present → Ok(credential): connect as the scoped per-tenant user", () => {
    const result = parseAclCredential("fugue-tenant-acme", "s3cret");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ username: "fugue-tenant-acme", password: "s3cret" });
  });

  it("TRIMS a whitespace-padded username before forwarding (no auth as `default`), keeps the password byte-exact", () => {
    // A Redis ACL username is an identifier — surrounding whitespace is never
    // significant, and a padded value (e.g. injected as `"…acme\n"`) forwarded
    // verbatim could mismatch the provisioner's whitespace-free user and silently
    // authenticate as `default` (potentially UNSCOPED) — the fail-open this guards.
    // The PASSWORD is a secret and must NOT be mutated: its surrounding whitespace
    // is preserved exactly.
    const result = parseAclCredential("  fugue-tenant-acme \n", " s3cret ");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ username: "fugue-tenant-acme", password: " s3cret " });
  });

  it("NEITHER set → Ok(undefined): ACL disabled, fall back to REDIS_URL", () => {
    const result = parseAclCredential(undefined, undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeUndefined();
  });

  it("username only → Err: refuses to boot unscoped (fail-closed, not ACL-disabled)", () => {
    const result = parseAclCredential("fugue-tenant-acme", undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    expect((result.error as { message: string }).message).toContain("fail-closed");
  });

  it("password only → Err: refuses to boot unscoped (fail-closed)", () => {
    const result = parseAclCredential(undefined, "s3cret");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    // The lone secret value must not leak into the fail-closed message.
    expect((result.error as { message: string }).message).not.toContain("s3cret");
  });

  it("BLANK username → Err: a present-but-empty value is a fault, not ACL-disabled (fail-closed, no fall-open)", () => {
    // An empty username is never a valid scoped ACL user; forwarding it to ioredis
    // can authenticate as `default` (potentially UNSCOPED). It must fail closed,
    // NOT silently degrade to the shared REDIS_URL credential.
    for (const blank of ["", "   ", "\t"]) {
      const result = parseAclCredential(blank, "s3cret");
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.kind).toBe("config-invalid");
      expect((result.error as { message: string }).message).not.toContain("s3cret");
    }
  });

  it("BLANK password → Err: a present-but-empty secret is a fault (fail-closed)", () => {
    for (const blank of ["", "   ", "\t"]) {
      const result = parseAclCredential("fugue-tenant-acme", blank);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.kind).toBe("config-invalid");
    }
  });

  it("BOTH blank → Err: not treated as the legal NEITHER-set (disabled) state", () => {
    // Distinct from `undefined`/`undefined` (ACL disabled): a present-but-empty
    // pair signals a broken injection and must refuse to boot, not fall back.
    const result = parseAclCredential("", "");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
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
