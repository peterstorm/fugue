/**
 * Declarative-bootstrap SHELL (apply + reconcile) — `supervisor/bootstrap/run-bootstrap.ts`.
 *
 * Wired against the REAL registry adapter (in-memory Redis fake) and the
 * in-memory token store, so these are integration-style tests of the idempotent
 * apply, not mock theatre.
 *
 * Covers:
 *   - tenants seed into the registry; re-running the SAME bootstrap is a no-op
 *     success (idempotency, SC-009).
 *   - a provided team token is hashed + stored so it resolves; re-run idempotent.
 *   - a ROTATED token (same team, new value) upserts: new resolves, old does not.
 *   - the SAME token reused across two teams fails closed.
 *   - a token for a team no active tenant owns fails closed.
 *   - path wins over inline; a readFile failure fails closed.
 *   - no bootstrap input → no-op (zero counts).
 */

import { describe, it, expect } from "bun:test";
import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../../../domain/host-error.js";
import { runBootstrap } from "../../../supervisor/bootstrap/run-bootstrap.js";
import type { BootstrapDeps, BootstrapInputs } from "../../../supervisor/bootstrap/run-bootstrap.js";
import { createRedisTenantRegistry, createInMemoryRedisFake } from "../../../supervisor/registry/redis-registry-adapter.js";
import { createInMemoryTokenStore } from "../../../adapters/token-store.js";
import { hashToken, TOKEN_PREFIX } from "../../../domain/auth.js";
import type { TokenStorePort, LogPort } from "../../../ports.js";

const silentLog: LogPort = { info: () => {}, warn: () => {}, error: () => {} };
const FUG = (suffix: string): string => `${TOKEN_PREFIX}${suffix.padEnd(43, "A")}`;

const tenant = (id: string): Record<string, unknown> => ({
  id,
  team: id,
  keycloakClientMapping: { realm: "fugue", clientId: `${id}-c`, agentClientIdsByDag: {} },
  fsRoot: `/srv/${id}`,
  dagsRoot: `/dags/${id}`,
  secretsRef: `/run/secrets/${id}.env`,
  admission: { maxConcurrentRuns: 2, maxQueuedRuns: 4 },
  eagerPin: false,
});

interface Harness {
  readonly deps: BootstrapDeps;
  readonly tokenStore: TokenStorePort;
  readonly registry: ReturnType<typeof createRedisTenantRegistry>;
}

const harness = (files: Record<string, string> = {}): Harness => {
  const fake = createInMemoryRedisFake();
  const registry = createRedisTenantRegistry(fake.redis, fake.pubsub, {}, silentLog);
  const tokenStore = createInMemoryTokenStore();
  const readFile = (p: string): Result<string, HostError> =>
    p in files ? ok(files[p]) : err({ kind: "config-invalid", message: `bootstrap file '${p}' unreadable (ENOENT)` });
  const deps: BootstrapDeps = { registry, tokenStore, now: () => 1_000, readFile, logger: silentLog };
  return { deps, tokenStore, registry };
};

const tokenResolves = async (store: TokenStorePort, token: string): Promise<string | null> => {
  const hash = await hashToken(token);
  const r = await store.resolve(hash);
  return r.ok && r.value ? r.value.team : null;
};

describe("runBootstrap — no-op", () => {
  it("returns zero counts when no input is configured", async () => {
    const { deps } = harness();
    const r = await runBootstrap(deps, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ tenantsApplied: 0, teamTokensApplied: 0 });
  });
});

describe("runBootstrap — tenants", () => {
  it("seeds tenants into the registry and is idempotent on re-run", async () => {
    const inputs: BootstrapInputs = { tenantsInline: JSON.stringify([tenant("alpha"), tenant("beta")]) };
    const { deps, registry } = harness();

    const first = await runBootstrap(deps, inputs);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.tenantsApplied).toBe(2);
    expect(registry.snapshot().entries.size).toBe(2);

    // Re-run the identical bootstrap — no error, same end state (SC-009).
    const second = await runBootstrap(deps, inputs);
    expect(second.ok).toBe(true);
    expect(registry.snapshot().entries.size).toBe(2);
  });

  it("fails closed and seeds nothing-extra on an invalid tenant config", async () => {
    const inputs: BootstrapInputs = {
      tenantsInline: JSON.stringify([tenant("alpha"), { ...tenant("beta"), dagsRoot: "/dags/../etc" }]),
    };
    const { deps, registry } = harness();
    const r = await runBootstrap(deps, inputs);
    expect(r.ok).toBe(false);
    // alpha may have been applied before beta failed — fail-closed means the boot
    // aborts; the parser rejects beta BEFORE any apply, so nothing is seeded.
    expect(registry.snapshot().entries.size).toBe(0);
  });
});

