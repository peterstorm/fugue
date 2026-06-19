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
// Type-only import of the branded `Tenant` principal for the tenant-aware authz
// extension below. `tenant.ts` imports `AuthIdentity` (a type) from this module;
// keeping THIS import type-only means no runtime import cycle.
import type { Tenant } from "./tenant.js";

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

declare const __teamBrand: unique symbol;

/**
 * A team identifier — the unit the host authorizes on (`canAccessDag` keys on
 * team equality; tokens, the JWT `teams` claim, DAG ownership, and a `Tenant`'s
 * owning team are all teams). Branded so a team can never be confused at a type
 * level with another identifier (a `clientId`, a `sub`, an `AgentClientId`): the
 * load-bearing `tenant.team === dagTeam` / `canAccessDag` comparisons are now
 * `Team === Team`, not bare-string equality a refactor could silently misalign.
 *
 * A PURE brand (like `SubjectToken` / `AuthenticatedUser`): `markTeam` stamps the
 * phantom type without runtime validation — team values arrive already-trusted
 * from their own boundaries (a verified JWT claim, a stored token grant, the
 * registry config, a loaded DAG). The brand asserts PROVENANCE ("this string came
 * through a team boundary"), not a shape; it carries no self-protection beyond
 * that and erases at runtime, so it is behaviourally identical to the string.
 */
export type Team = string & { readonly [__teamBrand]: void };

/**
 * Brand a string as a `Team`. The single, greppable producer at each team
 * boundary (JWT `teams` claim, team-token grant, tenant/DAG config). A pure cast —
 * no validation — so it never changes runtime behaviour; it only records that the
 * value crossed a team boundary so downstream authz compares like-typed values.
 */
export const markTeam = (s: string): Team => s as Team;

declare const __subjectTokenBrand: unique symbol;

/**
 * The raw, compact-serialized user JWT that was SIGNATURE-VERIFIED at the inbound
 * boundary — the `subject_token` proof an RFC 8693 Standard Token Exchange V2
 * presents so the exchanged downstream token keeps the user as `sub` (FR-030).
 *
 * Hard-branded with a `unique symbol` (like `RunId` / `SignatureVerifiedClaims`):
 * a plain string — an attacker-supplied or merely decoded token — does NOT inhabit
 * it. Its SOLE producer is `markSubjectToken`, which the auth middleware calls only
 * AFTER `VerifyRealmJwt` returns `ok` (signature verified). The brand makes "this
 * is the exact compact JWT whose signature we checked" a single, greppable seam,
 * not a convention spread across call sites.
 *
 * NFR-011 / NFR-014: this raw token is NEVER placed on a capability handle, NEVER
 * crosses the framework `InvocationOrigin` (which stays string-only, FR-032), and
 * is threaded HOST-SIDE only (a `runId → SubjectToken` side-channel resolved at the
 * broker). Being a branded STRING, it carries NO self-protection: `String()`,
 * `JSON.stringify`, or template interpolation surface the raw JWT verbatim (unlike
 * the object-typed `KeycloakClientCredential`, whose shape resists accidental
 * coercion). The ONLY protections are the documented never-log constraint and the
 * single-producer brand; the value only ever flows into the exchange POST body.
 */
export type SubjectToken = string & { readonly [__subjectTokenBrand]: void };

/**
 * Brand a raw compact JWT as the verified user's `subject_token`. The trust
 * boundary's single producer: ONLY the auth middleware calls it, and only AFTER
 * the injected `VerifyRealmJwt` returned `ok` for THIS exact token string (so the
 * branded value is the compact JWT whose signature was cryptographically
 * verified). Calling it on an unverified string is a deliberate forgery of the
 * brand — visible in review, never accidental (mirrors `markSignatureVerified`).
 */
export const markSubjectToken = (verifiedCompactJwt: string): SubjectToken =>
  verifiedCompactJwt as SubjectToken;

/**
 * The Keycloak client id an agent acts AS — the identity the broker's policy
 * gate (`AssignedScopes`), the token-cache identity, and the audit `azp` are
 * all keyed on. It is the REAL Keycloak agent-type client id (e.g.
 * `fugue-agent-mail`), resolved from a DAG id through the config-mapped
 * `AgentClientMap` by `agentClientIdForDag` (FR-040, ADR-0056). The DAG-id
 * placeholder is gone: a DAG with no mapping fails closed (no identity
 * passthrough), so a node can never mint as the wrong/absent client.
 *
 * The brand is LOAD-BEARING at the policy gate: `AssignedScopes` demands an
 * `AgentClientId`, so the fail-closed scope lookup cannot be called with an
 * arbitrary string (e.g. the user's `sub`, or the frontend `azp`) — only a
 * value that came through one of the two branding boundaries below. It cannot
 * be load-bearing at the FRAMEWORK seam (`InvocationOrigin.agentClientId` is a
 * framework type and stays plain `string` — the framework port must not depend
 * on this host-only Keycloak-client brand), so the brand is erased crossing
 * into the framework and RESTORED at the single host re-entry point by
 * `agentClientIdFromFrameworkOrigin` below. `AGENT_CLIENT_SCOPES` config keys
 * are now REAL client ids (not dag ids); they are consulted only behind the
 * branded `AssignedScopes` boundary.
 */
