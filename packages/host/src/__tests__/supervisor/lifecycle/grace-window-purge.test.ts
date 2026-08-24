/**
 * Grace-window retention + auto-purge (FR-030, SC-010).
 *
 * Covers:
 *   - PURE predicate: the grace window is RETAINED until it elapses, then purge
 *     is due — driven by a SIMULATED `now` (no real clock), so "7 days passed" is
 *     deterministic.
 *   - the default window is 7 days (FR-030).
 *   - `selectPurgeable` returns only deregistered tenants past their window.
 *   - the purge orchestrator revokes ACL, removes the worker registry record,
 *     deletes the keyspace + fs mount, and hard-deletes the registry tombstone —
 *     all idempotent, in order.
 *   - a partial failure is reported (fail-closed) so the sweep retries.
 */

import { describe, it, expect } from "bun:test";
import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../../../domain/host-error.js";
import type { HardDeleteOutcome } from "../../../supervisor/registry/redis-registry-adapter.js";
import { redisUnavailable } from "../../../domain/host-error.js";
import { tenantId, markSecretsRef } from "../../../domain/tenant.js";
import type { TenantId } from "../../../domain/tenant.js";
import { tenantConfig, registryOf } from "../../../supervisor/registry/tenant-registry.js";
import type { ActiveTenantConfig, DeregisteredTenantConfig, TenantConfig, TenantRegistry } from "../../../supervisor/registry/tenant-registry.js";
import {
  DAY_MS,
  DEFAULT_GRACE_WINDOW_MS,
  gracePurgeDueAt,
  isGraceWindowElapsed,
  selectPurgeable,
  purgeTenantFootprint,
  purgeSucceeded,
  runGracePurgeSweep,
} from "../../../supervisor/lifecycle/grace-window-purge.js";
import type { GracePurgeDeps } from "../../../supervisor/lifecycle/grace-window-purge.js";

const tid = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`bad id ${s}`);
  return r.value;
};

const makeActive = (id: string): ActiveTenantConfig => {
  const r = tenantConfig({
    id: tid(id),
    team: `${id}-team`,
    keycloakClientMapping: { realm: "fugue", clientId: `${id}-c`, agentClientIdsByDag: {} },
    fsRoot: `/srv/${id}`,
    dagsRoot: `/dags/${id}`,
    secretsRef: markSecretsRef(`vault://${id}`),
    admission: { maxConcurrentRuns: 1, maxQueuedRuns: 1 },
    eagerPin: false,
  });
  if (!r.ok) throw new Error("bad cfg");
  return r.value;
};

const tombstone = (id: string, deregisteredAt: number): DeregisteredTenantConfig => ({
  ...makeActive(id),
  status: "deregistered",
  deregisteredAt,
});

