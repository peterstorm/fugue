/**
 * @fuguejs/pg — PostgreSQL capability adapter for Fugue.
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
 * import { createPgAdapter } from "@fuguejs/pg";
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
 * This package augments `@fuguejs/framework`'s `CapabilityRegistry` to add the
 * `"db"` capability. After importing this package, `requires: ["db"]` becomes
 * valid and `ctx.db` is typed as `PgCapability`.
 *
 * @satisfies ADR-0051 — Extensible capability registry
 */

import { createRequire } from "node:module";
import type { z } from "zod";
import type { Result, FrameworkError, CapabilityHandle } from "@fuguejs/framework";
import { ok, err, nodeId, probeErrorCode, safeErrorMessage } from "@fuguejs/framework";
import type { PoolConfig } from "pg";

// ---------------------------------------------------------------------------
// Capability Interface
// ---------------------------------------------------------------------------

/** Sentinel node ID for pg capability errors */
const PG_NODE_ID = nodeId("pg-capability");

/**
 * THE one non-retriable `node-crash` for this adapter. Every crash it reports is
 * deterministic — a schema mismatch, a PG error outside the transient classes —
 * so `retriability` is fixed here rather than repeated at each site, where an
 * omission would silently fall back to retriable and turn a permanent failure
 * into a retry storm against the database.
 */
const pgCrash = (message: string): FrameworkError => ({
  kind: "node-crash",
  nodeId: PG_NODE_ID,
  message,
  retriability: "non-retriable",
});

/**
 * The row-validation failure shared by production and fake query paths. Schema
 * mismatch is deterministic, so the shared `pgCrash` classification prevents a
 * missing retriability field from turning it into a database retry storm.
 */
const rowValidationError = (label: string, detail: string): FrameworkError =>
  pgCrash(label + ": " + detail);

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
   * Execute a query and return the first row, or `null` if no rows match.
   * Validates that first row against the schema if present; additional rows are ignored.
   */
  queryOne<T>(schema: z.ZodType<T>, sql: string, params?: unknown[]): Promise<Result<T | null, FrameworkError>>;

  /**
   * Execute a write statement (INSERT, UPDATE, DELETE).
   * Returns the number of affected rows.
   */
  execute(sql: string, params?: unknown[]): Promise<Result<{ rowCount: number }, FrameworkError>>;

  /**
   * Escape hatch: execute a query and return raw rows as `unknown[]` with NO
   * schema validation. This bypasses parse-don't-validate — every row must be
   * narrowed manually before use. Reach for `query` with a Zod schema first;
   * use this only for genuinely dynamic schemas (e.g. `information_schema`
   * introspection) or pass-through tooling.
   */
  queryRaw(sql: string, params?: unknown[]): Promise<Result<unknown[], FrameworkError>>;
}

// ---------------------------------------------------------------------------
// Module Augmentation
// ---------------------------------------------------------------------------

declare module "@fuguejs/framework" {
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

/**
 * Map a `pg` error to a `FrameworkError`. Connection-class SQLSTATEs
 * (08xxx), insufficient-resources (53xxx), and admin shutdown (57P01) are
 * `transient` (retriable); everything else (syntax, constraint, etc.) is a
 * non-retriable `node-crash`. Exported for testing — this classification
 * drives retry behavior.
 */
export const mapPgError = (error: unknown, sql: string): FrameworkError => {
  const message = safeErrorMessage(error);
  // Determine if the error is transient (connection issues) or permanent (syntax, constraint).
  // The total probe preserves the Result boundary even for hostile proxies and
  // throwing accessors at the driver boundary.
  const code = probeErrorCode(error);
  if (code.kind === "code") {
    const pgCode = code.code;
    // Connection-class errors (08xxx) and insufficient resources (53xxx) are transient
    if (pgCode.startsWith("08") || pgCode.startsWith("53") || pgCode === "57P01") {
      return { kind: "transient", nodeId: PG_NODE_ID, message: `PG transient: ${message} (${pgCode})` };
    }
  }
  return pgCrash(`PG error: ${message} [sql: ${sql.slice(0, 100)}]`);
};

/**
 * The slice of `pg.Pool` the capability client actually uses. Tests inject a
 * fake; production passes the real pool (structurally compatible).
 */
export interface PgQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/**
 * Validate every row against the caller's schema, failing on the FIRST bad row.
 *
 * ONE encoding (round-38 cs-25) of the row-validation loop the real client and
 * the fake each carried; they differ only in the label their validation failure
 * names, so a schema-rejection reads the same shape from either.
 */
const validateRows = <T,>(
  schema: z.ZodType<T>,
  rows: readonly unknown[],
  label: string,
): Result<T[], FrameworkError> => {
  const validated: T[] = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (!parsed.success) {
      return err(rowValidationError(label, parsed.error.message));
    }
    validated.push(parsed.data);
  }
  return ok(validated);
};

