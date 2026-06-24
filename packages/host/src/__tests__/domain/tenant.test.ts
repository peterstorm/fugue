/**
 * Tests for the `Tenant` security principal and the identity→tenant boundary
 * parse (`domain/tenant.ts`).
 *
 * Covers (per the plan's testing matrix for `tenant.ts`):
 *   - brand resolution rules: a resolved `Tenant` always maps to a REGISTERED
 *     id (property), and is the tenant for the caller's own team (US3).
 *   - unknown → `tenant-unknown`, UNIFORMLY (no leakage: FR-040) — admin, user,
 *     and unregistered-team identities all resolve to the SAME error shape.
 *   - forgery-resistance: `tenantId` rejects ids that could widen a Redis
 *     key/ACL namespace (`:` or glob metacharacters), which is load-bearing for
 *     AD-4 / SC-001.
 */

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import { isOk, isErr } from "@fuguejs/framework";
import {
  tenantId,
  markTenant,
  markSecretsRef,
  resolveTenant,
  TENANT_ID_REGEX,
  RESERVED_TENANT_IDS,
  isReservedTenantId,
  type Tenant,
  type TenantId,
  type TenantRegistryView,
} from "../../domain/tenant.js";
import { type AuthIdentity } from "../../domain/auth.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a registry view from a team→tenant map (pure, in-memory). */
const registryOf = (entries: Record<string, Tenant>): TenantRegistryView => ({
  tenantForTeam: (team) =>
    Object.prototype.hasOwnProperty.call(entries, team) ? entries[team] : undefined,
});

const mkTenant = (id: string, team: string): Tenant =>
  markTenant(id as unknown as TenantId, team);

const adminIdentity: AuthIdentity = { kind: "admin" };
const teamIdentity = (team: string): AuthIdentity => ({ kind: "team", team, label: "ci" });
const userIdentity = (allowed: readonly string[]): AuthIdentity => ({
  kind: "user",
  sub: "user-1",
  azp: "frontend",
  canRunDag: (dagTeam) => allowed.includes(dagTeam),
});

// ── tenantId smart constructor (forgery-resistance) ──────────────────────────

describe("tenantId", () => {
  it("accepts a well-formed id", () => {
    const r = tenantId("acme-corp_1");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe("acme-corp_1" as TenantId);
  });

  it.each([
    ["a colon (Redis key delimiter)", "acme:evil"],
    ["a glob star (would widen the ACL pattern)", "acme*"],
    ["a glob question mark", "ac?me"],
    ["a glob bracket", "acme[0]"],
    ["whitespace", "acme corp"],
    ["empty string", ""],
    ["over 64 chars", "a".repeat(65)],
    ["a slash", "acme/evil"],
  ])("rejects an id with %s", (_desc, raw) => {
    const r = tenantId(raw);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("config-invalid");
  });

  it("the regex forbids `:` and glob metacharacters (the AD-4 key/ACL-scoping invariant)", () => {
    for (const ch of [":", "*", "?", "[", "]", "/", " "]) {
      expect(TENANT_ID_REGEX.test(`acme${ch}`)).toBe(false);
    }
  });

  it("property: any accepted id is safe to interpolate into a fugue:<tenant>:* prefix without escaping", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const r = tenantId(raw);
        if (!isOk(r)) return; // only assert about accepted ids
        const id = r.value;
        // An accepted id must contain neither the key delimiter nor any glob
        // metacharacter — otherwise `~fugue:<id>:*` could match another tenant.
        expect(id.includes(":")).toBe(false);
        for (const ch of ["*", "?", "[", "]"]) expect(id.includes(ch)).toBe(false);
      }),
    );
  });

  it("property: tenantId(s) is Ok ⟺ TENANT_ID_REGEX.test(s) — both sides, over a char set that INCLUDES forbidden chars", () => {
    // A char arbitrary that mixes allowed chars with the EXACT forbidden ones
    // (`:`, glob metas, slash, whitespace) at meaningful density, so the
    // REJECTION side is exercised — not just the accept side. Strings are
    // length 0..70 to also hit the empty-string and >64 boundaries.
    const charArb = fc.constantFrom(
      ..."abcXYZ09_-".split(""), // allowed
      ..."*?[]/: \t\n".split(""), // forbidden: glob metas, slash, colon, whitespace
    );
    fc.assert(
      fc.property(
        fc.array(charArb, { minLength: 0, maxLength: 70 }).map((cs) => cs.join("")),
        (s) => {
          const accepted = isOk(tenantId(s));
          // The smart constructor accepts a string iff it is shape-valid AND not a
          // reserved control-plane namespace — no fail-open gap on either side.
          const valid = TENANT_ID_REGEX.test(s) && !isReservedTenantId(s);
          expect(accepted).toBe(valid);
        },
      ),
    );
  });
});

