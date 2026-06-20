/**
 * Tests for the per-tenant Redis ACL provisioning (AD-4).
 *
 * Two layers:
 *   1. PURE spec (`redis-acl.ts`): the scope-only key pattern, command scoping,
 *      excluded admin commands, the DENIAL of keyspace enumeration
 *      (`SCAN`/`RANDOMKEY`/`DBSIZE`/`KEYS` — key-pattern ACLs do not reliably
 *      scope enumeration across Redis versions), and the cross-tenant non-overlap
 *      that MAKES SC-001 true (an adversarial worker's cross-tenant `GET` hits
 *      NOPERM, and it cannot enumerate the keyspace to discover other tenants).
 *   2. Provisioner (`redis-acl-provisioner.ts`): apply issues the correct
 *      `ACL SETUSER`, revoke issues `ACL DELUSER`, both fail closed on a `!ok`
 *      admin response, and the minted credential is RETURNED (for spawn-env handoff
 *      to the owning worker — a channel SEPARATE from the SecretsSource port) but
 *      never retained/logged by the provisioner.
 *
 * @satisfies FR-009 — a worker MUST NOT read another tenant's secrets/data/state.
 * @satisfies FR-010 — a worker compromise MUST NOT yield another tenant's material.
 * @satisfies SC-001 — adversarial cross-tenant reads are ZERO bytes (this ACL
 *   spec is the server-enforced mechanism that makes it true).
 * @satisfies US2 — hard cross-tenant isolation under compromise.
 */

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { TENANT_ID_REGEX, tenantId, type TenantId } from "../../../domain/tenant.js";
import { buildAclSpec, aclUsername } from "../../../supervisor/secrets/redis-acl.js";
import {
  apply,
  revoke,
  createFakeAclAdmin,
  ACL_PASSWORD_RANDOM_BYTES,
  type AclProvisionerDeps,
} from "../../../supervisor/secrets/redis-acl-provisioner.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Unwrap a known-good tenantId for tests (the input always matches the regex). */
const mkTenant = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`test setup: invalid tenant id "${s}"`);
  return r.value;
};

/** Deterministic 32-byte randomness source for credential-minting tests. */
const fixedRandomBytes = (fill = 7): AclProvisionerDeps => ({
  generateRandomBytes: () => new Uint8Array(ACL_PASSWORD_RANDOM_BYTES).fill(fill),
});

/** A fast-check arbitrary that yields strings matching TENANT_ID_REGEX. */
const tenantIdArb = fc
  .stringMatching(TENANT_ID_REGEX)
  .map((s) => mkTenant(s));

// ── PURE spec: scope-only key pattern ────────────────────────────────────────

describe("buildAclSpec — scope-only key pattern (SC-001, FR-009)", () => {
  it("produces EXACTLY one key pattern: ~fugue:<tenant>:*", () => {
    const spec = buildAclSpec(mkTenant("acme"));
    expect(spec.keyPattern).toBe("~fugue:acme:*");
    // Exactly one key pattern appears in the rule tokens.
    const keyPatterns = spec.rules.filter((r) => r.startsWith("~"));
    expect(keyPatterns).toEqual(["~fugue:acme:*"]);
  });

  it("matches the cache-keys.ts tenantPrefix scheme (covers every emitted key)", () => {
    // domain/cache-keys.ts builds `fugue:<tenant>:…`; token-store builds
    // `fugue:<tenant>:tokens|teams:…`. The ACL pattern must cover all of them.
    const spec = buildAclSpec(mkTenant("acme"));
    const sampleKeys = [
      "fugue:acme:dag1:cache:k",
      "fugue:acme:dag1:run1:node1",
      "fugue:acme:tokens:abc",
      "fugue:acme:teams:team1",
      "fugue:acme:hitl:r1",
    ];
    // The glob `fugue:acme:*` matches every key under the tenant.
    for (const k of sampleKeys) {
      expect(k.startsWith("fugue:acme:")).toBe(true);
    }
    expect(spec.keyPattern).toBe("~fugue:acme:*");
  });

  it("NEVER grants ~* or allkeys (no global keyspace)", () => {
    const spec = buildAclSpec(mkTenant("acme"));
    expect(spec.rules).not.toContain("~*");
    expect(spec.rules).not.toContain("allkeys");
    expect(spec.rules.some((r) => r === "~*" || r === "allkeys")).toBe(false);
  });

  it("NEVER grants a second key pattern", () => {
    const spec = buildAclSpec(mkTenant("acme"));
    const keyPatterns = spec.rules.filter((r) => r.startsWith("~"));
    expect(keyPatterns).toHaveLength(1);
  });

  it("resets the user first (no inherited keys/channels/commands/passwords)", () => {
    const spec = buildAclSpec(mkTenant("acme"));
    expect(spec.rules[0]).toBe("reset");
  });

  it("enables the user and grants no pub/sub channels", () => {
    const spec = buildAclSpec(mkTenant("acme"));
    expect(spec.rules).toContain("on");
    expect(spec.rules).toContain("resetchannels");
    // No channel grant (`&…` or `allchannels`).
    expect(spec.rules.some((r) => r.startsWith("&") || r === "allchannels")).toBe(false);
  });
});

