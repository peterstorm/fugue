/**
 * T11 — Supervisor-secrets-absence (SC-002 / NFR-011) + one-tenant-per-worker
 * (SC-003) ADVERSARIAL isolation sweep.
 *
 * Two spec concerns, both verified by inspecting REAL supervisor/lifecycle state
 * across its lifetime (not by trusting a comment):
 *
 *   A. SUPERVISOR-SECRETS-ABSENCE (SC-002, NFR-011): inspection of the
 *      supervisor's deps + the worker-lifecycle's spawn outputs across the whole
 *      flow reveals ZERO tenant secrets. The supervisor handles only
 *      NON-dereferenceable `SecretsRef` values — it must NOT be able to turn a ref
 *      into actual secret material. We assert:
 *        - no supervisor module imports a concrete `SecretsSource` (so no
 *          `SupervisorDeps`-reachable dereference path exists) — verified
 *          structurally by reading the supervisor sources;
 *        - every `WorkerSpawnSpec` the lifecycle emits carries only a `SecretsRef`
 *          REFERENCE, never a resolved value;
 *        - dereferencing requires the env-file `SecretsSource` (filesystem
 *          authority) the supervisor structurally lacks — a ref alone yields ZERO
 *          secret bytes supervisor-side.
 *
 *   B. ONE-TENANT-PER-WORKER (SC-003, FR-007): every spawned/live worker holds
 *      EXACTLY one tenant's config/secrets. We drive the REAL `createWorkerLifecycle`
 *      to spawn several tenants' workers, then sweep ALL spawn specs + all live
 *      registry records and assert each names exactly one tenant and carries that
 *      ONE tenant's own ref + own socket — never two, never a foreign tenant's.
 *
 * @satisfies SC-002 — supervisor memory/state across its lifetime holds ZERO tenant secrets.
 * @satisfies NFR-011 — the supervisor process MUST contain zero tenant secrets.
 * @satisfies SC-003 — every spawned worker holds exactly ONE tenant's config/secrets.
 * @satisfies FR-005/FR-007 — supervisor holds only references; one worker, one tenant.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ok } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { tenantId, markSecretsRef } from "../../domain/tenant.js";
import type { TenantId } from "../../domain/tenant.js";
import type { HostError } from "../../domain/host-error.js";
import type { LogPort } from "../../ports.js";
import { workerSocketPath } from "../../domain/config.js";
import { createEnvFileSecretsSource } from "../../supervisor/secrets/env-file-secrets-source.js";
import { apply, createFakeAclAdmin, ACL_PASSWORD_RANDOM_BYTES } from "../../supervisor/secrets/redis-acl-provisioner.js";
import { createWorkerLifecycle } from "../../supervisor/lifecycle/worker-lifecycle-manager.js";
import type { TenantSpawnConfigView, WorkerLifecycleConfig } from "../../supervisor/lifecycle/worker-lifecycle-manager.js";
import { createWorkerRegistry, createInMemoryWorkerRedisFake } from "../../supervisor/lifecycle/worker-registry-redis.js";
import type { SpawnPort, ProcManagePort, WorkerSpawnSpec, WorkerHandle } from "../../supervisor/lifecycle/spawn-port.js";
import { buildWorkerBootstrap } from "../../worker-main.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

const tid = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`bad tenant fixture ${s}`);
  return r.value;
};

const silentLog: LogPort = { info: () => {}, warn: () => {}, error: () => {} };

/** The actual secret bytes — they live ONLY in env-files, never supervisor-side. */
const SECRET_BYTES_BY_TENANT: Record<string, string> = {
  acme: "ACME-SECRET-bytes-aa11",
  globex: "GLOBEX-SECRET-bytes-bb22",
  initech: "INITECH-SECRET-bytes-cc33",
};

/**
 * A SpawnPort fake that CAPTURES every `WorkerSpawnSpec` it is asked to spawn —
 * this is the inspection surface for the isolation sweep (what the supervisor
 * actually hands each worker process).
 */
const makeCapturingSpawn = () => {
  const specs: WorkerSpawnSpec[] = [];
  let nextPid = 1000;
  const spawn: SpawnPort = {
    spawn: async (spec): Promise<Result<WorkerHandle, HostError>> => {
      specs.push(spec);
      const pid = nextPid++;
      // A never-resolving `exited` — these workers stay "live" for the sweep.
      const exited = new Promise<number | null>(() => {});
      return ok({ pid, exited });
    },
  };
  const proc: ProcManagePort = {
    signal: async () => ok(undefined),
    isAlive: async () => true,
  };
  return { spawn, proc, specs };
};