// ── Reserved control-plane namespaces (cross-tenant isolation) ───────────────

describe("reserved tenant ids (control-plane namespace collision)", () => {
  it("RESERVED_TENANT_IDS covers the control-plane namespace roots", () => {
    // These are the segments that appear immediately after `fugue:` in
    // NON-tenant-scoped keys/channels. A drift-guard against the actual adapter
    // prefixes lives in import-boundaries.test.ts (boundary E).
    expect(RESERVED_TENANT_IDS.has("tenants")).toBe(true);
    expect(RESERVED_TENANT_IDS.has("supervisor")).toBe(true);
  });

  it.each([
    ["the tenant-registry namespace", "tenants"],
    ["the supervisor-state namespace", "supervisor"],
    ["a reserved id in different casing (case-insensitive)", "Tenants"],
    ["a reserved id upper-cased", "SUPERVISOR"],
  ])("tenantId REJECTS %s — its ~fugue:<id>:* ACL would overlap control-plane keys", (_desc, raw) => {
    const r = tenantId(raw);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("config-invalid");
      // The message names the overlap reason (not just a shape failure), so a
      // misconfigured GitOps id is diagnosable.
      expect(r.error).toHaveProperty("message");
      if ("message" in r.error) expect(r.error.message).toMatch(/reserved control-plane/i);
    }
  });

  it("a reserved id is SHAPE-valid yet still rejected (it passes the regex)", () => {
    // This is exactly why the regex alone is insufficient: `tenants` matches
    // TENANT_ID_REGEX, so without the reserved-id check it would mint a colliding
    // principal.
    expect(TENANT_ID_REGEX.test("tenants")).toBe(true);
    expect(isReservedTenantId("tenants")).toBe(true);
    expect(isErr(tenantId("tenants"))).toBe(true);
  });

  it("markTenant THROWS on a reserved (cast) id — closes the fail-open gate (defense-in-depth)", () => {
    // Simulates a producer that bypassed tenantId() with a cast. A `tenants`
    // principal would get the ACL pattern `~fugue:tenants:*`, overlapping every
    // other tenant's `fugue:tenants:<id>` config record, so markTenant must refuse.
    expect(() => markTenant("tenants" as unknown as TenantId, "tenants")).toThrow();
    try {
      markTenant("supervisor" as unknown as TenantId, "supervisor");
      throw new Error("expected markTenant to throw");
    } catch (e) {
      expect((e as { kind?: string }).kind).toBe("internal-invariant-violated");
    }
  });
});

// ── markTenant (internal-invariant enforcement) ──────────────────────────────

describe("markTenant", () => {
  it("brands a well-formed (id, team) pair", () => {
    const t = markTenant("acme" as TenantId, "acme");
    expect(t.id).toBe("acme" as TenantId);
    expect(t.team).toBe("acme");
  });

  it("THROWS on a regex-violating (cast) id — closes the fail-open gate for the T3 registry", () => {
    // Simulates a producer that bypassed tenantId()'s smart constructor with a
    // cast. A `:` would let the id widen its own fugue:<tenant>:* ACL namespace,
    // so markTenant must refuse to mint the principal.
    expect(() => markTenant("acme:evil" as unknown as TenantId, "acme")).toThrow();
    // The thrown value is the internal-invariant HostError (greppable kind).
    try {
      markTenant("acme*" as unknown as TenantId, "acme");
      throw new Error("expected markTenant to throw");
    } catch (e) {
      expect((e as { kind?: string }).kind).toBe("internal-invariant-violated");
    }
  });

  it("property: markTenant throws for EVERY id the regex rejects", () => {
    const charArb = fc.constantFrom(
      ..."abc09_-".split(""),
      ..."*?[]/: ".split(""),
    );
    fc.assert(
      fc.property(
        fc.array(charArb, { minLength: 0, maxLength: 70 }).map((cs) => cs.join("")),
        (s) => {
          const valid = TENANT_ID_REGEX.test(s) && !isReservedTenantId(s);
          if (valid) {
            expect(() => markTenant(s as TenantId, "team")).not.toThrow();
          } else {
            expect(() => markTenant(s as unknown as TenantId, "team")).toThrow();
          }
        },
      ),
    );
  });
});

