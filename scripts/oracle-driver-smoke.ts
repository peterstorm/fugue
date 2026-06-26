#!/usr/bin/env bun
/**
 * Oracle DRIVER-LOADS smoke — the SECRET-FREE, DB-FREE half of SC-006 (NFR-001).
 *
 * Proves the `oracledb` thin-mode driver LOADS and RUNS its network stack on the
 * PRODUCTION base image (`oven/bun:1.2-alpine`) — the one genuinely image-specific
 * risk (pure-JS Oracle Net over musl/alpine, no Instant Client / native addon).
 * It needs NO credentials and NO reachable database, so it runs unconditionally in
 * GitHub CI where neither the Oracle secrets (they live as OpenShift SealedSecrets)
 * nor network line-of-sight to the real DB exist.
 *
 * The REAL connectivity proof (an actual `SELECT 1 FROM DUAL` against prod Oracle)
 * is a SEPARATE check that can only run where the secret + network are: the
 * in-cluster OpenShift Job in packages/host/deploy (scripts/oracle-smoke-connect.ts).
 * This script deliberately does NOT attempt that — see the fugue-oracle-smoke Job in
 * packages/host/deploy/multi-tenant-openshift.yaml.
 *
 * What this asserts:
 *   - createOracleAdapter() constructs — it runs `createRequire("oracledb")`
 *     synchronously, so a throw HERE is a DRIVER-LOAD failure (the NFR-001 defect
 *     this smoke exists to catch), distinct from any connection problem.
 *   - connect() ATTEMPTS a connection to a deliberately-unreachable target. The
 *     EXPECTED outcome is a network/connection error (or a dial still in flight at
 *     timeout) — either proves the thin-mode network stack actually executed.
 *
 * Exit: 0 when the driver loads and attempts a connection; 1 only when the driver
 * fails to load on the image (the real regression).
 *
 * Usage:  bun scripts/oracle-driver-smoke.ts
 */
// Imported by relative path (not the bare `@fuguejs/oracle` specifier) for the same
// reason as oracle-smoke-connect.ts: the adapter is symlinked under packages/host's
// node_modules, not the workspace root, so a root-level script resolves the source
// directly by path. `oracledb` is a host runtime dependency, so it is present in the
// install graph and `createRequire` resolves it from the adapter's location.
import { createOracleAdapter, stripCredentials } from "../packages/adapter-oracle/src/index.ts";

const note = (msg: string): void => {
  console.error(msg);
};

const fmt = (e: unknown): string => stripCredentials(e instanceof Error ? e.message : String(e));

// An unreachable target: loopback port 1 has no listener, so a dial fails fast
// (ECONNREFUSED) without touching any real database. No credentials are real.
const UNREACHABLE_CONNECT_STRING = "127.0.0.1:1/DRIVER_SMOKE";
// Cap the dial so a driver that hangs (rather than refusing) still completes the
// smoke promptly — a hang ALSO proves the driver loaded and is dialling.
const DIAL_TIMEOUT_MS = 15_000;

let handle: ReturnType<typeof createOracleAdapter>;
try {
  handle = createOracleAdapter({
    connectString: UNREACHABLE_CONNECT_STRING,
    user: "driver-smoke",
    password: "driver-smoke",
    poolMin: 0,
    poolMax: 1,
  });
} catch (e) {
  // createOracleAdapter runs `createRequire("oracledb")` synchronously, so a throw
  // here means the thin-mode driver could not LOAD on this image — the NFR-001
  // failure. No handle exists to clean up.
  note(`❌  oracledb thin-mode driver FAILED TO LOAD on the prod image: ${fmt(e)}`);
  process.exit(1);
}

note("✅  oracledb thin-mode driver loaded (createRequire('oracledb') OK)");

let exitCode = 0;
try {
  // EXPECT a failure (or an in-flight dial at timeout): both prove the driver ran
  // its network stack. Only a driver that cannot load (caught above) is a failure.
  const outcome = await Promise.race([
    handle
      .connect?.()
      .then(() => "connected" as const)
      .catch((e: unknown) => ({ err: e })),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), DIAL_TIMEOUT_MS)),
  ]);

  if (outcome === "connected") {
    // Not expected against an unreachable target, but it still proves the driver works.
    note("✅  connect() unexpectedly succeeded — driver works (no live DB expected here)");
  } else if (outcome === "timeout") {
    note(`✅  driver still dialling after ${DIAL_TIMEOUT_MS}ms — thin-mode network stack ran`);
  } else {
    note(`✅  driver attempted a connection and failed as expected (network error, not a load error): ${fmt(outcome.err)}`);
  }
  note("✅  Oracle driver-loads smoke PASSED on the prod image (no secrets, no DB)");
} catch (e) {
  // connect()'s rejection is already absorbed by the race's .catch above, so
  // reaching here is unexpected — surface it (credential-stripped) and fail.
  note(`❌  Oracle driver-loads smoke FAILED unexpectedly: ${fmt(e)}`);
  exitCode = 1;
} finally {
  try {
    await handle.close?.();
  } catch {
    // A pool-close failure must not mask the smoke result.
  }
}

process.exit(exitCode);
