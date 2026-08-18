/**
 * Oracle `oracle` capability wiring (host boot).
 *
 * Translates the validated host `ORACLE_*` env config into the `@fuguejs/oracle`
 * capability — an `oracledb` thin-mode connection pool exposing a read-only
 * `query`/`queryOne`/`queryRaw` surface. This adapter is the one place that maps
 * THIS host's env into the adapter factory's shape (parse, don't validate: the
 * config was already validated by `HostConfigSchema`).
 *
 * The capability registers under the key `oracle`, so a DAG declaring
 * `requires: ["oracle"]` resolves once Oracle is configured.
 *
 * Gating (FR-033): returns `undefined` when Oracle is not configured
 * (ORACLE_CONNECT_STRING unset), mirroring the optional `documents`/CDRator
 * adapters — the capability is then simply not registered and a
 * `requires: ["oracle"]` DAG fails the boot-time capability check (ZERO
 * regression: the host runs exactly as before). When configured,
 * `HostConfigSchema`'s superRefine has already guaranteed ORACLE_USER and
 * ORACLE_PASSWORD are present, so the non-null reads below are sound by
 * construction.
 *
 * Performance (NFR-001 / SC-004): poolMin/poolMax flow through to the adapter's
 * `oracledb` pool so price lookups amortize connection cost and stay within the
 * p95 budget.
 *
 * Credentials (FR-040 / FR-041 / NFR-020 / SC-008): the connect string, user
 * and password flow ONLY from config into the factory; NOTHING here logs the
 * user or password. The non-secret host:port/service portion of the connect
 * string is the only connect detail surfaced — see `connectStringHost`.
 *
 * @satisfies FR-031, FR-033, FR-040, FR-041, NFR-001, NFR-020, SC-004, SC-008
 */

import { createOracleAdapter, stripCredentials } from "@fuguejs/oracle";
import type { CapabilityHandle } from "@fuguejs/framework";
import type { HostConfig } from "../domain/config.js";
import type { SyncLogger } from "../sync/sync-loop.js";

/**
 * The non-secret host portion of an Oracle connect string, safe to log.
 *
 * The host `ORACLE_*` config keeps user/password as SEPARATE fields, so the
 * connect string is expected to be a bare `HOST:PORT/SERVICE` easy-connect
 * descriptor with no embedded credentials. Defensively, however, an operator
 * MAY embed credentials (the schema only enforces `min(1)`), and they arrive in
 * THREE shapes, every one of which must come out credential-free (FR-041 /
 * SC-008):
 *
 *   1. `user/password@host:port/service` — the easy-connect credential prefix.
 *   2. a password CONTAINING `@`, e.g. `u/p@ss@host:1521/SVC` — the naive
 *      "strip up to the first `@`" leaked the `ss@host` remainder.
 *   3. a TNS/JDBC long-form DSN `(DESCRIPTION=...(PASSWORD=secret)...)` — no
 *      leading `user/pass@` at all, so a prefix-only strip logged the whole
 *      string, password included.
 *
 * Rather than re-implement (and get wrong) credential stripping here, we DELEGATE
 * to `@fuguejs/oracle`'s robust, tested `stripCredentials` — which redacts the
 * greedy `user/password@` run (handling embedded `@`) AND the
 * `password=`/`pwd=`/`user=`/`uid=` key-value forms — then drop any remaining
 * redacted `***@` credential prefix to leave only the host:port/service tail.
 * Composition: strip credentials, then extract the host. Pure: no I/O.
 */
export const connectStringHost = (connectString: string): string =>
  // 1) redact every credential shape (easy-connect prefix incl. embedded `@`,
  //    and key=value `PASSWORD=`/`USER=` forms in a TNS descriptor), then
  // 2) drop a leading redacted `***@` credential prefix, leaving the host tail.
  //    A TNS descriptor has no leading `@`, so step 2 is a no-op there — but the
  //    secret is already redacted to `***` by step 1, so nothing leaks.
  stripCredentials(connectString.trim()).replace(/^[^\s@]*@/, "");

