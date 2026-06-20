/**
 * Admin tenant lifecycle API (FR-025/026/028/029/030; SC-008/009/010; US5/US6).
 *
 * Covers:
 *   - ADMIN-ONLY authz (SC-008): a non-admin token and an unauthenticated request
 *     are REFUSED (403/401) and never mutate the registry — and the refusal is
 *     itself audited.
 *   - audit emission on EVERY op with actor/timestamp/tenant/action (FR-028, SC-008).
 *   - IDEMPOTENCY (SC-009): repeating an identical register/deregister yields an
 *     identical end state.
 *   - DEREGISTER immediate revoke (FR-029, SC-010): worker is evicted + token is
 *     invalidated, and the tenant stops resolving for new runs (tombstoned) while
 *     the footprint is RETAINED (not purged).
 */

import { describe, it, expect } from "bun:test";
import { ok, err } from "@fuguejs/framework";
import { redisUnavailable } from "../../../../domain/host-error.js";
import { handleAdminTenants } from "../../../../http/handlers/admin/tenants.js";
import type { AdminTenantsDeps } from "../../../../http/handlers/admin/tenants.js";
import type { AuthDeps } from "../../../../supervisor/supervisor.js";
import { hashToken } from "../../../../domain/auth.js";
import { tenantId } from "../../../../domain/tenant.js";
import type { TenantId } from "../../../../domain/tenant.js";
import { createRedisTenantRegistry, createInMemoryRedisFake } from "../../../../supervisor/registry/redis-registry-adapter.js";
import type { RedisTenantRegistry } from "../../../../supervisor/registry/redis-registry-adapter.js";
import { createFakeAuditSink } from "../../../../supervisor/audit/audit-sink-log-redis.js";
import type { FakeAuditSink } from "../../../../supervisor/audit/audit-sink-log-redis.js";
import type { WorkerLifecyclePort } from "../../../../supervisor/lifecycle/spawn-port.js";
import type { TokenStorePort, LogPort } from "../../../../ports.js";

const ADMIN_TOKEN = "admin-secret-token";
const silentLog: LogPort = { info: () => {}, warn: () => {}, error: () => {} };

const tid = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`bad id ${s}`);
  return r.value;
};

// ── Fakes ──────────────────────────────────────────────────────────────────────

interface RecordingLifecycle extends WorkerLifecyclePort {
  readonly evicted: readonly TenantId[];
}
const recordingLifecycle = (opts: { failEvict?: boolean } = {}): RecordingLifecycle => {
  const evicted: TenantId[] = [];
  return {
    get evicted() { return evicted as readonly TenantId[]; },
    ensureWorker: async () => ok({ udsPath: "/run/x.sock" }),
    drain: async () => ok(undefined),
    evict: async (t) => { evicted.push(t); return opts.failEvict ? err(redisUnavailable("evict")) : ok(undefined); },
    onCrash: async () => ok(undefined),
    reconcileReadopt: async () => ok({ adopted: [], pruned: [] }),
    liveWorkerCount: () => 0,
    idleEvictSweep: async () => [],
    livenessSweep: async () => [],
  };
};

interface RecordingTokenStore extends TokenStorePort {
  readonly revoked: readonly string[];
}
const recordingTokenStore = (opts: { failRevoke?: boolean } = {}): RecordingTokenStore => {
  const revoked: string[] = [];
  return {
    get revoked() { return revoked as readonly string[]; },
    resolve: async () => ok(null),
    store: async () => ok(undefined),
    listTeams: async () => ok([]),
    revoke: async (team) => { revoked.push(team); return opts.failRevoke ? err(redisUnavailable("revoke")) : ok(undefined); },
  };
};

/** A team-shaped token that resolves to a (non-admin) team identity. */
const TEAM_TOKEN = "fug_team_member_token";

const authDeps = async (): Promise<AuthDeps> => {
  // Wire the auth token store so a `fug_`-shaped token resolves to a TEAM
  // identity — exercising the authenticated-but-NOT-admin (403) path, distinct
  // from an unknown token (401).
  const teamHash = await hashToken(TEAM_TOKEN);
  const authStore: TokenStorePort = {
    resolve: async (h) => ok(String(h) === String(teamHash) ? { team: "intruder-team", label: "intruder" } : null),
    store: async () => ok(undefined),
    listTeams: async () => ok([]),
    revoke: async () => ok(undefined),
  };
  return { adminToken: ADMIN_TOKEN, tokenStore: authStore };
};

