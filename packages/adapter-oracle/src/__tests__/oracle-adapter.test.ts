/**
 * Unit tests for @fuguejs/oracle adapter.
 *
 * Covers the real client (`createOracleClient` over an injected fake
 * queryable — error classification, row validation, named-bind pass-through,
 * health-check timeout) and the in-memory fake (`createFakeOracleCapability`).
 * No real database needed; the only real connection is the gated CI
 * smoke-connect.
 */

import { describe, it, expect, mock } from "bun:test";
import { z } from "zod";
import { isOk, isErr } from "@fuguejs/framework";
import {
  createFakeOracleCapability,
  createOracleClient,
  createOracleAdapter,
  mapOracleError,
  healthCheckWithTimeout,
  stripCredentials,
  ORACLE_SESSION_NLS_SQL,
} from "../index.js";
import type { OracleCapability, OracleQueryable } from "../index.js";

const PackageSchema = z.object({
  optionKey: z.string(),
  standardPrice: z.string(),
  discountPrice: z.string(),
});

// ---------------------------------------------------------------------------
// Fake capability — routing
// ---------------------------------------------------------------------------

describe("@fuguejs/oracle — createFakeOracleCapability", () => {
  const fakeHandle = createFakeOracleCapability({
    "SELECT * FROM TABLE(GET_PACKAGE_INFO": {
      prefix: true,
      rows: [{ optionKey: "A", standardPrice: "199", discountPrice: "99" }],
    },
    "SELECT * FROM TABLE(GET_PACKAGE_INFO(:subId)) pkg WHERE pkg.foo": {
      prefix: true,
      rows: [{ optionKey: "NARROW", standardPrice: "299", discountPrice: "199" }],
    },
    "SELECT * FROM packages": [
      { optionKey: "B", standardPrice: "299", discountPrice: "199" },
      { optionKey: "C", standardPrice: "399", discountPrice: "299" },
    ],
  });

  const oracle: OracleCapability = fakeHandle.client;

  describe("query", () => {
    it("returns all matching rows validated against schema", async () => {
      const result = await oracle.query(PackageSchema, "SELECT * FROM packages");
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value[0]?.optionKey).toBe("B");
      }
    });

    it("prefix match — SQL with binds matches prefix route", async () => {
      const result = await oracle.query(
        PackageSchema,
        "SELECT * FROM TABLE(GET_PACKAGE_INFO(:subId)) pkg",
        { subId: "123" },
      );
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0]?.optionKey).toBe("A");
      }
    });

    it("unmatched SQL returns empty array", async () => {
      const result = await oracle.query(PackageSchema, "SELECT * FROM unknown_table");
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it("schema validation failure returns node-crash error", async () => {
      const StrictSchema = z.object({ standardPrice: z.number() }); // string in data
      const result = await oracle.query(StrictSchema, "SELECT * FROM packages");
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.kind).toBe("node-crash");
      }
    });
  });

  describe("queryOne", () => {
    it("returns first row validated against schema", async () => {
      const result = await oracle.queryOne(
        PackageSchema,
        "SELECT * FROM TABLE(GET_PACKAGE_INFO(:subId)) pkg",
        { subId: "1" },
      );
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value?.optionKey).toBe("A");
      }
    });

    it("returns null for unmatched SQL", async () => {
      const result = await oracle.queryOne(PackageSchema, "SELECT * FROM nonexistent");
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe("queryRaw", () => {
    it("returns raw rows without validation", async () => {
      const result = await oracle.queryRaw("SELECT * FROM packages");
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
      }
    });
  });

  describe("handle metadata", () => {
    it("has name 'oracle'", () => {
      expect(fakeHandle.name).toBe("oracle");
    });

    it("client is accessible", () => {
      expect(fakeHandle.client).toBeDefined();
    });
  });

  describe("longest-prefix matching", () => {
    it("when two opt-in prefixes match, the longest wins", async () => {
      const handle = createFakeOracleCapability({
        "SELECT * FROM TABLE(GET_PACKAGE_INFO": { prefix: true, rows: [{ optionKey: "broad", standardPrice: "1", discountPrice: "1" }] },
        "SELECT * FROM TABLE(GET_PACKAGE_INFO(:subId)) pkg WHERE pkg.foo": { prefix: true, rows: [{ optionKey: "narrow", standardPrice: "2", discountPrice: "1" }] },
      });
      const result = await handle.client.query(
        PackageSchema,
        "SELECT * FROM TABLE(GET_PACKAGE_INFO(:subId)) pkg WHERE pkg.foo = :foo",
        { subId: "1", foo: "x" },
      );
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value[0]?.optionKey).toBe("narrow");
      }
    });

    it("exact (non-prefix) routes do NOT match a query that merely shares their prefix", async () => {
      // The default route is an exact key. A longer query that starts with it
      // must NOT match — that prefix-swallow is exactly the foot-gun the opt-in
      // flag closes. A node running the wrong SQL gets an empty result, not the
      // fixture meant for a different query.
      const handle = createFakeOracleCapability({
        "SELECT * FROM packages": [{ optionKey: "exact", standardPrice: "1", discountPrice: "1" }],
      });
      const result = await handle.client.query(
        PackageSchema,
        "SELECT * FROM packages WHERE id = :id",
        { id: "1" },
      );
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it("an opt-in prefix route still matches the same longer query", async () => {
      const handle = createFakeOracleCapability({
        "SELECT * FROM packages": { prefix: true, rows: [{ optionKey: "broad", standardPrice: "1", discountPrice: "1" }] },
      });
      const result = await handle.client.query(
        PackageSchema,
        "SELECT * FROM packages WHERE id = :id",
        { id: "1" },
      );
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value[0]?.optionKey).toBe("broad");
      }
    });
  });

  describe("read-only surface", () => {
    it("exposes only query / queryOne / queryRaw (no execute)", () => {
      expect(typeof oracle.query).toBe("function");
      expect(typeof oracle.queryOne).toBe("function");
      expect(typeof oracle.queryRaw).toBe("function");
      expect((oracle as unknown as Record<string, unknown>).execute).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Real client over an injected fake queryable
// ---------------------------------------------------------------------------

/** Error shaped like an oracledb driver error (ORA-NNNNN in message). */
const oraError = (message: string): Error => new Error(message);

/**
 * Extract the human message from a mapped FrameworkError. `mapOracleError`
 * only ever returns `transient` / `node-crash`, both of which carry `message`.
 */
const messageOf = (e: { readonly kind: string } & Record<string, unknown>): string =>
  typeof e.message === "string" ? e.message : "";

const queryableThatThrows = (error: unknown): OracleQueryable => ({
  execute: async () => { throw error; },
});

const queryableWithRows = (rows: unknown[]): OracleQueryable => ({
  execute: async () => ({ rows }),
});

/** Records the binds it was called with so named-bind pass-through is asserted. */
const recordingQueryable = (rows: unknown[]): { q: OracleQueryable; calls: Array<Record<string, unknown> | undefined> } => {
  const calls: Array<Record<string, unknown> | undefined> = [];
  return {
    calls,
    q: {
      execute: async (_sql, binds) => {
        calls.push(binds);
        return { rows };
      },
    },
  };
};

describe("@fuguejs/oracle — mapOracleError classification", () => {
  it.each([
    ["ORA-03113", "ORA-03113: end-of-file on communication channel"],
    ["ORA-03114", "ORA-03114: not connected to ORACLE"],
    ["ORA-12541", "ORA-12541: TNS:no listener"],
    ["ORA-12170", "ORA-12170: TNS:Connect timeout occurred"],
    ["ORA-12514", "ORA-12514: TNS:listener does not currently know of service"],
  ])("%s → transient (retriable)", (code, message) => {
    const mapped = mapOracleError(oraError(message), "SELECT 1 FROM DUAL");
    expect(mapped.kind).toBe("transient");
    if (mapped.kind === "transient") {
      expect(mapped.message).toContain(code);
    }
  });

  it.each([
    ["ORA-00942", "ORA-00942: table or view does not exist"],
    ["ORA-00904", "ORA-00904: invalid identifier"],
    ["ORA-01017", "ORA-01017: invalid username/password; logon denied"],
  ])("%s → non-retriable node-crash", (code, message) => {
    const mapped = mapOracleError(oraError(message), "SELECT * FROM t");
    expect(mapped.kind).toBe("node-crash");
    if (mapped.kind === "node-crash") {
      expect(mapped.retriability).toBe("non-retriable");
      expect(mapped.message).toContain(code);
    }
  });

  it("stacked codes — non-transient first, transient second → transient", () => {
    // Oracle wraps a transient ORA-12541 inside a generic ORA-06512/ORA-00604.
    const stacked = oraError(
      "ORA-06512: at line 1\nORA-00604: error occurred at recursive SQL level 1\nORA-12541: TNS:no listener",
    );
    const mapped = mapOracleError(stacked, "SELECT 1 FROM DUAL");
    expect(mapped.kind).toBe("transient");
    if (mapped.kind === "transient") {
      expect(mapped.message).toContain("ORA-12541");
    }
  });

  it("structured errorNum classifies even when the message has no ORA token", () => {
    // A driver error object carrying only the numeric errorNum (12541) and a
    // bare message — classification must read errorNum, not just the message.
    const driverError = Object.assign(new Error("TNS:no listener"), { errorNum: 12541 });
    const mapped = mapOracleError(driverError, "SELECT 1 FROM DUAL");
    expect(mapped.kind).toBe("transient");
    if (mapped.kind === "transient") {
      expect(mapped.message).toContain("ORA-12541");
    }
  });

  it("structured errorNum wins when message ORA tokens are all non-transient", () => {
    const driverError = Object.assign(
      new Error("ORA-06512: at line 1\nORA-00604: recursive SQL error"),
      { errorNum: 3113 },
    );
    const mapped = mapOracleError(driverError, "SELECT 1 FROM DUAL");
    expect(mapped.kind).toBe("transient");
    if (mapped.kind === "transient") {
      expect(mapped.message).toContain("ORA-03113");
    }
  });

  it("stacked non-transient codes → non-retriable node-crash", () => {
    const mapped = mapOracleError(
      oraError("ORA-06512: at line 1\nORA-00942: table or view does not exist"),
      "SELECT * FROM t",
    );
    expect(mapped.kind).toBe("node-crash");
    if (mapped.kind === "node-crash") {
      expect(mapped.retriability).toBe("non-retriable");
    }
  });

  it("error without an ORA- code → non-retriable node-crash with truncated sql", () => {
    const longSql = `SELECT ${"x".repeat(200)}`;
    const mapped = mapOracleError(new Error("plain failure"), longSql);
    expect(mapped.kind).toBe("node-crash");
    if (mapped.kind === "node-crash") {
      expect(mapped.retriability).toBe("non-retriable");
      // Pin the exact slice(0, 100) boundary, not a loose length bound: the first
      // 100 SQL chars are present, the 101st is truncated away. A regression that
      // widened truncation (e.g. to 150) would surface char 101 and fail here.
      expect(mapped.message).toContain(longSql.slice(0, 100));
      expect(mapped.message).not.toContain(longSql.slice(0, 101));
    }
  });

  it("non-Error value → node-crash with stringified message", () => {
    const mapped = mapOracleError("weird string failure", "SELECT 1 FROM DUAL");
    expect(mapped.kind).toBe("node-crash");
    if (mapped.kind === "node-crash") {
      expect(mapped.message).toContain("weird string failure");
    }
  });

  it("strips easy-connect credentials from the message", () => {
    const leaky = oraError("ORA-12541: TNS:no listener for scott/tiger@db.example.com:1521/ORCL");
    const message = messageOf(mapOracleError(leaky, "SELECT 1 FROM DUAL"));
    expect(message).not.toContain("scott/tiger");
    expect(message).not.toContain("tiger");
    // The username (left of the slash) must be redacted too, not just the password.
    expect(message).not.toContain("scott");
    expect(message).toContain("***@");
  });

  it("strips password= key-value credentials from the message", () => {
    const leaky = oraError("connection failed (user=scott password=s3cr3t)");
    const message = messageOf(mapOracleError(leaky, "SELECT 1 FROM DUAL"));
    expect(message).not.toContain("s3cr3t");
    expect(message).not.toContain("scott");
    expect(message).toContain("password=***");
  });

  it("strips credentials embedded in the sql fragment", () => {
    const message = messageOf(mapOracleError(new Error("boom"), "-- pwd=hunter2 SELECT 1 FROM DUAL"));
    expect(message).not.toContain("hunter2");
  });
});

describe("@fuguejs/oracle — stripCredentials (exported, FR-041/SC-008)", () => {
  it("redacts a plain easy-connect user/password@ prefix", () => {
    expect(stripCredentials("scott/tiger@db.example.com:1521/ORCL")).toBe("***@db.example.com:1521/ORCL");
  });

  it("redacts a password CONTAINING `@` up to the host (no first-`@` leak)", () => {
    // The bug this guards: a non-greedy `[^@\s]+@` stopped at the first `@` and
    // left `ss@host` — leaking the password tail. Greedy match consumes to the
    // host boundary.
    const out = stripCredentials("u/p@ss@host:1521/SVC");
    expect(out).toBe("***@host:1521/SVC");
    expect(out).not.toContain("p@ss");
    expect(out).not.toContain("ss@");
  });

  it("redacts whitespace-prefixed credentials in place", () => {
    const out = stripCredentials("  scott/tiger@db:1521/ORCL");
    expect(out).not.toContain("tiger");
    expect(out).not.toContain("scott");
    expect(out).toContain("***@");
  });

  it("redacts PASSWORD=/USER= key-value forms in a TNS long-form DSN", () => {
    const dsn = "(DESCRIPTION=(ADDRESS=(HOST=h)(PORT=1521))(SECURITY=(PASSWORD=secret123)(USER=scott)))";
    const out = stripCredentials(dsn);
    expect(out).not.toContain("secret123");
    expect(out).not.toContain("scott");
    expect(out).toContain("PASSWORD=***");
    expect(out).toContain("USER=***");
  });

  it("leaves a bare host:port/service string unchanged", () => {
    expect(stripCredentials("dbhost:1521/PRICING")).toBe("dbhost:1521/PRICING");
  });

  it("is idempotent (re-application is stable)", () => {
    const inputs = [
      "scott/tiger@db:1521/ORCL",
      "u/p@ss@host:1521/SVC",
      "(DESC=(SECURITY=(PASSWORD=p)(USER=u)))",
    ];
    for (const i of inputs) {
      const once = stripCredentials(i);
      expect(stripCredentials(once)).toBe(once);
    }
  });
});

describe("@fuguejs/oracle — createOracleClient (real client, fake queryable)", () => {
  it("query validates all rows against the schema", async () => {
    const client = createOracleClient(queryableWithRows([
      { optionKey: "A", standardPrice: "199", discountPrice: "99" },
      { optionKey: "B", standardPrice: "299", discountPrice: "199" },
    ]));
    const result = await client.query(PackageSchema, "SELECT * FROM packages");
    expect(isOk(result)).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(2);
  });

  it("query returns node-crash when any row fails validation", async () => {
    const client = createOracleClient(queryableWithRows([
      { optionKey: "A", standardPrice: "199", discountPrice: "99" },
      { optionKey: "B", standardPrice: 299, discountPrice: "199" }, // number, not string
    ]));
    const result = await client.query(PackageSchema, "SELECT * FROM packages");
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect(result.error.kind === "node-crash" && result.error.retriability).toBe("non-retriable");
    }
  });

  it("query maps a connection-class throw to transient", async () => {
    const client = createOracleClient(queryableThatThrows(oraError("ORA-03113: end-of-file on communication channel")));
    const result = await client.query(PackageSchema, "SELECT * FROM packages");
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error.kind).toBe("transient");
  });

  it("query passes named binds through to the queryable verbatim", async () => {
    const { q, calls } = recordingQueryable([{ optionKey: "A", standardPrice: "1", discountPrice: "1" }]);
    const client = createOracleClient(q);
    await client.query(PackageSchema, "SELECT * FROM TABLE(GET_PACKAGE_INFO(:subId)) pkg", { subId: "555" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ subId: "555" });
  });

  it("query defaults binds to {} when omitted", async () => {
    const { q, calls } = recordingQueryable([]);
    const client = createOracleClient(q);
    await client.query(PackageSchema, "SELECT 1 FROM DUAL");
    expect(calls[0]).toEqual({});
  });

  it("query tolerates a missing rows field (undefined → empty)", async () => {
    const client = createOracleClient({ execute: async () => ({}) });
    const result = await client.query(PackageSchema, "SELECT * FROM packages");
    expect(isOk(result)).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it("queryOne returns null on zero rows and the validated row otherwise", async () => {
    const empty = createOracleClient(queryableWithRows([]));
    const one = createOracleClient(queryableWithRows([{ optionKey: "A", standardPrice: "199", discountPrice: "99" }]));

    const noneResult = await empty.queryOne(PackageSchema, "SELECT * FROM TABLE(GET_PACKAGE_INFO(:subId)) pkg", { subId: "x" });
    expect(isOk(noneResult)).toBe(true);
    if (noneResult.ok) expect(noneResult.value).toBeNull();

    const oneResult = await one.queryOne(PackageSchema, "SELECT * FROM TABLE(GET_PACKAGE_INFO(:subId)) pkg", { subId: "1" });
    expect(isOk(oneResult)).toBe(true);
    if (oneResult.ok) expect(oneResult.value?.optionKey).toBe("A");
  });

  it("queryOne returns node-crash on row validation failure", async () => {
    const client = createOracleClient(queryableWithRows([{ optionKey: 1 }]));
    const result = await client.queryOne(PackageSchema, "SELECT * FROM TABLE(GET_PACKAGE_INFO(:subId)) pkg", { subId: "1" });
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error.kind).toBe("node-crash");
  });

  it("queryRaw returns rows unvalidated and maps errors", async () => {
    const client = createOracleClient(queryableWithRows([{ anything: true }]));
    const result = await client.queryRaw("SELECT * FROM t");
    expect(isOk(result)).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ anything: true }]);

    const failing = createOracleClient(queryableThatThrows(oraError("ORA-12541: TNS:no listener")));
    const errResult = await failing.queryRaw("SELECT * FROM t");
    expect(isErr(errResult)).toBe(true);
    if (!errResult.ok) expect(errResult.error.kind).toBe("transient");
  });
});

