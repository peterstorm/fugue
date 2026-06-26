/**
 * @fuguejs/oracle — Oracle capability adapter for Fugue.
 *
 * Provides a typed `OracleCapability` interface that nodes access via
 * `requires: ["oracle"]` and `ctx.oracle`. Wraps an `oracledb` thin-mode
 * connection pool with:
 *
 * - Zod schema validation of query results
 * - Result-based error handling (no exceptions escape)
 * - Connection pool lifecycle management via CapabilityHandle
 * - Health check (SELECT 1 FROM DUAL) for degraded-state detection
 *
 * **Read-only.** The capability exposes `query`/`queryOne`/`queryRaw` only —
 * there is no write/exec surface (FR-032).
 *
 * The driver is loaded in **thin mode** (pure-JS Oracle Net over TCP — no
 * Instant Client, no native addon, musl/alpine-safe) and lazy-loaded via
 * `createRequire(import.meta.url)("oracledb")`, exactly as `@fuguejs/pg`
 * loads `pg`.
 *
 * ## Usage
 *
 * ```ts
 * import { createOracleAdapter } from "@fuguejs/oracle";
 *
 * const oracleHandle = createOracleAdapter({
 *   connectString: process.env.ORACLE_CONNECT_STRING!, // HOST:PORT/SERVICE
 *   user: process.env.ORACLE_USER!,
 *   password: process.env.ORACLE_PASSWORD!,
 *   poolMax: 8,
 * });
 *
 * // Register with the host:
 * const sharedInfra = { ..., capabilities: [oracleHandle] };
 *
 * // In a node (named binds — :name):
 * createFetchNode({
 *   id: "fetch-package",
 *   requires: ["oracle"] as const,
 *   fetch: async (input, ctx) => {
 *     return ctx.oracle.queryOne(
 *       PackageInfoRowSchema,
 *       "SELECT * FROM TABLE(GET_PACKAGE_INFO(:subId)) pkg",
 *       { subId: input.subId },
 *     );
 *   },
 * });
 * ```
 *
 * ## Module Augmentation
 *
 * This package augments `@fuguejs/framework`'s `CapabilityRegistry` to add the
 * `"oracle"` capability. After importing this package, `requires: ["oracle"]`
 * becomes valid and `ctx.oracle` is typed as `OracleCapability`.
 *
 * A distinct `"oracle"` key (not `"db"`) is used deliberately: `@fuguejs/pg`
 * already claims `"db"`, and two adapters cannot augment the same registry key.
 *
 * @satisfies ADR-0051 — Extensible capability registry
 */

import { createRequire } from "node:module";
import type { z } from "zod";
import type { Result, FrameworkError, CapabilityHandle } from "@fuguejs/framework";
import { ok, err, nodeId } from "@fuguejs/framework";

// ---------------------------------------------------------------------------
// Capability Interface
// ---------------------------------------------------------------------------

/** Sentinel node ID for oracle capability errors */
const ORACLE_NODE_ID = nodeId("oracle-capability");

/**
 * Oracle capability interface — what nodes see on `ctx.oracle`.
 *
 * All methods return `Result` — no exceptions escape. Query results are
 * validated against the provided Zod schema. Binds are **named** (`:name`)
 * and supplied as `Record<string, unknown>` — the one API divergence from
 * `@fuguejs/pg`'s positional `$1` / `unknown[]`.
 *
 * Read-only: there is intentionally no `execute`/write method.
 */
export interface OracleCapability {
  /**
   * Execute a query and validate all rows against the schema.
   * Returns an empty array if no rows match. Binds `:name` placeholders.
   */
  query<T>(schema: z.ZodType<T>, sql: string, binds?: Record<string, unknown>): Promise<Result<T[], FrameworkError>>;

  /**
   * Execute a query expecting at most one row. Returns `null` if no rows match.
   * Validates the row against the schema if present. Binds `:name` placeholders.
   */
  queryOne<T>(schema: z.ZodType<T>, sql: string, binds?: Record<string, unknown>): Promise<Result<T | null, FrameworkError>>;

  /**
   * Escape hatch: execute a query and return raw rows as `unknown[]` with NO
   * schema validation. This bypasses parse-don't-validate — every row must be
   * narrowed manually before use. Reach for `query` with a Zod schema first;
   * use this only for genuinely dynamic schemas or pass-through tooling.
   */
  queryRaw(sql: string, binds?: Record<string, unknown>): Promise<Result<unknown[], FrameworkError>>;
}

