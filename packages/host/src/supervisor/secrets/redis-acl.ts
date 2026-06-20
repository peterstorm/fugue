/**
 * Redis ACL spec — PURE construction of a per-tenant Redis ACL user (AD-4).
 *
 * THE HEART OF CROSS-TENANT ISOLATION (FR-009, FR-010, SC-001, US2):
 *   ONE Redis server backs every tenant. Each worker receives a Redis ACL
 *   credential scoped to ONLY its own tenant's key prefix `~fugue:<tenant>:*`.
 *   A compromised worker running `GET fugue:<other>:…` is refused with NOPERM —
 *   data-plane value access is enforced by Redis itself, not by application code
 *   a compromised worker could bypass. This module is the PURE description of
 *   that ACL user; the provisioner (`redis-acl-provisioner.ts`) applies it over
 *   an admin connection.
 *
 *   KEYSPACE ENUMERATION IS DENIED OUTRIGHT (defense-in-depth, version-INDEPENDENT):
 *   key-pattern ACLs (`~fugue:<tenant>:*`) reliably gate commands that ACCESS a
 *   key's VALUE, but they do NOT reliably constrain commands that ENUMERATE the
 *   keyspace across Redis/Valkey versions. `SCAN`/`SCAN MATCH`/`RANDOMKEY` can
 *   return — and `DBSIZE` counts — keys OUTSIDE the user's key pattern on many
 *   servers. Since key NAMES themselves encode sensitive data here
 *   (`fugue:<tenant>:teams:<team>` = team names, `fugue:<tenant>:tokens:<hash>` =
 *   token hashes, the `<tenant>` segment = the deliberately-unprobeable tenant
 *   roster), a scoped worker that could enumerate the keyspace would defeat the
 *   isolation premise. We therefore DENY `scan`, `randomkey`, and `dbsize` (and
 *   `keys`) on the per-tenant user — workers enumerate their OWN keys via
 *   tenant-scoped index SETs read with `SMEMBERS` (a single-key read the key ACL
 *   DOES constrain; see `adapters/token-store.ts` `listTeams`). The supervisor's
 *   registry hydrate `SCAN`s on the UNRESTRICTED admin connection, not this user.
 *
 * This file is PURE and TOTAL: `buildAclSpec(TenantId)` is a deterministic
 * function of its argument with no I/O, no clock, no randomness. The SECRET
 * (the user's password) is NOT part of the spec — it is minted at apply time by
 * the provisioner and handed straight to the owning worker's spawn-env channel
 * (distinct from the `SecretsSource` port), never retained. The spec describes
 * WHAT the user may do, never the credential.
 *
 * SCOPE-ONLY GUARANTEE (the load-bearing invariant):
 *   - EXACTLY ONE key pattern: `~fugue:<tenant>:*`. No `~*`, no `allkeys`, no
 *     second pattern. This is sound only because `TenantId` (see
 *     `domain/tenant.ts`, `TENANT_ID_REGEX`) forbids `:` and every glob
 *     metacharacter, so the interpolated `<tenant>` can never widen the pattern
 *     over another tenant's keyspace. We re-assert that invariant here as
 *     defense-in-depth.
 *   - The key pattern matches the key scheme in `domain/cache-keys.ts`
 *     (`fugue:<tenant>:…` via `tenantPrefix`) and `adapters/token-store.ts`
 *     (`fugue:<tenant>:tokens|teams:…`), so the ACL covers EVERY key a worker
 *     actually emits — cache, checkpoint, token, team, HITL — and nothing else.
 *   - DATA-PLANE commands only, LEAST-PRIVILEGE / fail-closed: the user is reset
 *     (`-@all`), granted the data-plane category, then has dangerous categories
 *     and explicit dangerous commands SUBTRACTED. A worker can read/write its
 *     own keyspace but cannot reconfigure the server, ENUMERATE the keyspace
 *     (`SCAN`/`RANDOMKEY`/`DBSIZE`/`KEYS` are denied — see banner), flush data,
 *     run Lua, inspect internals, or touch ACLs.
 */

import { internalInvariantViolated } from "../../domain/host-error.js";
import { TENANT_ID_REGEX, type TenantId } from "../../domain/tenant.js";

// ── ACL spec shape ───────────────────────────────────────────────────────────

