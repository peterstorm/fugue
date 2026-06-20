/**
 * Redis ACL provisioner — the imperative shell that APPLIES / REVOKES the pure
 * `RedisAclSpec` over an ADMIN Redis connection (AD-4, AD-6).
 *
 * SEPARATION OF AUTHORITY (the whole point):
 *   - The SUPERVISOR holds an admin Redis connection and uses it to PROVISION a
 *     per-tenant ACL user. It does NOT keep that admin connection's reach inside
 *     any worker — the worker only ever gets its OWN scoped credential.
 *   - The generated CREDENTIAL (username + minted password) is a SECRET. `apply`
 *     RETURNS it to the caller (the worker-lifecycle manager), who injects it into
 *     the owning worker's SPAWN ENV (AD-6, T4) so it flows ONLY into that worker.
 *     (This is the spawn-env channel, distinct from the `SecretsSource` env-file
 *     port that dereferences a tenant's secrets ref — an env-file path today,
 *     Vault later — inside the worker.) The provisioner
 *     NEVER persists it, NEVER stores it on any returned handle, and NEVER logs
 *     it. The password exists in process memory only for the duration of the
 *     `apply` call and the caller's immediate handoff. (See `AppliedAclCredential`
 *     and `CREDENTIAL HANDOFF CONTRACT` below.)
 *
 * FAIL-CLOSED (FR-009, FR-010, SC-001): every admin command returns
 * `Result<_, HostError>`. On any `!ok` admin response the provisioner returns
 * `err(redis-unavailable)` — it never proceeds, never returns a credential for a
 * user that may not have been created, and never half-provisions silently.
 *
 * The ACL SCOPE itself (key pattern, command denials) is decided purely in
 * `redis-acl.ts`; this module only carries those tokens to the server and adds
 * the one minted password. It mirrors `adapters/token-store.ts`'s RedisPort
 * structure and `.ok`-checked, fail-closed Result handling.
 */

import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { redisUnavailable } from "../../domain/host-error.js";
import type { HostError } from "../../domain/host-error.js";
import type { TenantId } from "../../domain/tenant.js";
import { aclUsername, buildAclSpec } from "./redis-acl.js";
import type { AclRuleToken } from "./redis-acl.js";

// ── Admin connection port ────────────────────────────────────────────────────

/**
 * The NARROW admin capability the provisioner needs — nothing more. Modelled as
 * a dedicated port (not the data-plane `RedisPort`) because provisioning ACL
 * users is a privileged operation that must run over the supervisor's admin
 * connection, kept structurally distinct from the scoped per-tenant data
 * connections. Both methods return `Result` so failures are explicit and
 * fail-closed at the call site (mirrors `RedisPort`).
 *
 * Implementations issue:
 *   - `setUser(username, rules)` → `ACL SETUSER <username> <…rules>`
 *   - `delUser(username)`        → `ACL DELUSER <username>`
 *
 * SECURITY: `rules` for `setUser` includes the minted `>password` token, so an
 * implementation MUST NOT log the rules verbatim — see the production adapter's
 * contract. The fake in this file demonstrates the safe pattern.
 */
export type RedisAclAdminPort = {
  /** `ACL SETUSER <username> <…rules>`. Creates or fully redefines the user. */
  readonly setUser: (
    username: string,
    rules: readonly AclRuleToken[],
  ) => Promise<Result<void, HostError>>;
  /** `ACL DELUSER <username>`. Idempotent — deleting an absent user is ok. */
  readonly delUser: (username: string) => Promise<Result<void, HostError>>;
};

// ── Credential handoff types ─────────────────────────────────────────────────