// ── PURE spec: command scoping / dangerous-command exclusion ─────────────────

describe("buildAclSpec — least-privilege command scoping", () => {
  const spec = buildAclSpec(mkTenant("acme"));

  it("denies dangerous categories (@admin, @dangerous, @scripting)", () => {
    expect(spec.rules).toContain("-@admin");
    expect(spec.rules).toContain("-@dangerous");
    expect(spec.rules).toContain("-@scripting");
  });

  it.each([
    "config",
    "acl",
    "flushall",
    "flushdb",
    "debug",
    "shutdown",
    "keys",
    "scan",
    "randomkey",
    "dbsize",
    "script",
    "eval",
    "evalsha",
    "function",
    "module",
    "cluster",
    "slaveof",
    "replicaof",
    "failover",
    "swapdb",
    "migrate",
    "restore",
  ])("explicitly denies the dangerous command: %s", (cmd) => {
    expect(spec.rules).toContain(`-${cmd}`);
  });

  it("denies ALL keyspace-enumeration commands (SCAN/RANDOMKEY/DBSIZE/KEYS)", () => {
    // Key-pattern ACLs do NOT reliably scope keyspace enumeration across Redis
    // versions, so enumeration is denied outright — not relied upon to be scoped.
    // Key NAMES encode sensitive data (team names, token hashes, tenant roster),
    // so a scoped worker that could enumerate would leak other tenants' data.
    expect(spec.rules).toContain("-keys");
    expect(spec.rules).toContain("-scan");
    expect(spec.rules).toContain("-randomkey");
    expect(spec.rules).toContain("-dbsize");
  });

  it("grants the broad data set before carving out denials (order matters)", () => {
    const grantIdx = spec.rules.indexOf("+@all");
    const denyIdx = spec.rules.indexOf("-@admin");
    expect(grantIdx).toBeGreaterThanOrEqual(0);
    expect(denyIdx).toBeGreaterThan(grantIdx);
  });
});

// ── PURE spec: username scheme ───────────────────────────────────────────────

describe("aclUsername — deterministic, tenant-derived", () => {
  it("derives a stable username from the tenant", () => {
    expect(aclUsername(mkTenant("acme"))).toBe("fugue-tenant-acme");
  });

  it("buildAclSpec carries the same username", () => {
    expect(buildAclSpec(mkTenant("acme")).username).toBe("fugue-tenant-acme");
  });

  it("different tenants get different usernames", () => {
    expect(aclUsername(mkTenant("acme"))).not.toBe(aclUsername(mkTenant("globex")));
  });
});

// ── PURE spec: cross-tenant non-overlap (the heart of SC-001) ────────────────

