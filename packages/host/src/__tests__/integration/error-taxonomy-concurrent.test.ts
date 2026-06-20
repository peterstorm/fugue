/**
 * Integration — Per-tenant error taxonomy under CONCURRENT load (T12.4).
 *
 * Four tenants, four distinct fault classes, exercised simultaneously:
 *   - `over` — over its OWN admission ceiling → 429 + Retry-After (per-tenant).
 *   - `sick` — admitted, but its worker is unhealthy/unavailable → 503.
 *   - `ghost` — unknown/unauthorized (no registered tenant) → 404 (non-leaking).
 *   - `healthy` — fully provisioned, under quota, live worker → 200.
 *
 * Asserts the EXACT status taxonomy AND, critically, that in ZERO cases does one
 * tenant's failure surface as another tenant's error — verified by interleaving
 * the four request classes concurrently and checking every response is the status
 * for ITS OWN tenant, with non-leaking bodies (a 429 names only its own tenant; a
 * 404 names no tenant at all).
 *
 * Admission uses the REAL per-tenant `admitTenant` ADT (`supervisor/admission.ts`)
 * so the over-quota 429 is produced by the genuine ceiling check, not a stubbed
 * decision. The over tenant's ceiling is pre-saturated; the others are not, so a
 * saturated tenant can NEVER consume another's slot (FR-032/SC-011).
 *
 * @satisfies SC-012 — over-quota→429+Retry-After, unhealthy-worker→503,
 *   unknown/unauthorized→404/401; ZERO cross-tenant error bleed, under concurrency.
 */

import { describe, test, expect } from "bun:test";
import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { createSupervisor } from "../../supervisor/supervisor.js";
import type { AuthDeps, AdmissionPort, AdmissionOutcome, SupervisorDeps } from "../../supervisor/supervisor.js";
import type { UdsTransport } from "../../supervisor/uds-proxy.js";
import { markTenant, tenantId, markSecretsRef } from "../../domain/tenant.js";
import type { Tenant, TenantId, TenantRegistryView } from "../../domain/tenant.js";
import type { AdmissionDecision } from "../../supervisor/routing.js";
import type { EnsuredWorker, WorkerLifecyclePort } from "../../supervisor/lifecycle/spawn-port.js";
import type { HostError } from "../../domain/host-error.js";
import { workerUnavailable } from "../../domain/host-error.js";
import type { HostConfig } from "../../domain/config.js";
import { workerSocketPath } from "../../domain/config.js";
import type { TokenStorePort, LogPort, RedisConnectivityPort } from "../../ports.js";
import { hashToken } from "../../domain/auth.js";
import {
  initTenantConcurrency,
  withTenantLimit,
  admitTenant,
  releaseTenant,
  type TenantConcurrencyState,
} from "../../supervisor/admission.js";

const KEY = "internal-hmac-not-a-secret";
const UDS_DIR = "/run/fugue";
const silentLog: LogPort = { info: () => {}, warn: () => {}, error: () => {} };

const tid = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`bad tenant id ${s}`);
  return r.value;
};
const makeTenant = (id: string): Tenant => markTenant(tid(id), `${id}-team`);
const aliveRedis: RedisConnectivityPort = { ping: async () => ok(undefined) };

const baseConfig = {
  PORT: 0,
  WORKER_UDS_DIR: UDS_DIR,
  FUGUE_SUPERVISOR_HMAC_KEY: KEY,
  REDIS_PROBE_INTERVAL_MS: 1_000_000,
} as unknown as HostConfig;

const tokenStoreFor = async (tenants: readonly Tenant[]): Promise<TokenStorePort> => {
  const byHash: Record<string, { team: string; label: string }> = {};
  for (const t of tenants) {
    const hash = (await hashToken(`fug_${t.id}`)) as unknown as string;
    byHash[hash] = { team: t.team, label: t.id };
  }
  return {
    resolve: async (hash) => ok(byHash[hash as unknown as string] ?? null),
    store: async () => ok(undefined),
    listTeams: async () => ok([]),
    revoke: async () => ok(undefined),
  };
};

const runFor = (id: string) =>
  new Request("http://host/runs/dag1", {
    method: "POST",
    headers: { Authorization: `Bearer fug_${id}` },
    body: "{}",
  });

