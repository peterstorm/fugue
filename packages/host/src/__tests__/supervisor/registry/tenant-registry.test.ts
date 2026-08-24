/**
 * Pure-core tests for the tenant registry ADT (FR-022, FR-024, FR-027, SC-009).
 *
 * These exercise the functional core only — no Redis, no clock. Idempotency is
 * pinned both with hand-written cases AND with fast-check property tests over
 * arbitrary action sequences (SC-009 requires identical end state in 100% of
 * repeated register/deregister).
 */

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import { isOk, isErr } from "@fuguejs/framework";
import { tenantId, markSecretsRef } from "../../../domain/tenant.js";
import type { TenantId } from "../../../domain/tenant.js";
import {
  emptyRegistry,
  registryOf,
  tenantConfig,
  register,
  deregister,
  reconfigure,
  lookup,
  retainedEntry,
  activeTenants,
  isActive,
} from "../../../supervisor/registry/tenant-registry.js";
import type {
  ActiveTenantConfig,
  TenantConfigBase,
  TenantRegistry,
} from "../../../supervisor/registry/tenant-registry.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const tid = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`bad test tenant id ${s}`);
  return r.value;
};

const makeConfig = (id: string, overrides: Partial<TenantConfigBase> = {}): ActiveTenantConfig => {
  const r = tenantConfig({
    id: tid(id),
    team: `${id}-team`,
    keycloakClientMapping: {
      realm: "fugue",
      clientId: `${id}-client`,
      agentClientIdsByDag: { "lead-desk": `${id}-agent` },
    },
    fsRoot: `/srv/${id}`,
    dagsRoot: `/dags/${id}`,
    secretsRef: markSecretsRef(`vault://${id}`),
    admission: { maxConcurrentRuns: 4, maxQueuedRuns: 8 },
    eagerPin: false,
    ...overrides,
  });
  if (!r.ok) throw new Error(`bad test config: ${JSON.stringify(r.error)}`);
  return r.value;
};