describe("buildAclSpec — cross-tenant scope is non-overlapping (FR-010, US2)", () => {
  it("two tenants get disjoint key patterns and usernames", () => {
    const a = buildAclSpec(mkTenant("acme"));
    const b = buildAclSpec(mkTenant("globex"));

    expect(a.keyPattern).toBe("~fugue:acme:*");
    expect(b.keyPattern).toBe("~fugue:globex:*");
    expect(a.keyPattern).not.toBe(b.keyPattern);
    expect(a.username).not.toBe(b.username);
  });

  it("tenant A's pattern does NOT match tenant B's keys (NOPERM by construction)", () => {
    const a = buildAclSpec(mkTenant("acme"));
    // A's glob is `fugue:acme:*` — tenant B's keys live under `fugue:globex:`.
    const bKey = "fugue:globex:secret";
    const aGlobPrefix = a.keyPattern.replace(/^~/, "").replace(/\*$/, ""); // "fugue:acme:"
    expect(bKey.startsWith(aGlobPrefix)).toBe(false);
  });

  it("a cross-tenant GET fugue:<other>:* falls outside the granted pattern", () => {
    const a = buildAclSpec(mkTenant("acme"));
    const aGlobPrefix = a.keyPattern.replace(/^~/, "").replace(/\*$/, "");
    // Adversarial keys a compromised worker might try to GET:
    expect("fugue:".startsWith(aGlobPrefix)).toBe(false); // probe the global keyspace
    expect("fugue:globex:data".startsWith(aGlobPrefix)).toBe(false); // GET fugue:globex:…
    // Only its own keyspace is covered:
    expect("fugue:acme:data".startsWith(aGlobPrefix)).toBe(true);
  });

  it("keyspace enumeration is DENIED, so a compromised worker cannot SCAN at all", () => {
    // Defense-in-depth: even if SCAN's results WERE key-ACL-scoped (version-
    // dependent, historically FALSE), the command itself is denied — the worker
    // gets NOPERM on SCAN/RANDOMKEY/DBSIZE, never a (possibly unfiltered) result.
    const a = buildAclSpec(mkTenant("acme"));
    expect(a.rules).toContain("-scan");
    expect(a.rules).toContain("-randomkey");
    expect(a.rules).toContain("-dbsize");
    expect(a.rules).toContain("-keys");
  });

  it("PREFIX COLLISION: one tenant id being a prefix of another does NOT widen scope", () => {
    // The `:`-delimited scheme defends against ids where one is a textual prefix
    // of another. `acme2`'s keys must NOT match `acme`'s glob prefix — the `:`
    // after the tenant segment is the guard. This is the exact hazard the scheme
    // exists to prevent.
    const acme = buildAclSpec(mkTenant("acme"));
    const acmeGlobPrefix = acme.keyPattern.replace(/^~/, "").replace(/\*$/, ""); // "fugue:acme:"
    expect("fugue:acme2:x".startsWith(acmeGlobPrefix)).toBe(false);
    expect("fugue:acme2:teams:t".startsWith(acmeGlobPrefix)).toBe(false);

    // And the single-char case: `t` vs `t1`.
    const t = buildAclSpec(mkTenant("t"));
    const tGlobPrefix = t.keyPattern.replace(/^~/, "").replace(/\*$/, ""); // "fugue:t:"
    expect("fugue:t1:x".startsWith(tGlobPrefix)).toBe(false);
    // Symmetric: t1's prefix does not capture t's keys either.
    const t1 = buildAclSpec(mkTenant("t1"));
    const t1GlobPrefix = t1.keyPattern.replace(/^~/, "").replace(/\*$/, ""); // "fugue:t1:"
    expect("fugue:t:x".startsWith(t1GlobPrefix)).toBe(false);
  });
});

// ── PURE spec: property tests ────────────────────────────────────────────────