// ── resolveTenant (boundary parse) ───────────────────────────────────────────

describe("resolveTenant", () => {
  const acme = mkTenant("acme", "acme");
  const registry = registryOf({ acme });

  it("resolves a team identity to the tenant for its team", () => {
    const r = resolveTenant(teamIdentity("acme"), registry);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.id).toBe("acme" as TenantId);
      expect(r.value.team).toBe("acme");
    }
  });

  it("returns tenant-unknown for a team that maps to no registered tenant", () => {
    const r = resolveTenant(teamIdentity("ghost"), registry);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("tenant-unknown");
  });

  it("returns tenant-unknown for an admin identity (not a routed tenant principal)", () => {
    const r = resolveTenant(adminIdentity, registry);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("tenant-unknown");
  });

  it("returns tenant-unknown for a user identity (resolved from run target, not identity)", () => {
    const r = resolveTenant(userIdentity(["acme"]), registry);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("tenant-unknown");
  });

  it("NON-LEAKAGE (FR-040): unknown-team, admin, and user all yield the SAME error shape", () => {
    const errors = [
      resolveTenant(teamIdentity("ghost"), registry),
      resolveTenant(adminIdentity, registry),
      resolveTenant(userIdentity([]), registry),
    ];
    for (const r of errors) {
      expect(isErr(r)).toBe(true);
      if (isErr(r)) {
        // Identical, tenant-agnostic — no field distinguishes "no such tenant"
        // from "not your tenant", and nothing names another tenant.
        expect(r.error).toEqual({ kind: "tenant-unknown" });
      }
    }
  });

  it("does not resolve via Object.prototype keys (no prototype-pollution lookup)", () => {
    const r = resolveTenant(teamIdentity("toString"), registry);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("tenant-unknown");
  });

  it("property: a resolved Tenant ALWAYS maps to a registered id, and to the caller's own team", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_-]{0,20}$/), { minLength: 1, maxLength: 8 }),
        fc.string(),
        (teams, queried) => {
          const reg = registryOf(
            Object.fromEntries(teams.map((t) => [t, mkTenant(t, t)])),
          );
          const r = resolveTenant(teamIdentity(queried), reg);
          if (isOk(r)) {
            // Success ⇒ the queried team was registered AND the principal's
            // team is exactly that team (never another tenant's).
            expect(teams.includes(queried)).toBe(true);
            expect(r.value.team).toBe(queried);
            expect(r.value.id).toBe(queried as TenantId);
          } else {
            // Failure ⇒ the queried team was NOT registered, and the error
            // leaks nothing.
            expect(teams.includes(queried)).toBe(false);
            expect(r.error).toEqual({ kind: "tenant-unknown" });
          }
        },
      ),
    );
  });
});

// ── markSecretsRef ───────────────────────────────────────────────────────────

describe("markSecretsRef", () => {
  it("brands a reference string opaquely (value preserved, not dereferenced)", () => {
    const ref = markSecretsRef("vault://acme/secrets");
    expect(ref).toBe("vault://acme/secrets" as ReturnType<typeof markSecretsRef>);
  });

  it("THROWS on a blank/whitespace-only reference — closes the fail-open gate at the registration/worker boundary", () => {
    // A blank ref means a producer bypassed the non-empty parse at its trust
    // boundary; markSecretsRef must refuse to brand it (mirroring markTenant).
    expect(() => markSecretsRef("")).toThrow();
    expect(() => markSecretsRef("   ")).toThrow();
    // The thrown value is the internal-invariant HostError (greppable kind),
    // for both the empty and the whitespace-only case.
    for (const blank of ["", "   "]) {
      try {
        markSecretsRef(blank);
        throw new Error("expected markSecretsRef to throw");
      } catch (e) {
        expect((e as { kind?: string }).kind).toBe("internal-invariant-violated");
      }
    }
  });
});

// NOTE: the ADR-0073 `canAccessDagForTenant` conjunctive gate was removed (pass 9)
// — it had zero production callers because tenant isolation for DAG execution is
// STRUCTURAL in this slice (the supervisor routes each caller to its own tenant's
// worker; a worker serves exactly one tenant's DAGs). DAG authz is exercised by
// the `canAccessDag` tests in `auth.test.ts`. Re-add a tenant-scoped conjunct here
// if a future shared-worker / multi-DAG-per-worker topology needs per-request
// tenant scoping.
