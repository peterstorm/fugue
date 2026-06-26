/**
 * Tests for the realm JWT signature verifier (adapters/realm-jwt-verifier.ts).
 *
 * Invariants under test:
 *   - FR-003 / AD-4 — verifies the SIGNATURE against the realm's published keys
 *     (`createRemoteJWKSet`) and brands the claims via `markSignatureVerified`.
 *     SIGNATURE-ONLY: a token whose iss/aud are "wrong" but whose SIGNATURE is
 *     valid still passes here (iss/aud/exp belong to the pure validator). An
 *     EXPIRED token also passes signature verification (with clock tolerance the
 *     adapter does NOT enforce exp — that is the validator's job).
 *   - NFR-020 — valid → SignatureVerified; bad-sig / unparsable → invalid;
 *     JWKS-down → unavailable. Never throws.
 *
 * The JWKS is served from a LOCAL HTTP server seeded with a jose-generated key
 * pair — a real signature round-trip, no live network beyond loopback. A second
 * key pair (never published) produces the bad-signature case. JWKS-down points
 * the verifier at a closed loopback port.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import {
  createRealmJwtVerifier,
  classifyRealmJoseError,
  realmJwksUri,
} from "../realm-jwt-verifier.js";

// jose is a runtime dep (used by the Bot verifier + the adapter under test).
import {
  exportJWK,
  generateKeyPair,
  generateSecret,
  SignJWT,
  type JWK,
  type CryptoKey,
} from "jose";

const ISSUER = "https://realm.example/realms/fugue-platform";

// ── Local JWKS server seeded with a generated RS256 key pair ─────────────────

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let signingKey: CryptoKey;
let foreignKey: CryptoKey; // a key whose public half is NEVER published → bad sig
let hmacKey: CryptoKey; // symmetric key for the HS256 alg-confusion negative test

// EC signing keys (ES256 / ES512) — published alongside the RS256 key so a
// single JWKS proves an ES-family token verifies against the alg allowlist.
const EC_ALGS = ["ES256", "ES512"] as const;
type EcAlg = (typeof EC_ALGS)[number];
const ecSigningKeys = new Map<EcAlg, CryptoKey>();
const ecPublicJwks: JWK[] = [];

/**
 * Controls what the JWKS endpoint returns, so a single harness can model a
 * healthy realm AND realm-outage modes (non-200, malformed body) for NFR-020.
 * Reset to "ok" in beforeEach via the per-test setters below.
 */
type JwksMode =
  | { kind: "ok" }
  | { kind: "non200"; status: number; body: string }
  | { kind: "malformed"; body: string };
let jwksMode: JwksMode = { kind: "ok" };