const seededRegistry = (seed: readonly ActiveTenantConfig[]): TenantRegistry => {
  const parsed = registryOf(seed);
  if (!parsed.ok) throw new Error(`bad registry seed: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
};

// ── Smart constructor (parse-don't-validate) ─────────────────────────────────

describe("tenantConfig parse boundary", () => {
  it("rejects empty team", () => {
    const r = tenantConfig({ ...makeConfig("a"), team: "" });
    expect(isErr(r)).toBe(true);
  });

  it("rejects empty fsRoot", () => {
    const r = tenantConfig({ ...makeConfig("a"), fsRoot: "" });
    expect(isErr(r)).toBe(true);
  });

  it("accepts only this tenant's canonical /srv subtree as fsRoot", () => {
    for (const fsRoot of [
      "srv/a",
      "/",
      "/etc",
      "/srv",
      "/srv/b",
      "/srv/ab",
      "/srv/a/../b",
      "/srv//a",
      "/srv/a\0/etc",
    ]) {
      expect(isErr(tenantConfig({ ...makeConfig("a"), fsRoot }))).toBe(true);
    }
    expect(isOk(tenantConfig({ ...makeConfig("a"), fsRoot: "/srv/a" }))).toBe(true);
    expect(isOk(tenantConfig({ ...makeConfig("a"), fsRoot: "/srv/a/documents" }))).toBe(true);
  });

  it("rejects empty dagsRoot", () => {
    const r = tenantConfig({ ...makeConfig("a"), dagsRoot: "" });
    expect(isErr(r)).toBe(true);
  });

  it("accepts only this tenant's canonical /dags subtree as dagsRoot", () => {
    for (const dagsRoot of [
      "dags/a",
      "/",
      "/tmp/code",
      "/dags",
      "/dags/b",
      "/dags/ab",
      "/dags/a/../b",
      "/dags//a",
      "/dags/a\0/etc",
    ]) {
      expect(isErr(tenantConfig({ ...makeConfig("a"), dagsRoot }))).toBe(true);
    }
    expect(isOk(tenantConfig({ ...makeConfig("a"), dagsRoot: "/dags/a" }))).toBe(true);
    expect(isOk(tenantConfig({ ...makeConfig("a"), dagsRoot: "/dags/a/releases/current" }))).toBe(true);
  });

  it("property: a tenant can never claim another tenant's fs or DAG subtree", () => {
    fc.assert(fc.property(
      fc.constantFrom("a", "b", "c"),
      fc.constantFrom("a", "b", "c"),
      (owner, other) => {
        fc.pre(owner !== other);
        expect(isErr(tenantConfig({ ...makeConfig(owner), fsRoot: `/srv/${other}` }))).toBe(true);
        expect(isErr(tenantConfig({ ...makeConfig(owner), dagsRoot: `/dags/${other}` }))).toBe(true);
      },
    ));
  });

  it("carries dagsRoot onto the constructed active config", () => {
    const r = tenantConfig({ ...makeConfig("a"), dagsRoot: "/dags/a/releases/current" });
    expect(isOk(r)).toBe(true);
    if (r.ok) expect(r.value.dagsRoot).toBe("/dags/a/releases/current");
  });

  it("treats dagsRoot as identity-config — a changed dagsRoot is NOT idempotent", () => {
    // configEquals drives register/reconfigure idempotency; dagsRoot must be part
    // of it, else moving a tenant onto a different DAG bundle would be a silent
    // no-op (the worker would keep serving the old team's DAGs).
    const reg = register(emptyRegistry(), makeConfig("a", { dagsRoot: "/dags/a/bundle-1" }), 1000);
    expect(isOk(reg)).toBe(true);
    if (!reg.ok) return;
    const same = register(reg.value, makeConfig("a", { dagsRoot: "/dags/a/bundle-1" }), 1000);
    expect(same.ok && same.value === reg.value).toBe(true); // identical → same reference
    const moved = register(reg.value, makeConfig("a", { dagsRoot: "/dags/a/bundle-2" }), 1000);
    expect(moved.ok && moved.value !== reg.value).toBe(true); // changed → new registry
  });

  it("rejects negative or non-integer admission limits", () => {
    expect(isErr(tenantConfig({ ...makeConfig("a"), admission: { maxConcurrentRuns: -1, maxQueuedRuns: 0 } }))).toBe(true);
    expect(isErr(tenantConfig({ ...makeConfig("a"), admission: { maxConcurrentRuns: 1.5, maxQueuedRuns: 0 } }))).toBe(true);
  });

  it("does not allow an unparsed structural config to inhabit ActiveTenantConfig", () => {
    const raw: TenantConfigBase = {
      id: tid("unparsed"),
      team: "unparsed-team",
      keycloakClientMapping: { realm: "fugue", clientId: "client", agentClientIdsByDag: {} },
      fsRoot: "/srv/unparsed",
      dagsRoot: "/dags/unparsed",
      secretsRef: markSecretsRef("vault://unparsed"),
      admission: { maxConcurrentRuns: 1, maxQueuedRuns: 1 },
      eagerPin: false,
    };
    // @ts-expect-error — only tenantConfig can mint the private validation brand.
    const forged: ActiveTenantConfig = { ...raw, status: "active" };
    expect(forged.status).toBe("active");
  });

  it("produces an ACTIVE config — status:active, and the active variant carries no tombstone", () => {
    const r = tenantConfig({
      id: tid("a"),
      team: "a-team",
      keycloakClientMapping: { realm: "fugue", clientId: "a-client", agentClientIdsByDag: {} },
      fsRoot: "/srv/a",
      dagsRoot: "/dags/a",
      secretsRef: markSecretsRef("vault://a"),
      admission: { maxConcurrentRuns: 1, maxQueuedRuns: 1 },
      eagerPin: false,
    });
    expect(isOk(r)).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe("active");
      // The active variant has no deregisteredAt field at all (illegal-state-free).
      expect("deregisteredAt" in r.value).toBe(false);
    }
  });
});

// ── register ─────────────────────────────────────────────────────────────────

describe("register", () => {
  it("adds a new tenant", () => {
    const cfg = makeConfig("a");
    const r = register(emptyRegistry(), cfg, 1000);
    expect(isOk(r)).toBe(true);
    if (r.ok) {
      const look = lookup(r.value, cfg.id);
      expect(isOk(look)).toBe(true);
    }
  });

  it("is idempotent — re-registering an identical config returns the SAME registry reference (SC-009)", () => {
    const cfg = makeConfig("a");
    const r1 = register(emptyRegistry(), cfg, 1000);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = register(r1.value, cfg, 2000);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    // Same reference — identical end state, no churn.
    expect(r2.value).toBe(r1.value);
  });

  it("does not expose a mutable backing Map that can bypass registry transitions", () => {
    const cfg = makeConfig("a");
    const registered = register(emptyRegistry(), cfg, 1000);
    if (!registered.ok) throw new Error("setup");
    const forged = makeConfig("b", { team: cfg.team });
    const exposed = registered.value.entries as Map<TenantId, ActiveTenantConfig>;

    expect(exposed.set).toBeUndefined();
    expect(() => exposed.set(forged.id, forged)).toThrow();
    expect(lookup(registered.value, forged.id).ok).toBe(false);
    expect(activeTenants(registered.value)).toEqual([cfg]);
  });

  it("stores a detached config snapshot so later caller mutation cannot bypass invariants", () => {
    const cfg = makeConfig("a");
    const registered = register(emptyRegistry(), cfg, 1000);
    if (!registered.ok) throw new Error("setup");
    const mutable = cfg as unknown as {
      team: string;
      fsRoot: string;
      admission: { maxConcurrentRuns: number };
      keycloakClientMapping: { agentClientIdsByDag: Record<string, string> };
    };

    mutable.team = "forged-team";
    mutable.fsRoot = "/forged";
    mutable.admission.maxConcurrentRuns = 999;
    mutable.keycloakClientMapping.agentClientIdsByDag["lead-desk"] = "forged-agent";

    const stored = lookup(registered.value, cfg.id);
    if (!stored.ok) throw new Error("lookup");
    expect(stored.value.team).toBe("a-team");
    expect(stored.value.fsRoot).toBe("/srv/a");
    expect(stored.value.admission.maxConcurrentRuns).toBe(4);
    expect(stored.value.keycloakClientMapping.agentClientIdsByDag["lead-desk"]).toBe("a-agent");
  });

  it("freezes retrieved configs recursively so casts cannot mutate live registry state", () => {
    const cfg = makeConfig("a");
    const registered = register(emptyRegistry(), cfg, 1000);
    if (!registered.ok) throw new Error("setup");
    const stored = lookup(registered.value, cfg.id);
    if (!stored.ok) throw new Error("lookup");
    const mutable = stored.value as unknown as {
      team: string;
      admission: { maxQueuedRuns: number };
      keycloakClientMapping: { agentClientIdsByDag: Record<string, string> };
    };

    expect(() => { mutable.team = "forged-team"; }).toThrow();
    expect(() => { mutable.admission.maxQueuedRuns = 999; }).toThrow();
    expect(() => { mutable.keycloakClientMapping.agentClientIdsByDag["lead-desk"] = "forged-agent"; }).toThrow();
    expect(lookup(registered.value, cfg.id)).toEqual(stored);
  });

  it("replaces when the config differs", () => {
    const cfg = makeConfig("a");
    const r1 = register(emptyRegistry(), cfg, 1000);
    if (!r1.ok) throw new Error("setup");
    const changed = makeConfig("a", { fsRoot: "/srv/a/new" });
    const r2 = register(r1.value, changed, 2000);
    if (!r2.ok) throw new Error("register");
    const look = lookup(r2.value, cfg.id);
    expect(look.ok && look.value.fsRoot).toBe("/srv/a/new");
  });

  it("revives a deregistered tenant (back to status:active, no tombstone)", () => {
    const cfg = makeConfig("a");
    const r1 = register(emptyRegistry(), cfg, 1000);
    if (!r1.ok) throw new Error("setup");
    const d = deregister(r1.value, cfg.id, 1500);
    if (!d.ok) throw new Error("deregister");
    const tomb = retainedEntry(d.value, cfg.id);
    expect(tomb?.status).toBe("deregistered");
    if (tomb?.status === "deregistered") expect(tomb.deregisteredAt).toBe(1500);
    const r2 = register(d.value, cfg, 2000);
    if (!r2.ok) throw new Error("revive");
    const revived = retainedEntry(r2.value, cfg.id);
    expect(revived?.status).toBe("active");
    expect(lookup(r2.value, cfg.id).ok).toBe(true);
  });
});

// ── team uniqueness (1:1 team↔tenant routing invariant) ──────────────────────

describe("team uniqueness (team↔tenant is 1:1)", () => {
  it("rejects a second ACTIVE tenant claiming a team already owned by another", () => {
    const a = makeConfig("a", { team: "shared" });
    const b = makeConfig("b", { team: "shared" });
    const r1 = register(emptyRegistry(), a, 1000);
    if (!r1.ok) throw new Error("setup");
    const r2 = register(r1.value, b, 2000);
    expect(isErr(r2)).toBe(true);
    if (!isErr(r2)) return;
    // A caller-side team conflict is a 400 (tenant-config-invalid), not a 500
    // (config-invalid, which is reserved for host config-LOAD faults).
    expect(r2.error.kind).toBe("tenant-config-invalid");
  });

  it("does not treat a tenant's OWN team as a conflict (re-register self)", () => {
    const a = makeConfig("a", { team: "shared" });
    const r1 = register(emptyRegistry(), a, 1000);
    if (!r1.ok) throw new Error("setup");
    // Same id + team, a different config field — must still succeed.
    const changed = makeConfig("a", { team: "shared", fsRoot: "/srv/a/2" });
    const r2 = register(r1.value, changed, 2000);
    expect(isOk(r2)).toBe(true);
  });

  it("allows reusing a team once its previous owner is deregistered", () => {
    const a = makeConfig("a", { team: "shared" });
    const r1 = register(emptyRegistry(), a, 1000);
    if (!r1.ok) throw new Error("setup");
    const d = deregister(r1.value, a.id, 1500);
    if (!d.ok) throw new Error("deregister");
    const b = makeConfig("b", { team: "shared" });
    const r2 = register(d.value, b, 2000);
    expect(isOk(r2)).toBe(true);
  });

  it("reconfigure cannot move a tenant onto a team owned by another active tenant", () => {
    const a = makeConfig("a", { team: "team-a" });
    const b = makeConfig("b", { team: "team-b" });
    let reg = register(emptyRegistry(), a, 1000);
    if (!reg.ok) throw new Error("setup a");
    reg = register(reg.value, b, 1100);
    if (!reg.ok) throw new Error("setup b");
    const bMoved = makeConfig("b", { team: "team-a" }); // collide with a's team
    const r = reconfigure(reg.value, bMoved, 2000);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    // Caller-side team conflict → 400 (tenant-config-invalid), not 500.
    expect(r.error.kind).toBe("tenant-config-invalid");
  });
});

// ── deregister ───────────────────────────────────────────────────────────────

describe("registryOf parse boundary", () => {
  it("rejects duplicate active team ownership regardless of seed order", () => {
    const a = makeConfig("a", { team: "shared" });
    const b = makeConfig("b", { team: "shared" });

    for (const seed of [[a, b], [b, a]]) {
      const parsed = registryOf(seed);
      expect(isErr(parsed)).toBe(true);
      if (!parsed.ok) expect(parsed.error.kind).toBe("config-invalid");
    }
  });

  it("allows one active owner when the prior tenant is deregistered", () => {
    const a = makeConfig("a", { team: "shared" });
    const registered = register(emptyRegistry(), a, 1000);
    if (!registered.ok) throw new Error("setup register");
    const deregistered = deregister(registered.value, a.id, 1100);
    if (!deregistered.ok) throw new Error("setup deregister");
    const tombstone = retainedEntry(deregistered.value, a.id);
    if (tombstone === undefined) throw new Error("missing tombstone");

    const parsed = registryOf([tombstone, makeConfig("b", { team: "shared" })]);
    expect(isOk(parsed)).toBe(true);
  });

  it("property: any two distinct active tenant ids sharing a team are rejected", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), (team) => {
        const a = makeConfig("a", { team });
        const b = makeConfig("b", { team });
        expect(isErr(registryOf([a, b]))).toBe(true);
        expect(isErr(registryOf([b, a]))).toBe(true);
      }),
    );
  });
});

// ── deregister ───────────────────────────────────────────────────────────────

describe("deregister", () => {
  it("marks deregisteredAt and RETAINS the entry (deregistered-then-retained)", () => {
    const cfg = makeConfig("a");
    const r1 = register(emptyRegistry(), cfg, 1000);
    if (!r1.ok) throw new Error("setup");
    const d = deregister(r1.value, cfg.id, 1500);
    if (!d.ok) throw new Error("deregister");
    // lookup hides it (fail-closed)…
    expect(isErr(lookup(d.value, cfg.id))).toBe(true);
    // …but the retained entry is still there as the deregistered variant.
    const tomb = retainedEntry(d.value, cfg.id);
    expect(tomb?.status).toBe("deregistered");
    if (tomb?.status === "deregistered") expect(tomb.deregisteredAt).toBe(1500);
  });

  it("deregistering an ABSENT tenant is a no-op success (not an error), same reference", () => {
    const base = emptyRegistry();
    const d = deregister(base, tid("ghost"), 1500);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.value).toBe(base);
  });

  it("is idempotent — repeating deregister preserves the ORIGINAL deregisteredAt (SC-009)", () => {
    const cfg = makeConfig("a");
    const r1 = register(emptyRegistry(), cfg, 1000);
    if (!r1.ok) throw new Error("setup");
    const d1 = deregister(r1.value, cfg.id, 1500);
    if (!d1.ok) throw new Error("d1");
    const d2 = deregister(d1.value, cfg.id, 9999);
    if (!d2.ok) throw new Error("d2");
    // Same reference, and the clock was NOT bumped to 9999.
    expect(d2.value).toBe(d1.value);
    const tomb = retainedEntry(d2.value, cfg.id);
    expect(tomb?.status === "deregistered" && tomb.deregisteredAt).toBe(1500);
  });
});

// ── reconfigure (takes effect on next spawn — registry state only) ───────────

describe("reconfigure", () => {
  it("updates an active tenant's config (effective next spawn)", () => {
    const cfg = makeConfig("a");
    const r1 = register(emptyRegistry(), cfg, 1000);
    if (!r1.ok) throw new Error("setup");
    const changed = makeConfig("a", { admission: { maxConcurrentRuns: 16, maxQueuedRuns: 32 } });
    const r2 = reconfigure(r1.value, changed, 2000);
    if (!r2.ok) throw new Error("reconfigure");
    const look = lookup(r2.value, cfg.id);
    expect(look.ok && look.value.admission.maxConcurrentRuns).toBe(16);
  });

  it("reconfiguring an UNKNOWN tenant fails closed (tenant-unknown)", () => {
    const r = reconfigure(emptyRegistry(), makeConfig("ghost"), 2000);
    expect(isErr(r)).toBe(true);
    if (!r.ok) expect(r.error.kind).toBe("tenant-unknown");
  });

  it("reconfiguring a DEREGISTERED tenant fails closed (never resurrects via reconfigure)", () => {
    const cfg = makeConfig("a");
    const r1 = register(emptyRegistry(), cfg, 1000);
    if (!r1.ok) throw new Error("setup");
    const d = deregister(r1.value, cfg.id, 1500);
    if (!d.ok) throw new Error("deregister");
    const r = reconfigure(d.value, makeConfig("a", { fsRoot: "/srv/a/new" }), 2000);
    expect(isErr(r)).toBe(true);
    if (!r.ok) expect(r.error.kind).toBe("tenant-unknown");
  });

  it("is idempotent — reconfigure with identical config returns the same reference", () => {
    const cfg = makeConfig("a");
    const r1 = register(emptyRegistry(), cfg, 1000);
    if (!r1.ok) throw new Error("setup");
    const r2 = reconfigure(r1.value, cfg, 2000);
    if (!r2.ok) throw new Error("reconfigure");
    expect(r2.value).toBe(r1.value);
  });
});

// ── lookup fail-closed ───────────────────────────────────────────────────────

describe("lookup (fail-closed)", () => {
  it("unknown tenant → tenant-unknown, never a guess", () => {
    const r = lookup(emptyRegistry(), tid("nope"));
    expect(isErr(r)).toBe(true);
    if (!r.ok) expect(r.error.kind).toBe("tenant-unknown");
  });

  it("deregistered tenant resolves as unknown", () => {
    const cfg = makeConfig("a");
    const r1 = register(emptyRegistry(), cfg, 1000);
    if (!r1.ok) throw new Error("setup");
    const d = deregister(r1.value, cfg.id, 1500);
    if (!d.ok) throw new Error("deregister");
    expect(isErr(lookup(d.value, cfg.id))).toBe(true);
  });

  it("activeTenants / isActive exclude deregistered entries", () => {
    let reg = seededRegistry([makeConfig("a"), makeConfig("b")]);
    expect(activeTenants(reg).length).toBe(2);
    const d = deregister(reg, tid("a"), 1500);
    if (!d.ok) throw new Error("deregister");
    reg = d.value;
    expect(activeTenants(reg).length).toBe(1);
    expect(isActive(reg, tid("a"))).toBe(false);
    expect(isActive(reg, tid("b"))).toBe(true);
  });
});

// ── PROPERTY TESTS — idempotency invariants (SC-009) ─────────────────────────

type Action =
  | { kind: "register"; id: string; fsRoot: string }
  | { kind: "deregister"; id: string; now: number }
  | { kind: "reconfigure"; id: string; fsRoot: string };

const idArb = fc.constantFrom("a", "b", "c");

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.record({ kind: fc.constant("register" as const), id: idArb, fsRoot: fc.constantFrom("/r1", "/r2", "/r3") }),
  fc.record({ kind: fc.constant("deregister" as const), id: idArb, now: fc.integer({ min: 1, max: 10_000 }) }),
  fc.record({ kind: fc.constant("reconfigure" as const), id: idArb, fsRoot: fc.constantFrom("/r1", "/r2", "/r3") }),
);

const apply = (reg: TenantRegistry, a: Action, step: number): TenantRegistry => {
  switch (a.kind) {
    case "register": {
      const r = register(reg, makeConfig(a.id, { fsRoot: `/srv/${a.id}${a.fsRoot}` }), step);
      return r.ok ? r.value : reg;
    }
    case "deregister": {
      const r = deregister(reg, tid(a.id), a.now);
      return r.ok ? r.value : reg;
    }
    case "reconfigure": {
      const r = reconfigure(reg, makeConfig(a.id, { fsRoot: `/srv/${a.id}${a.fsRoot}` }), step);
      return r.ok ? r.value : reg;
    }
  }
};

/** Canonical snapshot of registry state for structural-equality comparison. */
const snapshot = (reg: TenantRegistry): string =>
  JSON.stringify(
    Array.from(reg.entries.entries())
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([id, c]) => [id, c.fsRoot, c.status, c.status === "deregistered" ? c.deregisteredAt : null]),
  );

describe("property: idempotency (SC-009)", () => {
  it("repeating any register is a no-op — identical end state", () => {
    fc.assert(
      fc.property(idArb, fc.constantFrom("/x", "/y"), fc.array(actionArb, { maxLength: 20 }), (id, fsRoot, prefix) => {
        // Build an arbitrary base registry.
        let base = emptyRegistry();
        prefix.forEach((a, i) => { base = apply(base, a, i + 1); });
        const cfg = makeConfig(id, { fsRoot: `/srv/${id}${fsRoot}` });
        const once = register(base, cfg, 1000);
        const twice = once.ok ? register(once.value, cfg, 2000) : once;
        expect(once.ok).toBe(true);
        expect(twice.ok).toBe(true);
        if (once.ok && twice.ok) {
          expect(snapshot(twice.value)).toBe(snapshot(once.value));
        }
      }),
    );
  });

  it("repeating any deregister is a no-op — identical end state, clock not bumped", () => {
    fc.assert(
      fc.property(idArb, fc.array(actionArb, { maxLength: 20 }), (id, prefix) => {
        let base = emptyRegistry();
        prefix.forEach((a, i) => { base = apply(base, a, i + 1); });
        const once = deregister(base, tid(id), 5000);
        const twice = once.ok ? deregister(once.value, tid(id), 9999) : once;
        expect(once.ok).toBe(true);
        expect(twice.ok).toBe(true);
        if (once.ok && twice.ok) {
          expect(snapshot(twice.value)).toBe(snapshot(once.value));
        }
      }),
    );
  });

  it("transformations never mutate their input registry", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 30 }), (actions) => {
        let reg = emptyRegistry();
        actions.forEach((a, i) => {
          const before = snapshot(reg);
          const next = apply(reg, a, i + 1);
          // input registry is unchanged regardless of what the action returned
          expect(snapshot(reg)).toBe(before);
          reg = next;
        });
      }),
    );
  });

  it("lookup is fail-closed for every deregistered tenant in any reachable state", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 30 }), (actions) => {
        let reg = emptyRegistry();
        actions.forEach((a, i) => { reg = apply(reg, a, i + 1); });
        for (const [id, cfg] of reg.entries.entries()) {
          const look = lookup(reg, id);
          if (cfg.status === "deregistered") {
            expect(isErr(look)).toBe(true);
          } else {
            expect(isOk(look)).toBe(true);
          }
        }
      }),
    );
  });

  it("the active variant NEVER carries a deregisteredAt in any reachable state (illegal-state-free)", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 30 }), (actions) => {
        let reg = emptyRegistry();
        actions.forEach((a, i) => { reg = apply(reg, a, i + 1); });
        for (const [, cfg] of reg.entries.entries()) {
          if (cfg.status === "active") {
            // No deregisteredAt key exists on an active entry at all.
            expect("deregisteredAt" in cfg).toBe(false);
          } else {
            // The deregistered variant always carries its instant.
            expect(typeof cfg.deregisteredAt).toBe("number");
          }
        }
      }),
    );
  });
});