/** `validateRows` for the at-most-one-row shape: no rows reads as `ok(null)`. */
const validateFirstRow = <T,>(
  schema: z.ZodType<T>,
  rows: readonly unknown[],
  label: string,
): Result<T | null, FrameworkError> => {
  if (rows.length === 0) return ok(null);
  const parsed = schema.safeParse(rows[0]);
  return parsed.success
    ? ok(parsed.data)
    : err(rowValidationError(label, parsed.error.message));
};

/**
 * Build a `PgCapability` over an injected pool. Exported for testing —
 * `createPgAdapter` is the production entry point that owns pool
 * construction and lifecycle.
 */
export const createPgClient = (pool: PgQueryable): PgCapability => {
  /**
   * Run one pooled statement and project its result, mapping ANY thrown driver
   * error onto the typed `mapPgError` failure. ONE encoding of the
   * try/catch-around-`pool.query` shape all four methods need — an arm that
   * forgot the catch would surface a raw driver exception through a
   * `Result`-typed port.
   */
  const run = async <T,>(
    sql: string,
    params: unknown[] | undefined,
    project: (result: Awaited<ReturnType<PgQueryable["query"]>>) => Result<T, FrameworkError>,
  ): Promise<Result<T, FrameworkError>> => {
    try {
      return project(await pool.query(sql, params));
    } catch (error) {
      return err(mapPgError(error, sql));
    }
  };

  return {
    query: <T,>(schema: z.ZodType<T>, sql: string, params?: unknown[]): Promise<Result<T[], FrameworkError>> =>
      run(sql, params, (result) => validateRows(schema, result.rows, "Row validation failed")),

    queryOne: <T,>(schema: z.ZodType<T>, sql: string, params?: unknown[]): Promise<Result<T | null, FrameworkError>> =>
      run(sql, params, (result) => validateFirstRow(schema, result.rows, "Row validation failed")),

    execute: (sql: string, params?: unknown[]): Promise<Result<{ rowCount: number }, FrameworkError>> =>
      run(sql, params, (result) => ok({ rowCount: result.rowCount ?? 0 })),

    queryRaw: (sql: string, params?: unknown[]): Promise<Result<unknown[], FrameworkError>> =>
      run(sql, params, (result) => ok(result.rows)),
  };
};

// ---------------------------------------------------------------------------
// Adapter Factory
// ---------------------------------------------------------------------------