beforeAll(async () => {
  const kid = "test-key-1";
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" };

  const foreign = await generateKeyPair("RS256");
  foreignKey = foreign.privateKey;

  // Symmetric key for the alg-confusion defence test (HS256-signed token).
  hmacKey = (await generateSecret("HS256")) as CryptoKey;

  // EC key pairs whose PUBLIC halves are published in the JWKS — one per EC alg
  // under test — to prove a positive ES-family signature round-trip.
  for (const alg of EC_ALGS) {
    const ecPair = await generateKeyPair(alg);
    ecSigningKeys.set(alg, ecPair.privateKey);
    ecPublicJwks.push({ ...(await exportJWK(ecPair.publicKey)), kid: `ec-${alg}`, alg, use: "sig" });
  }

  // Serve the realm's JWKS at the Keycloak certs path the adapter derives.
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/realms/fugue-platform/protocol/openid-connect/certs") {
        switch (jwksMode.kind) {
          case "non200":
            // Realm REACHABLE but down (5xx / maintenance / 404 / redirect):
            // createRemoteJWKSet throws a bare JOSEError "Expected 200 OK…".
            return new Response(jwksMode.body, { status: jwksMode.status });
          case "malformed":
            // 200 but the body is not parseable JSON: createRemoteJWKSet throws
            // a bare JOSEError "Failed to parse the JSON Web Key Set…".
            return new Response(jwksMode.body, {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          case "ok":
            return new Response(JSON.stringify({ keys: [publicJwk, ...ecPublicJwks] }), {
              headers: { "Content-Type": "application/json" },
            });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

beforeEach(() => {
  jwksMode = { kind: "ok" };
});

afterAll(() => {
  server.stop(true);
});

/** Sign a JWT with the PUBLISHED key (valid signature). */
const signValid = (claims: Record<string, unknown>, expSecondsFromNow = 3600) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expSecondsFromNow)
    .sign(signingKey);

const issuerFor = () => `${baseUrl}/realms/fugue-platform`;

describe("realmJwksUri — derives the Keycloak certs endpoint (FR-003)", () => {
  it("appends the openid-connect certs path", () => {
    expect(realmJwksUri(ISSUER)).toBe(`${ISSUER}/protocol/openid-connect/certs`);
  });
  it("normalises a trailing slash on the issuer", () => {
    expect(realmJwksUri(`${ISSUER}/`)).toBe(`${ISSUER}/protocol/openid-connect/certs`);
  });
});

describe("createRealmJwtVerifier — explicit jwksUri decouples key-fetch from issuer (split-horizon)", () => {
  it("verifies a token whose iss is an UNREACHABLE public URL by fetching keys from the in-cluster jwksUri", async () => {
    // issuer = a public route that does NOT resolve (would fail if it were the
    // key source); jwksUri = the reachable local ('in-cluster') certs endpoint.
    const verify = createRealmJwtVerifier({
      issuer: "https://keycloak.public.example/realms/fugue-platform",
      jwksUri: realmJwksUri(issuerFor()),
    });
    const token = await signValid({ iss: "https://keycloak.public.example/realms/fugue-platform" });
    const res = await verify(token);
    // Signature verified against keys fetched over jwksUri, not the (dead) issuer.
    expect(res.ok).toBe(true);
  });
});

describe("createRealmJwtVerifier — valid signature → SignatureVerified (FR-003/NFR-020)", () => {
  it("a token signed by the realm's published key verifies and returns the claims", async () => {
    const verify = createRealmJwtVerifier({ issuer: issuerFor() });
    const token = await signValid({
      iss: issuerFor(),
      aud: "fugue-host",
      sub: "user-123",
      azp: "fugue-platform-frontend",
    });

    const r = await verify(token);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
    // The branded claims carry the raw payload through for the pure validator.
    expect(r.value.iss).toBe(issuerFor());
    expect(r.value.sub).toBe("user-123");
    expect(r.value.azp).toBe("fugue-platform-frontend");
  });

  it.each(EC_ALGS.map((alg) => [alg] as [EcAlg]))(
    "%s: a token signed by the realm's published EC key verifies (the alg allowlist admits the ES family, not just RS256)",
    async (alg) => {
      const verify = createRealmJwtVerifier({ issuer: issuerFor() });
      const token = await new SignJWT({ iss: issuerFor(), aud: "fugue-host", sub: "ec-user", azp: "x" })
        .setProtectedHeader({ alg, kid: `ec-${alg}` })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
        .sign(ecSigningKeys.get(alg)!);

      const r = await verify(token);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(`expected ok for ${alg}, got ${JSON.stringify(r.error)}`);
      expect(r.value.sub).toBe("ec-user");
    },
  );

  it("SIGNATURE-ONLY: a validly-signed token with a 'wrong' issuer/aud STILL passes here (iss/aud belong to the pure validator)", async () => {
    const verify = createRealmJwtVerifier({ issuer: issuerFor() });
    // These claims would be rejected by validateRealmJwtClaims, but the adapter
    // must NOT look at them — it verifies the signature only.
    const token = await signValid({
      iss: "https://attacker.example/realms/evil",
      aud: "some-other-audience",
      sub: "u",
      azp: "x",
    });
    const r = await verify(token);
    expect(r.ok).toBe(true);
  });

  it("SIGNATURE-ONLY: a validly-signed but EXPIRED token still passes the signature check (exp is the validator's job)", async () => {
    const verify = createRealmJwtVerifier({ issuer: issuerFor() });
    // Expired 10s ago — within the 60s clock tolerance, so jwtVerify accepts it.
    // The pure validator (now-strict, no tolerance) is what rejects expiry.
    const token = await signValid({ iss: issuerFor(), aud: "fugue-host", sub: "u", azp: "x" }, -10);
    const r = await verify(token);
    expect(r.ok).toBe(true);
  });
});

describe("createRealmJwtVerifier — bad signature → invalid (NFR-020, fail closed)", () => {
  it("a token signed by an UNPUBLISHED key → invalid (no matching JWKS key)", async () => {
    const verify = createRealmJwtVerifier({ issuer: issuerFor() });
    const token = await new SignJWT({ iss: issuerFor(), aud: "fugue-host", sub: "u", azp: "x" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" }) // claims the published kid…
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(foreignKey); // …but signs with a DIFFERENT key → signature fails

    const r = await verify(token);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected invalid");
    expect(r.error.kind).toBe("invalid");
  });

  it("a structurally garbage token → invalid (never throws)", async () => {
    const verify = createRealmJwtVerifier({ issuer: issuerFor() });
    const r = await verify("not.a.jwt");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected invalid");
    expect(r.error.kind).toBe("invalid");
  });

  it("alg-confusion: an HS256-signed token → invalid (the asymmetric alg allowlist rejects symmetric/none, not jose defaults)", async () => {
    const verify = createRealmJwtVerifier({ issuer: issuerFor() });
    // A token signed with a symmetric HMAC key, advertising the published kid.
    // The adapter's REALM_TOKEN_ALGS allowlist (RS/PS/ES only) must reject HS256
    // BEFORE any key lookup — the classic alg-confusion / alg:none defence.
    const token = await new SignJWT({ iss: issuerFor(), aud: "fugue-host", sub: "u", azp: "x" })
      .setProtectedHeader({ alg: "HS256", kid: "test-key-1" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(hmacKey);
    const r = await verify(token);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected invalid");
    expect(r.error.kind).toBe("invalid");
  });
});

describe("createRealmJwtVerifier — JWKS endpoint REACHABLE but faulted → unavailable (NFR-020)", () => {
  it("a JWKS endpoint that answers non-200 (realm down / maintenance / 5xx) → unavailable, not invalid", async () => {
    // Realm is reachable but returns 503 — createRemoteJWKSet's fetch throws a
    // bare JOSEError ("Expected 200 OK from the JSON Web Key Set HTTP response").
    // The token signature is otherwise valid, so the ONLY failure is the fetch.
    jwksMode = { kind: "non200", status: 503, body: "maintenance" };
    const verify = createRealmJwtVerifier({ issuer: issuerFor() });
    const token = await signValid({ iss: issuerFor(), aud: "fugue-host", sub: "u", azp: "x" });
    const r = await verify(token);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected unavailable");
    expect(r.error.kind).toBe("unavailable");
  });

  it("a JWKS endpoint that returns 200 with a non-JSON body → unavailable, not invalid", async () => {
    // 200 but unparseable — createRemoteJWKSet throws a bare JOSEError
    // ("Failed to parse the JSON Web Key Set HTTP response as JSON").
    jwksMode = { kind: "malformed", body: "not json" };
    const verify = createRealmJwtVerifier({ issuer: issuerFor() });
    const token = await signValid({ iss: issuerFor(), aud: "fugue-host", sub: "u", azp: "x" });
    const r = await verify(token);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected unavailable");
    expect(r.error.kind).toBe("unavailable");
  });
});

describe("createRealmJwtVerifier — JWKS down → unavailable (NFR-020, retriable 503)", () => {
  it("an unreachable JWKS endpoint → unavailable, not invalid (a key-rotation outage is not a forged token)", async () => {
    // Point at a closed loopback port: the lazy JWKS fetch inside jwtVerify fails.
    const verify = createRealmJwtVerifier({ issuer: "http://127.0.0.1:1/realms/down" });
    const token = await signValid({ iss: issuerFor(), aud: "fugue-host", sub: "u", azp: "x" });
    const r = await verify(token);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected unavailable");
    expect(r.error.kind).toBe("unavailable");
  });
});

describe("classifyRealmJoseError — infra vs token fault split (mirrors Bot verifier)", () => {
  it("classifies JWKS/network faults as unavailable (→ 503)", () => {
    expect(classifyRealmJoseError({ code: "ERR_JWKS_TIMEOUT" })).toBe("unavailable");
    expect(classifyRealmJoseError({ name: "JWKSTimeout", message: "timed out" })).toBe("unavailable");
    expect(classifyRealmJoseError(new TypeError("fetch failed"))).toBe("unavailable");
    expect(classifyRealmJoseError(new Error("getaddrinfo ENOTFOUND realm.example"))).toBe("unavailable");
    expect(classifyRealmJoseError(new Error("connect ECONNREFUSED"))).toBe("unavailable");
    // Bun's fetch reject shape: a plain Error with a `code` + "Unable to connect" message.
    expect(classifyRealmJoseError(Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" }))).toBe("unavailable");
    expect(classifyRealmJoseError(Object.assign(new Error("socket"), { code: "FailedToOpenSocket" }))).toBe("unavailable");
  });

  it("classifies a JWKS-fetch JOSEError (realm reachable but non-200 / unparseable) as unavailable (→ 503, NFR-020)", () => {
    // createRemoteJWKSet's fetch throws a bare JOSEError (code ERR_JOSE_GENERIC)
    // whose only signal is the English message. A realm outage must be 503, not
    // a 401 forged-token verdict.
    expect(
      classifyRealmJoseError(
        Object.assign(new Error("Expected 200 OK from the JSON Web Key Set HTTP response"), {
          code: "ERR_JOSE_GENERIC",
          name: "JOSEError",
        }),
      ),
    ).toBe("unavailable");
    expect(
      classifyRealmJoseError(
        Object.assign(new Error("Failed to parse the JSON Web Key Set HTTP response as JSON"), {
          code: "ERR_JOSE_GENERIC",
          name: "JOSEError",
        }),
      ),
    ).toBe("unavailable");
  });

  it("classifies a structurally-broken keyset (ERR_JWKS_INVALID / JWKSInvalid) as unavailable (botched rotation is infra, not a forged token)", () => {
    expect(classifyRealmJoseError({ code: "ERR_JWKS_INVALID", message: "JSON Web Key Set malformed" })).toBe(
      "unavailable",
    );
    expect(classifyRealmJoseError({ name: "JWKSInvalid", message: "JSON Web Key Set malformed" })).toBe(
      "unavailable",
    );
  });

  it("classifies signature/claim/structural faults as invalid (→ 401, fail closed)", () => {
    expect(classifyRealmJoseError({ code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED", message: "bad sig" })).toBe("invalid");
    expect(classifyRealmJoseError({ code: "ERR_JWT_EXPIRED", message: "exp" })).toBe("invalid");
    expect(classifyRealmJoseError(new Error("unexpected token type"))).toBe("invalid");
    expect(classifyRealmJoseError("opaque")).toBe("invalid");
  });
});