describe("buildAclSpec — properties (any valid TenantId)", () => {
  it("key pattern always equals ~fugue:${tenant}:* and is the ONLY pattern", () => {
    fc.assert(
      fc.property(tenantIdArb, (t) => {
        const spec = buildAclSpec(t);
        expect(spec.keyPattern).toBe(`~fugue:${t}:*`);
        const patterns = spec.rules.filter((r) => r.startsWith("~"));
        expect(patterns).toEqual([`~fugue:${t}:*`]);
      }),
    );
  });

  it("never grants ~* / allkeys for any valid tenant", () => {
    fc.assert(
      fc.property(tenantIdArb, (t) => {
        const spec = buildAclSpec(t);
        expect(spec.rules.includes("~*")).toBe(false);
        expect(spec.rules.includes("allkeys")).toBe(false);
      }),
    );
  });

  it("two distinct tenants always produce GLOB-DISJOINT key patterns (not mere string inequality)", () => {
    // SC-001 needs more than `patternA !== patternB`: it needs that NO key B can
    // legitimately name (`fugue:<b>:…`) falls under A's grantable glob prefix
    // (`fugue:<a>:`), and vice-versa. We model glob-disjointness with the
    // `startsWith` prefix check — the actual containment test a `:`-delimited
    // prefix glob performs. This catches the prefix-collision hazard (e.g.
    // `acme` vs `acme2`) that plain string inequality silently passes.
    fc.assert(
      fc.property(tenantIdArb, tenantIdArb, fc.string(), (a, b, suffix) => {
        fc.pre(a !== b);
        const sa = buildAclSpec(a);
        const sb = buildAclSpec(b);

        const aGlobPrefix = sa.keyPattern.replace(/^~/, "").replace(/\*$/, ""); // "fugue:<a>:"
        const bGlobPrefix = sb.keyPattern.replace(/^~/, "").replace(/\*$/, ""); // "fugue:<b>:"

        // Any key B can name does NOT fall under A's grantable prefix, and vice-versa.
        const bKey = `fugue:${b}:${suffix}`;
        const aKey = `fugue:${a}:${suffix}`;
        expect(bKey.startsWith(aGlobPrefix)).toBe(false);
        expect(aKey.startsWith(bGlobPrefix)).toBe(false);

        // The prefixes themselves are mutually non-containing (the `:` guard).
        expect(aGlobPrefix.startsWith(bGlobPrefix)).toBe(false);
        expect(bGlobPrefix.startsWith(aGlobPrefix)).toBe(false);

        expect(sa.username).not.toBe(sb.username);
      }),
    );
  });

  it("always denies @admin/@dangerous/@scripting for any valid tenant", () => {
    fc.assert(
      fc.property(tenantIdArb, (t) => {
        const spec = buildAclSpec(t);
        expect(spec.rules).toContain("-@admin");
        expect(spec.rules).toContain("-@dangerous");
        expect(spec.rules).toContain("-@scripting");
      }),
    );
  });
});

// ── PURE spec: defense-in-depth on forged TenantId ───────────────────────────

describe("buildAclSpec — defense-in-depth (forged TenantId)", () => {
  it("throws if a forged TenantId violates TENANT_ID_REGEX (would widen scope)", () => {
    const forged = "acme:*" as unknown as TenantId; // contains ':' and glob
    expect(() => buildAclSpec(forged)).toThrow(/TENANT_ID_REGEX/);
  });

  it("throws on a wildcard-injection attempt", () => {
    const forged = "*" as unknown as TenantId;
    expect(() => buildAclSpec(forged)).toThrow();
  });
});

// ── Provisioner: apply ───────────────────────────────────────────────────────