/**
 * A single ACL rule token, in Redis `ACL SETUSER` argument form (e.g. `on`,
 * `~fugue:t1:*`, `+@all`, `-@admin`, `-keys`, `resetkeys`). Modelled as a
 * branded-free readonly string list rather than a free-form string so the
 * provisioner forwards exactly these tokens, in order, with no re-parsing.
 */
export type AclRuleToken = string;

/**
 * The PURE description of a per-tenant Redis ACL user. Contains NO credential —
 * the password is minted by the provisioner at apply time and never appears
 * here (so the spec can be logged/inspected freely; it is not a secret).
 */
export type RedisAclSpec = {
  /** Deterministic, tenant-derived ACL username. */
  readonly username: string;
  /** The tenant this user is scoped to (for assertions / structured logging). */
  readonly tenant: TenantId;
  /**
   * The SINGLE key pattern this user may touch: `~fugue:<tenant>:*`. Exactly one
   * entry — never `~*`, never a second pattern.
   */
  readonly keyPattern: string;
  /**
   * The ordered `ACL SETUSER` rule tokens (excluding username and password),
   * ready to forward verbatim to the admin connection. Encodes: enable user,
   * reset all perms, key scope, command grants/denials. Pub/sub channels are
   * reset to none (`resetchannels`) — workers do not use cross-tenant pub/sub.
   */
  readonly rules: readonly AclRuleToken[];
};

// ── Username scheme ──────────────────────────────────────────────────────────

/** Prefix for every per-tenant ACL username. Greppable, collision-free vs ids. */
const ACL_USERNAME_PREFIX = "fugue-tenant-";

/**
 * Deterministic ACL username for a tenant. Safe because `TenantId` matches
 * `TENANT_ID_REGEX` (no whitespace/glob/`:`), so the username is a single
 * shell-safe, ACL-safe token.
 */
export const aclUsername = (tenant: TenantId): string => `${ACL_USERNAME_PREFIX}${tenant}`;

// ── Worker credential-handoff env contract ───────────────────────────────────

/**
 * The env-var NAMES the supervisor uses to hand a minted per-tenant ACL
 * credential into the owning worker's spawn env, and the worker reads to
 * authenticate to Redis as its OWN scoped user (ADR-0067 / AD-6). The SHARED
 * source of truth for both sides — the supervisor (spawn injection,
 * `worker-lifecycle-manager.ts`) and the worker (`worker-main.ts` Redis connect)
 * MUST agree byte-for-byte, so the names live here next to the ACL spec.
 *
 * The credential transits ONLY the spawn env (a bounded, unretained, never-logged
 * handoff): the supervisor passes it to `Bun.spawn` and drops the reference; it
 * is never persisted or logged. When unset (ACL disabled), the worker falls back
 * to the shared `REDIS_URL` credential.
 */
export const WORKER_REDIS_ACL_USERNAME_ENV = "FUGUE_REDIS_ACL_USERNAME" as const;
export const WORKER_REDIS_ACL_PASSWORD_ENV = "FUGUE_REDIS_ACL_PASSWORD" as const;

// ── Command scoping (data-plane only, least-privilege) ───────────────────────

/**
 * Dangerous command categories REMOVED after the broad data grant. Subtracting
 * categories (not just commands) is fail-closed: a future Redis command added to
 * `@admin`/`@dangerous` is denied by default, not silently granted.
 *
 *   - `@admin`     — CONFIG, SHUTDOWN, SLAVEOF/REPLICAOF, FAILOVER, ACL, CLIENT KILL…
 *   - `@dangerous` — FLUSHALL, FLUSHDB, KEYS, DEBUG, SWAPDB, MIGRATE, SORT_RO bypass…
 *   - `@scripting` — EVAL/EVALSHA/FUNCTION/SCRIPT: Lua can be used to escape key
 *                    ACL checks in some configs, so it is denied outright.
 */
const DENIED_CATEGORIES: readonly string[] = ["@admin", "@dangerous", "@scripting"];

