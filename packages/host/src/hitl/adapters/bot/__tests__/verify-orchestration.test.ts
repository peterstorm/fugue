// verify-orchestration.test.ts — the createBotTokenVerifier ORCHESTRATION
// (ADR-0060): the security boundary of the bot endpoint that decides accept vs
// 401 (invalid) vs 503 (unavailable). The pure helpers (`bearer`,
// `classifyJoseError`) are covered in verify.test.ts; this drives the full
// decision flow.
//
// Two seams, matching the production wiring:
//   - `jose` is dynamically imported → stubbed via `mock.module("jose", …)` so a
//     test drives `createRemoteJWKSet` + `jwtVerify` outcomes with no real crypto;
//   - the OpenID metadata is fetched via global `fetch` → stubbed (same pattern as
//     connector.test.ts) so a test drives the metadata-fetch outcome with no net.

import { describe, it, expect, afterEach, mock } from "bun:test";
// `verify.ts` imports `jose` LAZILY (a dynamic `import("jose")` at call time), and
// `mock.module` is hoisted by bun, so a normal static import of the verifier below
// still resolves the stubbed `jose` when each call runs. Importing statically (not
// top-level `await import`) keeps the file an ES module under the host tsconfig.
import { createBotTokenVerifier } from "../verify.js";

// ── jose stub (the ONLY system boundary mocked) ───────────────────────────────
// Mutable hooks the tests set per-case; `mock.module` is hoisted, so the module
// closure reads these lazily on each call.
let jwtVerifyImpl: (token: unknown, jwks: unknown, opts: unknown) => Promise<unknown> = async () => ({});
let createRemoteJWKSetImpl: (url: URL) => unknown = () => (async () => ({}));
const createRemoteJWKSetCalls: URL[] = [];
const jwtVerifyCalls: { token: unknown; opts: unknown }[] = [];

mock.module("jose", () => ({
  jwtVerify: (token: unknown, jwks: unknown, opts: unknown) => {
    jwtVerifyCalls.push({ token, opts });
    return jwtVerifyImpl(token, jwks, opts);
  },
  createRemoteJWKSet: (url: URL) => {
    createRemoteJWKSetCalls.push(url);
    return createRemoteJWKSetImpl(url);
  },
}));

// ── fetch stub for the OpenID metadata document ───────────────────────────────
type Resp = { ok: boolean; status: number; json: () => Promise<unknown> };
const resp = (status: number, body: unknown): Resp => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const installFetch = (handler: (url: string) => Resp | Promise<Resp>) => {
  const calls: string[] = [];
  // @ts-expect-error — override global fetch for the test
  globalThis.fetch = async (url: string) => { calls.push(String(url)); return (await handler(String(url))) as unknown as Response; };
  return calls;
};
const realFetch = globalThis.fetch;

const okMetadata = (url = "https://login.example/jwks") => () => resp(200, { jwks_uri: url });

afterEach(() => {
  globalThis.fetch = realFetch;
  jwtVerifyImpl = async () => ({});
  createRemoteJWKSetImpl = () => (async () => ({}));
  createRemoteJWKSetCalls.length = 0;
  jwtVerifyCalls.length = 0;
});

const APP_ID = "00000000-0000-0000-0000-000000000000";
const BEARER = "Bearer header.payload.sig";

describe("createBotTokenVerifier — accept", () => {
  it("accepts when metadata + JWKS resolve and jwtVerify succeeds", async () => {
    installFetch(okMetadata());
    jwtVerifyImpl = async () => ({ payload: { iss: "x" } });
    const verify = createBotTokenVerifier({ appId: APP_ID });

    const res = await verify(BEARER);
    expect(res.ok).toBe(true);
    // The audience the inbound token is checked against is the bot's app id, with
    // the asymmetric-only algorithm allowlist pinned.
    expect(jwtVerifyCalls).toHaveLength(1);
    const opts = jwtVerifyCalls[0]!.opts as { audience: string; algorithms: string[]; issuer: string };
    expect(opts.audience).toBe(APP_ID);
    expect(opts.algorithms).toEqual(["RS256"]);
    expect(opts.issuer).toBe("https://api.botframework.com");
  });

  it("caches the JWKS set across calls (metadata fetched + createRemoteJWKSet once)", async () => {
    const calls = installFetch(okMetadata());
    jwtVerifyImpl = async () => ({});
    const verify = createBotTokenVerifier({ appId: APP_ID });

    expect((await verify(BEARER)).ok).toBe(true);
    expect((await verify(BEARER)).ok).toBe(true);
    // Lazily-initialised, then reused: one metadata fetch, one JWKS set, two verifies.
    expect(calls).toHaveLength(1);
    expect(createRemoteJWKSetCalls).toHaveLength(1);
    expect(jwtVerifyCalls).toHaveLength(2);
  });
});

