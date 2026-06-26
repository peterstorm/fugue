/**
 * Wiring test for the Oracle `oracle` capability (FR-031/FR-033/FR-040/FR-041).
 *
 * Asserts the @fuguejs/oracle capability is constructed and registered under the
 * key `oracle` when the ORACLE_* env is present, and is NOT constructed when
 * ORACLE_CONNECT_STRING is absent (zero regression, FR-033) — mirroring the
 * optional `documents`/CDRator adapter gating.
 *
 * Also asserts the credential-safe logging contract (FR-041/NFR-020/SC-008):
 * the connect detail surfaced at boot (`connectStringHost`) contains ONLY the
 * host:port/service descriptor and NEVER the DB user or password. No live
 * network: we only build/register the handle; the handle's `connect()` (which
 * opens the pool) is never called here.
 */

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { parseHostConfig } from "../../domain/config.js";
import { buildOracleCapability, connectStringHost } from "../oracle-capability.js";
import type { SyncLogger } from "../../sync/sync-loop.js";

const baseEnv = {
  DAGS_REPO_URL: "https://github.com/org/dags.git",
  REDIS_URL: "redis://localhost:6379",
  ADMIN_TOKEN: "test-admin-token-long-enough",
  ANTHROPIC_API_KEY: "sk-ant-test-key",
};

const ORACLE_PASSWORD = "sup3r-s3cret-pw";
const ORACLE_USER = "PRICING_RO";

const oracleEnv = {
  ...baseEnv,
  ORACLE_CONNECT_STRING: "dbhost.oister.dk:1521/PRICING",
  ORACLE_USER,
  ORACLE_PASSWORD,
  ORACLE_POOL_MIN: "2",
  ORACLE_POOL_MAX: "8",
};

const parseOk = (env: Record<string, string | undefined>) => {
  const result = parseHostConfig(env);
  if (!result.ok) throw new Error(`expected valid config, got: ${JSON.stringify(result.error)}`);
  return result.value;
};

describe("buildOracleCapability — oracle wiring (FR-031/FR-033)", () => {
  it("registers the oracle capability keyed `oracle` when ORACLE_* env is present", () => {
    const config = parseOk(oracleEnv);
    const handle = buildOracleCapability(config);
    expect(handle).toBeDefined();
    // Registers under the key the DAG's `requires: ["oracle"]` resolves.
    expect(handle?.name).toBe("oracle");
    // The handle exposes a client + lifecycle hooks (constructed, not yet connected).
    expect(handle?.client).toBeDefined();
    expect(typeof handle?.connect).toBe("function");
    expect(typeof handle?.close).toBe("function");
  });

  it("does NOT register the capability when ORACLE_CONNECT_STRING is absent (zero regression, FR-033)", () => {
    const config = parseOk(baseEnv);
    expect(config.ORACLE_CONNECT_STRING).toBeUndefined();
    expect(buildOracleCapability(config)).toBeUndefined();
  });

  it("builds the capability when pool sizes are omitted (adapter applies its own defaults)", () => {
    const { ORACLE_POOL_MIN, ORACLE_POOL_MAX, ...noPool } = oracleEnv;
    void ORACLE_POOL_MIN;
    void ORACLE_POOL_MAX;
    const config = parseOk(noPool);
    expect(config.ORACLE_POOL_MIN).toBeUndefined();
    expect(config.ORACLE_POOL_MAX).toBeUndefined();
    const handle = buildOracleCapability(config);
    expect(handle?.name).toBe("oracle");
  });

  it("constructs network-free: building the handle opens no pool (connect() is never called)", () => {
    const config = parseOk(oracleEnv);
    // No throw and no live dial merely by constructing the handle — pool
    // creation is deferred to connect()/first query.
    const handle = buildOracleCapability(config);
    expect(handle).toBeDefined();
  });
});

describe("connectStringHost — credential-safe logging (FR-041/NFR-020/SC-008)", () => {
  it("returns a bare HOST:PORT/SERVICE connect string unchanged", () => {
    expect(connectStringHost("dbhost.oister.dk:1521/PRICING")).toBe("dbhost.oister.dk:1521/PRICING");
  });

  it("strips an embedded user/password@ prefix should an operator include one", () => {
    const surfaced = connectStringHost("PRICING_RO/sup3r-s3cret-pw@dbhost.oister.dk:1521/PRICING");
    expect(surfaced).toBe("dbhost.oister.dk:1521/PRICING");
    expect(surfaced).not.toContain("sup3r-s3cret-pw");
    expect(surfaced).not.toContain("PRICING_RO");
  });

  it("the surfaced connect detail contains NO credentials (FR-041/SC-008)", () => {
    const config = parseOk(oracleEnv);
    // This is the EXACT string the host logs at boot:
    //   `oracle capability: @fuguejs/oracle targeting ${connectStringHost(...)}`
    const surfaced = connectStringHost(config.ORACLE_CONNECT_STRING!);
    // The user and password live in the config but must never reach the log line.
    expect(surfaced).not.toContain(ORACLE_PASSWORD);
    expect(surfaced).not.toContain(ORACLE_USER);
    // Only the non-secret host portion is present.
    expect(surfaced).toContain("dbhost.oister.dk:1521/PRICING");
  });
});

