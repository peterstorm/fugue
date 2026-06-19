/**
 * Cache Keys — pure key-builder tests, focused on the TENANT-prefix security
 * invariant (AD-4 / US2 / SC-001) and per-DAG scoping preserved beneath it
 * (FR-013).
 *
 * The load-bearing property: NO key escapes `fugue:<tenant>:`, and two distinct
 * tenants NEVER produce a colliding key string for the same logical inputs — the
 * precondition for a per-tenant Redis ACL user scoped to `~fugue:<tenant>:*`.
 */

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import { dagId, runId as makeRunId, nodeId as makeNodeId, isOk } from "@fuguejs/framework";
import {
  cacheKeyPrefix,
  buildCacheKey,
  checkpointKeyPrefix,
  buildCheckpointKey,
  type TenantId,
} from "../../domain/cache-keys.js";
import { tenantId } from "../../domain/tenant.js";

/**
 * Build a `TenantId` for a test from a known-good literal via the CANONICAL
 * smart constructor (`domain/tenant.ts`) — the single `TenantId` source. The
 * constructor's forgery-resistance (`:`/glob rejection, length bound) is tested
 * exhaustively in `tenant.test.ts`; here we only need valid ids for the key
 * builders, so we unwrap and fail loudly if a literal we control is malformed.
 */
const mkTenant = (s: string): TenantId => {
  const r = tenantId(s);
  if (!isOk(r)) throw new Error(`test tenant id "${s}" is invalid (kind: ${r.error.kind})`);
  return r.value;
};

const TENANT_A = mkTenant("tenant-a");
const TENANT_B = mkTenant("tenant-b");

describe("cache key builders — tenant prefix (SECURITY: AD-4 / US2 / SC-001)", () => {
  it("cacheKeyPrefix is fugue:<tenant>:<dagId>:cache:", () => {
    expect(cacheKeyPrefix(TENANT_A, dagId("orders"))).toBe("fugue:tenant-a:orders:cache:");
  });

  it("buildCacheKey is fugue:<tenant>:<dagId>:cache:<key>", () => {
    expect(buildCacheKey(TENANT_A, dagId("orders"), "customer:123")).toBe(
      "fugue:tenant-a:orders:cache:customer:123",
    );
  });

  it("checkpointKeyPrefix is fugue:<tenant>:<dagId>:<runId>:", () => {
    expect(checkpointKeyPrefix(TENANT_A, dagId("orders"), makeRunId("run-1"))).toBe(
      "fugue:tenant-a:orders:run-1:",
    );
  });

  it("buildCheckpointKey is fugue:<tenant>:<dagId>:<runId>:<nodeId>", () => {
    expect(
      buildCheckpointKey(TENANT_A, dagId("orders"), makeRunId("run-1"), makeNodeId("fetch")),
    ).toBe("fugue:tenant-a:orders:run-1:fetch");
  });

  it("EVERY builder output starts with the tenant prefix (no key escapes)", () => {
    const prefix = `fugue:${TENANT_A}:`;
    const keys = [
      cacheKeyPrefix(TENANT_A, dagId("d")),
      buildCacheKey(TENANT_A, dagId("d"), "k"),
      checkpointKeyPrefix(TENANT_A, dagId("d"), makeRunId("r")),
      buildCheckpointKey(TENANT_A, dagId("d"), makeRunId("r"), makeNodeId("n")),
    ];
    for (const key of keys) {
      expect(key.startsWith(prefix)).toBe(true);
    }
  });
});