describe("@fuguejs/oracle — healthCheckWithTimeout", () => {
  it("healthy queryable → Ok", async () => {
    const result = await healthCheckWithTimeout(queryableWithRows([{ "1": 1 }]), 1_000);
    expect(isOk(result)).toBe(true);
  });

  it("throwing queryable → Err with reason", async () => {
    const result = await healthCheckWithTimeout(queryableThatThrows(oraError("ORA-03114: not connected")), 1_000);
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error).toContain("ORA-03114");
  });

  it("hung queryable → Err after the timeout", async () => {
    const hung: OracleQueryable = { execute: () => new Promise(() => {}) };
    const result = await healthCheckWithTimeout(hung, 20);
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error).toContain("timed out after 20ms");
  });

  it("a late rejection after the timeout does not leak as unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      // The execute promise loses the race to the timeout, then rejects later
      // (mirrors a hung connection eventually erroring, or conn.close() throwing
      // in the production seam's finally).
      const lateRejector: OracleQueryable = {
        execute: () =>
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("late connection failure")), 40),
          ),
      };
      const result = await healthCheckWithTimeout(lateRejector, 10);
      expect(isErr(result)).toBe(true);
      if (!result.ok) expect(result.error).toContain("timed out after 10ms");

      // Give the in-flight execute time to reject, then let any unhandled
      // rejection surface on the next microtask/macrotask turns.
      await new Promise((r) => setTimeout(r, 80));
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("strips credentials from a health-check error", async () => {
    const result = await healthCheckWithTimeout(
      queryableThatThrows(oraError("login failed scott/tiger@db:1521/ORCL")),
      1_000,
    );
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error).not.toContain("tiger");
      expect(result.error).not.toContain("scott");
      expect(result.error).toContain("***@");
    }
  });
});