describe("connectStringHost — adversarial credential vectors (FR-041/SC-008)", () => {
  // Each vector is a connect string the schema's `min(1)` guard lets through and
  // that the OLD `^[^@\s]+@` prefix-strip leaked. Assert NO user/password
  // substring survives the surfaced host detail.

  it("vector 1: password CONTAINING `@` does not leak the post-`@` remainder", () => {
    // OLD behaviour stripped only up to the FIRST `@` → leaked `ss@host:1521/SVC`.
    const surfaced = connectStringHost("u/p@ss@host:1521/SVC");
    expect(surfaced).not.toContain("p@ss");
    expect(surfaced).not.toContain("ss"); // no password fragment survives
    expect(surfaced).not.toMatch(/^u\b/); // user `u` is gone
    expect(surfaced).toBe("host:1521/SVC");
  });

  it("vector 2: whitespace-prefixed credentials are stripped (not logged verbatim)", () => {
    const user = "PRICING_RO";
    const pw = "sup3r-s3cret-pw";
    const surfaced = connectStringHost(`  ${user}/${pw}@dbhost.oister.dk:1521/PRICING`);
    expect(surfaced).not.toContain(pw);
    expect(surfaced).not.toContain(user);
    expect(surfaced).toBe("dbhost.oister.dk:1521/PRICING");
  });

  it("vector 3: TNS/JDBC long-form DSN redacts (PASSWORD=...)/(USER=...) — no whole-string leak", () => {
    const user = "PRICING_RO";
    const pw = "secret123";
    const dsn =
      `(DESCRIPTION=(ADDRESS=(HOST=dbhost)(PORT=1521))` +
      `(CONNECT_DATA=(SERVICE_NAME=PRICING))(SECURITY=(PASSWORD=${pw})(USER=${user})))`;
    const surfaced = connectStringHost(dsn);
    // OLD behaviour had no leading `user/pass@`, so it logged the WHOLE DSN —
    // password included. Now both credential fields are redacted to ***.
    expect(surfaced).not.toContain(pw);
    expect(surfaced).not.toContain(user);
    expect(surfaced).toContain("PASSWORD=***");
    expect(surfaced).toContain("USER=***");
    // The non-secret descriptor structure is preserved for operator diagnostics.
    expect(surfaced).toContain("HOST=dbhost");
    expect(surfaced).toContain("PORT=1521");
  });

  it("property: a `user/password@host` connect string is reduced to exactly the host tail", () => {
    // The fixed host uses only `[a-z0-9.:/]`. Credential tokens draw from a
    // DISJOINT alphabet (uppercase + symbols) so a credential substring can never
    // coincidentally appear inside the host — the "reduced to exactly the host"
    // assertion below is then a clean proof that NO credential character survived.
    //
    // CRITICAL: the password alphabet INCLUDES `@` (and the generator injects
    // extra `@`/`/` characters), because the headline regression is a password
    // CONTAINING `@` (`u/p@ss@host`). The OLD `^[^@\s]+@` / first-`@` strip
    // stopped at the FIRST `@` and leaked the `ss@host…` remainder — so a
    // password without `@` (the previous alphabet) would PASS even against the
    // broken impl and never guard the regression. With `@` in the password, this
    // property FAILS against the old first-`@` strip and PASSES against the
    // current greedy-to-last-`@` stripCredentials.
    // The username is an Oracle identifier — the credential prefix the stripper
    // anchors on is `\b[\w.$-]+/`, so the user draws from that realistic
    // identifier class (uppercase letters + `$` + `_`), DISJOINT from the
    // lowercase/digit/`.:/` host.
    const userChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ_$";
    const userToken = fc
      .array(fc.constantFrom(...userChars.split("")), { minLength: 0, maxLength: 23 })
      // Begin with a letter so the `\b` word boundary the stripper anchors on is
      // satisfied (an identifier starting with `$`/`_` is not a realistic Oracle
      // login and is out of scope for this regression).
      .map((cs) => "U" + cs.join(""));
    // Password alphabet adds `@` and `/` — the chars that break a naive strip.
    const pwChars = ("ABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%^&*()_+=~?" + "@/").split("");
    const pwToken = fc
      .array(fc.constantFrom(...pwChars), { minLength: 1, maxLength: 24 })
      // Guarantee at least one embedded `@` on most runs so the regression is
      // actively exercised: prefix a generated tail with `…@…`.
      .map((cs) => cs.join(""));
    // A dedicated generator that ALWAYS injects 0..n `@` into the password,
    // ensuring the embedded-`@` path is covered (a pure-uppercase password would
    // otherwise dodge it).
    const pwWithAt = fc
      .tuple(pwToken, fc.array(pwToken, { minLength: 1, maxLength: 4 }))
      .map(([head, tail]) => [head, ...tail].join("@"));
    fc.assert(
      fc.property(userToken, fc.oneof(pwToken, pwWithAt), (user, password) => {
        const host = "dbhost.oister.dk:1521/pricing";
        const surfaced = connectStringHost(`${user}/${password}@${host}`);
        // The surfaced detail is EXACTLY the host — every credential char gone.
        // Exact-equality is the clean proof: against the OLD first-`@` strip an
        // embedded-`@` password leaves `…@host`, so `surfaced !== host` and this
        // FAILS. The substring guards below are skipped only when a credential
        // char (`/`) trivially coincides with the host's own `/` separator — the
        // exact-equality above already covers that case.
        expect(surfaced).toBe(host);
        expect(surfaced).not.toContain(user); // user alphabet is `/`-free
        if (!host.includes(password)) {
          // Only meaningful when the password can't coincidentally overlap the
          // host (e.g. a lone `/`); equality above is the real proof regardless.
          expect(surfaced).not.toContain(password);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("buildOracleCapability — construction failure surfacing (FR-031, Fix 2)", () => {
  // A construction throw (e.g. oracledb fails to lazy-load) must be SURFACED with
  // context and re-thrown — never conflated with the `undefined` "not configured"
  // gate, and never leaking credentials.

  const captureLogger = (): { logger: SyncLogger; errors: string[] } => {
    const errors: string[] = [];
    const logger: SyncLogger = {
      info: () => {},
      warn: () => {},
      error: (msg) => { errors.push(msg); },
    };
    return { logger, errors };
  };

  it("re-throws a construction failure (distinct from the undefined gate) and logs safe context", () => {
    const config = parseOk(oracleEnv);
    const { logger, errors } = captureLogger();
    const boom = new Error(`oracledb thin-mode init failed for ${ORACLE_USER}/${ORACLE_PASSWORD}@dbhost.oister.dk:1521/PRICING`);
    const throwingFactory = () => { throw boom; };

    // Construction failure SURFACES as a throw — NOT a silent `undefined`.
    let thrown: unknown;
    try {
      buildOracleCapability(config, logger, throwingFactory);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);

    // The re-thrown error is CREDENTIAL-STRIPPED (Fix 2): the raw oracledb error
    // embedded `USER/PASSWORD@host`, but the abort HostError this becomes must not
    // carry creds into logs/output (FR-041/NFR-020/SC-008).
    const thrownMsg = (thrown as Error).message;
    expect(thrownMsg).not.toContain(ORACLE_PASSWORD);
    expect(thrownMsg).not.toContain(ORACLE_USER);
    expect(thrownMsg).toContain("***@");

    // It was logged with clear context...
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Oracle capability wiring failed");
    // ...including the safe host:port/service...
    expect(errors[0]).toContain("dbhost.oister.dk:1521/PRICING");
    // ...and NO credentials, even though the raw error embedded them (FR-041/SC-008).
    expect(errors[0]).not.toContain(ORACLE_PASSWORD);
    expect(errors[0]).not.toContain(ORACLE_USER);
  });

  it("the undefined gate is NOT a wiring failure: no factory call, no error log when unconfigured", () => {
    const config = parseOk(baseEnv);
    const { logger, errors } = captureLogger();
    let factoryCalled = false;
    const factory = (() => { factoryCalled = true; throw new Error("should not be called"); }) as unknown as Parameters<typeof buildOracleCapability>[2];
    // Not configured → undefined, factory never invoked, nothing logged.
    expect(buildOracleCapability(config, logger, factory)).toBeUndefined();
    expect(factoryCalled).toBe(false);
    expect(errors).toHaveLength(0);
  });

  it("re-throws even without a logger (failure is never swallowed)", () => {
    const config = parseOk(oracleEnv);
    const boom = new Error("construction blew up");
    const throwingFactory = () => { throw boom; };
    expect(() => buildOracleCapability(config, undefined, throwingFactory)).toThrow(boom);
  });
});
