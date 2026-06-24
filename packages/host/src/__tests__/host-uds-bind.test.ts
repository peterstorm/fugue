/**
 * createHost UDS-bind path (T6, FR-007) — the PRIMARY per-tenant isolation
 * boundary and, layered on top, the worker-side `X-Fugue-Tenant` verification
 * (defense-in-depth, C9).
 *
 * Covered here:
 *   1. `bind: { unix }` actually binds a Unix-domain socket, and the socket file
 *      is chmod'd 0600 (fs.statSync mode & 0o777 === 0o600) — the per-tenant
 *      isolation boundary FR-007 depends on.
 *   2. A real request over that UDS round-trips to a worker bound (via `tenant`)
 *      to a specific TenantId.
 *   3. Worker-side header verification is FAIL-CLOSED when
 *      `FUGUE_SUPERVISOR_HMAC_KEY` is set + UDS mode: a request with NO header is
 *      401, a forged/mismatched header is 403, and a correctly supervisor-signed
 *      header for THIS tenant is served (200 from the unauthenticated /health
 *      route, which proves the request reached `app.fetch`).
 *   4. When the key is UNSET, verification is skipped and the same /health
 *      request is served (legacy single-tenant/TCP posture preserved, FR-035).
 *   5. A bind failure (binding the SAME socket path twice) is a fail-closed boot
 *      ABORT (`internal-invariant-violated`), never a half-booted host.
 *
 * No real Redis/git/filesystem-of-DAGs: ports are faked. The socket lives under
 * the OS temp dir and is cleaned up after each test.
 */

import { describe, test, expect, afterEach, mock } from "bun:test";
import { ok, err, noopTracer, gitSha } from "@fuguejs/framework";
import type { DagId } from "@fuguejs/framework";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statSync, existsSync, rmSync } from "node:fs";
import type { GitPort, ModuleLoaderPort, BulkLoadResult, SharedInfra, RedisPort } from "../ports.js";
import type { RedisConnectivityPort } from "../lifecycle/startup.js";
import type { SyncLogger } from "../sync/sync-loop.js";
import type { HostConfig } from "../domain/config.js";
import { parseHostConfig } from "../domain/config.js";
import type { HostInstance } from "../host.js";
import { createHost } from "../host.js";
import { tenantId } from "../domain/tenant.js";
import { signTenantHeader, TENANT_HEADER_NAME } from "../domain/tenant-header.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

const HMAC_KEY = "internal-platform-hmac-key-not-a-tenant-secret";

const makeConfig = (overrides?: Record<string, string | undefined>): HostConfig => {
  const r = parseHostConfig({
    DAGS_REPO_URL: "https://github.com/test/dags.git",
    DAGS_LOCAL_PATH: "/tmp/test-dags",
    REDIS_URL: "redis://localhost:6379",
    // PORT is unused in UDS mode (we bind a socket), but parse requires >=1.
    PORT: "8080",
    DAGS_POLL_INTERVAL_MS: "60000",
    REDIS_PROBE_INTERVAL_MS: "60000",
    LLM_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "test-key",
    ADMIN_TOKEN: "test-admin-token-long-enough",
    ...overrides,
  });
  if (!r.ok) throw new Error(`bad test config: ${JSON.stringify(r.error)}`);
  return r.value;
};

const fakeGit = (): GitPort => ({
  clone: async () => ok(undefined),
  pull: async () => ok(undefined),
  currentSha: async () => ok(gitSha("abc1234")),
  hasLockfileChanged: async () => ok(false),
  install: async () => ok(undefined),
});

const fakeLoader = (): ModuleLoaderPort => ({
  loadDagModule: async (path) => err({ kind: "import-failed", path, message: "not found" }),
  discoverDagPaths: async () => ok([]),
  loadAll: async (): Promise<BulkLoadResult> => ({ loaded: [], errors: [] }),
});

const fakeRedis = (): { port: RedisConnectivityPort; redis: RedisPort } => {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    port: { ping: async () => ok(undefined) },
    redis: {
      get: async (key) => ok(store.get(key) ?? null),
      set: async (key, value) => { store.set(key, value); return ok("OK" as string | null); },
      del: async (key) => { const had = store.has(key) ? 1 : 0; store.delete(key); return ok(had); },
      scan: async (pattern) => {
        const prefix = pattern.replace(/\*$/, "");
        return ok({ cursor: "0", keys: [...store.keys()].filter((k) => k.startsWith(prefix)) });
      },
      setNx: async (key, value) => { if (store.has(key)) return ok(false); store.set(key, value); return ok(true); },
      sAdd: async (key, member) => {
        const s = sets.get(key) ?? new Set<string>(); const had = s.has(member); s.add(member); sets.set(key, s); return ok(had ? 0 : 1);
      },
      sRem: async (key, member) => {
        const s = sets.get(key); if (!s || !s.has(member)) return ok(0); s.delete(member); return ok(1);
      },
      sMembers: async (key) => ok(Array.from(sets.get(key) ?? [])),
    },
  };
};