interface Harness {
  readonly deps: AdminTenantsDeps;
  readonly registry: RedisTenantRegistry;
  readonly audit: FakeAuditSink;
  readonly lifecycle: RecordingLifecycle;
  readonly tokenStore: RecordingTokenStore;
  now: number;
}

const harness = async (
  opts: { failEvict?: boolean; failRevoke?: boolean; audit?: FakeAuditSink; auditOverride?: AdminTenantsDeps["audit"]; logger?: LogPort } = {},
): Promise<Harness> => {
  const fake = createInMemoryRedisFake();
  const registry = createRedisTenantRegistry(fake.redis, fake.pubsub, {}, silentLog);
  const audit = opts.audit ?? createFakeAuditSink();
  const lifecycle = recordingLifecycle({ failEvict: opts.failEvict });
  const tokenStore = recordingTokenStore({ failRevoke: opts.failRevoke });
  const state = { now: 1_000 };
  const deps: AdminTenantsDeps = {
    auth: await authDeps(),
    registry,
    lifecycle,
    tokenStore,
    audit: opts.auditOverride ?? audit,
    now: () => state.now,
    logger: opts.logger ?? silentLog,
  };
  return {
    deps,
    registry,
    audit,
    lifecycle,
    tokenStore,
    get now() { return state.now; },
    set now(v: number) { state.now = v; },
  };
};

const validBody = (id: string) => ({
  team: `${id}-team`,
  keycloakClientMapping: { realm: "fugue", clientId: `${id}-c`, agentClientIdsByDag: {} },
  fsRoot: `/srv/${id}`,
  secretsRef: `vault://${id}`,
  admission: { maxConcurrentRuns: 2, maxQueuedRuns: 4 },
  eagerPin: false,
});