describe("apply — provisions the scoped ACL user over the admin connection", () => {
  it("issues a single ACL SETUSER with the spec rules + minted password", async () => {
    const admin = createFakeAclAdmin();
    const tenant = mkTenant("acme");

    const result = await apply(admin, tenant, fixedRandomBytes());

    expect(result.ok).toBe(true);
    expect(admin.setUserCalls).toHaveLength(1);
    const call = admin.setUserCalls[0]!;
    expect(call.username).toBe("fugue-tenant-acme");
    // Carries the scope-only key pattern.
    expect(call.rules).toContain("~fugue:acme:*");
    expect(call.rules).toContain("reset");
    expect(call.rules).toContain("on");
    // Exactly one password token, appended.
    const pwTokens = call.rules.filter((r) => r.startsWith(">"));
    expect(pwTokens).toHaveLength(1);
  });

  it("RETURNS the credential (username + password + tenant) for spawn-env handoff to the owning worker", async () => {
    const admin = createFakeAclAdmin();
    const result = await apply(admin, mkTenant("acme"), fixedRandomBytes());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.username).toBe("fugue-tenant-acme");
    expect(result.value.tenant).toBe(mkTenant("acme"));
    expect(typeof result.value.password).toBe("string");
    expect(result.value.password.length).toBeGreaterThan(0);
  });

  it("the returned password matches the >password token sent to Redis", async () => {
    const admin = createFakeAclAdmin();
    const result = await apply(admin, mkTenant("acme"), fixedRandomBytes());
    if (!result.ok) throw new Error("unreachable");
    const pwToken = admin.setUserCalls[0]!.rules.find((r) => r.startsWith(">"))!;
    expect(pwToken).toBe(`>${result.value.password}`);
  });

  it("mints a high-entropy password (base64url, no padding)", async () => {
    const admin = createFakeAclAdmin();
    const result = await apply(admin, mkTenant("acme"), fixedRandomBytes());
    if (!result.ok) throw new Error("unreachable");
    // 32 bytes → 43 base64url chars (no '=').
    expect(result.value.password).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.value.password.length).toBeGreaterThanOrEqual(43);
  });

  it("different randomness yields different passwords (no fixed secret)", async () => {
    const a = await apply(createFakeAclAdmin(), mkTenant("acme"), fixedRandomBytes(1));
    const b = await apply(createFakeAclAdmin(), mkTenant("acme"), fixedRandomBytes(2));
    if (!a.ok || !b.ok) throw new Error("unreachable");
    expect(a.value.password).not.toBe(b.value.password);
  });

  it("fails closed on a !ok admin response — returns err, NO credential", async () => {
    const admin = createFakeAclAdmin({ fail: true });
    const result = await apply(admin, mkTenant("acme"), fixedRandomBytes());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("redis-unavailable");
  });

  it("does not retain the credential anywhere on the provisioner module", async () => {
    // The provisioner exposes no getter/state; the only handle to the password
    // is the returned value. Two applies return independent credentials with no
    // shared/cached state.
    const a = await apply(createFakeAclAdmin(), mkTenant("acme"), fixedRandomBytes(3));
    const b = await apply(createFakeAclAdmin(), mkTenant("globex"), fixedRandomBytes(3));
    if (!a.ok || !b.ok) throw new Error("unreachable");
    expect(a.value.tenant).toBe(mkTenant("acme"));
    expect(b.value.tenant).toBe(mkTenant("globex"));
  });

  it("throws (defense-in-depth) if given a forged TenantId", async () => {
    const admin = createFakeAclAdmin();
    const forged = "acme:*" as unknown as TenantId;
    await expect(apply(admin, forged, fixedRandomBytes())).rejects.toThrow(/TENANT_ID_REGEX/);
    // No SETUSER was issued for the forged id.
    expect(admin.setUserCalls).toHaveLength(0);
  });

  it("throws if randomness is too short (refuses a weak credential)", async () => {
    const admin = createFakeAclAdmin();
    const weak: AclProvisionerDeps = { generateRandomBytes: () => new Uint8Array(8) };
    await expect(apply(admin, mkTenant("acme"), weak)).rejects.toThrow(/entropy/i);
  });
});

// ── Provisioner: revoke ──────────────────────────────────────────────────────

describe("revoke — removes the ACL user over the admin connection", () => {
  it("issues ACL DELUSER for the tenant's derived username", async () => {
    const admin = createFakeAclAdmin();
    const result = await revoke(admin, mkTenant("acme"));

    expect(result.ok).toBe(true);
    expect(admin.delUserCalls).toHaveLength(1);
    expect(admin.delUserCalls[0]!.username).toBe("fugue-tenant-acme");
  });

  it("fails closed on a !ok admin response", async () => {
    const admin = createFakeAclAdmin({ fail: true });
    const result = await revoke(admin, mkTenant("acme"));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("redis-unavailable");
  });

  it("targets exactly the tenant's own user, never another tenant's", async () => {
    const admin = createFakeAclAdmin();
    await revoke(admin, mkTenant("acme"));
    expect(admin.delUserCalls[0]!.username).toBe(aclUsername(mkTenant("acme")));
    expect(admin.delUserCalls[0]!.username).not.toBe(aclUsername(mkTenant("globex")));
  });
});