export type AgentClientId = string & { readonly __brand: "AgentClientId" };

/**
 * The config-mapped DAG-id → real-Keycloak-agent-client-id registry (FR-040,
 * ADR-0056 Variant A: one Keycloak service-account client per agent TYPE). Keys
 * are DAG ids; values are the real client ids (`fugue-agent-mail`, …) on which
 * `AGENT_CLIENT_SCOPES` and `KEYCLOAK_AGENT_CLIENT_CREDENTIALS` are keyed. A DAG
 * id absent from this map has NO agent client — its origin resolution fails
 * closed (see `agentClientIdForDag`).
 */
export type AgentClientMap = Readonly<Record<string, string>>;

/**
 * THE source producer of `AgentClientId` (the inbound boundary): resolves a DAG
 * id to its REAL Keycloak agent-type client id via the config-mapped
 * `AgentClientMap` (FR-040, ADR-0056). The map is INJECTED (it comes from host
 * config, `AGENT_CLIENT_MAP`), keeping this function pure.
 *
 * FAIL CLOSED (FR-040): a DAG id with no mapping returns `undefined` — first-
 * class ABSENCE, not the identity-function passthrough that would silently mint
 * as the dag-id-named (wrong/absent) client. The call site treats `undefined`
 * as "no agent identity for this run" and refuses rather than fabricate one.
 */
export const agentClientIdForDag = (
  map: AgentClientMap,
  dagId: string,
): AgentClientId | undefined => {
  // Own-property lookup only — never resolve an inherited Object.prototype key
  // (`__proto__`, `constructor`, `toString`, …) to a client id; an unmapped DAG
  // resolves to first-class ABSENCE (fail-closed), keeping the `AgentClientId`
  // brand honest. Matches the sibling guard in `approverTeamIdentity`.
  const clientId = Object.prototype.hasOwnProperty.call(map, dagId) ? map[dagId] : undefined;
  return clientId === undefined ? undefined : (clientId as AgentClientId);
};

/**
 * RESTORE the `AgentClientId` brand at the single host re-entry point — the
 * capability broker, where the value re-enters host code off the framework
 * `InvocationOrigin.agentClientId` (a plain `string`, because the framework
 * port must not depend on this host brand). The value was already minted by
 * `agentClientIdForDag` at the inbound boundary (`invocationOriginForIdentity`)
 * and merely WIDENED crossing the framework seam; this re-narrows it so the
 * broker's `AssignedScopes` gate demands the brand rather than any string.
 * Brand-boundary idiom — a documented re-narrow at one seam, like
 * `markSignatureVerified` for verified claims (NOT a third name↔client
 * correlation cast; ADR-0053's two-point rule is about those).
 */
export const agentClientIdFromFrameworkOrigin = (agentClientId: string): AgentClientId =>
  agentClientId as AgentClientId;

// ── Token Grant (stored in Redis) ──────────────────────────────────────────

/**
 * What a resolved team token grants access to.
 * Stored as JSON value in Redis keyed by the token's hash.
 */
export interface TokenGrant {
  readonly team: Team;
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
 *   boot). Inbound user JWT verification is LIVE (gated on `REALM_JWT_ISSUER`);
 *   only the downstream per-hop token-exchange legs may be config-gated/unwired
 *   (AD-3 config-presence gating, not a deferred wave). No token exchange
 *   happens here.
 *
 *   `canRunDag` is the user-run AUTHORIZATION POLICY, captured at the single
 *   construction site (the auth middleware) from the REQUIRED
 *   `RealmJwtDeps.authorizeUserRun` member. Pairing the policy with the
 *   verifier (and carrying it on the identity) makes "verifier wired but
 *   user-run authorization undecided" UNREPRESENTABLE — the same move as
 *   `MintingAuthority`/`RealmJwtDeps` themselves. `canAccessDag` delegates its
 *   `user` branch here.
 */
export type AuthIdentity =
  | { readonly kind: "admin" }
  | { readonly kind: "team"; readonly team: Team; readonly label: string }
  | {
      readonly kind: "user";
      readonly sub: string;
      readonly azp: string;
      /** May this user run/see DAGs owned by `dagTeam`? Provided by `RealmJwtDeps.authorizeUserRun`. */
      readonly canRunDag: (dagTeam: Team) => boolean;
      /**
       * The user's ACTUAL verified compact JWT — the `subject_token` proof the
       * broker presents in the RFC 8693 Standard Token Exchange V2 so the
       * exchanged downstream token preserves this user as `sub` (FR-030/FR-031).
       * Branded (`markSubjectToken`), produced ONLY at the verify seam (the auth
       * middleware, after the signature verified). It is carried on the identity
       * so the run-context factory can thread it HOST-SIDE (`runId → SubjectToken`)
       * — it MUST NOT cross the framework `InvocationOrigin` (FR-032) and MUST NOT
       * reach any capability handle (NFR-011).
       *
       * PRESENT for an inbound live request (the middleware always sets it from
       * the just-verified token). ABSENT only for a DURABLE-run reconstruction
       * (`hitl/identity.ts toExecIdentity`): a raw bearer JWT is deliberately NOT
       * persisted across the queue (NFR-014) and would be expired by the time a
       * human approves, so a reconstructed user run carries no proof and the
       * broker's user exchange FAILS CLOSED (FR-030) — never a proof-less token.
       */
      readonly subjectToken?: SubjectToken;
    };

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
 * - `teams` — the user's team memberships, a realm-mapped multi-valued claim
 *   (FR-020). The host authorizes a user run by checking the run's DAG-owning
 *   team against this list (FR-021). The decision is STATELESS — derived purely
 *   from the verified token, never a per-request datastore lookup (FR-022). A
 *   user with no teams (empty list) can access no team's DAGs — fail-closed.
 */