const req = (
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Request => {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers["Authorization"] = `Bearer ${opts.token}`;
  return new Request(`http://supervisor${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
};

// ── Admin-only authz (SC-008) ───────────────────────────────────────────────────

describe("admin-only authz (FR-026, SC-008)", () => {
  it("rejects an UNAUTHENTICATED register (401) and does not mutate", async () => {
    const h = await harness();
    const res = await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { body: validBody("acme") }));
    expect(res!.status).toBe(401);
    expect(h.registry.snapshot().entries.size).toBe(0);
  });

  it("rejects a NON-ADMIN (team-shaped) token register (403) and does not mutate", async () => {
    const h = await harness();
    const res = await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: TEAM_TOKEN, body: validBody("acme") }));
    expect(res!.status).toBe(403);
    expect(h.registry.snapshot().entries.size).toBe(0);
  });

  it("audits the non-admin refusal (SC-008: refusals are observable)", async () => {
    const h = await harness();
    await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: "wrong", body: validBody("acme") }));
    const refusals = h.audit.records.filter((r) => r.outcome === "refused");
    expect(refusals.length).toBeGreaterThanOrEqual(1);
    expect(refusals[0]!.action).toBe("register");
  });

  it("admits the correct admin token", async () => {
    const h = await harness();
    const res = await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: validBody("acme") }));
    expect(res!.status).toBe(200);
    expect(h.registry.snapshot().entries.size).toBe(1);
  });
});

// ── Audit emission (FR-028, SC-008) ──────────────────────────────────────────────

describe("audit emission (FR-028)", () => {
  it("emits a record with actor/timestamp/tenant/action on register success", async () => {
    const h = await harness();
    h.now = 4242;
    await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: validBody("acme") }));
    const success = h.audit.records.filter((r) => r.outcome === "succeeded");
    expect(success).toHaveLength(1);
    expect(success[0]).toMatchObject({ action: "register", tenant: "acme", timestamp: 4242 });
    expect(success[0]!.actor.kind).toBe("admin");
  });

  it("captures the X-Fugue-Actor label", async () => {
    const h = await harness();
    const r = new Request("http://supervisor/admin/tenants/acme", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "X-Fugue-Actor": "alice@ops" },
      body: JSON.stringify(validBody("acme")),
    });
    await handleAdminTenants(h.deps, r);
    expect(h.audit.records[0]!.actor.label).toBe("alice@ops");
  });
});

// ── Idempotency (SC-009) ─────────────────────────────────────────────────────────

describe("idempotency (SC-009)", () => {
  it("re-registering an identical config yields an identical end state", async () => {
    const h = await harness();
    await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: validBody("acme") }));
    const first = h.registry.snapshot();
    await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: validBody("acme") }));
    const second = h.registry.snapshot();
    expect(second.entries.size).toBe(1);
    // Same committed config (structurally) — register is a no-op the second time.
    expect(second.entries.get(tid("acme"))).toEqual(first.entries.get(tid("acme")));
  });

  it("re-deregistering preserves the original deregisteredAt (no grace-clock bump)", async () => {
    const h = await harness();
    await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: validBody("acme") }));
    h.now = 5_000;
    await handleAdminTenants(h.deps, req("DELETE", "/admin/tenants/acme", { token: ADMIN_TOKEN }));
    const firstEntry = h.registry.snapshot().entries.get(tid("acme"));
    expect(firstEntry?.status).toBe("deregistered");
    const firstAt = firstEntry?.status === "deregistered" ? firstEntry.deregisteredAt : -1;
    expect(firstAt).toBe(5_000);

    h.now = 9_999; // a later retry must NOT bump the grace-window clock
    await handleAdminTenants(h.deps, req("DELETE", "/admin/tenants/acme", { token: ADMIN_TOKEN }));
    const secondEntry = h.registry.snapshot().entries.get(tid("acme"));
    const secondAt = secondEntry?.status === "deregistered" ? secondEntry.deregisteredAt : -1;
    expect(secondAt).toBe(5_000);
  });
});

// ── Deregister immediate-revoke + retain (FR-029, FR-030, SC-010) ────────────────

describe("deregister immediate revoke + grace-window retain (FR-029, SC-010)", () => {
  it("kills the worker AND invalidates the token AND tombstones the tenant", async () => {
    const h = await harness();
    await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: validBody("acme") }));

    const res = await handleAdminTenants(h.deps, req("DELETE", "/admin/tenants/acme", { token: ADMIN_TOKEN }));
    expect(res!.status).toBe(200);

    // FR-029 worker-kill: lifecycle.evict was called for this tenant.
    expect(h.lifecycle.evicted).toEqual([tid("acme")]);
    // FR-029 token-invalidate: the team's token was revoked.
    expect(h.tokenStore.revoked).toEqual(["acme-team"]);

    // SC-010 immediate access revoke: the tenant no longer resolves for new runs.
    expect(h.registry.lookup(tid("acme")).ok).toBe(false);
    expect(h.registry.resolveForNewRun(tid("acme")).ok).toBe(false);

    // FR-030 footprint RETAINED: the registry still holds the tombstone (not purged).
    const entry = h.registry.snapshot().entries.get(tid("acme"));
    expect(entry?.status).toBe("deregistered");
  });

  it("deregistering an absent tenant is an idempotent no-op success", async () => {
    const h = await harness();
    const res = await handleAdminTenants(h.deps, req("DELETE", "/admin/tenants/ghost", { token: ADMIN_TOKEN }));
    expect(res!.status).toBe(200);
  });
});

// ── Routing ──────────────────────────────────────────────────────────────────────

describe("routing", () => {
  it("returns undefined for a non-admin-tenants path (falls through to proxy)", async () => {
    const h = await harness();
    const res = await handleAdminTenants(h.deps, req("POST", "/dags/foo/run", { token: ADMIN_TOKEN }));
    expect(res).toBeUndefined();
  });

  it("405 for an unsupported method on the route", async () => {
    const h = await harness();
    const res = await handleAdminTenants(h.deps, req("GET", "/admin/tenants/acme", { token: ADMIN_TOKEN }));
    expect(res!.status).toBe(405);
  });
});

// ── Deregister revoke-failure branches (C3, FR-029, SC-010) ─────────────────────

describe("deregister revoke-failure is TRUTHFULLY audited (C3, FR-029, SC-008)", () => {
  it("with failing evict AND failing revoke: tombstone lands, 200 + revokeComplete:false, audit outcome=partial naming both halves", async () => {
    const h = await harness({ failEvict: true, failRevoke: true });
    await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: validBody("acme") }));

    const res = await handleAdminTenants(h.deps, req("DELETE", "/admin/tenants/acme", { token: ADMIN_TOKEN }));
    // The HTTP op stays 200 — the tombstone already cut new-run resolution.
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.revokeComplete).toBe(false);
    expect(body.footprintRetained).toBe(true);

    // SC-010 immediate access revoke: still resolves to false (tombstoned).
    expect(h.registry.resolveForNewRun(tid("acme")).ok).toBe(false);
    expect(h.registry.snapshot().entries.get(tid("acme"))?.status).toBe("deregistered");

    // The audit record must NOT lie: it is `partial`, not `succeeded`, and names
    // which halves failed.
    const deregRecords = h.audit.records.filter((r) => r.action === "deregister");
    expect(deregRecords).toHaveLength(1);
    expect(deregRecords[0]!.outcome).toBe("partial");
    expect(deregRecords[0]!.detail).toBe("revoke-incomplete: evict=false token=false");
    // No deregister record ever claims success in this run.
    expect(deregRecords.some((r) => r.outcome === "succeeded")).toBe(false);
  });

  it("with only token-revoke failing: audit is partial naming token (evict=true token=false)", async () => {
    const h = await harness({ failRevoke: true });
    await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: validBody("acme") }));
    const res = await handleAdminTenants(h.deps, req("DELETE", "/admin/tenants/acme", { token: ADMIN_TOKEN }));
    expect(res!.status).toBe(200);
    expect((await res!.json()).revokeComplete).toBe(false);
    const dereg = h.audit.records.filter((r) => r.action === "deregister");
    expect(dereg[0]!.outcome).toBe("partial");
    expect(dereg[0]!.detail).toBe("revoke-incomplete: evict=true token=false");
  });

  it("a clean deregister reports revokeComplete:true and outcome=succeeded", async () => {
    const h = await harness();
    await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: validBody("acme") }));
    const res = await handleAdminTenants(h.deps, req("DELETE", "/admin/tenants/acme", { token: ADMIN_TOKEN }));
    expect((await res!.json()).revokeComplete).toBe(true);
    const dereg = h.audit.records.filter((r) => r.action === "deregister");
    expect(dereg[0]!.outcome).toBe("succeeded");
  });

  it("revokes the team token read from the TOMBSTONE (the team survives the active→deregistered transition)", async () => {
    const h = await harness();
    await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: validBody("acme") }));
    // The tenant is active; the team lives on the tombstone after deregister, and
    // the handler reads it from the POST-deregister snapshot (race-free), not a
    // pre-tombstone read.
    const res = await handleAdminTenants(h.deps, req("DELETE", "/admin/tenants/acme", { token: ADMIN_TOKEN }));
    expect((await res!.json()).revokeComplete).toBe(true);
    // `acme-team` is exactly the team carried on the tombstone (validBody).
    expect(h.tokenStore.revoked).toEqual(["acme-team"]);
  });
});

// ── Deregister success-path audit record fields (FR-028) ────────────────────────

describe("deregister audit-record fields (FR-028)", () => {
  it("carries action/timestamp/tenant/actor on the success path", async () => {
    const h = await harness();
    await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: validBody("acme") }));
    h.now = 777_777;
    const r = new Request("http://supervisor/admin/tenants/acme", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "X-Fugue-Actor": "ops@bob" },
    });
    await handleAdminTenants(h.deps, r);
    const dereg = h.audit.records.filter((rec) => rec.action === "deregister");
    expect(dereg).toHaveLength(1);
    expect(dereg[0]).toMatchObject({ action: "deregister", tenant: "acme", timestamp: 777_777, outcome: "succeeded" });
    expect(dereg[0]!.actor.kind).toBe("admin");
    expect(dereg[0]!.actor.label).toBe("ops@bob");
  });
});

// ── Reconfigure (PATCH) through the HTTP/authz/audit boundary (SC-009, US5) ─────

describe("reconfigure PATCH boundary (SC-009, US5)", () => {
  it("PATCH success on an active tenant: 200 + reconfigure/succeeded audit", async () => {
    const h = await harness();
    await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: validBody("acme") }));
    const next = { ...validBody("acme"), admission: { maxConcurrentRuns: 9, maxQueuedRuns: 9 } };
    const res = await handleAdminTenants(h.deps, req("PATCH", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: next }));
    expect(res!.status).toBe(200);
    const recon = h.audit.records.filter((r) => r.action === "reconfigure");
    expect(recon).toHaveLength(1);
    expect(recon[0]!.outcome).toBe("succeeded");
    // Takes effect on next spawn: the committed config now carries the new ceiling.
    const entry = h.registry.snapshot().entries.get(tid("acme"));
    expect(entry?.status).toBe("active");
    if (entry?.status === "active") expect(entry.admission.maxConcurrentRuns).toBe(9);
  });

  it("PATCH of an unknown tenant fails closed + audits a refusal", async () => {
    const h = await harness();
    const res = await handleAdminTenants(h.deps, req("PATCH", "/admin/tenants/ghost", { token: ADMIN_TOKEN, body: validBody("ghost") }));
    expect(res!.status).toBeGreaterThanOrEqual(400);
    const recon = h.audit.records.filter((r) => r.action === "reconfigure");
    expect(recon).toHaveLength(1);
    expect(recon[0]!.outcome).toBe("refused");
  });

  it("PATCH of a DEREGISTERED tenant fails closed (never resurrects via reconfigure)", async () => {
    const h = await harness();
    await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: validBody("acme") }));
    await handleAdminTenants(h.deps, req("DELETE", "/admin/tenants/acme", { token: ADMIN_TOKEN }));
    const res = await handleAdminTenants(h.deps, req("PATCH", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: validBody("acme") }));
    expect(res!.status).toBeGreaterThanOrEqual(400);
    const recon = h.audit.records.filter((r) => r.action === "reconfigure");
    expect(recon[0]!.outcome).toBe("refused");
  });
});

// ── Malformed body → 400 (advisory: API-correctness) ────────────────────────────

describe("malformed register/reconfigure body → 400 (not 500)", () => {
  it("register with a negative maxConcurrentRuns yields 400", async () => {
    const h = await harness();
    const bad = { ...validBody("acme"), admission: { maxConcurrentRuns: -1, maxQueuedRuns: 4 } };
    const res = await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: bad }));
    expect(res!.status).toBe(400);
    expect(h.registry.snapshot().entries.size).toBe(0);
  });

  it("register with a missing team yields 400", async () => {
    const h = await harness();
    const { team: _team, ...noTeam } = validBody("acme");
    void _team;
    const res = await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: noTeam }));
    expect(res!.status).toBe(400);
  });

  it("register with a missing secretsRef yields 400 (not a later worker-spawn 500) and does not mutate", async () => {
    const h = await harness();
    const { secretsRef: _ref, ...noRef } = validBody("acme");
    void _ref;
    const res = await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: noRef }));
    expect(res!.status).toBe(400);
    expect(h.registry.snapshot().entries.size).toBe(0);
  });

  it("register with a blank secretsRef yields 400 and does not mutate", async () => {
    const h = await harness();
    const bad = { ...validBody("acme"), secretsRef: "   " };
    const res = await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: bad }));
    expect(res!.status).toBe(400);
    expect(h.registry.snapshot().entries.size).toBe(0);
  });

  it("register with a NON-NUMBER admission limit yields 400 (never coerced via Number(...)) and does not mutate", async () => {
    // `Number("5")` → 5, `Number(true)` → 1 would silently accept a malformed limit
    // as a valid-looking ceiling. The boundary rejects a non-number with 400 rather
    // than coercing it (parse-don't-validate parity with the registry deserialize).
    for (const bad of [
      { ...validBody("acme"), admission: { maxConcurrentRuns: "5", maxQueuedRuns: 4 } },
      { ...validBody("acme"), admission: { maxConcurrentRuns: true, maxQueuedRuns: 4 } },
      { ...validBody("acme"), admission: { maxConcurrentRuns: 2, maxQueuedRuns: null } },
      { ...validBody("acme"), admission: { maxConcurrentRuns: 2 } }, // missing → not a number
    ]) {
      const h = await harness();
      const res = await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: bad }));
      expect(res!.status).toBe(400);
      expect(h.registry.snapshot().entries.size).toBe(0);
    }
  });
});

// ── emitAudit never-throw boundary (C4, SC-008) ─────────────────────────────────

describe("emitAudit owns the never-throw boundary (C4, SC-008)", () => {
  const throwingSink = (): AdminTenantsDeps["audit"] => ({
    record: async () => { throw new Error("audit sink down"); },
  });

  it("a throwing sink does not turn a 403 refusal into a 500", async () => {
    const errors: string[] = [];
    const capturingLog: LogPort = { info: () => {}, warn: () => {}, error: (m) => { errors.push(m); } };
    const h = await harness({ auditOverride: throwingSink(), logger: capturingLog });
    const res = await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: TEAM_TOKEN, body: validBody("acme") }));
    expect(res!.status).toBe(403);
    // The audit failure was logged, not propagated.
    expect(errors.some((m) => m.includes("audit sink threw"))).toBe(true);
  });

  it("a throwing sink does not turn a 200 success into a 500", async () => {
    const h = await harness({ auditOverride: throwingSink() });
    const res = await handleAdminTenants(h.deps, req("POST", "/admin/tenants/acme", { token: ADMIN_TOKEN, body: validBody("acme") }));
    expect(res!.status).toBe(200);
    // Despite the sink throwing, the mutation still landed.
    expect(h.registry.snapshot().entries.size).toBe(1);
  });
});

// ── Deregister invariant: tombstone of an active tenant MUST carry a team ────────

describe("deregister tombstone-team invariant (FR-029, SC-008)", () => {
  /**
   * A hand-built `RedisTenantRegistry` whose pre-deregister snapshot reports the
   * tenant ACTIVE, whose `deregister` succeeds, but whose POST-deregister
   * tombstone carries an EMPTY team. This is an invariant violation (the team
   * survives the active→deregistered transition by construction) — the only way
   * to reach the "tombstoned-active but no team to revoke" branch, which must NOT
   * silently skip the security-critical revoke.
   */
  const teamlessTombstoneRegistry = (id: TenantId): RedisTenantRegistry => {
    let deregistered = false;
    const entryFor = (): Record<string, unknown> => ({
      status: deregistered ? "deregistered" : "active",
      id,
      team: "", // <- the invariant-violating empty team on the tombstone
      keycloakClientMapping: { realm: "fugue", clientId: "c", agentClientIdsByDag: {} },
      fsRoot: "/srv/x",
      secretsRef: "vault://x",
      admission: { maxConcurrentRuns: 1, maxQueuedRuns: 1 },
      eagerPin: false,
      ...(deregistered ? { deregisteredAt: 5_000 } : {}),
    });
    const snapshot = () => ({ entries: new Map<TenantId, unknown>([[id, entryFor()]]) });
    return {
      snapshot,
      lookup: () => ok(undefined),
      resolveForNewRun: () => ok(undefined),
      markRedisDegraded: () => {},
      register: async () => ok(undefined),
      deregister: async () => { deregistered = true; return ok(undefined); },
      reconfigure: async () => ok(undefined),
      hardDelete: async () => ok(undefined),
      hydrate: async () => ok(undefined),
    } as unknown as RedisTenantRegistry;
  };

  it("logs an ERROR and reports partial (NOT succeeded) when an active tenant's tombstone has no team — never a silent skip", async () => {
    const base = await harness();
    const errors: string[] = [];
    const capturingLog: LogPort = {
      info: () => {},
      warn: () => {},
      error: (m) => { errors.push(m); },
    };
    const id = tid("acme");
    const deps: AdminTenantsDeps = {
      ...base.deps,
      registry: teamlessTombstoneRegistry(id),
      logger: capturingLog,
    };

    const res = await handleAdminTenants(deps, req("DELETE", "/admin/tenants/acme", { token: ADMIN_TOKEN }));
    expect(res!.status).toBe(200);
    // The revoke half is reported as INCOMPLETE — the missing team is not a
    // silent skip dressed up as success.
    expect((await res!.json()).revokeComplete).toBe(false);

    // The invariant violation was logged at ERROR.
    expect(errors.some((m) => m.includes("INVARIANT VIOLATION"))).toBe(true);

    // The audit record is `partial` (token=false), never `succeeded`.
    const dereg = base.audit.records.filter((r) => r.action === "deregister");
    expect(dereg).toHaveLength(1);
    expect(dereg[0]!.outcome).toBe("partial");
    expect(dereg[0]!.detail).toBe("revoke-incomplete: evict=true token=false");
  });
});

// keep hashToken import referenced (used to confirm team-shaped tokens are non-admin)
void hashToken;