/**
 * The SECRET credential `apply` returns for handoff to the worker spawn-env channel.
 *
 * CREDENTIAL HANDOFF CONTRACT (AD-6, FR-005/FR-006, SC-002):
 *   - This value is the ONLY place the minted password ever materializes.
 *   - The caller MUST hand it to the owning worker's spawn-env channel (SEPARATE
 *     from the `SecretsSource` env-file port) and then drop the reference. The
 *     supervisor MUST NOT persist it, attach it
 *     to long-lived state, or log it.
 *   - The provisioner itself retains NOTHING: `apply` constructs this object,
 *     issues the ACL command, and returns it. No module-level cache, no logger
 *     call carries `password`.
 */
export type AppliedAclCredential = {
  /** The ACL username the worker authenticates as (deterministic per tenant). */
  readonly username: string;
  /** The freshly minted password — a SECRET. Never logged, never retained. */
  readonly password: string;
  /** The tenant this credential is scoped to (non-secret; for routing/handoff). */
  readonly tenant: TenantId;
};

/**
 * Injected dependencies for `apply`. Randomness is INJECTED (not pulled from
 * `crypto` inside the adapter) following the established host pattern
 * (`generateRandomBytes` in `host.ts` / admin team handlers) so provisioning is
 * deterministic under test and the entropy source is a single auditable seam.
 */
export type AclProvisionerDeps = {
  /**
   * Source of cryptographic randomness for the minted password. MUST return at
   * least 32 bytes of CSPRNG output (e.g. `crypto.getRandomValues`). The bytes
   * are base64url-encoded into the password.
   */
  readonly generateRandomBytes: () => Uint8Array;
};

/** Required entropy for a minted ACL password — 32 bytes (256 bits). */
export const ACL_PASSWORD_RANDOM_BYTES = 32;

// ── Password formatting (pure) ───────────────────────────────────────────────

/** base64url (no padding) — same alphabet the team-token formatter uses. */
const base64url = (bytes: Uint8Array): string => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * Format raw random bytes into an ACL password. Pure; enforces full entropy so a
 * wiring bug (short randomness) fails loudly rather than minting a weak secret —
 * mirrors `formatToken`'s entropy guard in `domain/auth.ts`.
 */
const formatAclPassword = (randomBytes: Uint8Array): string => {
  if (randomBytes.length < ACL_PASSWORD_RANDOM_BYTES) {
    throw new Error(
      `formatAclPassword: expected at least ${ACL_PASSWORD_RANDOM_BYTES} random bytes, got ${randomBytes.length} — refusing to mint a low-entropy ACL credential`,
    );
  }
  return base64url(randomBytes);
};

// ── Provisioner ──────────────────────────────────────────────────────────────

/**
 * PROVISION (create or update) the per-tenant ACL user over the admin
 * connection, minting a fresh password, and RETURN the credential for handoff to
 * the owning worker's spawn-env channel (distinct from the `SecretsSource` port).
 *
 * Steps:
 *   1. Build the PURE spec (`buildAclSpec`) — the scope-only key pattern + the
 *      data-plane command denials. This re-asserts `TENANT_ID_REGEX` (throws on a
 *      forged TenantId) so a malformed id can never reach an ACL pattern.
 *   2. Mint a password from injected randomness.
 *   3. Issue `ACL SETUSER <username> <…spec.rules> ><password>`. The `>password`
 *      token is appended LAST and added to the user (`reset` at the head of the
 *      rules first cleared any prior passwords, so the user ends with EXACTLY
 *      this one password).
 *   4. On admin `!ok`: return `err` (fail-closed) — NO credential is returned for
 *      a user that may not exist.
 *   5. On success: return the credential. The provisioner keeps no copy.
 *
 * The password is NEVER logged. The `rules` array passed to the admin port is the
 * spec rules plus the `>password` token; the admin adapter MUST treat it as
 * sensitive (the fake here shows the safe pattern).
 */