describe("no cross-tenant collision (the ACL precondition)", () => {
  it("two tenants with identical DAG + key produce DIFFERENT cache keys", () => {
    const keyA = buildCacheKey(TENANT_A, dagId("orders"), "shared");
    const keyB = buildCacheKey(TENANT_B, dagId("orders"), "shared");
    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe("fugue:tenant-a:orders:cache:shared");
    expect(keyB).toBe("fugue:tenant-b:orders:cache:shared");
  });

  it("two tenants with identical DAG + run + node produce DIFFERENT checkpoint keys", () => {
    const keyA = buildCheckpointKey(TENANT_A, dagId("orders"), makeRunId("run-1"), makeNodeId("n"));
    const keyB = buildCheckpointKey(TENANT_B, dagId("orders"), makeRunId("run-1"), makeNodeId("n"));
    expect(keyA).not.toBe(keyB);
  });

  it("a tenant's key namespace is a prefix-disjoint set from another tenant's", () => {
    // tenant-a's keyspace (fugue:tenant-a:*) and tenant-b's (fugue:tenant-b:*)
    // share no key. Demonstrated structurally: neither prefix is a prefix of the
    // other, so SCAN ~fugue:tenant-a:* can never surface a tenant-b key.
    const prefixA = `fugue:${TENANT_A}:`;
    const prefixB = `fugue:${TENANT_B}:`;
    expect(prefixA.startsWith(prefixB)).toBe(false);
    expect(prefixB.startsWith(prefixA)).toBe(false);
  });

  it("preserves per-DAG isolation WITHIN a tenant (FR-013)", () => {
    const a = buildCacheKey(TENANT_A, dagId("dag-alpha"), "k");
    const b = buildCacheKey(TENANT_A, dagId("dag-beta"), "k");
    expect(a).not.toBe(b);
    expect(a).toBe("fugue:tenant-a:dag-alpha:cache:k");
    expect(b).toBe("fugue:tenant-a:dag-beta:cache:k");
  });
});

// ── Property: the load-bearing invariant over ARBITRARY tenants ─────────────
//
// The hardcoded cases above spot-check two literal tenants. The isolation model
// rests on the prefix-containment + cross-tenant-disjointness holding for EVERY
// valid `TenantId` pair, so prove it over the whole input space.

describe("cache key builders — prefix-containment property (SECURITY: AD-4 / SC-001)", () => {
  // Any string matching TENANT_ID_REGEX is a valid id — by construction it
  // contains no `:` (the segment delimiter) or glob metacharacter.
  const tenantArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/).map(mkTenant);
  // DAG / run / node ids are validated by the framework smart constructors,
  // which throw on a bad shape (and `dagId` additionally forbids `:`). Use the
  // colon-free intersection that all three accept.
  const idArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/);
  // The cache KEY is the genuinely-untrusted segment — ANY non-empty string,
  // including one containing `:` (e.g. "customer:123"). It must NOT be able to
  // break out of the tenant prefix.
  const keyArb = fc.string({ minLength: 1 });

  it("EVERY builder output is prefixed `fugue:<tenant>:` for any tenant + inputs", () => {
    fc.assert(
      fc.property(tenantArb, idArb, idArb, idArb, keyArb, (t, d, r, n, k) => {
        const prefix = `fugue:${t}:`;
        const keys = [
          cacheKeyPrefix(t, dagId(d)),
          buildCacheKey(t, dagId(d), k),
          checkpointKeyPrefix(t, dagId(d), makeRunId(r)),
          buildCheckpointKey(t, dagId(d), makeRunId(r), makeNodeId(n)),
        ];
        return keys.every((key) => key.startsWith(prefix));
      }),
    );
  });

  it("two DISTINCT tenants have prefix-disjoint, non-colliding namespaces for identical inputs", () => {
    fc.assert(
      fc.property(tenantArb, tenantArb, idArb, idArb, idArb, keyArb, (tA, tB, d, r, n, k) => {
        fc.pre(tA !== tB);
        const prefixA = `fugue:${tA}:`;
        const prefixB = `fugue:${tB}:`;
        // The trailing `:` delimiter (impossible inside a TenantId) makes the two
        // prefixes mutually non-prefixed, so a SCAN ~fugue:<tA>:* can never surface
        // a <tB> key — the precondition for per-tenant Redis ACL scoping.
        const disjoint = !prefixA.startsWith(prefixB) && !prefixB.startsWith(prefixA);
        const cacheDiffers =
          buildCacheKey(tA, dagId(d), k) !== buildCacheKey(tB, dagId(d), k);
        const ckptDiffers =
          buildCheckpointKey(tA, dagId(d), makeRunId(r), makeNodeId(n)) !==
          buildCheckpointKey(tB, dagId(d), makeRunId(r), makeNodeId(n));
        return disjoint && cacheDiffers && ckptDiffers;
      }),
    );
  });
});
