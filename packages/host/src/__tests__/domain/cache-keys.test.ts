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
import { dagId, runId as makeRunId, nodeId as makeNodeId, isOk, mapIndex, freshnessExecutionEpoch } from "@fuguejs/framework";
import {
  cacheKeyPrefix,
  buildCacheKey,
  checkpointKeyPrefix,
  buildCheckpointKey,
  buildCheckpointMetaKey,
  buildCheckpointNodesKey,
  buildSpendKey,
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
const childScope = (index: number, map = "fan", epoch = 0) => ({
  mapNodeId: makeNodeId(map), index: mapIndex(index), executionEpoch: freshnessExecutionEpoch(epoch),
});

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

  it("buildCheckpointMetaKey / buildCheckpointNodesKey are the run's $-suffixed aggregates", () => {
    expect(buildCheckpointMetaKey(TENANT_A, dagId("orders"), makeRunId("run-1"))).toBe(
      "fugue:tenant-a:orders:run-1:$meta",
    );
    expect(buildCheckpointNodesKey(TENANT_A, dagId("orders"), makeRunId("run-1"))).toBe(
      "fugue:tenant-a:orders:run-1:$nodes",
    );
  });

  it("EVERY builder output starts with the tenant prefix (no key escapes)", () => {
    const prefix = `fugue:${TENANT_A}:`;
    const keys = [
      cacheKeyPrefix(TENANT_A, dagId("d")),
      buildCacheKey(TENANT_A, dagId("d"), "k"),
      checkpointKeyPrefix(TENANT_A, dagId("d"), makeRunId("r")),
      buildCheckpointKey(TENANT_A, dagId("d"), makeRunId("r"), makeNodeId("n")),
      buildCheckpointMetaKey(TENANT_A, dagId("d"), makeRunId("r")),
      buildCheckpointNodesKey(TENANT_A, dagId("d"), makeRunId("r")),
      buildSpendKey(TENANT_A, dagId("d"), makeRunId("r")),
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
          buildCheckpointMetaKey(t, dagId(d), makeRunId(r)),
          buildCheckpointNodesKey(t, dagId(d), makeRunId(r)),
          buildSpendKey(t, dagId(d), makeRunId(r)),
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

describe("the spend key is disjoint from the checkpoint NodeId namespace (C1)", () => {
  // The node arbitrary covers the complete `ID_PATTERN` alphabet. Tenant, DAG,
  // and run ids keep the colon-free alphabet their constructors require.
  const anyNodeId = fc.stringMatching(/^[A-Za-z0-9_:-]{1,64}$/);
  const colonFree = fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/);
  const anyTenant = colonFree.map(mkTenant);
  // The bug this pins: `buildSpendKey` shares `checkpointKeyPrefix` with
  // `buildCheckpointKey`, whose final segment is a caller-supplied `NodeId`.
  // With a plain `spend` segment, a DAG node named `spend` produced the SAME
  // key — and the checkpoint writer's `SET` (a STRING) would destroy the
  // ledger's HASH, silently zeroing the run's recorded spend and then
  // permanently refusing every later slice of a budgeted run on `WRONGTYPE`.
  //
  // `$` is outside `ID_PATTERN`, so no valid `NodeId` can reach this string.
  // Same technique as `DAG_INPUT = "$input"`, same reason.

  it("an ABSENT scope produces the byte-identical pre-F1 key (FR-F1-008)", () => {
    // The no-migration guarantee, stated as an equality rather than a format
    // description: adding the parameter must not have moved a single existing
    // key by one byte.
    const key = buildCheckpointKey(TENANT_A, dagId("orders"), makeRunId("run-1"), makeNodeId("fetch"));
    expect(key).toBe("fugue:tenant-a:orders:run-1:fetch");
  });

  it("a mapped scope uses the existing composite codec beneath the same prefix", () => {
    expect(
      buildCheckpointKey(TENANT_A, dagId("orders"), makeRunId("run-1"), makeNodeId("fetch"), childScope(3, "fan", 2)),
    ).toBe("fugue:tenant-a:orders:run-1:fan@fetch@3@2");
    // Index 0 is a real address, NOT the canonical form. This is the same
    // decision ADR-0075 made for the composite codec: an explicit zero selects
    // the indexed keyspace, so a one-wide fan does not overwrite the node's own
    // canonical checkpoint.
    expect(
      buildCheckpointKey(TENANT_A, dagId("orders"), makeRunId("run-1"), makeNodeId("fetch"), childScope(0)),
    ).toBe("fugue:tenant-a:orders:run-1:fan@fetch@0@0");
  });

  it("index 0 is NOT the canonical key — a one-wide fan cannot clobber the node", () => {
    const canonical = buildCheckpointKey(TENANT_A, dagId("d"), makeRunId("r"), makeNodeId("n"));
    const indexed = buildCheckpointKey(TENANT_A, dagId("d"), makeRunId("r"), makeNodeId("n"), childScope(0));
    expect(indexed).not.toBe(canonical);
  });

  it("distinct indices address distinct keys — no index overwrites another (FR-F1-006)", () => {
    const keys = [0, 1, 2, 24].map((i) =>
      buildCheckpointKey(TENANT_A, dagId("d"), makeRunId("r"), makeNodeId("n"), childScope(i)),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("map, child, index and epoch independently isolate output addresses", () => {
    fc.assert(fc.property(anyNodeId, anyNodeId, fc.nat({ max: 1_000_000 }), fc.nat({ max: 1_000_000 }),
      (map, child, index, epoch) => {
        const key = (m: string, n: string, i: number, e: number) =>
          buildCheckpointKey(TENANT_A, dagId("d"), makeRunId("r"), makeNodeId(n), childScope(i, m, e));
        const addresses = [key(map, child, index, epoch), key(`${map}x`, child, index, epoch),
          key(map, `${child}x`, index, epoch), key(map, child, index + 1, epoch), key(map, child, index, epoch + 1)];
        expect(new Set(addresses).size).toBe(5);
      }), { numRuns: 400 });
  });

  it("NO valid node id can impersonate an indexed address, for any tenant/dag/run", () => {
    // `@` is outside ID_PATTERN, separating canonical and composite addresses.
    fc.assert(
      fc.property(anyTenant, colonFree, colonFree, anyNodeId, anyNodeId, fc.nat({ max: 10_000 }),
        (t, d, r, canonicalNode, fannedNode, i) => {
          const canonical = buildCheckpointKey(t, dagId(d), makeRunId(r), makeNodeId(canonicalNode));
          const indexed = buildCheckpointKey(
            t, dagId(d), makeRunId(r), makeNodeId(fannedNode), childScope(i),
          );
          return canonical !== indexed;
        }),
      { numRuns: 400 },
    );
  });

  it("NO indexed address can reach the spend key either", () => {
    // A checkpoint SET must never destroy the ledger HASH.
    fc.assert(
      fc.property(anyTenant, colonFree, colonFree, anyNodeId, fc.nat({ max: 10_000 }),
        (t, d, r, n, i) => {
          const indexed = buildCheckpointKey(t, dagId(d), makeRunId(r), makeNodeId(n), childScope(i));
          return indexed !== buildSpendKey(t, dagId(d), makeRunId(r));
        }),
      { numRuns: 400 },
    );
  });

  it("every indexed key still carries the tenant prefix (AD-4 / US2 / SC-001)", () => {
    // The index is a new way to build a key, so it is a new way to escape the
    // tenant ACL scope if it ever bypassed the prefix chokepoint.
    fc.assert(
      fc.property(anyTenant, colonFree, colonFree, anyNodeId, fc.nat({ max: 10_000 }),
        (t, d, r, n, i) =>
          buildCheckpointKey(t, dagId(d), makeRunId(r), makeNodeId(n), childScope(i))
            .startsWith(`fugue:${t}:`)),
      { numRuns: 400 },
    );
  });

  it("a node literally named `spend` does NOT collide with the spend key", () => {
    const spendKey = buildSpendKey(TENANT_A, dagId("orders"), makeRunId("run-1"));
    const checkpoint = buildCheckpointKey(
      TENANT_A, dagId("orders"), makeRunId("run-1"), makeNodeId("spend"),
    );
    expect(spendKey).not.toBe(checkpoint);
    expect(spendKey).toBe("fugue:tenant-a:orders:run-1:$spend");
  });

  it("NO valid node id can produce the spend key, for any tenant/dag/run", () => {
    // The general statement: `anyNodeId` generates the `ID_PATTERN` domain, and
    // the property is that the spend keys sit outside the image of
    // `buildCheckpointKey` entirely — not merely that a few names differ.
    fc.assert(
      fc.property(anyTenant, colonFree, colonFree, anyNodeId, (t, d, r, n) => {
        const checkpoint = buildCheckpointKey(t, dagId(d), makeRunId(r), makeNodeId(n));
        return checkpoint !== buildSpendKey(t, dagId(d), makeRunId(r));
      }),
    );
  });

  it("NO node id — bare or indexed — can reach the $meta or $nodes aggregates", () => {
    // The same statement the spend key earns, for the two aggregates the
    // checkpointer adds beneath the identical prefix. A node key colliding with
    // `$nodes` would have a `SET` destroy the run's whole readable fan; one
    // colliding with `$meta` would make every index look like a fresh run.
    fc.assert(
      fc.property(anyTenant, colonFree, colonFree, anyNodeId, fc.nat({ max: 10_000 }),
        (t, d, r, n, i) => {
          const bare = buildCheckpointKey(t, dagId(d), makeRunId(r), makeNodeId(n));
          const indexed = buildCheckpointKey(t, dagId(d), makeRunId(r), makeNodeId(n), childScope(i));
          const metaKey = buildCheckpointMetaKey(t, dagId(d), makeRunId(r));
          const nodesKey = buildCheckpointNodesKey(t, dagId(d), makeRunId(r));
          return bare !== metaKey && bare !== nodesKey
            && indexed !== metaKey && indexed !== nodesKey;
        }),
      { numRuns: 400 },
    );
  });

  it("the three $-aggregates beneath one run prefix are mutually distinct", () => {
    const args = [TENANT_A, dagId("orders"), makeRunId("run-1")] as const;
    const keys = [
      buildSpendKey(...args),
      buildCheckpointMetaKey(...args),
      buildCheckpointNodesKey(...args),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("two tenants with identical DAG + run produce DIFFERENT spend keys", () => {
    expect(buildSpendKey(TENANT_A, dagId("orders"), makeRunId("run-1"))).not.toBe(
      buildSpendKey(TENANT_B, dagId("orders"), makeRunId("run-1")),
    );
  });
});
