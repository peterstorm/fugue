/**
 * Auth domain — pure types and functions for the host's inbound auth.
 *
 * The auth model has THREE inbound identities (see `AuthIdentity`):
 * - ADMIN_TOKEN (env var) = root of trust, full access, used to provision teams.
 * - Team tokens = generated per-team, stored hashed in Redis, scoped to team's DAGs.
 * - User (OIDC) = a human authenticated via a fugue-platform realm JWT, verified
 *   by the injected JWKS verifier then claim-validated here (`SignatureVerifiedClaims`
 *   → `AuthenticatedUser`). The user's `sub` is threaded into the run `origin` for
 *   per-hop capability minting by the broker.
 *
 * All functions here are pure — no I/O, no Redis, no crypto side effects (the
 * branding constructors only stamp a phantom type). The imperative shell
 * (middleware, handlers) calls these for decisions.
 */

import { match } from "ts-pattern";

// ── Branded Types ──────────────────────────────────────────────────────────

/**
 * An inbound string matching the team-token SHAPE (`fug_` prefix + minimum
 * length). Shape is ALL this brand asserts — an attacker-supplied
 * `fug_aaaa…` inhabits it. Produced by the `isTeamTokenShape` guard; safe to
 * use only for routing + hash-lookup (resolution is hash-based, so a forged
 * shape resolves to nothing).
 */
export type TeamTokenShaped = string & { readonly __shapeBrand: "TeamTokenShaped" };

/**
 * A raw team token as returned to the admin (shown once, never stored raw).
 * Subtype of `TeamTokenShaped` that ADDITIONALLY encodes "carries full
 * entropy" — its only producer is `formatToken`, which enforces the 32-byte
 * input. Keeping the two brands distinct stops an inbound shape-checked string
 * from being passed where a generated, full-entropy token is required.
 */
export type TeamToken = TeamTokenShaped & { readonly __brand: "TeamToken" };

/** SHA-256 hash of a token — this is what's stored in Redis */
export type TokenHash = string & { readonly __brand: "TokenHash" };

/**
 * The Keycloak client id an agent acts AS — the identity the broker's policy
 * gate (`assignedScopes`), the token-cache identity, and the audit `azp` are
 * all keyed on. Branded with a SINGLE constructor (`agentClientIdForDag`)
 * because the value is currently a PLACEHOLDER: until the dagId→Keycloak-client
 * mapping lands (ADR-0056), the DAG id stands in for the agent client id at
 * every one of those sites. Funnelling construction through one function makes
 * that migration compiler-checked — swap the constructor body for the
 * config-mapped lookup and every consumer is already correct — instead of a
 * grep across a security-relevant correlation chain.
 */
export type AgentClientId = string & { readonly __brand: "AgentClientId" };

/**
 * THE single producer of `AgentClientId`. Today: the dagId-as-client
 * placeholder (one Keycloak client per agent type / per DAG, ADR-0056 — the
 * mapping is the identity function until the config-mapped registry lands).
 * When the real mapping arrives, change ONLY this body.
 */
export const agentClientIdForDag = (dagId: string): AgentClientId => dagId as AgentClientId;

// ── Token Grant (stored in Redis) ──────────────────────────────────────────

/**
 * What a resolved team token grants access to.
 * Stored as JSON value in Redis keyed by the token's hash.
 */
export interface TokenGrant {
  readonly team: string;
  readonly label: string;
  readonly createdAt: number;
}

// ── Auth Identity (resolved at request time) ───────────────────────────────

/**
 * The identity resolved from a bearer token during a request.
 * Set on Hono context for downstream handlers.
 *
 * Variants:
 * - `admin` — root of trust (ADMIN_TOKEN env var), full access.
 * - `team`  — opaque `fug_` team token, scoped to the team's DAGs.
 * - `user`  — a human authenticated via a fugue-platform realm OIDC JWT
 *   (FR-W3-006/FR-W3-007). `sub` is the user's subject; `azp` is the
 *   authorized party (the OIDC client that minted the token). This identity
 *   is established at the inbound boundary so the user's subject can be threaded
 *   through the run and exchanged per-hop by the capability broker (sub stays
 *   the user, azp becomes the agent — `adapters/keycloak-broker.ts`, wired at
 *   boot; the live exchange endpoint remains fail-closed-unwired pending the
 *   JWKS wave). No token exchange happens here.
 */
