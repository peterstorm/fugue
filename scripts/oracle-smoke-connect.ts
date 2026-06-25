#!/usr/bin/env bun
/**
 * Oracle smoke-connect — opens a REAL Oracle connection via @fuguejs/oracle on
 * the PRODUCTION base image (oven/bun:1.2-alpine) and runs `SELECT 1 FROM DUAL`,
 * exiting non-zero if the connection or query fails (SC-006).
 *
 * Closes the brief's one residual feasibility check: oracledb thin mode was
 * verified on Bun 1.3.x in dev, but prod runs `oven/bun:1.2-alpine`. This script
 * is run by the `oracle-smoke-connect` CI job INSIDE that exact image to prove
 * thin-mode connectivity there (NFR-001 — pooled thin-mode works on prod image).
 *
 * It REUSES the package's lifecycle handle rather than re-implementing the driver
 * call: `createOracleAdapter(...).connect()` is the canonical connectivity probe
 * — it acquires a pooled connection in thin mode and executes `SELECT 1 FROM DUAL`
 * (see packages/adapter-oracle/src/index.ts). `healthCheck()` runs the same query
 * behind a 5s timeout as a second, bounded confirmation.
 *
 * Credentials come ONLY from the environment (wired from CI secrets by the job):
 *   - ORACLE_CONNECT_STRING   easy-connect `HOST:PORT/SERVICE`
 *   - ORACLE_USER             Oracle schema/user
 *   - ORACLE_PASSWORD         Oracle password
 * They are never hardcoded and never printed — the adapter strips credentials
 * from every surfaced error (FR-041 / NFR-020 / SC-008), and this script never
 * echoes any env var.
 *
 * Usage:  bun scripts/oracle-smoke-connect.ts
 * Exit:   0 on success, 1 on any missing-config / connect / query failure.
 */
// Imported by relative path (not the bare `@fuguejs/oracle` specifier): the
// adapter is only depended on by packages/host, so bun symlinks it under
// packages/host/node_modules/@fuguejs/oracle — NOT under the workspace-root
// node_modules/@fuguejs. A root-level script therefore can't resolve the bare
// specifier, so it imports the SAME package source directly by path (mirrors
// scripts/smoke-mlflow.ts importing framework internals by path). The adapter's
// `oracledb`/`zod` PEERS are still resolved at the root because host pulls them
// in (they're lockfile-pinned), so no separate install is needed.
import { createOracleAdapter } from "../packages/adapter-oracle/src/index.ts";

/**
 * Read a required credential from the environment. Returns the value or pushes a
 * (name-only, value-free) message onto `missing`. The value itself is never
 * surfaced — only the variable NAME is ever mentioned.
 */
const required = (name: string, missing: string[]): string | undefined => {
  const value = process.env[name];
  if (value == null || value === "") {
    missing.push(name);
    return undefined;
  }
  return value;
};

/**
 * Progress/diagnostic line. Goes to STDERR (not a structured logger — this is a
 * standalone CI script, not host runtime code) so it never interleaves with any
 * machine-read stdout and is allowed by the no-console-log boundary. Never
 * carries credentials — only the adapter's already-stripped messages reach here.
 */
const note = (msg: string): void => {
  console.error(msg);
};

async function main(): Promise<void> {
  note(`🔌  Oracle smoke-connect (thin mode) on ${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`}`);

  const missing: string[] = [];
  const connectString = required("ORACLE_CONNECT_STRING", missing);
  const user = required("ORACLE_USER", missing);
  const password = required("ORACLE_PASSWORD", missing);

  if (missing.length > 0) {
    // Name the missing vars only — never their values.
    console.error(`❌  Missing required env var(s): ${missing.join(", ")}`);
    process.exit(1);
  }

  // Non-null: the guard above exits when any is missing.
  const oracle = createOracleAdapter({
    connectString: connectString!,
    user: user!,
    password: password!,
    poolMin: 0,
    poolMax: 1,
  });

  try {
    // connect() acquires a pooled thin-mode connection and runs SELECT 1 FROM
    // DUAL; it throws (credential-stripped) on any failure.
    await oracle.connect!();
    note("✅  connect() OK — SELECT 1 FROM DUAL succeeded");

    // Second, bounded confirmation via the same query behind a 5s timeout.
    if (oracle.healthCheck != null) {
      const health = await oracle.healthCheck();
      if (!health.ok) {
        console.error(`❌  healthCheck() failed: ${health.error}`);
        process.exit(1);
      }
      note("✅  healthCheck() OK");
    }

    note("✅  Oracle smoke-connect PASSED on the prod image");
    process.exit(0);
  } catch (e) {
    // The adapter already strips credentials from this message.
    console.error(`❌  Oracle smoke-connect FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  } finally {
    try {
      await oracle.close!();
    } catch {
      // A pool-close failure must not mask the smoke result.
    }
  }
}

main().catch((e) => {
  console.error(`❌  Oracle smoke-connect threw: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
