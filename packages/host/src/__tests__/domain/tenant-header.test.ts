/**
 * The `X-Fugue-Tenant` header contract (T6/T7 SHARED). Asserts sign/verify round
 * trips and every fail-closed verification branch — these are the exact functions
 * T7's supervisor imports to STAMP the header, so a regression here breaks proxy
 * routing for every worker.
 */

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import {
  TENANT_HEADER_NAME,
  signTenantHeader,
  verifyTenantHeader,
} from "../../domain/tenant-header.js";
import { tenantId, type TenantId } from "../../domain/tenant.js";

const KEY = "internal-supervisor-hmac-key";

/**
 * Unwrap a `tenantId(...)` parse result for tests. The framework's `unwrap`
 * helper is intentionally NOT in the public barrel, and `Result` is a plain
 * `{ ok, value | error }` union, so we narrow on `ok` directly here. Throws if
 * the generator ever produces a value the real parser rejects — turning any
 * drift between the generator and `TENANT_ID_REGEX` into a loud failure.
 */
const unwrapTenantId = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`generator produced an invalid TenantId: "${s}"`);
  return r.value;
};

// ── fast-check arbitraries ────────────────────────────────────────────────────

/**
 * An arbitrary VALID branded `TenantId`. Strings are generated to the exact
 * `TENANT_ID_REGEX` shape (`[A-Za-z0-9_-]{1,64}`) and then run through the REAL
 * `tenantId` smart constructor, so the brand is genuine and the generator can
 * never drift from the production parser — if `TENANT_ID_REGEX` changes and a
 * generated value stops matching, `unwrap` throws and the property fails loudly
 * rather than silently testing an invalid id.
 */
const tenantIdArb: fc.Arbitrary<TenantId> = fc
  .stringMatching(/^[A-Za-z0-9_-]{1,64}$/)
  .map(unwrapTenantId);

/** An arbitrary HMAC key. The signer accepts any non-empty key material. */
const keyArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 128 });

/** Mutate exactly one character of `s` at `index` to a guaranteed-different char. */
const flipCharAt = (s: string, index: number): string => {
  const i = index % s.length;
  const original = s[i]!;
  // Pick a replacement that differs from the original so the mutation is real.
  const replacement = original === "0" ? "1" : "0";
  return s.slice(0, i) + replacement + s.slice(i + 1);
};

describe("tenant-header — contract shape", () => {
  it("header name is exactly X-Fugue-Tenant", () => {
    expect(TENANT_HEADER_NAME).toBe("X-Fugue-Tenant");
  });

  it("signs as <tenantId>.<hmacHex> and is deterministic", () => {
    const a = signTenantHeader(KEY, "acme-corp");
    const b = signTenantHeader(KEY, "acme-corp");
    expect(a).toBe(b);
    expect(a.startsWith("acme-corp.")).toBe(true);
    const [, hmac] = a.split(".");
    expect(/^[0-9a-f]{64}$/.test(hmac)).toBe(true); // hex SHA-256
  });

  it("a different key produces a different signature", () => {
    expect(signTenantHeader(KEY, "t1")).not.toBe(signTenantHeader("other-key", "t1"));
  });
});

describe("tenant-header — verify (fail-closed)", () => {
  it("accepts a header the same key signed for the bound tenant", () => {
    const header = signTenantHeader(KEY, "acme-corp");
    expect(verifyTenantHeader(KEY, "acme-corp", header)).toEqual({ kind: "ok" });
  });

  it("absent header → absent", () => {
    expect(verifyTenantHeader(KEY, "acme-corp", undefined)).toEqual({ kind: "absent" });
  });

  it("malformed header (no dot) → malformed", () => {
    expect(verifyTenantHeader(KEY, "acme-corp", "no-dot-here")).toEqual({ kind: "malformed" });
  });

  it("malformed header (empty hmac) → malformed", () => {
    expect(verifyTenantHeader(KEY, "acme-corp", "acme-corp.")).toEqual({ kind: "malformed" });
  });

  it("header for a DIFFERENT tenant → tenant-mismatch", () => {
    const headerForB = signTenantHeader(KEY, "tenant-b");
    expect(verifyTenantHeader(KEY, "tenant-a", headerForB)).toEqual({ kind: "tenant-mismatch" });
  });

  it("right tenant, wrong key → bad-signature", () => {
    const forged = signTenantHeader("wrong-key", "acme-corp");
    expect(verifyTenantHeader(KEY, "acme-corp", forged)).toEqual({ kind: "bad-signature" });
  });

  it("right tenant, tampered hmac of wrong length → bad-signature", () => {
    expect(verifyTenantHeader(KEY, "acme-corp", "acme-corp.deadbeef")).toEqual({ kind: "bad-signature" });
  });
});