export type AuthIdentity =
  | { readonly kind: "admin" }
  | { readonly kind: "team"; readonly team: string; readonly label: string }
  | { readonly kind: "user"; readonly sub: string; readonly azp: string };

// ── Realm JWT Claims (validated fugue-platform OIDC token) ─────────────────

/**
 * The audience claim of an OIDC token. Keycloak emits `aud` as either a single
 * string or an array of strings depending on how many audiences are mapped, so
 * both shapes are modelled and handled by the validator.
 */
export type JwtAudience = string | readonly string[];

/**
 * The subset of fugue-platform realm JWT claims this host validates.
 *
 * IMPORTANT: this type describes claims whose SIGNATURE HAS ALREADY BEEN
 * VERIFIED by the injected verifier. It is NOT a trust assertion on its own —
 * `validateRealmJwtClaims` still enforces iss/aud/exp before any claim is used.
 *
 * - `iss` — token issuer (must equal the fugue-platform realm issuer URL).
 * - `aud` — intended audience(s) (must contain `fugue-host`).
 * - `exp` — expiry as a UNIX timestamp in SECONDS (OIDC convention).
 * - `sub` — the authenticated user's subject (stable user id).
 * - `azp` — authorized party: the OIDC client id the token was minted for.
 */
export interface RealmJwtClaims {
  readonly iss: string;
  readonly aud: JwtAudience;
  readonly exp: number;
  readonly sub: string;
  readonly azp: string;
}

// ── Signature-verified claims & authenticated user (branded — review C5) ────

declare const __sigVerifiedBrand: unique symbol;
declare const __authUserBrand: unique symbol;

/**
 * `RealmJwtClaims` whose JWT SIGNATURE HAS BEEN VERIFIED by the JWKS-backed
 * verifier port. Hard-branded (a `unique symbol`, like `RunId`): a plain claims
 * object — e.g. `JSON.parse(atob(token.split(".")[1]))` from an UNVERIFIED token
 * — does NOT inhabit this type, so it cannot be passed where verified claims are
 * required. The brand encodes the fact the comment used to assert: that signature
 * verification happened FIRST. The ONLY producer is `markSignatureVerified`,
 * which the verifier port (and test fakes standing in for it) call — making every
 * "trust this token" decision a single, greppable, reviewable site rather than an
 * implicit convention spread across endpoint authors.
 */
export type SignatureVerifiedClaims = RealmJwtClaims & { readonly [__sigVerifiedBrand]: void };

/**
 * The result of fully authenticating a realm JWT: signature verified AND
 * iss/aud/exp policy satisfied. Hard-branded and produced ONLY by
 * `validateRealmJwtClaims`, so a bare `{ sub, azp }` (indistinguishable from
 * unvalidated strings) can never be mistaken for an authenticated principal. The
 * `sub`/`azp` are read off it at the one trusted construction site (the auth
 * middleware) to build the `user` `AuthIdentity`.
 */
export type AuthenticatedUser = { readonly sub: string; readonly azp: string } & {
  readonly [__authUserBrand]: void;
};

/**
 * Brand raw claims as signature-verified. This is the trust boundary's single
 * entry point: ONLY the JWKS signature verifier (and the fakes that substitute
 * for it in tests) may call it, and only AFTER cryptographically verifying the
 * token's signature against the realm's keys. Calling it on unverified claims is
 * a deliberate forgery of the brand — visible in review, never accidental.
 */
export const markSignatureVerified = (claims: RealmJwtClaims): SignatureVerifiedClaims =>
  claims as SignatureVerifiedClaims;

/**
 * Brand a validated principal. @internal — only `validateRealmJwtClaims`
 * constructs an `AuthenticatedUser`, AFTER the iss/aud/exp checks pass.
 */
export const markAuthenticatedUser = (user: { readonly sub: string; readonly azp: string }): AuthenticatedUser =>
  user as AuthenticatedUser;

// ── Authorization (pure) ───────────────────────────────────────────────────

