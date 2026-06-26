#!/usr/bin/env bun
/**
 * CDRator `authedHttp` smoke-connect — drives the REAL host wiring
 * (`parseHostConfig` → `buildCdratorCapability` → `connect()`) against the live
 * Oister/CDRator token endpoint and mints a bearer token, exiting non-zero if the
 * config is invalid or the mint fails.
 *
 * This is the authenticated-REST counterpart to `scripts/oracle-smoke-connect.ts`.
 * It proves the client_credentials grant end-to-end THROUGH the same code path the
 * host boots (not a bespoke curl): the generic @fuguejs/http-auth capability,
 * configured for CDRator by `buildCdratorCapability`, authenticating via HTTP Basic
 * `client_id:client_secret` with `brand_key` + `operator` in the grant body.
 *
 * `connect()` mints the first token, so a successful connect IS the credential
 * proof. When CDRATOR_SMOKE_PATH is set, the script additionally does one GET to
 * exercise an authenticated data call (the minted bearer is injected by the client).
 *
 * Credentials come ONLY from the environment (source `.env.cdrator` first):
 *   CDRATOR_URL, CDRATOR_AUTH_URL, CDRATOR_BRAND_KEY, CDRATOR_GRANT_TYPE,
 *   CDRATOR_CLIENT_ID, CDRATOR_CLIENT_SECRET, CDRATOR_OPERATOR
 * The token and secret are NEVER printed — the capability never surfaces the token
 * (NFR-010) and this script only ever names a missing variable, never its value.
 *
 * Modes:
 *   bun scripts/cdrator-smoke-connect.ts            live mint (needs Oister VPN)
 *   bun scripts/cdrator-smoke-connect.ts --dry-run  offline: build the real
 *                                                    capability with a recording
 *                                                    fetch and print the EXACT
 *                                                    outbound mint request shape
 *                                                    (secret masked) — no network.
 *
 * Exit: 0 on success, 1 on any missing-config / connect / data-call failure.
 *
 * Imported by relative path (not the bare `@fuguejs/host` specifier) — mirrors
 * scripts/oracle-smoke-connect.ts: a root-level script can't resolve the bare
 * workspace specifier, so it imports the package source directly.
 */
import { parseHostConfig } from "../packages/host/src/domain/config.ts";
import { buildCdratorCapability } from "../packages/host/src/adapters/cdrator-capability.ts";
import type { FetchLike, FetchResponseLike } from "@fuguejs/http-auth";

/** Diagnostic line → STDERR (standalone script; never carries credentials). */
const note = (msg: string): void => {
  console.error(msg);
};

const isDryRun = process.argv.includes("--dry-run");

/**
 * A recording fetch for --dry-run: captures the outbound request and replies with
 * a canned token mint, so the REAL capability is built and driven with zero
 * network. Lets us print the exact mint URL / headers / body the wiring produces.
 */
const recordingFetch = (): { fetch: FetchLike; calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> } => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fetch: FetchLike = async (url, init): Promise<FetchResponseLike> => {
    calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
      json: async () => ({ access_token: "dry-run-token", token_type: "bearer", expires_in: 1799 }),
    };
  };
  return { fetch, calls };
};

/** Mask everything but the first 6 chars of a Basic header so the secret never prints. */
const maskAuthorization = (headers: Record<string, string>): Record<string, string> => {
  const out = { ...headers };
  if (typeof out.Authorization === "string") {
    out.Authorization = `${out.Authorization.slice(0, 6)}<redacted>`;
  }
  return out;
};

async function main(): Promise<void> {
  note(`🔌  CDRator authedHttp smoke-connect${isDryRun ? " (--dry-run, no network)" : ""}`);

  // Seed the unrelated REQUIRED core fields with throwaway dummies (mirrors
  // run-host.sh's dummy-boot) so a CDRator-only smoke does not demand a Redis URL
  // / DAGs repo / admin token. The CDRATOR_* fields and their superRefine still
  // parse EXACTLY as at boot — only the orthogonal host plumbing is stubbed.
  const env: Record<string, string | undefined> = {
    DAGS_REPO_URL: "local",
    REDIS_URL: "redis://localhost:6379",
    ADMIN_TOKEN: "smoke-dummy-admin-token-0123456789",
    LLM_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "sk-ant-dummy-smoke-only",
    ...process.env,
  };

  // Parse the SAME way the host boots — a missing/invalid CDRATOR_* fails here
  // with the exact boot-time message (parse, don't validate).
  const configResult = parseHostConfig(env);
  if (!configResult.ok) {
    console.error(`❌  Config invalid: ${JSON.stringify(configResult.error)}`);
    process.exit(1);
  }
  const config = configResult.value;

  if (config.CDRATOR_URL === undefined) {
    console.error("❌  CDRATOR_URL is unset — the authedHttp capability is not configured. Source .env.cdrator first.");
    process.exit(1);
  }
  note(`   grant: ${config.CDRATOR_GRANT_TYPE}  brand: ${config.CDRATOR_BRAND_KEY}  auth: ${config.CDRATOR_AUTH_URL}`);

  const recorder = isDryRun ? recordingFetch() : undefined;
  const handle = buildCdratorCapability(config, recorder?.fetch);
  if (handle === undefined) {
    console.error("❌  buildCdratorCapability returned undefined (CDRATOR_URL gate). Should not happen after the guard above.");
    process.exit(1);
  }

  try {
    // connect() mints the first token through the real TokenProvider — the
    // credential proof. A bad credential / wrong endpoint throws here (the
    // message is secret-free by construction, NFR-010).
    await handle.connect?.();
    note("✅  connect() OK — client_credentials token minted via the real capability wiring");

    if (isDryRun && recorder) {
      const mint = recorder.calls[0];
      if (mint) {
        note("   ── exact outbound mint request (recorded, secret masked) ──");
        note(`   POST ${mint.url}`);
        note(`   headers: ${JSON.stringify(maskAuthorization(mint.headers))}`);
        note(`   body:    ${mint.body}`);
      }
    }

    // Optional authenticated data call to prove the bearer is injected + accepted.
    const smokePath = process.env.CDRATOR_SMOKE_PATH;
    if (smokePath && !isDryRun) {
      const { z } = await import("zod");
      const result = await handle.client.get(smokePath, { schema: z.unknown() });
      if (result.ok) {
        note(`✅  GET ${smokePath} OK — authenticated data call succeeded`);
      } else {
        console.error(`❌  GET ${smokePath} failed: ${JSON.stringify(result.error)}`);
        process.exit(1);
      }
    }

    note("✅  CDRator smoke-connect PASSED");
    process.exit(0);
  } catch (e) {
    // connect() surfaces a secret-free FrameworkError message; print as-is.
    console.error(`❌  CDRator smoke-connect FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  } finally {
    await handle.close?.().catch(() => {});
  }
}

main().catch((e) => {
  console.error(`❌  CDRator smoke-connect threw: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
