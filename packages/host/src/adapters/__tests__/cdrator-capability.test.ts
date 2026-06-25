/**
 * Wiring test for the CDRator `authedHttp` capability (FR-060/NFR-010).
 *
 * Asserts the generic @fuguejs/http-auth capability is constructed and registered
 * under the key `authedHttp` when the CDRATOR_* env is present, and is NOT
 * constructed when CDRATOR_URL is absent — mirroring the optional `documents`
 * adapter gating. No live network: we only assert the handle is built/registered;
 * the handle's `connect()` (which mints a token) is never called here.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import type { FetchLike, FetchResponseLike } from "@fuguejs/http-auth";
import { parseHostConfig } from "../../domain/config.js";
import { buildCdratorCapability } from "../cdrator-capability.js";

/** One captured outbound request (url + headers + body) seen by the fetch seam. */
interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

/**
 * A recording `FetchLike` that captures every outbound request and replies with
 * a canned token mint (for the auth URL) or an empty JSON object (for data
 * requests). Lets the wiring tests assert the EXACT token-mint request and the
 * EXACT default headers that reach a data request, with zero real network.
 */
const recordingFetch = (): { fetch: FetchLike; calls: CapturedRequest[] } => {
  const calls: CapturedRequest[] = [];
  const fetch: FetchLike = async (url, init): Promise<FetchResponseLike> => {
    calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body });
    const isTokenMint = init.body !== undefined && init.body.includes("grant_type");
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
      json: async () => (isTokenMint ? { access_token: "minted-token", expires_in: 3600 } : {}),
    };
  };
  return { fetch, calls };
};

const baseEnv = {
  DAGS_REPO_URL: "https://github.com/org/dags.git",
  REDIS_URL: "redis://localhost:6379",
  ADMIN_TOKEN: "test-admin-token-long-enough",
  ANTHROPIC_API_KEY: "sk-ant-test-key",
};

const cdratorEnv = {
  ...baseEnv,
  CDRATOR_URL: "https://rator1.ibt.oister.dk/rest-api-core",
  CDRATOR_AUTH_URL: "https://rator1.ibt.oister.dk/rest-api-auth",
  CDRATOR_BRAND_KEY: "oister",
  CDRATOR_USERNAME: "operator",
  CDRATOR_PASSWORD: "s3cret",
};

const parseOk = (env: Record<string, string | undefined>) => {
  const result = parseHostConfig(env);
  if (!result.ok) throw new Error(`expected valid config, got: ${JSON.stringify(result.error)}`);
  return result.value;
};

describe("buildCdratorCapability — authedHttp wiring (FR-060)", () => {
  it("registers the authedHttp capability when CDRATOR_* env is present", () => {
    const config = parseOk(cdratorEnv);
    const handle = buildCdratorCapability(config);
    expect(handle).toBeDefined();
    // Registers under the key the DAG's `requires: ["authedHttp"]` resolves.
    expect(handle?.name).toBe("authedHttp");
    // The handle exposes a client + lifecycle hooks (constructed, not yet connected).
    expect(handle?.client).toBeDefined();
    expect(typeof handle?.connect).toBe("function");
  });

  it("does NOT register the capability when CDRATOR_URL is absent (zero regression)", () => {
    const config = parseOk(baseEnv);
    expect(config.CDRATOR_URL).toBeUndefined();
    expect(buildCdratorCapability(config)).toBeUndefined();
  });

  it("builds the capability with the optional HTTP Basic client credentials when set", () => {
    const config = parseOk({
      ...cdratorEnv,
      CDRATOR_CLIENT_ID: "client-id",
      CDRATOR_CLIENT_SECRET: "client-secret",
    });
    const handle = buildCdratorCapability(config);
    expect(handle?.name).toBe("authedHttp");
  });

  it("constructs network-free: building the handle issues no fetch (token mints only on connect)", async () => {
    let fetchCalls = 0;
    const config = parseOk(cdratorEnv);
    const handle = buildCdratorCapability(config, async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "",
        json: async () => ({ access_token: "tok", expires_in: 3600 }),
      };
    });
    expect(handle).toBeDefined();
    // No fetch happened merely by constructing the handle.
    expect(fetchCalls).toBe(0);
    // Driving the lifecycle's connect() WOULD mint via the injected fetch seam —
    // proving the wiring threads through without a real network call.
    await handle?.connect?.();
    expect(fetchCalls).toBe(1);
  });
});