// ---------------------------------------------------------------------------
// Module Augmentation
// ---------------------------------------------------------------------------

declare module "@fuguejs/framework" {
  interface CapabilityRegistry {
    /** Oracle database capability (read-only). Access via `ctx.oracle` in nodes. */
    oracle: OracleCapability;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the Oracle adapter. Credentials come from env config
 * only — never hardcoded (FR-040) and never logged (FR-041).
 */
export interface OracleAdapterConfig {
  /** Easy-connect string: `HOST:PORT/SERVICE`. */
  readonly connectString: string;
  /** Oracle schema/user. */
  readonly user: string;
  /** Oracle password. Never logged nor included in any error message. */
  readonly password: string;
  /** Minimum number of connections kept open in the pool. Default: 0. */
  readonly poolMin?: number;
  /** Maximum number of connections in the pool. Default: 4. */
  readonly poolMax?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * ORA- codes treated as transient (retriable) connection-class failures:
 * - ORA-03113 end-of-file on communication channel
 * - ORA-03114 not connected to ORACLE
 * - ORA-12541 no listener
 * - ORA-12170 connect timeout
 * - ORA-12514 listener does not currently know of service
 */
const TRANSIENT_ORA_CODES: ReadonlySet<string> = new Set([
  "ORA-03113",
  "ORA-03114",
  "ORA-12541",
  "ORA-12170",
  "ORA-12514",
]);

/** Match every `ORA-NNNNN` code in a driver error message. Oracle stacks codes. */
const ORA_CODE_GLOBAL = /ORA-\d{5}/g;

/**
 * Read the structured numeric `errorNum` an `oracledb` error carries (e.g.
 * `12541`) and render it as a canonical `ORA-NNNNN` token. Returns undefined
 * when the field is absent or not a usable integer.
 */
const oraCodeFromErrorNum = (error: unknown): string | undefined => {
  if (error == null || typeof error !== "object") return undefined;
  const errorNum = (error as { readonly errorNum?: unknown }).errorNum;
  if (typeof errorNum !== "number" || !Number.isInteger(errorNum) || errorNum < 0) {
    return undefined;
  }
  return `ORA-${String(errorNum).padStart(5, "0")}`;
};

/**
 * Strip anything that could be a credential from a string before it is surfaced
 * or logged. Handles BOTH credential shapes Oracle connect strings / driver
 * errors carry (FR-041, NFR-020, SC-008):
 *
 *  1. easy-connect / DSN `user/password@host` fragments → `***@host`. The
 *     password MAY itself contain `@` (e.g. `u/p@ss@host`), so the credential
 *     run is consumed GREEDILY up to the LAST `@` of the whitespace-delimited
 *     token — the `@` that precedes the host. A non-greedy match would stop at
 *     the first `@` inside the password and leak the remainder (the bug this
 *     replaces). Over-redacting toward the host boundary is the safe direction.
 *  2. `password=` / `pwd=` / `user=` / `uid=` key-value pairs (TNS/JDBC
 *     long-form descriptors, e.g. `(DESCRIPTION=...(PASSWORD=secret)...)`) →
 *     `key=***`. Case-insensitive; bounded by `;`, `,`, whitespace, or `)`.
 *
 * Idempotent: `***@` and `key=***` are stable under re-application. Pure: no I/O.
 *
 * Exported so the HOST's `connectStringHost` (which surfaces the non-secret
 * host:port/service of a connect string at boot) can delegate to the SAME tested
 * stripper rather than re-implementing a weaker leading-`@` strip.
 */
export const stripCredentials = (message: string): string =>
  message
    // easy-connect / DSN style: user/password@... → ***@... (greedy to last @).
    .replace(/\b[\w.$-]+\/[^\s]*@/g, "***@")
    // bare user@host form (no `/password`): user@host:port/svc → ***@host:port/svc.
    // The lookahead requires a host-like token followed by `:` (port) or `/`
    // (service) so this only fires on a connect-string `userinfo@host`, not on
    // ordinary prose. `***@` is left intact (`*` ∉ [\w.$-]), so this stays
    // idempotent and composes with the easy-connect rule above.
    .replace(/\b[\w.$-]+@(?=[\w.$-]+[:/])/g, "***@")
    // key=value password fields (password=, pwd=, user=, uid=).
    .replace(/\b(password|pwd|user|uid)\s*=\s*[^;,\s)]+/gi, "$1=***");

/**
 * Map an `oracledb` error to a `FrameworkError`. Connection-class ORA- codes
 * (`ORA-03113/03114/12541/12170/12514`) are `transient` (retriable);
 * everything else (syntax, missing table, etc.) is a non-retriable
 * `node-crash`. Credentials are stripped from every message. Exported for
 * testing — this classification drives retry behavior.
 */
export const mapOracleError = (error: unknown, sql: string): FrameworkError => {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = stripCredentials(rawMessage);

  // Prefer the driver's structured numeric `errorNum` when present (it is the
  // unambiguous code), then fall back to scanning the message. Oracle commonly
  // STACKS several ORA codes in one message (a generic ORA-06512 / ORA-00604
  // wrapping a transient ORA-12541), so match ALL codes — classify transient
  // if ANY of them is connection-class, regardless of position.
  const structuredCode = oraCodeFromErrorNum(error);
  const messageCodes = message.match(ORA_CODE_GLOBAL) ?? [];
  const allCodes = structuredCode != null ? [structuredCode, ...messageCodes] : messageCodes;

  const transientCode = allCodes.find((code) => TRANSIENT_ORA_CODES.has(code));
  if (transientCode != null) {
    return { kind: "transient", nodeId: ORACLE_NODE_ID, message: `Oracle transient: ${message} (${transientCode})` };
  }

  return {
    kind: "node-crash",
    nodeId: ORACLE_NODE_ID,
    message: `Oracle error: ${message} [sql: ${stripCredentials(sql).slice(0, 100)}]`,
    retriability: "non-retriable",
  };
};

/**
 * The slice of a pooled `oracledb` connection (or the pool itself) that the
 * capability client actually uses. Tests inject a fake; production passes a
 * thin shim over `pool.getConnection()` → `conn.execute()` → `conn.close()`
 * (structurally compatible).
 */
export interface OracleQueryable {
  execute(
    sql: string,
    binds?: Record<string, unknown>,
    opts?: { readonly outFormat?: unknown },
  ): Promise<{ rows?: unknown[] }>;
}

/**
 * Build an `OracleCapability` over an injected queryable seam. Exported for
 * testing — `createOracleAdapter` is the production entry point that owns pool
 * construction and lifecycle.
 *
 * `outFormat` is supplied per execute by the seam itself (the adapter sets
 * `OUT_FORMAT_OBJECT`); the client passes binds through verbatim.
 */
export const createOracleClient = (queryable: OracleQueryable): OracleCapability => ({
  query: async <T,>(schema: z.ZodType<T>, sql: string, binds?: Record<string, unknown>): Promise<Result<T[], FrameworkError>> => {
    try {
      const result = await queryable.execute(sql, binds ?? {});
      const rows = result.rows ?? [];
      const validated: T[] = [];
      for (const row of rows) {
        const parsed = schema.safeParse(row);
        if (!parsed.success) {
          return err({
            kind: "node-crash",
            nodeId: ORACLE_NODE_ID,
            message: `Row validation failed: ${parsed.error.message}`,
            retriability: "non-retriable",
          });
        }
        validated.push(parsed.data);
      }
      return ok(validated);
    } catch (error) {
      return err(mapOracleError(error, sql));
    }
  },

  queryOne: async <T,>(schema: z.ZodType<T>, sql: string, binds?: Record<string, unknown>): Promise<Result<T | null, FrameworkError>> => {
    try {
      const result = await queryable.execute(sql, binds ?? {});
      const rows = result.rows ?? [];
      if (rows.length === 0) return ok(null);
      const parsed = schema.safeParse(rows[0]);
      if (!parsed.success) {
        return err({
          kind: "node-crash",
          nodeId: ORACLE_NODE_ID,
          message: `Row validation failed: ${parsed.error.message}`,
          retriability: "non-retriable",
        });
      }
      return ok(parsed.data);
    } catch (error) {
      return err(mapOracleError(error, sql));
    }
  },

  queryRaw: async (sql: string, binds?: Record<string, unknown>): Promise<Result<unknown[], FrameworkError>> => {
    try {
      const result = await queryable.execute(sql, binds ?? {});
      return ok(result.rows ?? []);
    } catch (error) {
      return err(mapOracleError(error, sql));
    }
  },
});

// ---------------------------------------------------------------------------
// Adapter Factory
// ---------------------------------------------------------------------------

/** Health checks are bounded by this timeout so a hung pool reports unhealthy. */
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/**
 * Session fix-up SQL run ONCE per freshly-created pooled connection (via the
 * pool's `sessionCallback`). It pins the session's numeric formatting so the
 * driver renders NUMBER columns to strings with a PERIOD decimal separator,
 * INDEPENDENT of the database's default locale.
 *
 * Why this exists: the prod OISTERTS database defaults to a Danish locale
 * (`NLS_NUMERIC_CHARACTERS = ',.'`), so price columns (e.g. `GET_PACKAGE_INFO`'s
 * `PACK_FEE_PRICE`) came back as `"74,25"` — a COMMA decimal that a canonical
 * period-decimal parser rejects, collapsing real figures to "unknown" even when
 * the value is genuinely present. Prices are NUMBERs; the separator is a pure
 * locale artifact, so the deterministic fix belongs HERE at the adapter seam
 * (every Oracle-number-as-string consumer benefits) rather than baked into one
 * caller's parser. The two-char value is decimal + group; the group char is
 * irrelevant for implicit NUMBER→string conversion (no group separators are
 * emitted without an explicit format model), so only the leading period matters.
 */
export const ORACLE_SESSION_NLS_SQL = "ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '. '";

/**
 * Minimal structural view of the parts of the `oracledb` module the adapter
 * touches. Kept here (rather than importing the SDK types into core
 * signatures) so the lazy `require` call has a precise shape without leaking
 * the vendor surface.
 */
interface OracleDbModule {
  readonly OUT_FORMAT_OBJECT: number;
  createPool(config: {
    readonly connectString: string;
    readonly user: string;
    readonly password: string;
    readonly poolMin: number;
    readonly poolMax: number;
    // Node-callback-form session fix-up: oracledb invokes it on each
    // newly-created physical connection and waits for `callbackFn()` before
    // handing the connection out. The CALLBACK form is mandatory here — the
    // promise/async form HANGS under oracledb thin mode (getConnection never
    // resolves). See `ORACLE_SESSION_NLS_SQL`.
    readonly sessionCallback?: (
      connection: OracleConnection,
      requestedTag: string,
      callbackFn: (error?: unknown) => void,
    ) => void;
  }): Promise<OraclePool>;
}

interface OracleConnection {
  execute(
    sql: string,
    binds?: Record<string, unknown>,
    opts?: { readonly outFormat?: unknown },
  ): Promise<{ rows?: unknown[] }>;
  close(): Promise<void>;
}

interface OraclePool {
  getConnection(): Promise<OracleConnection>;
  close(drainTimeSeconds: number): Promise<void>;
}

/**
 * Create an Oracle capability handle.
 *
 * The handle manages the connection pool lifecycle:
 * - `connect()`: validates connectivity with `SELECT 1 FROM DUAL`
 * - `close()`: closes the pool immediately (`pool.close(0)`, zero drain window)
 * - `healthCheck()`: runs `SELECT 1 FROM DUAL`, racing a 5s timeout
 *
 * The driver is loaded lazily via `createRequire` in **thin mode** (the
 * `oracledb` 7.x default). Each query acquires and releases a pooled
 * connection, amortizing connection cost so a single lookup stays within the
 * p95 budget (NFR-001 / SC-004).
 *
 * @example
 * ```ts
 * const oracle = createOracleAdapter({
 *   connectString: process.env.ORACLE_CONNECT_STRING!,
 *   user: process.env.ORACLE_USER!,
 *   password: process.env.ORACLE_PASSWORD!,
 *   poolMax: 8,
 * });
 * const sharedInfra = { ..., capabilities: [oracle] };
 * ```
 */
export const createOracleAdapter = (config: OracleAdapterConfig): CapabilityHandle<"oracle"> => {
  // `createRequire` keeps the lazy-CJS load working under both Bun and plain
  // Node ESM (a bare `require` is undefined in Node ESM module scope). Thin
  // mode is the oracledb 7.x default — no Instant Client / native addon.
  const requireModule = createRequire(import.meta.url);
  const oracledb = requireModule("oracledb") as OracleDbModule;

  const poolMin = config.poolMin ?? 0;
  const poolMax = config.poolMax ?? 4;

  // The pool is created eagerly (returns a Promise); we acquire connections
  // per query. Construction is deferred behind a lazily-awaited promise so the
  // handle is synchronous to build (mirrors pg's synchronous `new Pool`).
  let poolPromise: Promise<OraclePool> | undefined;
  const getPool = (): Promise<OraclePool> => {
    if (poolPromise == null) {
      poolPromise = oracledb
        .createPool({
          connectString: config.connectString,
          user: config.user,
          password: config.password,
          poolMin,
          poolMax,
          // Pin numeric locale once per physical connection so NUMBER→string
          // prices use a period decimal regardless of the DB's default locale
          // (see ORACLE_SESSION_NLS_SQL). Amortized across every query on the
          // connection rather than paid per getConnection(). MUST be the
          // node-callback form — the async/promise form hangs in thin mode.
          sessionCallback: (connection, _requestedTag, callbackFn) => {
            connection
              .execute(ORACLE_SESSION_NLS_SQL)
              .then(() => callbackFn())
              .catch((e: unknown) => callbackFn(e));
          },
        })
        .catch((e) => {
          // Reset so a transient createPool failure (DNS blip, listener not yet
          // up, ORA-12541 during a rolling DB restart) can be retried on the
          // next call rather than wedging the capability with a permanently
          // cached rejection. Mirrors realm-jwt-verifier's jwksPromise reset and
          // honours mapOracleError's transient/retriable classification. Also
          // makes `close()` a clean no-op after a failed open (poolPromise is
          // undefined again rather than a rejected promise it would re-await).
          poolPromise = undefined;
          throw e;
        });
    }
    return poolPromise;
  };

  // Production queryable: acquire a pooled connection, execute with
  // OUT_FORMAT_OBJECT, always release the connection.
  const queryable: OracleQueryable = {
    execute: async (sql, binds, opts) => {
      const pool = await getPool();
      const conn = await pool.getConnection();
      try {
        return await conn.execute(sql, binds ?? {}, {
          outFormat: opts?.outFormat ?? oracledb.OUT_FORMAT_OBJECT,
        });
      } finally {
        await conn.close();
      }
    },
  };

  return {
    name: "oracle",
    client: createOracleClient(queryable),

    connect: async () => {
      // Validate connectivity through the pool. ANY failure here — pool
      // creation (createPool DSN parse), getConnection (ORA-12154/ORA-01017),
      // or the SELECT 1 — must surface CREDENTIAL-STRIPPED: oracledb connect-time
      // errors routinely echo the supplied connectString/DSN, and this error
      // propagates to the boot log and the abort HostError (createHost
      // connectAll). Mirror healthCheckWithTimeout: re-throw with the message run
      // through stripCredentials, releasing the connection in finally (FR-041 /
      // NFR-020 / SC-008).
      let conn: OracleConnection | undefined;
      try {
        const pool = await getPool();
        conn = await pool.getConnection();
        await conn.execute("SELECT 1 FROM DUAL", {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      } catch (e) {
        throw new Error(stripCredentials(e instanceof Error ? e.message : String(e)));
      } finally {
        // The connection is only acquired if getConnection() resolved; release it
        // even when SELECT 1 throws. close() failures are swallowed — the
        // original (stripped) error is the one worth surfacing.
        if (conn != null) {
          try {
            await conn.close();
          } catch {
            // ignore: a release failure must not mask the connect error.
          }
        }
      }
    },

    close: async () => {
      if (poolPromise == null) return;
      const pool = await poolPromise;
      await pool.close(0);
    },

    healthCheck: () => healthCheckWithTimeout(queryable, HEALTH_CHECK_TIMEOUT_MS),
  };
};

/**
 * Race `SELECT 1 FROM DUAL` against a timeout. A pool that hangs (e.g.
 * exhausted connections, dead network) reports unhealthy instead of stalling
 * the caller. Exported for testing.
 */
export const healthCheckWithTimeout = async (
  queryable: OracleQueryable,
  timeoutMs: number,
): Promise<Result<void, string>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Hold the execute promise so that, if the timeout wins the race, we can
  // still attach a catch to the (now losing) in-flight execute. Without this a
  // later rejection — a hung connection eventually erroring, or the production
  // seam's `conn.close()` throwing in `finally` — becomes a process-level
  // unhandledRejection AFTER we already returned Err(timeout). Swallow it with
  // intent: the timeout result has already been decided.
  const executePromise = queryable.execute("SELECT 1 FROM DUAL", {});
  executePromise.catch(() => {});
  try {
    await Promise.race([
      executePromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`health check timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return ok(undefined);
  } catch (e) {
    return err(stripCredentials(e instanceof Error ? e.message : String(e)));
  } finally {
    if (timer != null) clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Fake for Testing
// ---------------------------------------------------------------------------

/**
 * In-memory fake OracleCapability for unit testing nodes that use
 * `ctx.oracle`.
 *
 * Accepts a response map that returns canned results for SQL. Matching is
 * **exact by default**: a route keyed on a full SQL string matches only that
 * exact SQL the real adapter would run. This keeps a test from passing against
 * a query the production pool would never execute.
 *
 * Prefix matching is **opt-in** per route via `{ rows, prefix: true }`: only
 * routes explicitly flagged participate in the longest-`startsWith` fallback,
 * and only when no exact key matched. Reach for it when you deliberately want a
 * broad match (e.g. a query whose binds are interpolated into the SQL string);
 * keep flagged keys specific enough that one can't accidentally swallow another's
 * query. Binds are not inspected, so this fake cannot catch a wrong-`:name`
 * binding bug regardless of match mode.
 *
 * @example
 * ```ts
 * const fakeOracle = createFakeOracleCapability({
 *   // exact match (default) — matches this SQL and nothing else
 *   "SELECT * FROM packages": [{ optionKey: "X", standardPrice: "199", discountPrice: "99" }],
 *   // opt-in prefix match — matches any SQL starting with this string
 *   "SELECT * FROM TABLE(GET_PACKAGE_INFO": { prefix: true, rows: [{ optionKey: "Y", standardPrice: "1", discountPrice: "1" }] },
 * });
 * ```
 */
export interface FakeOracleRoute {
  readonly rows?: unknown[];
  /**
   * When `true`, this route matches any SQL that `startsWith` its key (longest
   * flagged prefix wins), used only after an exact-key match fails. Default
   * `false`/absent → exact-SQL match only. Opt-in to avoid silently swallowing
   * an unrelated query whose text happens to share a prefix.
   */
  readonly prefix?: boolean;
}

export const createFakeOracleCapability = (
  routes: Readonly<Record<string, unknown[] | FakeOracleRoute>>,
): CapabilityHandle<"oracle"> => {
  const matchRoute = (sql: string): FakeOracleRoute | null => {
    // Exact match always wins.
    const direct = routes[sql];
    if (direct) {
      return Array.isArray(direct) ? { rows: direct } : direct;
    }
    // Longest-prefix fallback, restricted to routes that opted in with
    // `prefix: true`. An array-shorthand or a route without the flag never
    // participates, so it can only ever match its exact key.
    let bestMatch: FakeOracleRoute | null = null;
    let bestLength = 0;
    for (const [pattern, value] of Object.entries(routes)) {
      if (Array.isArray(value) || value.prefix !== true) continue;
      if (sql.startsWith(pattern) && pattern.length > bestLength) {
        bestMatch = value;
        bestLength = pattern.length;
      }
    }
    return bestMatch;
  };

  const client: OracleCapability = {
    query: async <T,>(schema: z.ZodType<T>, sql: string, _binds?: Record<string, unknown>): Promise<Result<T[], FrameworkError>> => {
      const route = matchRoute(sql);
      if (!route || !route.rows) {
        return ok([] as T[]);
      }
      const validated: T[] = [];
      for (const row of route.rows) {
        const parsed = schema.safeParse(row);
        if (!parsed.success) {
          return err({ kind: "node-crash", nodeId: ORACLE_NODE_ID, message: `Fake row validation: ${parsed.error.message}`, retriability: "non-retriable" });
        }
        validated.push(parsed.data);
      }
      return ok(validated);
    },

    queryOne: async <T,>(schema: z.ZodType<T>, sql: string, _binds?: Record<string, unknown>): Promise<Result<T | null, FrameworkError>> => {
      const route = matchRoute(sql);
      if (!route || !route.rows || route.rows.length === 0) return ok(null);
      const parsed = schema.safeParse(route.rows[0]);
      if (!parsed.success) {
        return err({ kind: "node-crash", nodeId: ORACLE_NODE_ID, message: `Fake row validation: ${parsed.error.message}`, retriability: "non-retriable" });
      }
      return ok(parsed.data);
    },

    queryRaw: async (sql: string, _binds?: Record<string, unknown>): Promise<Result<unknown[], FrameworkError>> => {
      const route = matchRoute(sql);
      return ok(route?.rows ?? []);
    },
  };

  return { name: "oracle", client };
};