const seededRegistry = (seed: readonly TenantConfig[]): TenantRegistry => {
  const parsed = registryOf(seed);
  if (!parsed.ok) throw new Error(`bad registry seed: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
};

// ── Fake footprint ports (recorded calls) ─────────────────────────────────────

interface RecordingDeps extends GracePurgeDeps {
  readonly calls: {
    acl: TenantId[];
    workerRegistry: TenantId[];
    keyspace: TenantId[];
    fs: string[];
    registry: TenantId[];
  };
}

/**
 * `live` is the registry view the purge re-reads between steps. It defaults to
 * "exactly the tombstones the purge was launched against", i.e. nothing changed
 * mid-flight; a revival test hands in a view where the tenant is active again.
 */
const recordingDeps = (
  opts: {
    failKeyspace?: boolean;
    failKeyspaceFor?: (t: TenantId) => boolean;
    failAcl?: boolean;
    /** Registry the purge re-reads between steps. Defaults to `seed`. */
    live?: () => TenantRegistry;
    /** Tombstones the purge is being launched against (the unchanged baseline). */
    seed?: readonly TenantConfig[];
    hardDelete?: (tombstone: DeregisteredTenantConfig) => Promise<Result<HardDeleteOutcome, HostError>>;
  } = {},
): RecordingDeps => {
  const calls = { acl: [] as TenantId[], workerRegistry: [] as TenantId[], keyspace: [] as TenantId[], fs: [] as string[], registry: [] as TenantId[] };
  const ksFails = (t: TenantId): boolean => opts.failKeyspace === true || (opts.failKeyspaceFor?.(t) ?? false);
  // Default: the seeded tombstones are still live and unchanged, so the
  // between-step re-check never fires and the test sees the plain purge sequence.
  const baseline = seededRegistry(opts.seed ?? []);
  const live = opts.live ?? ((): TenantRegistry => baseline);
  return {
    calls,
    acl: { revokeAcl: async (t) => { calls.acl.push(t); return opts.failAcl ? err(redisUnavailable("acl")) : ok(undefined); } },
    workerRegistry: { remove: async (t) => { calls.workerRegistry.push(t); return ok(undefined); } },
    keyspace: { purgeKeyspace: async (t) => { calls.keyspace.push(t); return ksFails(t) ? err(redisUnavailable("ks")) : ok(3); } },
    fs: { removeMount: async (root) => { calls.fs.push(root); return ok(undefined); } },
    registry: {
      snapshot: live,
      hardDelete: opts.hardDelete
        ? async (tombstone) => { calls.registry.push(tombstone.id); return opts.hardDelete!(tombstone); }
        : async (tombstone) => { calls.registry.push(tombstone.id); return ok("deleted" as const); },
    },
  };
};

// ── Pure predicates ────────────────────────────────────────────────────────────

describe("grace window default (FR-030)", () => {
  it("is 7 days", () => {
    expect(DEFAULT_GRACE_WINDOW_MS).toBe(7 * DAY_MS);
  });
});

describe("isGraceWindowElapsed (clock-injected, deterministic)", () => {
  const deregAt = 1_000_000;

  it("is RETAINED (not elapsed) during the window", () => {
    expect(isGraceWindowElapsed(deregAt, DEFAULT_GRACE_WINDOW_MS, deregAt)).toBe(false);
    expect(isGraceWindowElapsed(deregAt, DEFAULT_GRACE_WINDOW_MS, deregAt + DAY_MS)).toBe(false);
    expect(isGraceWindowElapsed(deregAt, DEFAULT_GRACE_WINDOW_MS, deregAt + 6 * DAY_MS)).toBe(false);
  });

  it("is purge-DUE once the window elapses (simulate 7 days)", () => {
    expect(isGraceWindowElapsed(deregAt, DEFAULT_GRACE_WINDOW_MS, deregAt + 7 * DAY_MS)).toBe(true);
    expect(isGraceWindowElapsed(deregAt, DEFAULT_GRACE_WINDOW_MS, deregAt + 7 * DAY_MS + 1)).toBe(true);
  });

  it("gracePurgeDueAt = deregisteredAt + window", () => {
    expect(gracePurgeDueAt(deregAt, DEFAULT_GRACE_WINDOW_MS)).toBe(deregAt + DEFAULT_GRACE_WINDOW_MS);
  });
});

describe("selectPurgeable", () => {
  it("returns only deregistered tenants past their window", () => {
    const now = 10_000_000;
    const win = DAY_MS;
    const registry = seededRegistry([
      makeActive("active-one"),
      tombstone("due", now - 2 * DAY_MS),       // past window → purge
      tombstone("in-window", now - 1),          // still in window → retained
    ]);
    const due = selectPurgeable(registry, win, now);
    expect(due.map((c) => c.id)).toEqual([tid("due")]);
  });

  it("never selects an active tenant", () => {
    const registry = seededRegistry([makeActive("a"), makeActive("b")]);
    expect(selectPurgeable(registry, 0, Number.MAX_SAFE_INTEGER)).toHaveLength(0);
  });
});

// ── Purge orchestration ─────────────────────────────────────────────────────────

describe("purgeTenantFootprint (FR-030 footprint reclamation)", () => {
  it("revokes ACL, removes worker registry, purges keyspace + fs, hard-deletes registry", async () => {
    const cfg = tombstone("acme", 0);
    const deps = recordingDeps({ seed: [cfg] });
    const outcome = await purgeTenantFootprint(deps, cfg);
    expect(purgeSucceeded(outcome)).toBe(true);
    expect(outcome.kind === "completed" ? outcome.failedSteps : null).toEqual([]);
    expect(deps.calls.acl).toEqual([tid("acme")]);
    expect(deps.calls.workerRegistry).toEqual([tid("acme")]);
    expect(deps.calls.keyspace).toEqual([tid("acme")]);
    expect(deps.calls.fs).toEqual(["/srv/acme"]);
    expect(deps.calls.registry).toEqual([tid("acme")]);
    expect(outcome.keysDeleted).toBe(3);
  });

  it("reports a partial failure with the REAL typed failed step (fail-closed) so the sweep retries", async () => {
    const cfg = tombstone("acme", 0);
    const deps = recordingDeps({ failKeyspace: true, seed: [cfg] });
    const outcome = await purgeTenantFootprint(deps, cfg);
    expect(purgeSucceeded(outcome)).toBe(false);
    // The genuine typed failed step is preserved — never a "see-error" placeholder.
    expect(outcome.kind === "completed" ? outcome.failedSteps : null).toEqual(["keyspace-purge"]);
    // keysDeleted from a failed keyspace step is 0; the successful steps still ran.
    expect(outcome.keysDeleted).toBe(0);
    // Even with one failed step, every OTHER step was still attempted (idempotent).
    expect(deps.calls.acl).toHaveLength(1);
    expect(deps.calls.registry).toHaveLength(1);
  });
});

describe("purgeTenantFootprint — tenant revived mid-purge (FR-030 race)", () => {
  it("ABANDONS the purge as soon as the tombstone it observed is no longer live", async () => {
    const cfg = tombstone("acme", 0);
    // The registry the purge re-reads shows the tenant ACTIVE again: an admin
    // revived it after the sweep sampled the tombstone.
    const revived = seededRegistry([makeActive("acme")]);
    const deps = recordingDeps({ live: () => revived });

    const outcome = await purgeTenantFootprint(deps, cfg);

    expect(outcome.kind).toBe("superseded");
    expect(purgeSucceeded(outcome)).toBe(false);
    expect(outcome.kind === "superseded" ? outcome.abortedAt : null).toBe("acl-revoke");
    // NOTHING destructive ran against the live tenant.
    expect(deps.calls.acl).toEqual([]);
    expect(deps.calls.workerRegistry).toEqual([]);
    expect(deps.calls.keyspace).toEqual([]);
    expect(deps.calls.fs).toEqual([]);
    expect(deps.calls.registry).toEqual([]);
  });

  it("reports `superseded` when the revival is only caught by the final compare-and-delete", async () => {
    const cfg = tombstone("acme", 0);
    // The between-step re-check sees an unchanged tombstone (the revival lands
    // after step 4), so only the atomic compare-and-delete can catch it — the
    // case the registry adapter's guard exists for.
    const deps = recordingDeps({
      seed: [cfg],
      hardDelete: async () => ok("superseded" as const),
    });

    const outcome = await purgeTenantFootprint(deps, cfg);

    expect(outcome.kind).toBe("superseded");
    expect(outcome.kind === "superseded" ? outcome.abortedAt : null).toBe("registry-hard-delete");
    // The earlier steps DID run — this is the window the compare-and-delete
    // narrows but cannot retroactively undo; it is the permanent step it closes.
    expect(deps.calls.acl).toEqual([tid("acme")]);
    expect(deps.calls.registry).toEqual([tid("acme")]);
  });

  it("a superseded purge is NOT retried by the sweep and is logged as a revival", async () => {
    const now = 10_000_000;
    const registry = seededRegistry([tombstone("due", now - 2 * DAY_MS)]);
    const revived = seededRegistry([makeActive("due")]);
    const deps = recordingDeps({ live: () => revived });
    const warnings: Array<{ msg: string; data?: Record<string, unknown> }> = [];
    const capturingLog = {
      info: () => {},
      warn: (msg: string, data?: Record<string, unknown>) => { warnings.push({ msg, ...(data ? { data } : {}) }); },
      error: () => {},
    };

    const outcomes = await runGracePurgeSweep(deps, registry, DAY_MS, now, capturingLog);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.kind).toBe("superseded");
    const warn = warnings.find((w) => w.msg.includes("revived"));
    expect(warn).toBeDefined();
    expect(warn!.data?.abortedAt).toBe("acl-revoke");
  });
});

describe("runGracePurgeSweep (SC-010 retain-then-purge)", () => {
  it("purges only the due tenant; retains the in-window one", async () => {
    const now = 10_000_000;
    const win = DAY_MS;
    const registry = seededRegistry([
      makeActive("active"),
      tombstone("due", now - 2 * DAY_MS),
      tombstone("retained", now - 1),
    ]);
    const deps = recordingDeps({ live: () => registry });
    const outcomes = await runGracePurgeSweep(deps, registry, win, now);
    expect(outcomes.map((o) => o.tenant)).toEqual([tid("due")]);
    // The retained tenant's footprint was NOT touched (still in grace window).
    expect(deps.calls.acl).toEqual([tid("due")]);
    expect(deps.calls.registry).toEqual([tid("due")]);
  });

  it("aggregates per-tenant outcomes losslessly: continues past a partially-failing tenant, preserving REAL typed failedSteps + keysDeleted (C5, SC-010)", async () => {
    const now = 10_000_000;
    const win = DAY_MS;
    // `due-bad`'s keyspace purge persistently fails; `due-ok` purges cleanly.
    const registry = seededRegistry([
      tombstone("due-ok", now - 2 * DAY_MS),
      tombstone("due-bad", now - 2 * DAY_MS),
      tombstone("retained", now - 1),
    ]);
    const deps = recordingDeps({ failKeyspaceFor: (t) => t === tid("due-bad"), live: () => registry });
    const warnings: Array<{ msg: string; data?: Record<string, unknown> }> = [];
    const capturingLog = {
      info: () => {},
      warn: (msg: string, data?: Record<string, unknown>) => { warnings.push({ msg, ...(data ? { data } : {}) }); },
      error: () => {},
    };

    const outcomes = await runGracePurgeSweep(deps, registry, win, now, capturingLog);

    // The sweep did NOT abort on the failing tenant — both due tenants are present.
    expect(outcomes.map((o) => o.tenant).sort()).toEqual([tid("due-bad"), tid("due-ok")].sort());

    const okOutcome = outcomes.find((o) => o.tenant === tid("due-ok"))!;
    const badOutcome = outcomes.find((o) => o.tenant === tid("due-bad"))!;

    // The clean tenant is fully purged with its real keysDeleted preserved.
    expect(purgeSucceeded(okOutcome)).toBe(true);
    expect(okOutcome.kind === "completed" ? okOutcome.failedSteps : null).toEqual([]);
    expect(okOutcome.keysDeleted).toBe(3);

    // The failing tenant carries the GENUINE typed failed step — never ["see-error"].
    expect(purgeSucceeded(badOutcome)).toBe(false);
    expect(badOutcome.kind === "completed" ? badOutcome.failedSteps : null).toEqual(["keyspace-purge"]);
    expect(badOutcome.keysDeleted).toBe(0);

    // The retained (in-window) tenant was never touched.
    expect(deps.calls.acl).not.toContain(tid("retained"));

    // The persistently-stuck step is surfaced via a warn so it is observable.
    const stuckWarn = warnings.find((w) => (w.data?.tenant as TenantId | undefined) === tid("due-bad"));
    expect(stuckWarn).toBeDefined();
    expect(stuckWarn!.data?.failedSteps).toEqual(["keyspace-purge"]);
  });

  it("propagates the REAL failed step + keysDeleted from the sweep — a DIFFERENT failing step (acl-revoke) proves it is not hardcoded to one step or a 'see-error' placeholder (SC-010)", async () => {
    const now = 10_000_000;
    const win = DAY_MS;
    // Fail a DIFFERENT step than keyspace — the sweep must surface the genuine
    // typed step name, and the keysDeleted from the step that DID run.
    const registry = seededRegistry([tombstone("due", now - 2 * DAY_MS)]);
    const deps = recordingDeps({ failAcl: true, live: () => registry });
    const warnings: Array<{ msg: string; data?: Record<string, unknown> }> = [];
    const capturingLog = {
      info: () => {},
      warn: (msg: string, data?: Record<string, unknown>) => { warnings.push({ msg, ...(data ? { data } : {}) }); },
      error: () => {},
    };

    const outcomes = await runGracePurgeSweep(deps, registry, win, now, capturingLog);

    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0]!;
    // The GENUINE typed failed step is propagated — not "see-error", not collapsed.
    expect(outcome.kind === "completed" ? outcome.failedSteps : null).toEqual(["acl-revoke"]);
    expect(purgeSucceeded(outcome)).toBe(false);
    // keyspace-purge still ran (every other step is attempted), so the REAL
    // keysDeleted survives into the sweep outcome.
    expect(outcome.keysDeleted).toBe(3);
    // The warn carries the real failed step + keysDeleted (SC-010 observability).
    const warn = warnings.find((w) => (w.data?.tenant as TenantId | undefined) === tid("due"));
    expect(warn).toBeDefined();
    expect(warn!.data?.failedSteps).toEqual(["acl-revoke"]);
    expect(warn!.data?.keysDeleted).toBe(3);
  });
});