describe("createBotTokenVerifier — missing/malformed bearer (fails closed, no fetch)", () => {
  it("rejects a missing Authorization header as invalid WITHOUT touching the network", async () => {
    const calls = installFetch(okMetadata());
    const verify = createBotTokenVerifier({ appId: APP_ID });
    const res = await verify(undefined);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("invalid");
    expect(calls).toHaveLength(0); // never fetched metadata for a tokenless request
  });
});

describe("createBotTokenVerifier — metadata fetch failure (→ 503, retriable, retries later)", () => {
  it("maps a non-2xx metadata response to `unavailable` and RESETS so a later call retries", async () => {
    let metaCalls = 0;
    installFetch(() => { metaCalls++; return metaCalls === 1 ? resp(503, {}) : resp(200, { jwks_uri: "https://login.example/jwks" }); });
    jwtVerifyImpl = async () => ({});
    const verify = createBotTokenVerifier({ appId: APP_ID });

    const first = await verify(BEARER);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.kind).toBe("unavailable");

    // jwksPromise was reset on the metadata failure → the next call re-fetches and
    // can now succeed (a transient metadata outage is not sticky).
    const second = await verify(BEARER);
    expect(second.ok).toBe(true);
    expect(metaCalls).toBe(2);
  });

  it("maps metadata missing `jwks_uri` to `unavailable` (and still retries afterwards)", async () => {
    let metaCalls = 0;
    installFetch(() => { metaCalls++; return metaCalls === 1 ? resp(200, { not_jwks: "x" }) : resp(200, { jwks_uri: "https://login.example/jwks" }); });
    jwtVerifyImpl = async () => ({});
    const verify = createBotTokenVerifier({ appId: APP_ID });

    const first = await verify(BEARER);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.kind).toBe("unavailable");

    const second = await verify(BEARER);
    expect(second.ok).toBe(true);
    expect(metaCalls).toBe(2); // re-fetched → proves the cached promise was reset
  });

  it("maps a network throw during the metadata fetch to `unavailable`", async () => {
    installFetch(() => { throw new TypeError("fetch failed"); });
    const verify = createBotTokenVerifier({ appId: APP_ID });
    const res = await verify(BEARER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("unavailable");
  });
});

describe("createBotTokenVerifier — JWKS / verify failures", () => {
  it("maps a JWKS-fetch throw inside jwtVerify (lazy fetch) to `unavailable` (→ 503)", async () => {
    installFetch(okMetadata());
    // createRemoteJWKSet returns a resolver that fails like a JWKS timeout — jose
    // fetches the JWKS LAZILY inside jwtVerify, so the infra fault surfaces there.
    jwtVerifyImpl = async () => { throw Object.assign(new Error("jwks timed out"), { code: "ERR_JWKS_TIMEOUT" }); };
    const verify = createBotTokenVerifier({ appId: APP_ID });
    const res = await verify(BEARER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("unavailable");
  });

  it("maps a signature/claim failure to `invalid` (→ 401, fails closed)", async () => {
    installFetch(okMetadata());
    jwtVerifyImpl = async () => { throw Object.assign(new Error("signature verification failed"), { code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" }); };
    const verify = createBotTokenVerifier({ appId: APP_ID });
    const res = await verify(BEARER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("invalid");
  });

  it("does NOT reset the cached JWKS set on a token failure (only metadata failures reset)", async () => {
    const calls = installFetch(okMetadata());
    jwtVerifyImpl = async () => { throw Object.assign(new Error("bad sig"), { code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" }); };
    const verify = createBotTokenVerifier({ appId: APP_ID });

    await verify(BEARER);
    await verify(BEARER);
    // Two failed verifies, but the metadata + JWKS were resolved exactly once: a
    // forged token must not force a metadata re-fetch (that's reserved for infra).
    expect(calls).toHaveLength(1);
    expect(createRemoteJWKSetCalls).toHaveLength(1);
  });
});