/** Health checks are bounded by this timeout so a hung pool reports unhealthy. */
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/**
 * Create a PostgreSQL capability handle.
 *
 * The handle manages the connection pool lifecycle:
 * - `connect()`: validates connectivity with a SELECT 1 query
 * - `close()`: drains the pool
 * - `healthCheck()`: runs SELECT 1, racing a 5s timeout
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
  // Lazy pool creation — constructed at handle creation, connected at boot.
  // `createRequire` keeps the lazy-CJS load working under both Bun and plain
  // Node ESM (a bare `require` is undefined in Node ESM module scope).
  const requireModule = createRequire(import.meta.url);
  const { Pool } = requireModule("pg") as typeof import("pg");

  const poolConfig: PoolConfig = {
    connectionString: config.connectionString,
    max: config.poolSize ?? 10,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: config.idleTimeoutMs ?? 10_000,
    statement_timeout: config.statementTimeoutMs ?? 30_000,
  };

  const pool = new Pool(poolConfig);

  return {
    name: "db",
    client: createPgClient(pool),

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

    healthCheck: () => healthCheckWithTimeout(pool, HEALTH_CHECK_TIMEOUT_MS),
  };
};

const warnPgWithoutThrowing = (error: unknown): void => {
  try {
    console.warn(`[pg] health check: late probe failure after timeout: ${safeErrorMessage(error)}`);
  } catch {
    // Diagnostics are subordinate to the already-decided timeout verdict.
  }
};

/**
 * Race SELECT 1 against a timeout. A pool that hangs (e.g. exhausted
 * connections, dead network) reports unhealthy instead of stalling the
 * caller. Exported for testing.
 */
export const healthCheckWithTimeout = async (
  pool: PgQueryable,
  timeoutMs: number,
): Promise<Result<void, string>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const query = pool.query("SELECT 1");
    query.catch((lateError: unknown) => {
      if (timedOut) warnPgWithoutThrowing(lateError);
    });
    await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`health check timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    return ok(undefined);
  } catch (e) {
    return err(safeErrorMessage(e));
  } finally {
    if (timer != null) clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Fake for Testing
// ---------------------------------------------------------------------------

/**
 * In-memory fake PgCapability for unit testing nodes that use `ctx.db`.
 *
 * Accepts a response map that returns canned results for exact SQL strings.
 * Query parameters are part of the route contract when supplied, so a fake
 * cannot silently accept a query that production would bind differently.
 *
 * @example
 * ```ts
 * const fakeDb = createFakePgCapability({
 *   "SELECT * FROM users": [{ id: "1", name: "Alice" }],
 *   "INSERT INTO orders": { rowCount: 1 },
 * });
 * ```
 */
interface FakePgRoute {
  readonly rows?: unknown[];
  readonly rowCount?: number;
  /** Exact positional bindings required by this canned response. */
  readonly params?: readonly unknown[];
}

export const createFakePgCapability = (
  routes: Readonly<Record<string, unknown[] | FakePgRoute>>,
): CapabilityHandle<"db"> => {
  const matchRoute = (sql: string, params?: unknown[]): FakePgRoute | null => {
    const direct = routes[sql];
    if (direct === undefined) return null;
    const route = Array.isArray(direct) ? { rows: direct } : direct;
    return route.params === undefined || JSON.stringify(route.params) === JSON.stringify(params ?? [])
      ? route
      : null;
  };

  const client: PgCapability = {
    query: async <T,>(schema: z.ZodType<T>, sql: string, params?: unknown[]): Promise<Result<T[], FrameworkError>> => {
      const route = matchRoute(sql, params);
      if (!route || !route.rows) {
        return ok([] as T[]);
      }
      return validateRows(schema, route.rows, "Fake row validation");
    },

    queryOne: async <T,>(schema: z.ZodType<T>, sql: string, params?: unknown[]): Promise<Result<T | null, FrameworkError>> => {
      const route = matchRoute(sql, params);
      return validateFirstRow(schema, route?.rows ?? [], "Fake row validation");
    },

    execute: async (sql: string, params?: unknown[]): Promise<Result<{ rowCount: number }, FrameworkError>> => {
      const route = matchRoute(sql, params);
      return ok({ rowCount: route?.rowCount ?? 0 });
    },

    queryRaw: async (sql: string, params?: unknown[]): Promise<Result<unknown[], FrameworkError>> => {
      const route = matchRoute(sql, params);
      return ok(route?.rows ?? []);
    },
  };

  return { name: "db", client };
};
