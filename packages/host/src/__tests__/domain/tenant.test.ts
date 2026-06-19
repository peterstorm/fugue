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
 *   - tenant-aware authz extension (`canAccessDagForTenant`): conjunctive with
 *     the existing `canAccessDag`, so a resolved tenant can never reach another
 *     tenant's DAG (US3, FR-041) while single-tenant behaviour is unchanged.
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
  type Tenant,
  type TenantId,
  type TenantRegistryView,
} from "../../domain/tenant.js";
import { canAccessDag, canAccessDagForTenant, type AuthIdentity } from "../../domain/auth.js";

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
          const matches = TENANT_ID_REGEX.test(s);
          // Full biconditional: the smart constructor accepts a string iff the
          // regex matches it — no fail-open gap on either side.
          expect(accepted).toBe(matches);
        },
      ),
    );
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
          const valid = TENANT_ID_REGEX.test(s);
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
});

// ── canAccessDagForTenant (tenant-aware authz extension, US3) ─────────────────

describe("canAccessDagForTenant", () => {
  const acme = mkTenant("acme", "acme");
  const globex = mkTenant("globex", "globex");

  it("admin within its tenant can access that tenant's DAG", () => {
    expect(canAccessDagForTenant(acme, adminIdentity, "acme")).toBe(true);
  });

  it("admin CANNOT reach another tenant's DAG once scoped to a tenant principal (FR-041)", () => {
    // canAccessDag(admin, *) is true, but the tenant gate blocks cross-tenant.
    expect(canAccessDag(adminIdentity, "globex")).toBe(true);
    expect(canAccessDagForTenant(acme, adminIdentity, "globex")).toBe(false);
  });

  it("team identity can access its own tenant's DAG", () => {
    expect(canAccessDagForTenant(acme, teamIdentity("acme"), "acme")).toBe(true);
  });

  it("a multi-team user CANNOT cross the tenant boundary even if the policy permits the other team", () => {
    const user = userIdentity(["acme", "globex"]);
    // The identity policy would permit globex…
    expect(canAccessDag(user, "globex")).toBe(true);
    // …but the resolved tenant is acme, so the conjunctive gate refuses.
    expect(canAccessDagForTenant(acme, user, "globex")).toBe(false);
    // Within its own tenant it still works.
    expect(canAccessDagForTenant(acme, user, "acme")).toBe(true);
  });

  it("is the conjunction of canAccessDag AND tenant ownership (fail-closed)", () => {
    // identity denies → false regardless of tenant match
    expect(canAccessDagForTenant(acme, teamIdentity("other"), "acme")).toBe(false);
    // tenant mismatch → false regardless of identity
    expect(canAccessDagForTenant(globex, teamIdentity("acme"), "acme")).toBe(false);
  });

  it("property: canAccessDagForTenant ⟹ canAccessDag AND dagTeam === tenant.team", () => {
    const idArb: fc.Arbitrary<AuthIdentity> = fc.oneof(
      fc.constant(adminIdentity),
      fc.stringMatching(/^[a-z]{1,8}$/).map((t) => teamIdentity(t)),
      fc.array(fc.stringMatching(/^[a-z]{1,8}$/)).map((a) => userIdentity(a)),
    );
    const teamArb = fc.stringMatching(/^[a-z]{1,8}$/);
    fc.assert(
      fc.property(idArb, teamArb, teamArb, (identity, tenantTeam, dagTeam) => {
        const tenant = mkTenant(tenantTeam, tenantTeam);
        const got = canAccessDagForTenant(tenant, identity, dagTeam);
        const expected = canAccessDag(identity, dagTeam) && tenantTeam === dagTeam;
        expect(got).toBe(expected);
        // The extension NEVER widens access beyond the base predicate.
        if (got) expect(canAccessDag(identity, dagTeam)).toBe(true);
      }),
    );
  });
});
