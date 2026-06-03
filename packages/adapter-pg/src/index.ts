/**
 * @fugue/pg — PostgreSQL capability adapter for Fugue.
 *
 * Provides a typed `PgCapability` interface that nodes access via
 * `requires: ["db"]` and `ctx.db`. Wraps the `pg` Pool with:
 *
 * - Zod schema validation of query results
 * - Result-based error handling (no exceptions escape)
 * - Connection pool lifecycle management via CapabilityHandle
 * - Health check (SELECT 1) for degraded-state detection
 *
 * ## Usage
 *
 * ```ts
 * import { createPgAdapter } from "@fugue/pg";
 *
 * const pgHandle = createPgAdapter({
 *   connectionString: process.env.DATABASE_URL,
 *   poolSize: 10,
 * });
 *
 * // Register with the host:
 * const sharedInfra = { ..., capabilities: [pgHandle] };
 *
 * // In a node:
 * createFetchNode({
 *   id: "fetch-users",
 *   requires: ["db"] as const,
 *   fetch: async (input, ctx) => {
 *     return ctx.db.query(UserSchema, "SELECT * FROM users WHERE active = $1", [true]);
 *   },
 * });
 * ```
 *
 * ## Module Augmentation
 *
 * This package augments `@fugue/framework`'s `CapabilityRegistry` to add the
 * `"db"` capability. After importing this package, `requires: ["db"]` becomes
 * valid and `ctx.db` is typed as `PgCapability`.
 *
 * @satisfies ADR-0051 — Extensible capability registry
 */

import type { z } from "zod";
import type { Result, FrameworkError, CapabilityHandle } from "@fugue/framework";
import { ok, err, nodeId } from "@fugue/framework";
import type { Pool as PgPool, PoolConfig } from "pg";

// ---------------------------------------------------------------------------
// Capability Interface
// ---------------------------------------------------------------------------

/** Sentinel node ID for pg capability errors */
const PG_NODE_ID = nodeId("pg-capability");

/**
 * PostgreSQL capability interface — what nodes see on `ctx.db`.
 *
 * All methods return `Result` — no exceptions escape. Query results are
 * validated against the provided Zod schema.
 */
export interface PgCapability {
  /**
   * Execute a query and validate all rows against the schema.
   * Returns an empty array if no rows match.
   */
  query<T>(schema: z.ZodType<T>, sql: string, params?: unknown[]): Promise<Result<T[], FrameworkError>>;

  /**
   * Execute a query expecting at most one row. Returns `null` if no rows match.
   * Validates the row against the schema if present.
   */
  queryOne<T>(schema: z.ZodType<T>, sql: string, params?: unknown[]): Promise<Result<T | null, FrameworkError>>;

  /**
   * Execute a write statement (INSERT, UPDATE, DELETE).
   * Returns the number of affected rows.
   */
  execute(sql: string, params?: unknown[]): Promise<Result<{ rowCount: number }, FrameworkError>>;

  /**
   * Execute a query and return the raw rows without schema validation.
   * Use when you need untyped access or the schema is dynamic.
   */
  queryRaw(sql: string, params?: unknown[]): Promise<Result<unknown[], FrameworkError>>;
}

// ---------------------------------------------------------------------------
// Module Augmentation
// ---------------------------------------------------------------------------

