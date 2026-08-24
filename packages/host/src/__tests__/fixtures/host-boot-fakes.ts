/**
 * Shared `createHost` boot fakes — the lightweight fake-port stack the host
 * boot tests use (host-uds-bind.test.ts, hitl-boot-wiring.test.ts).
 *
 * No real Redis/git/filesystem-of-DAGs: every port is a plain in-memory fake
 * (the repo's established port/fake idiom — no mock frameworks). The socket
 * fetch helper covers Bun's UDS `fetch` option.
 */

import { ok, err, noopTracer, gitSha } from "@fuguejs/framework";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitPort, ModuleLoaderPort, BulkLoadResult, SharedInfra, RedisPort } from "../../ports.js";
import type { RedisConnectivityPort } from "../../lifecycle/startup.js";
import type { SyncLogger } from "../../sync/sync-loop.js";
import type { HostConfig } from "../../domain/config.js";
import { parseHostConfig } from "../../domain/config.js";
import { tenantId } from "../../domain/tenant.js";

export const makeConfig = (overrides?: Record<string, string | undefined>): HostConfig => {
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

export const fakeGit = (): GitPort => ({
  clone: async () => ok(undefined),
  pull: async () => ok(undefined),
  currentSha: async () => ok(gitSha("abc1234")),
  hasLockfileChanged: async () => ok(false),
  install: async () => ok(undefined),
});

export const fakeLoader = (): ModuleLoaderPort => ({
  loadDagModule: async (path) => err({ kind: "import-failed", path, message: "not found" }),
  discoverDagPaths: async () => ok([]),
  loadAll: async (): Promise<BulkLoadResult> => ({ loaded: [], errors: [] }),
});

export const fakeRedis = (): { port: RedisConnectivityPort; redis: RedisPort } => {
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
      compareAndDelete: async (key, expected) => { if (store.get(key) !== expected) return ok(false); store.delete(key); return ok(true); },
      compareAndExpire: async (key, expected) => ok(store.get(key) === expected),
      setIfValue: async (guard, expected, key, value) => {
        if (store.get(guard) !== expected) return ok(false);
        store.set(key, value);
        return ok(true);
      },
      setIfValues: async (guards, key, value) => {
        if (guards.some((guard) => store.get(guard.key) !== guard.expectedValue)) return ok(false);
        store.set(key, value);
        return ok(true);
      },
      setNxIfPresent: async (guard, key, value) => {
        if (!store.has(guard)) return ok("not-present" as const);
        if (store.has(key)) return ok("exists" as const);
        store.set(key, value);
        return ok("created" as const);
      },
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

export const fakeInfra = (redis: RedisPort): SharedInfra => ({
  llm: { chat: async () => ({ content: "", usage: { inputTokens: 0, outputTokens: 0 } }) } as never,
  redis,
  tracer: noopTracer,
  contentFilter: null,
  prompts: null,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  capabilities: [],
});

export const testLogger = (): SyncLogger & { logs: Array<{ level: string; msg: string }> } => {
  const logs: Array<{ level: string; msg: string }> = [];
  return {
    logs,
    info: (msg) => logs.push({ level: "info", msg }),
    warn: (msg) => logs.push({ level: "warn", msg }),
    error: (msg) => logs.push({ level: "error", msg }),
  };
};

export const mkTenant = (id: string) => {
  const r = tenantId(id);
  if (!r.ok) throw new Error(`bad tenant ${id}`);
  return r.value;
};

/** fetch over a Unix-domain socket (Bun) at an absolute path. */
export const fetchOverUds = (sock: string, path: string, headers?: Record<string, string>): Promise<Response> =>
  fetch(`http://uds.fugue.internal${path}`, {
    headers,
    unix: sock,
  } as RequestInit & { unix: string });