/**
 * Can the given identity access a DAG owned by `dagTeam`?
 *
 * Rules:
 * - Admin can access anything.
 * - Team identity can only access DAGs owned by that team.
 * - User identity (fugue-platform JWT) may run DAGs in this wave. User-run
 *   authorization is NOT team-scoped here: the user's downstream authorization
 *   is enforced per-hop by the identity-scoped capability broker
 *   (`adapters/keycloak-broker.ts`, selected at boot when `REALM_JWT_ISSUER` is
 *   set) via the V2 token exchange, where the realm/Keycloak policy gates what
 *   the user-via-agent may actually reach. THIS predicate deliberately does NOT
 *   grant admin-equivalent access — a `user` is not an `admin`; it only clears
 *   the inbound run gate so the user's `sub` can be threaded into the run.
 *   It returns `true` independent of `dagTeam` (a user is not bound to a single
 *   host-side team), which is the minimal correct behaviour for threading-only
 *   delivery; tightening this to a realm/role check is a later-wave concern.
 *
 * SECURITY (latent until the JWKS wave): this `user → true` branch is
 * UNREACHABLE in production today only because no `realmJwt` verifier group is wired
 * (`host.ts` leaves the JWT path fail-closed). The moment a live JWKS verifier
 * is wired into the router deps, ANY authenticated realm user can execute ANY
 * team's DAG — consuming its concurrency permits, LLM budget, and circuit
 * headroom — because the broker's scope gate only protects downstream
 * Graph/Dynamics hops, not DAG execution or static capabilities. The verifier
 * wiring site (`buildHost` in `host.ts`) carries the mirror of this note: DO
 * NOT wire a verifier without revisiting this predicate (realm/role check or a
 * config gate on user-run acceptance).
 */
export const canAccessDag = (identity: AuthIdentity, dagTeam: string): boolean =>
  match(identity)
    .with({ kind: "admin" }, () => true)
    .with({ kind: "team" }, (t) => t.team === dagTeam)
    .with({ kind: "user" }, () => true)
    .exhaustive();

// ── Token Generation (pure computation, randomness injected) ───────────────

/** Prefix for Fugue team tokens — makes them greppable in logs/configs */
export const TOKEN_PREFIX = "fug_";

/** Minimum token length (prefix + 43 chars of base64url from 32 bytes) */
export const TOKEN_MIN_LENGTH = TOKEN_PREFIX.length + 43;

/** Required entropy for a team token — 32 bytes → 43 base64url chars. */
export const TOKEN_RANDOM_BYTES = 32;

/**
 * Construct a TeamToken from a prefix + random bytes (base64url encoded).
 * The randomness is injected — this function just formats.
 *
 * Enforces the 32-byte input: the `TeamToken` brand encodes "carries full
 * entropy", so producing one from short input would forge the brand at its
 * origin. A wrong length throws (a wiring bug, not a runtime input) rather than
 * silently minting a weak token (review suggestion).
 *
 * @param randomBytes - exactly 32 bytes of cryptographic randomness
 */
export const formatToken = (randomBytes: Uint8Array): TeamToken => {
  if (randomBytes.length !== TOKEN_RANDOM_BYTES) {
    throw new Error(
      `formatToken: expected ${TOKEN_RANDOM_BYTES} random bytes, got ${randomBytes.length} — ` +
        `the TeamToken brand requires full entropy`,
    );
  }
  const encoded = base64url(randomBytes);
  return `${TOKEN_PREFIX}${encoded}` as TeamToken;
};

/**
 * Type guard: validates that a string has the team token shape (prefix + minimum length).
 * Does NOT check if the token exists — that's the store's job — and does NOT
 * assert entropy: it narrows to `TeamTokenShaped`, never to `TeamToken` (whose
 * brand means "generated with full entropy" and is minted only by `formatToken`).
 */
export const isTeamTokenShape = (s: string): s is TeamTokenShaped =>
  s.startsWith(TOKEN_PREFIX) && s.length >= TOKEN_MIN_LENGTH;

// ── Hashing (pure — crypto.subtle is deterministic for same input) ─────────

/**
 * Hash a token using SHA-256 for storage.
 * Tokens are high-entropy (32 random bytes), so no salt is needed.
 *
 * NOTE: This is an async function because Web Crypto API is async.
 * It's still deterministic (same input → same output).
 */
export const hashToken = async (token: string): Promise<TokenHash> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return hexEncode(hashArray) as TokenHash;
};

// ── Helpers ────────────────────────────────────────────────────────────────

/** Encode bytes as base64url (no padding) */
const base64url = (bytes: Uint8Array): string => {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Encode bytes as lowercase hex string */
const hexEncode = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
