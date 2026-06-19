/**
 * The `X-Fugue-Tenant` header contract (T6/T7 SHARED). Asserts sign/verify round
 * trips and every fail-closed verification branch — these are the exact functions
 * T7's supervisor imports to STAMP the header, so a regression here breaks proxy
 * routing for every worker.
 */

import { describe, it, expect } from "bun:test";
import {
  TENANT_HEADER_NAME,
  signTenantHeader,
  verifyTenantHeader,
} from "../../domain/tenant-header.js";

const KEY = "internal-supervisor-hmac-key";

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
