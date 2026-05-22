/**
 * Auth domain — pure types and functions for team-scoped token auth.
 *
 * The auth model:
 * - ADMIN_TOKEN (env var) = root of trust, full access, used to provision teams
 * - Team tokens = generated per-team, stored hashed in Redis, scoped to team's DAGs
 *
 * All functions here are pure — no I/O, no Redis, no crypto side effects.
 * The imperative shell (middleware, handlers) calls these for decisions.
 */

// ── Branded Types ──────────────────────────────────────────────────────────

/** A raw team token as returned to the admin (shown once, never stored raw) */
export type TeamToken = string & { readonly __brand: "TeamToken" };

/** SHA-256 hash of a token — this is what's stored in Redis */
export type TokenHash = string & { readonly __brand: "TokenHash" };

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
 */
export type AuthIdentity =
  | { readonly kind: "admin" }
  | { readonly kind: "team"; readonly team: string; readonly label: string };

// ── Authorization (pure) ───────────────────────────────────────────────────

/**
 * Can the given identity access a DAG owned by `dagTeam`?
 *
 * Rules:
 * - Admin can access anything
 * - Team identity can only access DAGs owned by that team
 */
export const canAccessDag = (identity: AuthIdentity, dagTeam: string): boolean =>
  identity.kind === "admin" || identity.team === dagTeam;

// ── Token Generation (pure computation, randomness injected) ───────────────

/** Prefix for Fugue team tokens — makes them greppable in logs/configs */
export const TOKEN_PREFIX = "fug_";

/** Minimum token length (prefix + 43 chars of base64url from 32 bytes) */
export const TOKEN_MIN_LENGTH = TOKEN_PREFIX.length + 43;

/**
 * Construct a TeamToken from a prefix + random bytes (base64url encoded).
 * The randomness is injected — this function just formats.
 *
 * @param randomBytes - 32 bytes of cryptographic randomness
 */
export const formatToken = (randomBytes: Uint8Array): TeamToken => {
  const encoded = base64url(randomBytes);
  return `${TOKEN_PREFIX}${encoded}` as TeamToken;
};

/**
 * Validate that a string looks like a team token (has prefix, sufficient length).
 * Does NOT check if the token exists — that's the store's job.
 */
export const isTeamTokenShape = (s: string): boolean =>
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
