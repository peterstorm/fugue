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