describe("buildCdratorCapability — outbound request shape (FR-060/NFR-010)", () => {
  /** Parse the urlencoded grant body into a flat map for field-level assertions. */
  const formFields = (body: string | undefined): Record<string, string> =>
    Object.fromEntries(new URLSearchParams(body ?? "").entries());

  it("mints the token at CDRATOR_AUTH_URL with the operator grant + brand_key form fields", async () => {
    const config = parseOk(cdratorEnv);
    const { fetch, calls } = recordingFetch();
    const handle = buildCdratorCapability(config, fetch);
    // connect() drives exactly the token mint, no data request.
    await handle?.connect?.();

    expect(calls).toHaveLength(1);
    const mint = calls[0]!;
    // The token endpoint URL is CDRATOR_AUTH_URL (not the core base URL).
    expect(mint.url).toBe("https://rator1.ibt.oister.dk/rest-api-auth");
    expect(mint.method).toBe("POST");

    const fields = formFields(mint.body);
    expect(fields.grant_type).toBe("operator_password");
    expect(fields.brand_key).toBe("oister");
    // The operator username/password are the grant's form credentials.
    expect(fields.username).toBe("operator");
    expect(fields.password).toBe("s3cret");
  });

  it("threads the X-RATOR-brand-key + Accept-Language: DK default headers onto a data request", async () => {
    const config = parseOk(cdratorEnv);
    const { fetch, calls } = recordingFetch();
    const handle = buildCdratorCapability(config, fetch);

    // Drive a real data request through the client — mints, then GETs.
    const result = await handle?.client.get("/customers/123", { schema: z.object({}) });
    expect(result?.ok).toBe(true);

    // calls[0] = token mint; calls[1] = the data request.
    expect(calls).toHaveLength(2);
    const dataReq = calls[1]!;
    expect(dataReq.url).toBe("https://rator1.ibt.oister.dk/rest-api-core/customers/123");
    // The minted bearer token is injected (NFR-010 path: token only on the header).
    expect(dataReq.headers.Authorization).toBe("Bearer minted-token");
    // The static defaults reach the data request.
    expect(dataReq.headers["X-RATOR-brand-key"]).toBe("oister");
    // The market/country value the CDRator API expects — NOT a BCP-47 tag.
    expect(dataReq.headers["Accept-Language"]).toBe("DK");
  });

  it("includes an Authorization: Basic header on the token mint when client id/secret ARE configured", async () => {
    const config = parseOk({
      ...cdratorEnv,
      CDRATOR_CLIENT_ID: "client-id",
      CDRATOR_CLIENT_SECRET: "client-secret",
    });
    const { fetch, calls } = recordingFetch();
    const handle = buildCdratorCapability(config, fetch);
    await handle?.connect?.();

    const mint = calls[0]!;
    // HTTP Basic = base64("client-id:client-secret").
    const expected = `Basic ${Buffer.from("client-id:client-secret", "utf8").toString("base64")}`;
    expect(mint.headers.Authorization).toBe(expected);
  });

  it("OMITS the Authorization: Basic header on the token mint when client id/secret are NOT configured", async () => {
    const config = parseOk(cdratorEnv);
    const { fetch, calls } = recordingFetch();
    const handle = buildCdratorCapability(config, fetch);
    await handle?.connect?.();

    const mint = calls[0]!;
    // No client credentials → no Basic header on the token request (operator grant only).
    expect(mint.headers.Authorization).toBeUndefined();
  });
});