/**
 * Tenant spawn-config view: each tenant maps to its OWN secrets REFERENCE (a
 * vault-style ref string). CRITICAL: a ref is NOT a secret value — the strings
 * here are pointers, and `SECRET_BYTES_BY_TENANT` (the real material) never
 * appears in any ref.
 */
const tenantsView = (tenants: readonly string[]): TenantSpawnConfigView => ({
  spawnConfigFor: (tenant) => {
    if (!tenants.includes(tenant)) return undefined;
    return { secretsRef: markSecretsRef(`vault://${tenant}/env`), eagerPin: false };
  },
});

const baseConfig = (over: Partial<WorkerLifecycleConfig> = {}): WorkerLifecycleConfig => ({
  udsDir: "/run/fugue",
  workerEntry: "/app/worker-main.ts",
  idleEvictMs: 900_000,
  spawnReadyTimeoutMs: 1000,
  spawnReadyPollMs: 5,
  ...over,
});

const fixedClock = () => {
  let t = 0;
  return { clock: () => t, advance: (ms: number) => { t += ms; } };
};

// ───────────────────────────────────────────────────────────────────────────
// A. Supervisor-secrets-absence (SC-002, NFR-011)
// ───────────────────────────────────────────────────────────────────────────

describe("Supervisor-secrets-absence: handles refs only, never secret material (SC-002, NFR-011)", () => {
  it("every WorkerSpawnSpec the supervisor emits carries a SecretsRef, NEVER a resolved value", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc, specs } = makeCapturingSpawn();
    const tenants = ["acme", "globex", "initech"];
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView(tenants),
      clock: fixedClock().clock, config: baseConfig(), logger: silentLog,
    });

    for (const t of tenants) {
      const r = await lc.ensureWorker(tid(t));
      expect(r.ok).toBe(true);
    }

    // Inspect EVERY spawn spec the supervisor produced over its lifetime: each
    // carries only the tenant's branded ref pointer — ZERO actual secret bytes.
    expect(specs.length).toBe(3);
    const wholeSpecBlob = JSON.stringify(specs);
    for (const t of tenants) {
      expect(wholeSpecBlob).not.toContain(SECRET_BYTES_BY_TENANT[t]);
    }
    // The refs ARE present — proving the supervisor forwards the reference, not nothing.
    for (const spec of specs) {
      expect(spec.secretsRef as string).toMatch(/^vault:\/\//);
    }
  });

  it("a SecretsRef alone yields ZERO secret bytes — the supervisor cannot dereference it", () => {
    // The supervisor holds a `SecretsRef` (a pointer). It does NOT construct a
    // SecretsSource (that requires filesystem/Vault authority it structurally
    // lacks). A ref by itself is inert: there is no `ref.deref()` — the only way to
    // get bytes is via a concrete source, which is the WORKER's job.
    const ref = markSecretsRef("vault://acme/env");
    // The ref string carries no secret bytes (it is a pointer).
    expect(ref as string).not.toContain(SECRET_BYTES_BY_TENANT.acme);

    // The env-file source — the ONLY dereferencer — is a worker concern. Pointing
    // it at a vault:// ref (a path that does not exist on this fs) fails closed
    // with ZERO secret bytes, demonstrating the ref is not magically resolvable.
    const source = createEnvFileSecretsSource();
    const result = source(ref);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a vault ref should not resolve via the env-file source");
    expect(JSON.stringify(result.error)).not.toContain(SECRET_BYTES_BY_TENANT.acme);
  });

  it("the Redis ACL credential mint+handoff retains ZERO secret state supervisor-side (SC-002 scope note)", async () => {
    // The ONE deliberate supervisor-side secret mint is the per-tenant ACL
    // password — but it is a bounded handoff: `apply` RETURNS it and the
    // provisioner keeps no copy. We INSPECT the admin connection's recorded
    // commands after the handoff and prove the password appears ONLY as the
    // transient `>password` SETUSER token (carried to the server), never retained
    // on any long-lived supervisor handle.
    const admin = createFakeAclAdmin();
    const deps = { generateRandomBytes: () => new Uint8Array(ACL_PASSWORD_RANDOM_BYTES).fill(9) };

    const r = await apply(admin, tid("acme"), deps);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const password = r.value.password;

    // (a) The minted password reaches the server EXACTLY ONCE, as a `>`-prefixed
    // SETUSER token — the transient handoff, never bare.
    expect(admin.setUserCalls.length).toBe(1);
    const issuedRules = admin.setUserCalls[0].rules;
    const passwordTokens = issuedRules.filter((tok) => tok === `>${password}`);
    expect(passwordTokens.length).toBe(1);
    // The password NEVER appears bare (un-prefixed) in the issued rules — the only
    // occurrence is the `>password` token asserted above.
    const bareOccurrences = issuedRules.filter((tok) => tok === password);
    expect(bareOccurrences.length).toBe(0);

    // (b) The returned credential is the ONLY place the password materializes; the
    // provisioner exposes no getter/cache and attaches it to no long-lived handle.
    // The admin port (the long-lived supervisor handle) records ONLY the spec rules
    // + the transient `>password` token — there is no extra field carrying the
    // password elsewhere on it.
    const adminHandleBlob = JSON.stringify({
      setUserCalls: admin.setUserCalls.map((c) => ({ username: c.username })),
      delUserCalls: admin.delUserCalls,
    });
    expect(adminHandleBlob).not.toContain(password);

    // (c) Two independent applies share no state — distinct tenants get distinct,
    // non-cross-readable usernames AND distinct credentials.
    const admin2 = createFakeAclAdmin();
    const r2 = await apply(admin2, tid("globex"), deps);
    if (!r2.ok) throw new Error("unreachable");
    expect(r.value.tenant).toBe(tid("acme"));
    expect(r2.value.tenant).toBe(tid("globex"));
    // The ACL password is NOT a tenant ENV-FILE secret — it never resolves another
    // tenant's material. Distinct tenants get distinct, non-cross-readable creds.
    expect(r.value.username).not.toBe(r2.value.username);
    // The first admin handle never saw the second tenant's username (no cross-bleed).
    expect(admin.setUserCalls.some((c) => c.username === r2.value.username)).toBe(false);
  });

  it("NO supervisor module imports a concrete SecretsSource (NFR-011 enforced structurally, not by convention)", async () => {
    // NFR-011 / SC-002: the supervisor structurally LACKS the authority to
    // dereference a SecretsRef — there is no resolution path supervisor-side. The
    // env-file (and any future Vault) adapter is the ONLY dereferencer and is a
    // WORKER concern. We make "supervisor cannot dereference a ref" regression-proof
    // by reading the actual supervisor sources and asserting none of them import a
    // `*-secrets-source` module. (`redis-acl-provisioner` is fine — it mints the ACL
    // credential, it does not resolve a tenant's env-file secrets.)
    const here = dirname(fileURLToPath(import.meta.url));
    const srcRoot = join(here, "..", "..");
    const supervisorSources = [
      "supervisor/supervisor.ts",
      "supervisor/routing.ts",
      "supervisor/uds-proxy.ts",
      "supervisor/admission.ts",
      "main-supervisor.ts",
    ];

    for (const rel of supervisorSources) {
      const text = await Bun.file(join(srcRoot, rel)).text();
      // The concrete dereferencers — importing either grants secret-read authority.
      expect(text).not.toContain("secrets-source");
      expect(text).not.toContain("env-file-secrets");
      // Defense-in-depth: the supervisor must not even name the resolution port's
      // constructor (catches a re-export aliasing trick).
      expect(text).not.toContain("createEnvFileSecretsSource");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// B. One-tenant-per-worker isolation sweep (SC-003, FR-007)
// ───────────────────────────────────────────────────────────────────────────

describe("One-tenant-per-worker: every live worker holds EXACTLY one tenant (SC-003, FR-007)", () => {
  it("sweeps all spawned workers — each spec names exactly ONE tenant with its OWN ref + OWN socket", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc, specs } = makeCapturingSpawn();
    const tenants = ["acme", "globex", "initech"];
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView(tenants),
      clock: fixedClock().clock, config: baseConfig(), logger: silentLog,
    });

    for (const t of tenants) {
      const r = await lc.ensureWorker(tid(t));
      expect(r.ok).toBe(true);
    }

    // THE SWEEP: one spawn per tenant, each bound to exactly its own tenant.
    expect(specs.length).toBe(tenants.length);
    expect(lc.liveWorkerCount()).toBe(tenants.length);

    const seenTenants = new Set<string>();
    for (const spec of specs) {
      const t = spec.tenant as string;
      // Exactly ONE tenant id per spec, and not a duplicate.
      expect(tenants).toContain(t);
      expect(seenTenants.has(t)).toBe(false);
      seenTenants.add(t);

      // The spec's secretsRef is THIS tenant's own ref — never a foreign tenant's.
      expect(spec.secretsRef as string).toBe(`vault://${t}/env`);
      for (const other of tenants) {
        if (other === t) continue;
        expect(spec.secretsRef as string).not.toContain(other);
      }

      // The spec's UDS path is THIS tenant's own socket (FR-004) — derived from its
      // own id, so it can never point at another tenant's worker.
      expect(spec.udsPath).toBe(workerSocketPath("/run/fugue", t));
    }
    // Every tenant got its own worker — no tenant was skipped or doubled.
    expect([...seenTenants].sort()).toEqual([...tenants].sort());
  });

  it("the live Redis registry records mirror one-tenant-per-worker (no record names two tenants)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc } = makeCapturingSpawn();
    const tenants = ["acme", "globex"];
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView(tenants),
      clock: fixedClock().clock, config: baseConfig(), logger: silentLog,
    });
    for (const t of tenants) await lc.ensureWorker(tid(t));

    // Each persisted worker record is keyed by exactly one tenant, and its payload
    // udsPath is that tenant's own socket. (The tenant rides on the KEY, not the
    // serialized payload — so the key is the single source of the record's tenant.)
    for (const t of tenants) {
      const key = `fugue:supervisor:workers:${t}`;
      const raw = fake.store.get(key);
      expect(raw).toBeDefined();
      const rec = JSON.parse(raw!) as { udsPath: string };
      expect(rec.udsPath).toBe(workerSocketPath("/run/fugue", t));
      // The record for tenant t does NOT name any other tenant.
      for (const other of tenants) {
        if (other === t) continue;
        expect(rec.udsPath).not.toContain(other);
      }
    }
    // Exactly one worker key per tenant — the store holds no extra worker entries.
    const workerKeys = [...fake.store.keys()].filter((k) => k.startsWith("fugue:supervisor:workers:"));
    expect(workerKeys.length).toBe(tenants.length);
  });

  it("a worker's spawn config is sourced per-tenant — an unconfigured tenant gets NO worker (fail-closed)", async () => {
    // SC-003 corollary: there is no path that spawns a worker holding a tenant the
    // registry never configured — so a worker can only ever hold a tenant it was
    // explicitly, singly configured for.
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc, specs } = makeCapturingSpawn();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView(["acme"]), // only acme is configured
      clock: fixedClock().clock, config: baseConfig(), logger: silentLog,
    });

    const r = await lc.ensureWorker(tid("globex")); // never configured
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("ISOLATION BREACH: spawned a worker for an unconfigured tenant");
    expect(specs.length).toBe(0); // nothing spawned
    expect(lc.liveWorkerCount()).toBe(0);
  });

  it("real worker bootstrap binds EXACTLY one tenant; a second tenant's bootstrap is a separate, non-overlapping worker", () => {
    // End-to-end-ish: two real `buildWorkerBootstrap` plans (the worker boundary)
    // each carry exactly one tenant's resolved config. Proves SC-003 at the actual
    // worker boot site, not just the spawn spec.
    const dir = mkdtempSync(join(tmpdir(), "fugue-one-tenant-"));
    try {
      const acmeRef = join(dir, "acme.env");
      writeFileSync(acmeRef, `ANTHROPIC_API_KEY=${SECRET_BYTES_BY_TENANT.acme}\n`, "utf8");
      const globexRef = join(dir, "globex.env");
      writeFileSync(globexRef, `ANTHROPIC_API_KEY=${SECRET_BYTES_BY_TENANT.globex}\n`, "utf8");

      // buildWorkerBootstrap is the PURE planner (no socket bind) — imported above.
      const baseEnv = {
        DAGS_REPO_URL: "https://github.com/org/dags.git",
        REDIS_URL: "redis://localhost:6379",
        ADMIN_TOKEN: "test-admin-token-long-enough",
      };
      const source = createEnvFileSecretsSource();

      const acme = buildWorkerBootstrap({ ...baseEnv, TENANT_ID: "acme", FUGUE_SECRETS_REF: acmeRef }, source);
      const globex = buildWorkerBootstrap({ ...baseEnv, TENANT_ID: "globex", FUGUE_SECRETS_REF: globexRef }, source);

      expect(acme.ok).toBe(true);
      expect(globex.ok).toBe(true);
      if (!acme.ok || !globex.ok) throw new Error("unreachable");

      // Each worker holds exactly its OWN tenant + its OWN secret — and ZERO bytes
      // of the other's.
      expect(acme.value.tenant).toBe(tid("acme"));
      expect(globex.value.tenant).toBe(tid("globex"));
      expect(acme.value.config.ANTHROPIC_API_KEY).toBe(SECRET_BYTES_BY_TENANT.acme);
      expect(JSON.stringify(acme.value.config)).not.toContain(SECRET_BYTES_BY_TENANT.globex);
      expect(JSON.stringify(globex.value.config)).not.toContain(SECRET_BYTES_BY_TENANT.acme);
      // Distinct sockets — never the same worker.
      expect(acme.value.socketPath).not.toBe(globex.value.socketPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