// ---------------------------------------------------------------------------
// connect() credential stripping (CRITICAL — SC-008 / FR-041 / NFR-020)
// ---------------------------------------------------------------------------

/**
 * `createOracleAdapter().connect()` builds its own oracledb pool via
 * `createRequire(...)("oracledb")`. To drive the connect-time error path
 * deterministically (without a real Oracle), mock the `oracledb` module: its
 * `getConnection`/`execute` throw an error whose message embeds a credential,
 * exactly as oracledb connect-time errors (ORA-12154/ORA-01017/NJS DSN parse)
 * echo the supplied connectString/DSN.
 *
 * Regression guard: before Fix 1, connect() propagated the RAW driver error
 * un-stripped (unlike query/healthCheck), so embedded `user/secret@host`
 * reached the boot log and the abort HostError. The re-thrown error must now
 * carry NO credential substring.
 */
const installOracledbMock = (
  makeConn: () => { execute: () => Promise<{ rows?: unknown[] }>; close: () => Promise<void> },
): void => {
  void mock.module("oracledb", () => ({
    default: {
      OUT_FORMAT_OBJECT: 4002,
      createPool: async () => ({
        getConnection: async () => makeConn(),
        close: async () => {},
      }),
    },
    OUT_FORMAT_OBJECT: 4002,
    createPool: async () => ({
      getConnection: async () => makeConn(),
      close: async () => {},
    }),
  }));
};