describe("tenant-header — HMAC properties (fast-check)", () => {
  // 1. ROUNDTRIP — a header signed by a key always verifies `ok` for that key
  // and the tenant it was signed for, across ALL valid keys and tenant ids.
  it("PROPERTY roundtrip: verify(key, t, sign(key, t)) === ok", () => {
    fc.assert(
      fc.property(keyArb, tenantIdArb, (key, tenant) => {
        const header = signTenantHeader(key, tenant);
        expect(verifyTenantHeader(key, tenant, header)).toEqual({ kind: "ok" });
      }),
    );
  });

  // 2a. SINGLE-CHAR TAMPER (signature) — mutating any one character of the hex
  // HMAC portion must NEVER verify `ok`. The bound tenant id is unchanged, so a
  // tampered signature can only land on `bad-signature` (the id still matches).
  it("PROPERTY tamper: flipping one signature char never verifies ok", () => {
    fc.assert(
      fc.property(keyArb, tenantIdArb, fc.nat(), (key, tenant, idx) => {
        const header = signTenantHeader(key, tenant);
        const dot = header.indexOf(".");
        const id = header.slice(0, dot);
        const sig = header.slice(dot + 1);

        const tamperedSig = flipCharAt(sig, idx);
        // Guard the (improbable) case where the flip is a no-op; here it never
        // is because flipCharAt always substitutes a differing char, but assert
        // the precondition so the property's meaning stays honest.
        expect(tamperedSig).not.toBe(sig);

        const tampered = `${id}.${tamperedSig}`;
        const result = verifyTenantHeader(key, tenant, tampered);
        expect(result.kind).not.toBe("ok");
        expect(result.kind).toBe("bad-signature");
      }),
    );
  });

  // 2b. SINGLE-CHAR TAMPER (bound tenant) — mutating one character of the tenant
  // id portion of the header, while the worker stays bound to the ORIGINAL
  // tenant, must NEVER verify `ok`. Because the signer signs the id, a changed
  // id no longer matches the worker's bound id → `tenant-mismatch`.
  it("PROPERTY tamper: flipping one bound-tenant char never verifies ok", () => {
    fc.assert(
      fc.property(keyArb, tenantIdArb, fc.nat(), (key, tenant, idx) => {
        const header = signTenantHeader(key, tenant);
        const dot = header.indexOf(".");
        const id = header.slice(0, dot);
        const sig = header.slice(dot + 1);

        // Flip a char in the id that keeps it TENANT_ID_REGEX-safe (0/1 are both
        // in the charset and never `.`), so the header stays well-formed and the
        // failure is a true tenant-mismatch rather than `malformed`.
        const tamperedId = flipCharAt(id, idx);
        expect(tamperedId).not.toBe(id);

        const tampered = `${tamperedId}.${sig}`;
        const result = verifyTenantHeader(key, tenant, tampered);
        expect(result.kind).not.toBe("ok");
        expect(result.kind).toBe("tenant-mismatch");
      }),
    );
  });

  // 3. WRONG-KEY REJECTION — a header signed under key A must never verify `ok`
  // under a DIFFERENT key B for the same tenant. Generated keys are constrained
  // to be distinct (`fc.pre`) so the property is not vacuous.
  it("PROPERTY wrong key: header signed with A never verifies ok under B", () => {
    fc.assert(
      fc.property(keyArb, keyArb, tenantIdArb, (keyA, keyB, tenant) => {
        fc.pre(keyA !== keyB);
        const header = signTenantHeader(keyA, tenant);
        const result = verifyTenantHeader(keyB, tenant, header);
        expect(result.kind).not.toBe("ok");
        expect(result.kind).toBe("bad-signature");
      }),
    );
  });
});
