/**
 * Tests for `purgeTenantKeyspace` (purge-keyspace.ts) — the scan + delete leaf
 * that reclaims a deregistered tenant's `fugue:<tenant>:*` keyspace (FR-030).
 * Extracted from the supervisor composition root so its best-effort enumeration
 * invariant is covered: a single failing `del` must NOT abort enumeration — keep
 * the FIRST error, attempt every key, return the error only at the end; a `scan`
 * failure, by contrast, aborts immediately.
 *
 * Driven with an in-memory fake (no real Redis).
 */

import { describe, test, expect } from "bun:test";
import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { tenantId } from "../../../domain/tenant.js";
import type { TenantId } from "../../../domain/tenant.js";
import type { HostError } from "../../../domain/host-error.js";
import { purgeTenantKeyspace, type KeyspacePurgeRedis } from "../../../supervisor/lifecycle/purge-keyspace.js";

const tid = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`bad tenant fixture ${s}`);
  return r.value;
};

type ScanResult = { cursor: string; keys: string[] };

const hostErr = (message: string): HostError => ({ kind: "config-invalid", message });

/**
 * Fake admin-Redis: returns the supplied scan pages in call order, and routes
 * `del` through `delFor` (default: deletes 1). Records every key whose del was
 * attempted and every key successfully deleted, plus the cursors `scan` saw.
 */
const fakeRedis = (
  pages: Array<Result<ScanResult, HostError>>,
  delFor: (key: string) => Result<number, HostError> = () => ok(1),
): KeyspacePurgeRedis & {
  attempted: string[];
  deleted: string[];
  scanPatterns: string[];
  scanCursors: string[];
} => {
  let i = 0;
  const attempted: string[] = [];
  const deleted: string[] = [];
  const scanPatterns: string[] = [];
  const scanCursors: string[] = [];
  return {
    attempted,
    deleted,
    scanPatterns,
    scanCursors,
    scan: async (pattern: string, cursor?: string) => {
      scanPatterns.push(pattern);
      scanCursors.push(cursor ?? "0");
      const page = pages[i++];
      if (page === undefined) throw new Error("fake scan called more times than pages provided");
      return page;
    },
    del: async (key: string) => {
      attempted.push(key);
      const r = delFor(key);
      if (r.ok) deleted.push(key);
      return r;
    },
  };
};

describe("purgeTenantKeyspace", () => {
  test("scans the tenant-scoped pattern with cursor '0' first", async () => {
    const redis = fakeRedis([ok({ cursor: "0", keys: [] })]);
    await purgeTenantKeyspace(redis, tid("acme"));
    expect(redis.scanPatterns[0]).toBe("fugue:acme:*");
    expect(redis.scanCursors[0]).toBe("0");
  });

  test("empty keyspace is a no-op success returning 0", async () => {
    const redis = fakeRedis([ok({ cursor: "0", keys: [] })]);
    const r = await purgeTenantKeyspace(redis, tid("acme"));
    expect(r).toEqual(ok(0));
    expect(redis.deleted).toEqual([]);
  });

  test("deletes every key across paginated cursors and sums the deleted count", async () => {
    const redis = fakeRedis([
      ok({ cursor: "42", keys: ["fugue:acme:a", "fugue:acme:b"] }),
      ok({ cursor: "0", keys: ["fugue:acme:c"] }),
    ]);
    const r = await purgeTenantKeyspace(redis, tid("acme"));
    expect(r).toEqual(ok(3));
    expect(redis.deleted).toEqual(["fugue:acme:a", "fugue:acme:b", "fugue:acme:c"]);
    // Second scan continues from the cursor the first page returned.
    expect(redis.scanCursors).toEqual(["0", "42"]);
  });

  test("accumulates per-del counts (a del returning 0 contributes nothing)", async () => {
    const redis = fakeRedis(
      [ok({ cursor: "0", keys: ["a", "b", "gone"] })],
      (key) => (key === "gone" ? ok(0) : ok(1)),
    );
    const r = await purgeTenantKeyspace(redis, tid("acme"));
    expect(r).toEqual(ok(2));
  });

  test("a scan failure aborts immediately", async () => {
    const boom = hostErr("scan boom");
    const redis = fakeRedis([err(boom)]);
    const r = await purgeTenantKeyspace(redis, tid("acme"));
    expect(r).toEqual(err(boom));
    expect(redis.attempted).toEqual([]);
  });

  test("a scan failure on a later page aborts after the earlier page was purged", async () => {
    const boom = hostErr("scan boom page 2");
    const redis = fakeRedis([
      ok({ cursor: "7", keys: ["fugue:acme:a"] }),
      err(boom),
    ]);
    const r = await purgeTenantKeyspace(redis, tid("acme"));
    expect(r).toEqual(err(boom));
    expect(redis.deleted).toEqual(["fugue:acme:a"]);
  });

  test("a failing del does NOT abort enumeration — every key is still attempted", async () => {
    const delBoom = hostErr("del boom");
    const redis = fakeRedis(
      [ok({ cursor: "0", keys: ["a", "b", "c"] })],
      (key) => (key === "b" ? err(delBoom) : ok(1)),
    );
    const r = await purgeTenantKeyspace(redis, tid("acme"));
    expect(redis.attempted).toEqual(["a", "b", "c"]); // all attempted despite "b" failing
    expect(redis.deleted).toEqual(["a", "c"]);
    expect(r).toEqual(err(delBoom));
  });

  test("returns the FIRST del error when multiple keys fail", async () => {
    const first = hostErr("first del failure");
    const second = hostErr("second del failure");
    const redis = fakeRedis(
      [ok({ cursor: "0", keys: ["a", "b", "c"] })],
      (key) => (key === "a" ? err(first) : key === "c" ? err(second) : ok(1)),
    );
    const r = await purgeTenantKeyspace(redis, tid("acme"));
    expect(redis.attempted).toEqual(["a", "b", "c"]);
    expect(redis.deleted).toEqual(["b"]);
    expect(r).toEqual(err(first));
  });
});