describe("@fuguejs/oracle — createOracleAdapter().connect() credential stripping", () => {
  const CREDENTIAL_CONNECT_STRING = "scott/s3cr3t@dbhost.oister.dk:1521/PRICING";

  it("strips an embedded credential from the error when SELECT 1 FROM DUAL throws", async () => {
    // execute() throws an oracledb-style error echoing the connect string creds.
    installOracledbMock(() => ({
      execute: async () => {
        throw new Error(`ORA-01017: invalid username/password; logon denied for scott/s3cr3t@dbhost.oister.dk:1521/PRICING`);
      },
      close: async () => {},
    }));

    const handle = createOracleAdapter({
      connectString: CREDENTIAL_CONNECT_STRING,
      user: "scott",
      password: "s3cr3t",
    });

    let thrown: unknown;
    try {
      await handle.connect?.();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    // No credential substring survives (SC-008: 0 occurrences).
    expect(msg).not.toContain("scott/s3cr3t");
    expect(msg).not.toContain("s3cr3t");
    expect(msg).not.toContain("scott");
    expect(msg).toContain("***@");
  });

  it("strips a credential echoed by a connection-acquire (getConnection) failure", async () => {
    // getConnection itself throws (e.g. ORA-12154 DSN parse) carrying the DSN.
    void mock.module("oracledb", () => {
      const mod = {
        OUT_FORMAT_OBJECT: 4002,
        createPool: async () => ({
          getConnection: async () => {
            throw new Error("ORA-12154: TNS:could not resolve for scott/s3cr3t@dbhost.oister.dk:1521/PRICING");
          },
          close: async () => {},
        }),
      };
      return { default: mod, ...mod };
    });

    const handle = createOracleAdapter({
      connectString: CREDENTIAL_CONNECT_STRING,
      user: "scott",
      password: "s3cr3t",
    });

    let thrown: unknown;
    try {
      await handle.connect?.();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).not.toContain("s3cr3t");
    expect(msg).not.toContain("scott");
    expect(msg).toContain("***@");
  });

  it("releases the connection even when SELECT 1 throws (close() still called)", async () => {
    let closed = false;
    installOracledbMock(() => ({
      execute: async () => {
        throw new Error("ORA-00942: table or view does not exist");
      },
      close: async () => { closed = true; },
    }));

    const handle = createOracleAdapter({
      connectString: "dbhost:1521/PRICING",
      user: "u",
      password: "p",
    });

    await expect(handle.connect?.()).rejects.toBeInstanceOf(Error);
    expect(closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pool-promise reset on createPool failure (CRITICAL Fix — getPool recovery)
// ---------------------------------------------------------------------------

describe("@fuguejs/oracle — createOracleAdapter() recovers from a transient createPool failure", () => {
  it("re-creates the pool after a rejected createPool instead of caching the rejection forever", async () => {
    // getPool memoises createPool's promise. A transient open failure (ORA-12541
    // no-listener during a rolling DB restart) must NOT be cached permanently:
    // before the reset fix, the rejected promise stuck and EVERY later getPool()
    // — connect/healthCheck/query — re-awaited the same stale rejection, wedging
    // the capability for the process lifetime despite an ORA-12541 the classifier
    // calls transient/retriable. The reset (mirroring realm-jwt-verifier) lets the
    // next call re-create the pool.
    let createPoolCalls = 0;
    void mock.module("oracledb", () => {
      const mod = {
        OUT_FORMAT_OBJECT: 4002,
        createPool: async () => {
          createPoolCalls += 1;
          if (createPoolCalls === 1) {
            throw new Error("ORA-12541: TNS:no listener");
          }
          return {
            getConnection: async () => ({
              execute: async () => ({ rows: [{ "1": 1 }] }),
              close: async () => {},
            }),
            close: async () => {},
          };
        },
      };
      return { default: mod, ...mod };
    });

    const handle = createOracleAdapter({
      connectString: "dbhost:1521/PRICING",
      user: "u",
      password: "p",
    });

    // First attempt hits the rejected createPool and surfaces the error.
    await expect(handle.connect?.()).rejects.toBeInstanceOf(Error);
    // Second attempt re-creates the pool and succeeds — the regression proof:
    // without the reset this would re-await the cached rejection and reject again.
    await expect(handle.connect?.()).resolves.toBeUndefined();
    expect(createPoolCalls).toBe(2);
  });

  it("leaves close() a clean no-op after a failed open (no rejected promise to re-await)", async () => {
    // The reset returns poolPromise to undefined on rejection, so a close() in the
    // host's connect-failure cleanup path is a safe no-op rather than re-throwing
    // the (now stale) open error as a misleading "failed to close".
    void mock.module("oracledb", () => {
      const mod = {
        OUT_FORMAT_OBJECT: 4002,
        createPool: async () => {
          throw new Error("ORA-12541: TNS:no listener");
        },
      };
      return { default: mod, ...mod };
    });

    const handle = createOracleAdapter({
      connectString: "dbhost:1521/PRICING",
      user: "u",
      password: "p",
    });

    await expect(handle.connect?.()).rejects.toBeInstanceOf(Error);
    await expect(handle.close?.()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Production query/close lifecycle (real per-query seam, no injected fake)
// ---------------------------------------------------------------------------

describe("@fuguejs/oracle — createOracleAdapter() production query/close lifecycle", () => {
  it("releases the pooled connection when a query's execute throws (finally close)", async () => {
    // No fake OracleQueryable is injected, so client.query() drives the REAL
    // per-query seam: pool.getConnection → conn.execute → finally conn.close.
    // A throwing execute must still release the connection or the pool leaks
    // under query errors (the seam at adapter index.ts:415 was previously only
    // covered for connect(), never the query path).
    let closed = 0;
    installOracledbMock(() => ({
      execute: async () => {
        throw new Error("ORA-00942: table or view does not exist");
      },
      close: async () => {
        closed += 1;
      },
    }));

    const handle = createOracleAdapter({
      connectString: "dbhost:1521/PRICING",
      user: "u",
      password: "p",
    });

    const result = await handle.client.query(PackageSchema, "SELECT * FROM packages");
    expect(isErr(result)).toBe(true);
    // The connection was released exactly once despite execute throwing.
    expect(closed).toBe(1);
  });

  it("close() drains the pool with pool.close(0) after a successful open", async () => {
    // Only close()-as-no-op-after-failed-open was covered. This asserts the happy
    // path: once the pool has been opened, close() calls pool.close(0) (zero-drain
    // window) exactly once.
    let poolCloseCalls = 0;
    let poolCloseArg: number | undefined;
    void mock.module("oracledb", () => {
      const mod = {
        OUT_FORMAT_OBJECT: 4002,
        createPool: async () => ({
          getConnection: async () => ({
            execute: async () => ({ rows: [{ "1": 1 }] }),
            close: async () => {},
          }),
          close: async (drainSeconds?: number) => {
            poolCloseCalls += 1;
            poolCloseArg = drainSeconds;
          },
        }),
      };
      return { default: mod, ...mod };
    });

    const handle = createOracleAdapter({
      connectString: "dbhost:1521/PRICING",
      user: "u",
      password: "p",
    });

    // connect() lazily opens the pool; close() must then drain it.
    await handle.connect?.();
    await handle.close?.();
    expect(poolCloseCalls).toBe(1);
    expect(poolCloseArg).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Session NLS fix-up — pin the numeric locale on every new pooled connection
// ---------------------------------------------------------------------------
//
// Regression guard for a LIVE-DB bug the fakes can't reach: the prod database
// defaults to a Danish numeric locale (NLS_NUMERIC_CHARACTERS = ',.'), so NUMBER
// columns serialized to strings with a COMMA decimal ("74,25"), which canonical
// period-decimal parsers reject — silently collapsing real figures to "unknown".
// The adapter must therefore issue an ALTER SESSION pragma on each new physical
// connection. This is asserted WITHOUT a database by capturing the pool's
// sessionCallback and simulating how oracledb invokes it.
describe("@fuguejs/oracle — session NLS fix-up", () => {
  it("issues the period-decimal NLS pragma on each new connection, before first use (callback form)", async () => {
    const executed: string[] = [];
    let captured:
      | ((conn: unknown, tag: string, cb: (e?: unknown) => void) => void)
      | undefined;

    const makeConn = () => ({
      execute: async (sql: string) => {
        executed.push(sql);
        return { rows: [{ "1": 1 }] };
      },
      close: async () => {},
    });

    void mock.module("oracledb", () => {
      const mod = {
        OUT_FORMAT_OBJECT: 4002,
        createPool: async (cfg: { sessionCallback?: typeof captured }) => {
          captured = cfg.sessionCallback;
          return {
            // Faithfully simulate oracledb thin mode: run the session fix-up on
            // each brand-new connection and WAIT for its callback before handing
            // the connection out (the async/promise form hangs here in reality,
            // so the adapter must use the node-callback form — exercised below).
            getConnection: async () => {
              const conn = makeConn();
              if (captured) {
                await new Promise<void>((resolve, reject) =>
                  captured!(conn, "", (e) => (e ? reject(e) : resolve())),
                );
              }
              return conn;
            },
            close: async () => {},
          };
        },
      };
      return { default: mod, ...mod };
    });

    const handle = createOracleAdapter({
      connectString: "dbhost:1521/PRICING",
      user: "u",
      password: "p",
    });
    await handle.connect?.();

    // The adapter wired a session fix-up...
    expect(captured).toBeTypeOf("function");
    // ...it ran the exact NLS pragma...
    expect(executed).toContain(ORACLE_SESSION_NLS_SQL);
    // ...BEFORE the connection's first real use (the SELECT 1 connectivity probe).
    const selectIdx = executed.findIndex((s) => s.includes("SELECT 1 FROM DUAL"));
    expect(selectIdx).toBeGreaterThanOrEqual(0);
    expect(executed.indexOf(ORACLE_SESSION_NLS_SQL)).toBeLessThan(selectIdx);

    // The pragma pins a PERIOD decimal separator — the whole point of the fix.
    expect(ORACLE_SESSION_NLS_SQL).toContain("NLS_NUMERIC_CHARACTERS");
    expect(ORACLE_SESSION_NLS_SQL).toContain("'. '");

    await handle.close?.();
  });

  it("propagates a failed NLS pragma through the callback so connection acquisition fails (the .catch(callbackFn(e)) branch)", async () => {
    // The success path proves the pragma runs before first use. This drives the
    // failure branch: the ALTER SESSION execute rejects, the adapter feeds the
    // error to oracledb's callbackFn, and oracledb (faithfully simulated here)
    // rejects getConnection — fail-closed, no connection handed out un-pinned.
    const pragmaError = new Error("ORA-00604: NLS pragma failed");
    let captured:
      | ((conn: unknown, tag: string, cb: (e?: unknown) => void) => void)
      | undefined;

    const makeConn = () => ({
      execute: async (sql: string) => {
        if (sql === ORACLE_SESSION_NLS_SQL) throw pragmaError;
        return { rows: [{ "1": 1 }] };
      },
      close: async () => {},
    });

    void mock.module("oracledb", () => {
      const mod = {
        OUT_FORMAT_OBJECT: 4002,
        createPool: async (cfg: { sessionCallback?: typeof captured }) => {
          captured = cfg.sessionCallback;
          return {
            // oracledb propagates a sessionCallback error: the pending
            // getConnection rejects rather than handing out the connection.
            getConnection: async () => {
              const conn = makeConn();
              if (captured) {
                await new Promise<void>((resolve, reject) =>
                  captured!(conn, "", (e) => (e ? reject(e) : resolve())),
                );
              }
              return conn;
            },
            close: async () => {},
          };
        },
      };
      return { default: mod, ...mod };
    });

    const handle = createOracleAdapter({
      connectString: "dbhost:1521/PRICING",
      user: "u",
      password: "p",
    });

    // connect() lazily opens the pool and acquires a connection — which now
    // fails because the session fix-up rejected.
    await expect(handle.connect?.()).rejects.toBeInstanceOf(Error);
    expect(captured).toBeTypeOf("function");
  });
});