describe("buildCdratorCapability — 401 retry through the real wired token provider", () => {
  it("invalidates and re-mints on a 401, retrying the data request with a fresh token", async () => {
    // The adapter wires a REAL createTokenProvider (not a fake). A 401 on the data
    // request must drive invalidate → re-mint → retry through that wired provider,
    // proving the wiring re-mints — not just client.ts's unit-level fake provider.
    const calls: CapturedRequest[] = [];
    let mintCount = 0;
    let dataCount = 0;
    const fetch: FetchLike = async (url, init): Promise<FetchResponseLike> => {
      calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body });
      const isTokenMint = init.body !== undefined && init.body.includes("grant_type");
      if (isTokenMint) {
        mintCount += 1;
        // Distinct token per mint so the retry's Authorization header proves a re-mint.
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "",
          json: async () => ({ access_token: `minted-token-${mintCount}`, expires_in: 3600 }),
        };
      }
      // Data request: first attempt 401 (stale token), the retry 200.
      dataCount += 1;
      const unauthorized = dataCount === 1;
      return {
        ok: !unauthorized,
        status: unauthorized ? 401 : 200,
        statusText: unauthorized ? "Unauthorized" : "OK",
        text: async () => (unauthorized ? "token expired" : ""),
        json: async () => ({}),
      };
    };

    const config = parseOk(cdratorEnv);
    const handle = buildCdratorCapability(config, fetch);
    const result = await handle?.client.get("/customers/123", { schema: z.object({}) });

    // The single 401-retry succeeded.
    expect(result?.ok).toBe(true);
    // Two mints (initial + re-mint after invalidate) and two data attempts.
    expect(mintCount).toBe(2);
    expect(dataCount).toBe(2);
    // Exact sequence: mint → data(401) → re-mint → data(200).
    expect(calls.map((c) => (c.body?.includes("grant_type") ? "mint" : "data"))).toEqual([
      "mint",
      "data",
      "mint",
      "data",
    ]);
    // The first data attempt carried token #1; the retry carried the re-minted #2.
    const dataReqs = calls.filter((c) => !c.body?.includes("grant_type"));
    expect(dataReqs[0]!.headers.Authorization).toBe("Bearer minted-token-1");
    expect(dataReqs[1]!.headers.Authorization).toBe("Bearer minted-token-2");
  });
});

describe("HostConfigSchema — CDRATOR_* validation (FR-060/NFR-010)", () => {
  it("rejects CDRATOR_URL without the required operator credentials", () => {
    const result = parseHostConfig({ ...baseEnv, CDRATOR_URL: "https://rator1.ibt.oister.dk/rest-api-core" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("CDRATOR_AUTH_URL");
    expect(result.error.message).toContain("CDRATOR_USERNAME");
    expect(result.error.message).toContain("CDRATOR_PASSWORD");
  });

  it("rejects an http CDRATOR_AUTH_URL (the operator password is POSTed there)", () => {
    const result = parseHostConfig({ ...cdratorEnv, CDRATOR_AUTH_URL: "http://rator1.ibt.oister.dk/rest-api-auth" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("CDRATOR_AUTH_URL");
  });

  it("rejects CDRATOR_CLIENT_ID without CDRATOR_CLIENT_SECRET (Basic auth needs both)", () => {
    const result = parseHostConfig({ ...cdratorEnv, CDRATOR_CLIENT_ID: "client-id" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("CDRATOR_CLIENT_SECRET");
  });

  it("rejects CDRATOR_CLIENT_SECRET without CDRATOR_CLIENT_ID (the other direction of the pair)", () => {
    const result = parseHostConfig({ ...cdratorEnv, CDRATOR_CLIENT_SECRET: "client-secret" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("CDRATOR_CLIENT_ID");
  });

  it("rejects an http CDRATOR_URL (the minted bearer token is sent here on every request)", () => {
    const result = parseHostConfig({ ...cdratorEnv, CDRATOR_URL: "http://rator1.ibt.oister.dk/rest-api-core" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("CDRATOR_URL");
  });

  it("accepts a fully-configured CDRATOR_* env (capability will be wired)", () => {
    const result = parseHostConfig({
      ...cdratorEnv,
      CDRATOR_CLIENT_ID: "client-id",
      CDRATOR_CLIENT_SECRET: "client-secret",
    });
    expect(result.ok).toBe(true);
  });

  it("leaves CDRATOR_URL undefined by default (capability unconfigured)", () => {
    const result = parseHostConfig(baseEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.CDRATOR_URL).toBeUndefined();
  });
});