export const apply = async (
  admin: RedisAclAdminPort,
  tenant: TenantId,
  deps: AclProvisionerDeps,
): Promise<Result<AppliedAclCredential, HostError>> => {
  // (1) Pure spec — scope-only key pattern + data-plane command scoping.
  const spec = buildAclSpec(tenant);

  // (2) Mint the secret. Entropy is injected; formatting enforces full entropy.
  const password = formatAclPassword(deps.generateRandomBytes());

  // (3) `reset` (head of spec.rules) clears any prior passwords, so appending a
  // single `>password` leaves the user with EXACTLY this credential.
  const rulesWithPassword: readonly AclRuleToken[] = [...spec.rules, `>${password}`];

  // (4) Issue over the admin connection — fail-closed on any non-ok response.
  const setResult = await admin.setUser(spec.username, rulesWithPassword);
  if (!setResult.ok) {
    // Do NOT return the credential: the user may not have been created. The
    // password simply goes out of scope here, unretained and unlogged.
    return err(redisUnavailable("redis-acl-apply"));
  }

  // (5) Hand the credential back for the caller to inject into the owning
  // worker's spawn-env channel (distinct from the `SecretsSource` port). The
  // provisioner retains nothing.
  return ok({ username: spec.username, password, tenant });
};

/**
 * REVOKE the per-tenant ACL user (`ACL DELUSER`). Idempotent at the Redis level
 * (deleting an absent user is fine). Fail-closed: on any admin `!ok` response,
 * returns `err` so the caller knows the credential may still be live and can
 * retry — it never reports a revoke as succeeded when the server rejected it.
 *
 * Takes only the `TenantId`: the username is derived deterministically
 * (`aclUsername`), so revoke needs no retained per-tenant state and cannot
 * target the wrong user.
 */
export const revoke = async (
  admin: RedisAclAdminPort,
  tenant: TenantId,
): Promise<Result<void, HostError>> => {
  const username = aclUsername(tenant);
  const delResult = await admin.delUser(username);
  if (!delResult.ok) {
    return err(redisUnavailable("redis-acl-revoke"));
  }
  return ok(undefined);
};

// ── Fake admin connection (tests) ────────────────────────────────────────────

/**
 * In-memory fake `RedisAclAdminPort` for unit tests. Records every issued
 * command so tests can assert the EXACT `ACL SETUSER` / `ACL DELUSER` arguments,
 * and can be configured to fail (simulating an admin connection error) to verify
 * fail-closed handling.
 *
 * SECURITY DEMONSTRATION: it stores the rules verbatim under `setUserCalls` so a
 * test can assert the password was carried to the server — but a PRODUCTION
 * adapter modelled on this MUST NOT log those rules. The fake never logs.
 */
export type FakeAclAdmin = RedisAclAdminPort & {
  /** Every `setUser` invocation, in order. */
  readonly setUserCalls: ReadonlyArray<{ username: string; rules: readonly AclRuleToken[] }>;
  /** Every `delUser` invocation, in order. */
  readonly delUserCalls: ReadonlyArray<{ username: string }>;
};

/**
 * Build a fake admin connection. Pass `{ fail: true }` to make every command
 * return `err(redis-unavailable)`, exercising the provisioner's fail-closed path.
 */
export const createFakeAclAdmin = (opts: { fail?: boolean } = {}): FakeAclAdmin => {
  const setUserCalls: Array<{ username: string; rules: readonly AclRuleToken[] }> = [];
  const delUserCalls: Array<{ username: string }> = [];
  const fail = opts.fail === true;

  return {
    get setUserCalls() {
      return setUserCalls as ReadonlyArray<{ username: string; rules: readonly AclRuleToken[] }>;
    },
    get delUserCalls() {
      return delUserCalls as ReadonlyArray<{ username: string }>;
    },
    setUser: async (username, rules) => {
      setUserCalls.push({ username, rules });
      return fail ? err(redisUnavailable("fake-acl-setuser")) : ok(undefined);
    },
    delUser: async (username) => {
      delUserCalls.push({ username });
      return fail ? err(redisUnavailable("fake-acl-deluser")) : ok(undefined);
    },
  };
};