/**
 * Build the Oracle `oracle` capability handle from host config, or `undefined`
 * when Oracle is not configured.
 *
 * `undefined` means EXACTLY ONE thing — "Oracle is not configured"
 * (ORACLE_CONNECT_STRING unset). It is the intentional zero-regression gate
 * (FR-033): the capability is simply not registered and a `requires: ["oracle"]`
 * DAG fails the boot-time capability check. A `undefined` return MUST NEVER be
 * conflated with a wiring failure.
 *
 * Constructing the handle does NOT open the pool nor dial Oracle — that happens
 * in the handle's `connect()`. CONNECTIVITY surfacing is therefore NOT this
 * function's job: host boot (`createHost`) topologically sorts every registered
 * capability handle and `await`s `connect()` on ALL of them BEFORE going ready,
 * aborting boot on the first failure (see `host.ts` → "Connect External
 * Capabilities"). The oracle handle's `connect()` runs `SELECT 1 FROM DUAL`, so
 * a wrong host / service / credentials config FAILS LOUDLY AT BOOT with the
 * mapped (credential-stripped) Oracle error — NOT silently at first query. This
 * holds for both `main.ts` and `worker-main.ts`, which feed every built handle
 * into `sharedInfra.capabilities`. No extra boot-time `connect()` call is needed
 * here.
 *
 * What CAN still go wrong synchronously is CONSTRUCTION: `createOracleAdapter`
 * lazy-`require`s `oracledb` and may throw at build (missing module, thin-mode
 * init failure). An unguarded throw would propagate as an opaque boot crash
 * INDISTINGUISHABLE from the intentional `undefined` gate. We therefore wrap the
 * factory call: on a construction throw we log clear context (the safe
 * host:port/service only, error message credential-stripped via the shared
 * `stripCredentials`) and RE-THROW — surfacing the failure with context while
 * keeping `undefined` reserved solely for "not configured".
 *
 * The optional `logger` is the surfacing seam: production passes the host logger;
 * omit it (tests / callers without a logger) and the contextual log is skipped
 * but the throw is STILL re-raised, so the failure is never swallowed. Pure
 * apart from that single contextual log on the error path.
 *
 * The optional `factory` is the construction seam — it defaults to the real
 * `createOracleAdapter` and exists ONLY so tests can drive the construction-throw
 * surfacing path deterministically (without depending on whether `oracledb`
 * happens to load). Production never passes it.
 */
type OracleAdapterFactory = typeof createOracleAdapter;

export const buildOracleCapability = (
  config: HostConfig,
  logger?: SyncLogger,
  factory: OracleAdapterFactory = createOracleAdapter,
): CapabilityHandle<"oracle"> | undefined => {
  // ORACLE_CONNECT_STRING is the gate. The superRefine in HostConfigSchema
  // guarantees that when it is set, ORACLE_USER and ORACLE_PASSWORD are set too.
  if (config.ORACLE_CONNECT_STRING === undefined) return undefined;

  try {
    return factory({
      connectString: config.ORACLE_CONNECT_STRING,
      user: config.ORACLE_USER!,
      password: config.ORACLE_PASSWORD!,
      // Pool sizing for the p95 lookup budget (NFR-001 / SC-004). Undefined when
      // unset — the adapter applies its own defaults (poolMin 0 / poolMax 4).
      ...(config.ORACLE_POOL_MIN !== undefined ? { poolMin: config.ORACLE_POOL_MIN } : {}),
      ...(config.ORACLE_POOL_MAX !== undefined ? { poolMax: config.ORACLE_POOL_MAX } : {}),
    });
  } catch (e) {
    // A CONSTRUCTION failure is NOT the "not configured" gate — surface it with
    // context (safe host only, error credential-stripped) and re-throw so boot
    // crashes LOUDLY and attributably rather than via an opaque stack. NEVER
    // return undefined here: undefined means ONLY "not configured" (FR-033).
    const safeHost = connectStringHost(config.ORACLE_CONNECT_STRING);
    const safeError = stripCredentials(e instanceof Error ? e.message : String(e));
    logger?.error(`Oracle capability wiring failed for host ${safeHost} — ${safeError}`);
    // Re-throw a CREDENTIAL-STRIPPED error, NOT the raw `e`: the raw oracledb
    // construction error can echo the supplied connectString/DSN (creds and all),
    // and this throw aborts boot as a HostError that hits logs/output. Surfacing
    // the stripped message keeps SC-008 (0 credential occurrences) while staying
    // distinct from the `undefined` "not configured" gate (it still throws).
    throw new Error(safeError);
  }
};