export interface RealmJwtClaims {
  readonly iss: string;
  readonly aud: JwtAudience;
  readonly exp: number;
  readonly sub: string;
  readonly azp: string;
  readonly teams: readonly Team[];
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
export type AuthenticatedUser = {
  readonly sub: string;
  readonly azp: string;
  /**
   * The verified user's team memberships (FR-020/FR-021). The user-run
   * authorization policy (`RealmJwtDeps.authorizeUserRun`) tests the run's
   * DAG-owning team against this list — STATELESS, no datastore lookup
   * (FR-022). An empty list means the user is in no team and so can run no
   * team's DAGs (fail-closed).
   */
  readonly teams: readonly Team[];
} & {
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
export const markAuthenticatedUser = (user: {
  readonly sub: string;
  readonly azp: string;
  readonly teams: readonly Team[];
}): AuthenticatedUser => user as AuthenticatedUser;

// ── Authorization (pure) ───────────────────────────────────────────────────

/**
 * Can the given identity access a DAG owned by `dagTeam`?
 *
 * Rules:
 * - Admin can access anything.
 * - Team identity can only access DAGs owned by that team.
 * - User identity (fugue-platform JWT) delegates to the `canRunDag` policy the
 *   identity carries — captured at the auth middleware from the REQUIRED
 *   `RealmJwtDeps.authorizeUserRun` member. A user identity cannot exist
 *   without a wired `realmJwt` group, and the group cannot be constructed
 *   without deciding the policy, so "verifier wired but user-run authorization
 *   undecided" is unrepresentable — wiring the future JWKS verifier FORCES the
 *   authorization decision at the same construction site, in types rather than
 *   mirrored SECURITY comments. The user's downstream authorization is
 *   additionally enforced per-hop by the capability broker
 *   (`adapters/keycloak-broker.ts`); this predicate gates DAG execution and
 *   static capabilities, which the broker's scope gate does not cover.
 */
export const canAccessDag = (identity: AuthIdentity, dagTeam: Team): boolean =>
  match(identity)
    .with({ kind: "admin" }, () => true)
    .with({ kind: "team" }, (t) => t.team === dagTeam)
    .with({ kind: "user" }, (u) => u.canRunDag(dagTeam))
    .exhaustive();

// ── Tenant-aware authorization (multi-tenant supervisor, AD-10) ──────────────

/**
 * Tenant-scoped DAG authorization — the EXTENSION of `canAccessDag` for the
 * multi-tenant supervisor (FR-003, US3). It does NOT replace `canAccessDag`:
 * the existing identity→team decision still runs and still gates single-tenant
 * deployments unchanged (FR-035). This adds a SECOND, conjunctive gate so that
 * once an identity has been resolved to a `Tenant` principal at the boundary,
 * every authz decision is made AGAINST THAT TENANT'S principal and can never
 * reach another tenant's DAG (US3, FR-041).
 *
 * Both conditions must hold (logical AND — fail-closed):
 *   1. The existing identity→team authorization (`canAccessDag`) permits the
 *      DAG's owning team. This preserves the established admin / team / user
 *      semantics verbatim.
 *   2. The DAG's owning team is THIS resolved tenant's own team. The supervisor
 *      resolved the caller to exactly one `Tenant`; a DAG owned by a different
 *      team belongs to a different tenant, so even an over-broad identity
 *      decision (e.g. a multi-team user) cannot cross the tenant boundary. The
 *      branded `Tenant` makes this check unforgeable: the second operand is the
 *      principal resolved at the boundary, never an attacker-supplied string.
 *
 * Pure — like `canAccessDag`, a boolean decision over already-resolved inputs.
 *
 * @param tenant   The `Tenant` principal resolved at the supervisor boundary.
 * @param identity The inbound identity (admin / team / user).
 * @param dagTeam  The owning team of the DAG under authorization.
 *
 * NOTE: `Tenant` is imported as a TYPE only — `auth.ts` stays free of the
 * tenant module's runtime (`tenant.ts` depends on `auth.ts` for `AuthIdentity`,
 * so a value import would cycle). The brand still applies at the type level, so
 * the second operand cannot be a bare string.
 */
export const canAccessDagForTenant = (
  tenant: Tenant,
  identity: AuthIdentity,
  dagTeam: Team,
): boolean => canAccessDag(identity, dagTeam) && tenant.team === dagTeam;

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