/**
 * Explicit single-command denials (defense-in-depth). Even though the categories
 * above already cover these in current Redis, naming them makes the intent
 * auditable and survives category re-classification across Redis versions.
 *
 * KEYSPACE ENUMERATION DENIED (`scan`, `randomkey`, `dbsize`, `keys`):
 *   A per-tenant key-pattern ACL (`~fugue:<tenant>:*`) gates commands that ACCESS
 *   a key's VALUE, but it does NOT reliably scope commands that ENUMERATE the
 *   keyspace across Redis/Valkey versions — `SCAN`/`RANDOMKEY` can return, and
 *   `DBSIZE` counts, keys OUTSIDE the user's pattern. Because key NAMES here
 *   encode sensitive data (team names, token hashes, the tenant roster itself), a
 *   scoped worker that could enumerate the keyspace would leak other tenants'
 *   data. We therefore deny enumeration outright rather than relying on the
 *   (version-dependent, historically FALSE) assumption that the key ACL filters
 *   SCAN's results. Workers enumerate their OWN keys via tenant-scoped index SETs
 *   read with `SMEMBERS` (a single-key read the key ACL DOES constrain; see
 *   `adapters/token-store.ts` `listTeams`).
 */
const DENIED_COMMANDS: readonly string[] = [
  "config",
  "acl",
  "flushall",
  "flushdb",
  "debug",
  "shutdown",
  // Keyspace-enumeration commands — NOT reliably scoped by the key ACL.
  "keys",
  "scan",
  "randomkey",
  "dbsize",
  "script",
  "eval",
  "evalsha",
  "function",
  "module",
  "cluster",
  "slaveof",
  "replicaof",
  "failover",
  "swapdb",
  "migrate",
  "restore",
];

/**
 * The full, ordered list of command-permission tokens. Order matters in Redis
 * ACL evaluation: a broad `+@all` followed by `-@category`/`-command` yields the
 * intersection we want (everything EXCEPT the denied set). Starting from a clean
 * slate (`reset`) makes the result independent of any prior state on the user.
 */
const commandRules = (): readonly AclRuleToken[] => [
  // Grant the broad command set, then carve out the dangerous parts. Per AD-4
  // the worker needs full data-plane access WITHIN its keyspace; least-privilege
  // is enforced by the key scope plus these explicit denials.
  "+@all",
  ...DENIED_CATEGORIES.map((c) => `-${c}`),
  ...DENIED_COMMANDS.map((c) => `-${c}`),
];

// ── Pure builder ─────────────────────────────────────────────────────────────

/**
 * Build the PURE ACL spec for a tenant. Deterministic and total.
 *
 * Produces a user that is:
 *   - enabled (`on`),
 *   - reset to a known-empty baseline (`reset` clears keys, channels, commands,
 *     passwords — the provisioner then adds exactly one password at apply time),
 *   - scoped to the SINGLE key pattern `~fugue:<tenant>:*`,
 *   - granted data-plane commands minus dangerous categories/commands,
 *   - given NO pub/sub channels (`resetchannels`, already implied by `reset`,
 *     restated for clarity/audit).
 *
 * @throws internal-invariant-violated if `tenant` somehow violates
 *   `TENANT_ID_REGEX` (a producer bypassed the `tenantId` smart constructor with
 *   a cast). Defense-in-depth: a malformed id must NEVER reach an ACL pattern
 *   where it could widen the keyspace. This mirrors `markTenant`'s re-assertion.
 */
export const buildAclSpec = (tenant: TenantId): RedisAclSpec => {
  if (!TENANT_ID_REGEX.test(tenant)) {
    throw internalInvariantViolated(
      "buildAclSpec called with a TenantId that violates TENANT_ID_REGEX — a producer bypassed the tenantId() smart constructor with a cast; refusing to build an ACL pattern that could widen the tenant keyspace",
      { tenant },
    );
  }

  // The SINGLE key pattern. Mirrors `tenantPrefix` in domain/cache-keys.ts
  // (`fugue:<tenant>:`) so the ACL covers every key the workers emit.
  const keyPattern = `~fugue:${tenant}:*`;

  const rules: readonly AclRuleToken[] = [
    // Clean slate — clears any prior keys/channels/commands/passwords for this
    // username so re-provisioning is idempotent and never inherits stale grants.
    "reset",
    // Enable the user (a `reset` user is `off`).
    "on",
    // No pub/sub channel access (restated; `reset` already cleared channels).
    "resetchannels",
    // EXACTLY ONE key pattern. No `~*`, no `allkeys`, no second pattern.
    keyPattern,
    // Data-plane command grants minus dangerous categories/commands.
    ...commandRules(),
  ];

  return {
    username: aclUsername(tenant),
    tenant,
    keyPattern,
    rules,
  };
};