const fakeInfra = (redis: RedisPort): SharedInfra => ({
  llm: { chat: async () => ({ content: "", usage: { inputTokens: 0, outputTokens: 0 } }) } as never,
  redis,
  tracer: noopTracer,
  contentFilter: null,
  prompts: null,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  capabilities: [],
});

const testLogger = (): SyncLogger & { logs: Array<{ level: string; msg: string }> } => {
  const logs: Array<{ level: string; msg: string }> = [];
  return {
    logs,
    info: (msg) => logs.push({ level: "info", msg }),
    warn: (msg) => logs.push({ level: "warn", msg }),
    error: (msg) => logs.push({ level: "error", msg }),
  };
};

const mkTenant = (id: string) => {
  const r = tenantId(id);
  if (!r.ok) throw new Error(`bad tenant ${id}`);
  return r.value;
};

/** fetch over a Unix-domain socket (Bun) at an absolute path. */
const fetchOverUds = (sock: string, path: string, headers?: Record<string, string>): Promise<Response> =>
  fetch(`http://uds.fugue.internal${path}`, {
    headers,
    unix: sock,
  } as RequestInit & { unix: string });

// ── Tests ──────────────────────────────────────────────────────────────────

describe("createHost — UDS bind + chmod 0600 (FR-007)", () => {
  let host: HostInstance | null = null;
  let sock: string | null = null;

  afterEach(async () => {
    if (host) { await host.shutdown(); host = null; }
    if (sock && existsSync(sock)) rmSync(sock, { force: true });
    sock = null;
  });

  test("binds a UDS, chmods it 0600, and serves a real request over it", async () => {
    sock = join(tmpdir(), `fugue-bind-${crypto.randomUUID()}.sock`);
    const { port, redis } = fakeRedis();
    const result = await createHost({
      config: makeConfig(),
      git: fakeGit(),
      loader: fakeLoader(),
      redis: port,
      sharedInfra: fakeInfra(redis),
      logger: testLogger(),
      tenant: mkTenant("acme"),
      bind: { unix: sock },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    host = result.value;

    // PRIMARY isolation boundary: the socket exists and is 0600 (owner-only).
    expect(existsSync(sock)).toBe(true);
    expect(statSync(sock).mode & 0o777).toBe(0o600);

    // A real request round-trips over the socket (no HMAC key → no header check).
    const res = await fetchOverUds(sock, "/health");
    expect(res.status).toBe(200);

    // The handle reports no TCP port for a UDS server.
    expect(host.server?.port).toBe(0);
  });

  test("worker-side header verification is FAIL-CLOSED when the HMAC key is set", async () => {
    sock = join(tmpdir(), `fugue-bind-${crypto.randomUUID()}.sock`);
    const tenant = mkTenant("acme");
    const { port, redis } = fakeRedis();
    const logger = testLogger();
    const result = await createHost({
      config: makeConfig({ FUGUE_SUPERVISOR_HMAC_KEY: HMAC_KEY }),
      git: fakeGit(),
      loader: fakeLoader(),
      redis: port,
      sharedInfra: fakeInfra(redis),
      logger,
      tenant,
      bind: { unix: sock },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    host = result.value;

    // Posture is observable in the boot log.
    expect(logger.logs.some((l) => l.msg.includes("tenant-header verification ACTIVE"))).toBe(true);

    // Absent header → 401 (no usable principal proof), fail-closed BEFORE dispatch.
    const absent = await fetchOverUds(sock, "/health");
    expect(absent.status).toBe(401);

    // Malformed header → 401.
    const malformed = await fetchOverUds(sock, "/health", { [TENANT_HEADER_NAME]: "no-dot-here" });
    expect(malformed.status).toBe(401);

    // Valid signature but a DIFFERENT tenant → 403 (tenant-mismatch).
    const otherTenant = await fetchOverUds(sock, "/health", {
      [TENANT_HEADER_NAME]: signTenantHeader(HMAC_KEY, "evil"),
    });
    expect(otherTenant.status).toBe(403);

    // Right tenant, WRONG key (forged signature) → 403 (bad-signature).
    const forged = await fetchOverUds(sock, "/health", {
      [TENANT_HEADER_NAME]: signTenantHeader("wrong-key", "acme"),
    });
    expect(forged.status).toBe(403);

    // Correct supervisor-signed header for THIS tenant → reaches app.fetch (200).
    const good = await fetchOverUds(sock, "/health", {
      [TENANT_HEADER_NAME]: signTenantHeader(HMAC_KEY, "acme"),
    });
    expect(good.status).toBe(200);
  });

  test("verification is SKIPPED when the key is unset (legacy posture, FR-035)", async () => {
    sock = join(tmpdir(), `fugue-bind-${crypto.randomUUID()}.sock`);
    const { port, redis } = fakeRedis();
    const logger = testLogger();
    const result = await createHost({
      config: makeConfig(), // no FUGUE_SUPERVISOR_HMAC_KEY
      git: fakeGit(),
      loader: fakeLoader(),
      redis: port,
      sharedInfra: fakeInfra(redis),
      logger,
      tenant: mkTenant("acme"),
      bind: { unix: sock },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    host = result.value;

    expect(logger.logs.some((l) => l.msg.includes("tenant-header verification INACTIVE"))).toBe(true);

    // No header, no key → still served (socket isolation alone).
    const res = await fetchOverUds(sock, "/health");
    expect(res.status).toBe(200);
  });

  test("a bind failure is a fail-closed boot ABORT (internal-invariant-violated)", async () => {
    sock = join(tmpdir(), `fugue-bind-${crypto.randomUUID()}.sock`);
    const { port, redis } = fakeRedis();

    // First host claims the socket.
    const first = await createHost({
      config: makeConfig(),
      git: fakeGit(),
      loader: fakeLoader(),
      redis: port,
      sharedInfra: fakeInfra(redis),
      logger: testLogger(),
      tenant: mkTenant("acme"),
      bind: { unix: sock },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    host = first.value;

    // Second host on the SAME path must fail to bind → boot abort, not a partial host.
    let onShutdownCalled = false;
    const second = await createHost({
      config: makeConfig(),
      git: fakeGit(),
      loader: fakeLoader(),
      redis: port,
      sharedInfra: fakeInfra(redis),
      logger: testLogger(),
      tenant: mkTenant("acme"),
      bind: { unix: sock },
      onShutdown: async () => { onShutdownCalled = true; },
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.kind).toBe("internal-invariant-violated");
    }
    // The boot-abort cleanup path ran onShutdown (no leaked resources).
    expect(onShutdownCalled).toBe(true);
  });

  test("a chmod failure AFTER a successful bind aborts boot AND leaves no listener (FR-007)", async () => {
    // REGRESSION: `Bun.serve` binds the UDS the instant it returns; if the
    // subsequent `chmodSync(unixPath, 0o600)` throws, the catch must `bunServer.stop()`
    // the already-bound server. The old catch only closed capabilities + onShutdown,
    // leaving a mis-permissioned socket LISTENING. The earlier bind-failure test
    // double-binds, which makes `Bun.serve` ITSELF throw BEFORE assignment — it does
    // NOT exercise this chmod-after-bind branch. This test forces chmod to fail.
    sock = join(tmpdir(), `fugue-bind-${crypto.randomUUID()}.sock`);

    // Mock ONLY chmodSync to throw; every other `node:fs` export stays real so the
    // module mock is harmless to the rest of the file. `await import("node:fs")` in
    // host.ts resolves through this mock; we restore it in `finally` so no leakage.
    const actualFs = (await import("node:fs")) as typeof import("node:fs");
    const realChmodSync = actualFs.chmodSync;
    mock.module("node:fs", () => ({
      ...actualFs,
      default: actualFs,
      chmodSync: () => {
        throw new Error("EPERM chmod test");
      },
    }));

    let onShutdownCalled = false;
    try {
      const { port, redis } = fakeRedis();
      const result = await createHost({
        config: makeConfig(),
        git: fakeGit(),
        loader: fakeLoader(),
        redis: port,
        sharedInfra: fakeInfra(redis),
        logger: testLogger(),
        tenant: mkTenant("acme"),
        bind: { unix: sock },
        onShutdown: async () => {
          onShutdownCalled = true;
        },
      });

      // (1) Boot is a fail-closed abort, not a half-booted host.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("internal-invariant-violated");
      }
      // The boot-abort cleanup path ran onShutdown (mirrors the bind-failure test).
      expect(onShutdownCalled).toBe(true);
    } finally {
      // Restore the REAL `node:fs` before any other test runs (the harness's
      // top-level statSync/existsSync/rmSync bindings, and any later
      // `await import("node:fs")` in host.ts, must point at the real impl).
      // NOTE: in Bun 1.3.x `mock.restore()` does NOT clear a `mock.module`
      // override — you must re-mock with the real exports, and the throwing
      // `chmodSync` must be replaced EXPLICITLY with the captured real fn.
      mock.module("node:fs", () => ({ ...actualFs, default: actualFs, chmodSync: realChmodSync }));
    }

    // (2) NO server remains listening on the socket. The bug left the bound server
    // up; the fix's `bunServer.stop()` tears it down. Proven two ways:
    //   (a) a fresh request over the socket FAILS to connect (nothing is listening), and
    //   (b) a SECOND createHost on the SAME path now binds cleanly — only possible
    //       if the first boot released the socket.
    await expect(fetchOverUds(sock, "/health")).rejects.toThrow();

    const { port, redis } = fakeRedis();
    const second = await createHost({
      config: makeConfig(),
      git: fakeGit(),
      loader: fakeLoader(),
      redis: port,
      sharedInfra: fakeInfra(redis),
      logger: testLogger(),
      tenant: mkTenant("acme"),
      bind: { unix: sock },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    host = second.value; // afterEach shuts it down + removes the socket.

    // With chmod restored, the second boot fully succeeded: socket is 0600 and serves.
    expect(existsSync(sock)).toBe(true);
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    const res = await fetchOverUds(sock, "/health");
    expect(res.status).toBe(200);
  });
});
