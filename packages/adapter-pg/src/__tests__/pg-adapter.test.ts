/**
 * Unit tests for @fugue/pg adapter.
 *
 * Tests the fake PgCapability implementation (no real database needed).
 * Integration tests with a real Postgres would use Testcontainers.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { ok, isOk, isErr } from "@fugue/framework";
import { createFakePgCapability } from "../index.js";
import type { PgCapability } from "../index.js";

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
});