describe("Integration — per-tenant error taxonomy under concurrency (SC-012)", () => {
  test("over-quota→429+Retry-After, unhealthy→503, unknown→404, healthy→200, with ZERO cross-tenant bleed", async () => {
    const over = makeTenant("over");
    const sick = makeTenant("sick");
    const healthy = makeTenant("healthy");
    // `ghost` is registered as a token→team but maps to NO registered tenant in
    // the registry view → resolveTenant fails closed (unknown/unauthorized → 404).
    const ghost = makeTenant("ghost");

    const registered = [over, sick, healthy]; // ghost intentionally absent
    const allTokens = [over, sick, healthy, ghost];

    // ── REAL per-tenant admission state ─────────────────────────────────────
    // `over` has a ceiling of 1 and is pre-saturated (one slot held); the others
    // have generous ceilings. The clock is injected (pure ADT) — use a counter.
    let now = 0;
    let admissionState: TenantConcurrencyState = initTenantConcurrency({
      defaultTenantMax: 1000,
      retryAfterSeconds: 17, // distinctive per-tenant backoff to assert on
    });
    admissionState = withTenantLimit(admissionState, over.id, 1);
    // Pre-saturate `over`: hold one slot so the NEXT admit for `over` is at-ceiling.
    const sat = admitTenant(admissionState, over.id, now++);
    if (!sat.ok) throw new Error("failed to saturate over-tenant");
    admissionState = sat.value.state;

    // The admission PORT folds the real ADT: admit → acquire a slot (or refuse),
    // release → free it. Synchronous read-modify-write under Bun's single thread.
    const admission: AdmissionPort = {
      admit: (t): AdmissionOutcome => {
        const r = admitTenant(admissionState, t.id, now++);
        if (!r.ok) {
          // Map the real HostError to the routing AdmissionDecision.
          const decision: AdmissionDecision =
            r.error.kind === "tenant-over-quota"
              ? { kind: "over-quota", retryAfterSeconds: r.error.retryAfterSeconds }
              : r.error.kind === "worker-unavailable"
                ? { kind: "unavailable" }
                : { kind: "unknown" };
          return { decision, release: () => {} };
        }
        admissionState = r.value.state;
        const token = r.value.token;
        let released = false;
        return {
          decision: { kind: "admitted" },
          release: () => {
            if (released) return;
            released = true;
            admissionState = releaseTenant(admissionState, token);
          },
        };
      },
    };

    // ── Lifecycle: `sick`'s worker is unavailable (503); others are live. ────
    const lifecycle: WorkerLifecyclePort = {
      ensureWorker: async (t): Promise<Result<EnsuredWorker, HostError>> =>
        (t as unknown as string) === sick.id
          ? err(workerUnavailable(t))
          : ok({ udsPath: workerSocketPath(UDS_DIR, t) }),
      drain: async () => ok(undefined),
      evict: async () => ok(undefined),
      onCrash: async () => ok(undefined),
      reconcileReadopt: async () => ok({ adopted: [], pruned: [] }),
      liveWorkerCount: () => registered.length,
      idleEvictSweep: async () => [],
      livenessSweep: async () => [],
    };

    const registryView: TenantRegistryView = {
      tenantForTeam: (team) => registered.find((t) => t.team === team),
    };

    const transport: UdsTransport = async (socketPath) => {
      const tenant = socketPath.slice(`${UDS_DIR}/`.length, -".sock".length);
      return ok(new Response(JSON.stringify({ runId: `run-${tenant}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    };

    const deps: SupervisorDeps = {
      config: baseConfig,
      redis: aliveRedis,
      auth: { adminToken: "admin", tokenStore: await tokenStoreFor(allTokens), logger: silentLog } satisfies AuthDeps,
      registryView,
      admission,
      lifecycle,
      transport,
      logger: silentLog,
    };

    const sup = await createSupervisor(deps);
    expect(sup.ok).toBe(true);
    if (!sup.ok) return;

    try {
      const expected: Record<string, number> = {
        [over.id]: 429,
        [sick.id]: 503,
        [ghost.id]: 404,
        [healthy.id]: 200,
      };

      // ── CONCURRENT interleave: many overlapping requests across all four
      //    classes at once. Each response must be the status for ITS OWN tenant.
      const ROUNDS = 40;
      const jobs: Promise<{ id: string; status: number; retryAfter: string | null; body: string }>[] = [];
      for (let i = 0; i < ROUNDS; i++) {
        for (const id of [over.id, sick.id, ghost.id, healthy.id]) {
          jobs.push(
            sup.value.handle(runFor(id)).then(async (r) => ({
              id,
              status: r.status,
              retryAfter: r.headers.get("Retry-After"),
              body: await r.text(),
            })),
          );
        }
      }
      const results = await Promise.all(jobs);

      // Every response carries the EXACT status for its OWN tenant — ZERO bleed.
      for (const r of results) {
        expect(r.status).toBe(expected[r.id]);
      }

      // Taxonomy detail assertions.
      const overResults = results.filter((r) => r.id === over.id);
      expect(overResults.every((r) => r.status === 429)).toBe(true);
      // 429 carries the per-tenant Retry-After (FR-038).
      expect(overResults.every((r) => r.retryAfter === "17")).toBe(true);
      // The over-quota body names ONLY its own tenant — never another's (FR-041).
      for (const r of overResults) {
        expect(r.body).toContain(over.id);
        expect(r.body).not.toContain(sick.id);
        expect(r.body).not.toContain(healthy.id);
        expect(r.body).not.toContain(ghost.id);
      }

      const sickResults = results.filter((r) => r.id === sick.id);
      expect(sickResults.every((r) => r.status === 503)).toBe(true);
      expect(sickResults.every((r) => r.retryAfter === "5")).toBe(true);

      const ghostResults = results.filter((r) => r.id === ghost.id);
      expect(ghostResults.every((r) => r.status === 404)).toBe(true);
      // 404 (tenant-unknown) is non-leaking: names NO tenant at all.
      for (const r of ghostResults) {
        for (const t of [over, sick, healthy]) expect(r.body).not.toContain(t.id);
        expect(r.body).toContain("not found");
      }

      const healthyResults = results.filter((r) => r.id === healthy.id);
      expect(healthyResults.every((r) => r.status === 200)).toBe(true);
      // The healthy tenant was NEVER starved by `over`'s saturation (SC-011):
      // every one of its concurrent runs was admitted + proxied.
      expect(healthyResults.length).toBe(ROUNDS);
    } finally {
      await sup.value.shutdown();
    }
  });
});