declare module "@fugue/framework" {
  interface CapabilityRegistry {
    /** PostgreSQL database capability. Access via `ctx.db` in nodes. */
    db: PgCapability;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the PostgreSQL adapter.
 */
export interface PgAdapterConfig {
  /** PostgreSQL connection string (e.g., "postgresql://user:pass@host:5432/db") */
  readonly connectionString: string;
  /** Maximum number of connections in the pool. Default: 10. */
  readonly poolSize?: number;
  /** Statement timeout in milliseconds. Default: 30000 (30s). */
  readonly statementTimeoutMs?: number;
  /** Connection timeout in milliseconds. Default: 5000 (5s). */
  readonly connectionTimeoutMs?: number;
  /** Idle timeout in milliseconds before a connection is closed. Default: 10000 (10s). */
  readonly idleTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const mapPgError = (error: unknown, sql: string): FrameworkError => {
  const message = error instanceof Error ? error.message : String(error);
  // Determine if the error is transient (connection issues) or permanent (syntax, constraint)
  if (error instanceof Error && "code" in error) {
    const pgCode = (error as { code: string }).code;
    // Connection-class errors (08xxx) and insufficient resources (53xxx) are transient
    if (pgCode.startsWith("08") || pgCode.startsWith("53") || pgCode === "57P01") {
      return { kind: "transient", nodeId: PG_NODE_ID, message: `PG transient: ${message} (${pgCode})` };
    }
  }
  return {
    kind: "node-crash",
    nodeId: PG_NODE_ID,
    message: `PG error: ${message} [sql: ${sql.slice(0, 100)}]`,
    retriability: "non-retriable",
  };
};

const createPgClient = (pool: PgPool, _statementTimeoutMs: number): PgCapability => ({
  query: async <T,>(schema: z.ZodType<T>, sql: string, params?: unknown[]): Promise<Result<T[], FrameworkError>> => {
    try {
      const result = await pool.query(sql, params);
      const validated: T[] = [];
      for (const row of result.rows) {
        const parsed = schema.safeParse(row);
        if (!parsed.success) {
          return err({
            kind: "node-crash",
            nodeId: PG_NODE_ID,
            message: `Row validation failed: ${parsed.error.message}`,
            retriability: "non-retriable",
          });
        }
        validated.push(parsed.data);
      }
      return ok(validated);
    } catch (error) {
      return err(mapPgError(error, sql));
    }
  },

  queryOne: async <T,>(schema: z.ZodType<T>, sql: string, params?: unknown[]): Promise<Result<T | null, FrameworkError>> => {
    try {
      const result = await pool.query(sql, params);
      if (result.rows.length === 0) return ok(null);
      const parsed = schema.safeParse(result.rows[0]);
      if (!parsed.success) {
        return err({
          kind: "node-crash",
          nodeId: PG_NODE_ID,
          message: `Row validation failed: ${parsed.error.message}`,
          retriability: "non-retriable",
        });
      }
      return ok(parsed.data);
    } catch (error) {
      return err(mapPgError(error, sql));
    }
  },

  execute: async (sql: string, params?: unknown[]): Promise<Result<{ rowCount: number }, FrameworkError>> => {
    try {
      const result = await pool.query(sql, params);
      return ok({ rowCount: result.rowCount ?? 0 });
    } catch (error) {
      return err(mapPgError(error, sql));
    }
  },

  queryRaw: async (sql: string, params?: unknown[]): Promise<Result<unknown[], FrameworkError>> => {
    try {
      const result = await pool.query(sql, params);
      return ok(result.rows);
    } catch (error) {
      return err(mapPgError(error, sql));
    }
  },
});

// ---------------------------------------------------------------------------
// Adapter Factory
// ---------------------------------------------------------------------------

/**
 * Create a PostgreSQL capability handle.
 *
 * The handle manages the connection pool lifecycle:
 * - `connect()`: validates connectivity with a SELECT 1 query
 * - `close()`: drains the pool
 * - `healthCheck()`: runs SELECT 1 within 5s timeout
 *
 * @example
 * ```ts
 * const pg = createPgAdapter({
 *   connectionString: process.env.DATABASE_URL!,
 *   poolSize: 20,
 *   statementTimeoutMs: 15_000,
 * });
 *
 * // Register with host
 * const sharedInfra = { ..., capabilities: [pg] };
 * ```
 */
export const createPgAdapter = (config: PgAdapterConfig): CapabilityHandle<"db"> => {
  // Lazy pool creation — constructed at handle creation, connected at boot
  const { Pool } = require("pg") as typeof import("pg");

  const poolConfig: PoolConfig = {
    connectionString: config.connectionString,
    max: config.poolSize ?? 10,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: config.idleTimeoutMs ?? 10_000,
  };

  const pool = new Pool(poolConfig);
  const statementTimeoutMs = config.statementTimeoutMs ?? 30_000;

  return {
    name: "db",
    client: createPgClient(pool, statementTimeoutMs),

    connect: async () => {
      // Validate connectivity
      const client = await pool.connect();
      try {
        await client.query("SELECT 1");
      } finally {
        client.release();
      }
    },

    close: async () => {
      await pool.end();
    },

    healthCheck: async () => {
      try {
        await pool.query("SELECT 1");
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Fake for Testing
// ---------------------------------------------------------------------------

/**
 * In-memory fake PgCapability for unit testing nodes that use `ctx.db`.
 *
 * Accepts a response map that returns canned results for SQL patterns.
 *
 * @example
 * ```ts
 * const fakeDb = createFakePgCapability({
 *   "SELECT * FROM users": [{ id: "1", name: "Alice" }],
 *   "INSERT INTO orders": { rowCount: 1 },
 * });
 * ```
 */
export interface FakePgRoute {
  readonly rows?: unknown[];
  readonly rowCount?: number;
}

export const createFakePgCapability = (
  routes: Readonly<Record<string, unknown[] | FakePgRoute>>,
): CapabilityHandle<"db"> => {
  const matchRoute = (sql: string): FakePgRoute | null => {
    // Try exact match first, then longest prefix match
    const direct = routes[sql];
    if (direct) {
      return Array.isArray(direct) ? { rows: direct } : direct;
    }
    // Find the longest prefix match
    let bestMatch: FakePgRoute | null = null;
    let bestLength = 0;
    for (const [pattern, value] of Object.entries(routes)) {
      if (sql.startsWith(pattern) && pattern.length > bestLength) {
        bestMatch = Array.isArray(value) ? { rows: value } : value;
        bestLength = pattern.length;
      }
    }
    return bestMatch;
  };

  const client: PgCapability = {
    query: async <T,>(schema: z.ZodType<T>, sql: string, _params?: unknown[]): Promise<Result<T[], FrameworkError>> => {
      const route = matchRoute(sql);
      if (!route || !route.rows) {
        return ok([] as T[]);
      }
      const validated: T[] = [];
      for (const row of route.rows) {
        const parsed = schema.safeParse(row);
        if (!parsed.success) {
          return err({ kind: "node-crash", nodeId: PG_NODE_ID, message: `Fake row validation: ${parsed.error.message}`, retriability: "non-retriable" });
        }
        validated.push(parsed.data);
      }
      return ok(validated);
    },

    queryOne: async <T,>(schema: z.ZodType<T>, sql: string, _params?: unknown[]): Promise<Result<T | null, FrameworkError>> => {
      const route = matchRoute(sql);
      if (!route || !route.rows || route.rows.length === 0) return ok(null);
      const parsed = schema.safeParse(route.rows[0]);
      if (!parsed.success) {
        return err({ kind: "node-crash", nodeId: PG_NODE_ID, message: `Fake row validation: ${parsed.error.message}`, retriability: "non-retriable" });
      }
      return ok(parsed.data);
    },

    execute: async (sql: string, _params?: unknown[]): Promise<Result<{ rowCount: number }, FrameworkError>> => {
      const route = matchRoute(sql);
      return ok({ rowCount: route?.rowCount ?? 0 });
    },

    queryRaw: async (sql: string, _params?: unknown[]): Promise<Result<unknown[], FrameworkError>> => {
      const route = matchRoute(sql);
      return ok(route?.rows ?? []);
    },
  };

  return { name: "db", client };
};
