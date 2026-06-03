/**
 * Unit tests for @fugue/pg adapter.
 *
 * Covers the real client (`createPgClient` over an injected fake pool —
 * error classification, row validation, health-check timeout) and the
 * in-memory fake (`createFakePgCapability`). No real database needed;
 * integration tests with a real Postgres would use Testcontainers.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { ok, isOk, isErr } from "@fugue/framework";
import {
  createFakePgCapability,
  createPgClient,
  mapPgError,
  healthCheckWithTimeout,
} from "../index.js";
import type { PgCapability, PgQueryable } from "../index.js";

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});

describe("@fugue/pg — createFakePgCapability", () => {
  const fakeHandle = createFakePgCapability({
    "SELECT * FROM users": [
      { id: "1", name: "Alice", email: "alice@example.com" },
      { id: "2", name: "Bob", email: "bob@example.com" },
    ],
    "SELECT * FROM users WHERE id": [
      { id: "1", name: "Alice", email: "alice@example.com" },
    ],
    "INSERT INTO orders": { rowCount: 1 },
  });

  const db: PgCapability = fakeHandle.client;

  describe("query", () => {
    it("returns all matching rows validated against schema", async () => {
      const result = await db.query(UserSchema, "SELECT * FROM users");
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value[0]?.name).toBe("Alice");
        expect(result.value[1]?.name).toBe("Bob");
      }
    });

    it("prefix match — SQL with params matches prefix route", async () => {
      const result = await db.query(UserSchema, "SELECT * FROM users WHERE id = $1", ["1"]);
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0]?.name).toBe("Alice");
      }
    });

    it("unmatched SQL returns empty array", async () => {
      const result = await db.query(UserSchema, "SELECT * FROM unknown_table");
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it("schema validation failure returns node-crash error", async () => {
      const StrictSchema = z.object({ id: z.number() }); // id is string in data
      const result = await db.query(StrictSchema, "SELECT * FROM users");
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.kind).toBe("node-crash");
      }
    });
  });

  describe("queryOne", () => {
    it("returns first row validated against schema", async () => {
      const result = await db.queryOne(UserSchema, "SELECT * FROM users WHERE id = $1", ["1"]);
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value?.name).toBe("Alice");
      }
    });

    it("returns null for unmatched SQL", async () => {
      const result = await db.queryOne(UserSchema, "SELECT * FROM nonexistent");
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe("execute", () => {
    it("returns rowCount for matched route", async () => {
      const result = await db.execute("INSERT INTO orders VALUES ($1)", ["data"]);
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value.rowCount).toBe(1);
      }
    });

    it("returns rowCount 0 for unmatched route", async () => {
      const result = await db.execute("DELETE FROM unknown");
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value.rowCount).toBe(0);
      }
    });
  });

  describe("queryRaw", () => {
    it("returns raw rows without validation", async () => {
      const result = await db.queryRaw("SELECT * FROM users");
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
      }
    });
  });

  describe("handle metadata", () => {
    it("has name 'db'", () => {
      expect(fakeHandle.name).toBe("db");
    });

    it("client is accessible", () => {
      expect(fakeHandle.client).toBeDefined();
    });
  });

  describe("longest-prefix matching", () => {
    it("when two prefixes match, the longest wins", async () => {
      const handle = createFakePgCapability({
        "SELECT * FROM users": [{ id: "broad", name: "Broad", email: "b@example.com" }],
        "SELECT * FROM users WHERE id": [{ id: "narrow", name: "Narrow", email: "n@example.com" }],
      });
      const result = await handle.client.query(UserSchema, "SELECT * FROM users WHERE id = $1", ["1"]);
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value[0]?.id).toBe("narrow");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Real client over an injected fake pool
// ---------------------------------------------------------------------------

/** Error shaped like a pg driver error (SQLSTATE in `code`). */
const pgError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

const poolThatThrows = (error: unknown): PgQueryable => ({
  query: async () => { throw error; },
});

const poolWithRows = (rows: unknown[], rowCount: number | null = rows.length): PgQueryable => ({
  query: async () => ({ rows, rowCount }),
});

describe("@fugue/pg — mapPgError classification", () => {
  it.each([
    ["08006", "connection failure"],
    ["08001", "unable to connect"],
    ["53300", "too many connections"],
    ["57P01", "admin shutdown"],
  ])("SQLSTATE %s → transient (retriable)", (code, message) => {
    const mapped = mapPgError(pgError(code, message), "SELECT 1");
    expect(mapped.kind).toBe("transient");
    if (mapped.kind === "transient") {
      expect(mapped.message).toContain(message);
      expect(mapped.message).toContain(code);
    }
  });

  it.each([
    ["42601", "syntax error"],
    ["23505", "unique constraint violation"],
    ["42P01", "relation does not exist"],
  ])("SQLSTATE %s → non-retriable node-crash", (code, message) => {
    const mapped = mapPgError(pgError(code, message), "SELECT * FROM t");
    expect(mapped.kind).toBe("node-crash");
    if (mapped.kind === "node-crash") {
      expect(mapped.retriability).toBe("non-retriable");
      expect(mapped.message).toContain(message);
    }
  });

  it("error without a code → non-retriable node-crash with truncated sql", () => {
    const longSql = `SELECT ${"x".repeat(200)}`;
    const mapped = mapPgError(new Error("plain failure"), longSql);
    expect(mapped.kind).toBe("node-crash");
    if (mapped.kind === "node-crash") {
      expect(mapped.retriability).toBe("non-retriable");
      expect(mapped.message.length).toBeLessThan(longSql.length + 50);
    }
  });

  it("non-Error value → node-crash with stringified message", () => {
    const mapped = mapPgError("weird string failure", "SELECT 1");
    expect(mapped.kind).toBe("node-crash");
    if (mapped.kind === "node-crash") {
      expect(mapped.message).toContain("weird string failure");
    }
  });
});