describe("runBootstrap — team tokens", () => {
  it("hashes + stores a provided token so it resolves; idempotent on re-run", async () => {
    const token = FUG("alpha-token");
    const inputs: BootstrapInputs = {
      tenantsInline: JSON.stringify([tenant("alpha")]),
      teamTokensInline: JSON.stringify({ alpha: token }),
    };
    const { deps, tokenStore } = harness();

    const first = await runBootstrap(deps, inputs);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.teamTokensApplied).toBe(1);
    expect(await tokenResolves(tokenStore, token)).toBe("alpha");

    const second = await runBootstrap(deps, inputs);
    expect(second.ok).toBe(true);
    expect(await tokenResolves(tokenStore, token)).toBe("alpha");
  });

  it("upserts a rotated token: the new token resolves, the old does not", async () => {
    const oldToken = FUG("old-token");
    const newToken = FUG("new-token");
    const { deps, tokenStore } = harness();

    const seed = await runBootstrap(deps, {
      tenantsInline: JSON.stringify([tenant("alpha")]),
      teamTokensInline: JSON.stringify({ alpha: oldToken }),
    });
    expect(seed.ok).toBe(true);
    expect(await tokenResolves(tokenStore, oldToken)).toBe("alpha");

    const rotate = await runBootstrap(deps, {
      tenantsInline: JSON.stringify([tenant("alpha")]),
      teamTokensInline: JSON.stringify({ alpha: newToken }),
    });
    expect(rotate.ok).toBe(true);
    expect(await tokenResolves(tokenStore, newToken)).toBe("alpha");
    expect(await tokenResolves(tokenStore, oldToken)).toBe(null);
  });

  it("fails closed when the same token is reused across two teams", async () => {
    const shared = FUG("shared-token");
    const r = await (async () => {
      const { deps } = harness();
      return runBootstrap(deps, {
        tenantsInline: JSON.stringify([tenant("alpha"), tenant("beta")]),
        teamTokensInline: JSON.stringify({ alpha: shared, beta: shared }),
      });
    })();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("config-invalid");
  });

  it("fails closed when a token's team has no active tenant", async () => {
    const { deps } = harness();
    const r = await runBootstrap(deps, {
      tenantsInline: JSON.stringify([tenant("alpha")]),
      teamTokensInline: JSON.stringify({ ghost: FUG("ghost-token") }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("no active tenant");
  });

  it("never leaks the token value in the cross-team-reuse error", async () => {
    const shared = FUG("leak-canary-token");
    const { deps } = harness();
    const r = await runBootstrap(deps, {
      tenantsInline: JSON.stringify([tenant("alpha"), tenant("beta")]),
      teamTokensInline: JSON.stringify({ alpha: shared, beta: shared }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).not.toContain(shared);
  });
});

describe("runBootstrap — source resolution + I/O", () => {
  it("reads from the file path, which wins over inline", async () => {
    const fromFile = JSON.stringify([tenant("filey")]);
    const fromInline = JSON.stringify([tenant("inliney")]);
    const { deps, registry } = harness({ "/etc/fugue/tenants.json": fromFile });
    const r = await runBootstrap(deps, {
      tenantsPath: "/etc/fugue/tenants.json",
      tenantsInline: fromInline,
    });
    expect(r.ok).toBe(true);
    expect(registry.snapshot().entries.has("filey" as never)).toBe(true);
    expect(registry.snapshot().entries.has("inliney" as never)).toBe(false);
  });

  it("fails closed when the configured file path is unreadable", async () => {
    const { deps } = harness(); // no files registered → readFile returns Left
    const r = await runBootstrap(deps, { tenantsPath: "/etc/fugue/missing.json" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("config-invalid");
  });
});