describe("@fugue/pg — createPgClient (real client, fake pool)", () => {
  it("query validates all rows against the schema", async () => {
    const client = createPgClient(poolWithRows([
      { id: "1", name: "Alice", email: "alice@example.com" },
      { id: "2", name: "Bob", email: "bob@example.com" },
    ]));
    const result = await client.query(UserSchema, "SELECT * FROM users");
    expect(isOk(result)).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(2);
  });

  it("query returns node-crash when any row fails validation", async () => {
    const client = createPgClient(poolWithRows([
      { id: "1", name: "Alice", email: "alice@example.com" },
      { id: "2", name: "Bob", email: "not-an-email" },
    ]));
    const result = await client.query(UserSchema, "SELECT * FROM users");
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect(result.error.kind === "node-crash" && result.error.retriability).toBe("non-retriable");
    }
  });

  it("query maps a connection-class throw to transient", async () => {
    const client = createPgClient(poolThatThrows(pgError("08006", "connection reset")));
    const result = await client.query(UserSchema, "SELECT * FROM users");
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error.kind).toBe("transient");
  });

  it("queryOne returns null on zero rows and the validated row otherwise", async () => {
    const empty = createPgClient(poolWithRows([]));
    const one = createPgClient(poolWithRows([{ id: "1", name: "Alice", email: "alice@example.com" }]));

    const noneResult = await empty.queryOne(UserSchema, "SELECT * FROM users WHERE id = $1", ["x"]);
    expect(isOk(noneResult)).toBe(true);
    if (noneResult.ok) expect(noneResult.value).toBeNull();

    const oneResult = await one.queryOne(UserSchema, "SELECT * FROM users WHERE id = $1", ["1"]);
    expect(isOk(oneResult)).toBe(true);
    if (oneResult.ok) expect(oneResult.value?.name).toBe("Alice");
  });

  it("queryOne returns node-crash on row validation failure", async () => {
    const client = createPgClient(poolWithRows([{ id: 1 }]));
    const result = await client.queryOne(UserSchema, "SELECT * FROM users WHERE id = $1", ["1"]);
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error.kind).toBe("node-crash");
  });

  it("execute returns rowCount, defaulting null to 0", async () => {
    const counted = createPgClient(poolWithRows([], 3));
    const uncounted = createPgClient(poolWithRows([], null));

    const countedResult = await counted.execute("UPDATE t SET x = 1");
    expect(isOk(countedResult)).toBe(true);
    if (countedResult.ok) expect(countedResult.value.rowCount).toBe(3);

    const uncountedResult = await uncounted.execute("UPDATE t SET x = 1");
    expect(isOk(uncountedResult)).toBe(true);
    if (uncountedResult.ok) expect(uncountedResult.value.rowCount).toBe(0);
  });

  it("execute maps errors through mapPgError", async () => {
    const client = createPgClient(poolThatThrows(pgError("23505", "duplicate key")));
    const result = await client.execute("INSERT INTO t VALUES (1)");
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect(result.error.kind === "node-crash" && result.error.retriability).toBe("non-retriable");
    }
  });

  it("queryRaw returns rows unvalidated and maps errors", async () => {
    const client = createPgClient(poolWithRows([{ anything: true }]));
    const result = await client.queryRaw("SELECT * FROM t");
    expect(isOk(result)).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ anything: true }]);

    const failing = createPgClient(poolThatThrows(pgError("53300", "too many connections")));
    const errResult = await failing.queryRaw("SELECT * FROM t");
    expect(isErr(errResult)).toBe(true);
    if (!errResult.ok) expect(errResult.error.kind).toBe("transient");
  });
});

describe("@fugue/pg — healthCheckWithTimeout", () => {
  it("healthy pool → Ok", async () => {
    const result = await healthCheckWithTimeout(poolWithRows([{ "?column?": 1 }]), 1_000);
    expect(isOk(result)).toBe(true);
  });

  it("throwing pool → Err with reason", async () => {
    const result = await healthCheckWithTimeout(poolThatThrows(pgError("08006", "down")), 1_000);
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error).toContain("down");
  });

  it("hung pool → Err after the timeout", async () => {
    const hung: PgQueryable = { query: () => new Promise(() => {}) };
    const result = await healthCheckWithTimeout(hung, 20);
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error).toContain("timed out after 20ms");
  });
});
