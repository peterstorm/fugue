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
 *     second pattern. This is sound only because (a) `TenantId` (see
 *     `domain/tenant.ts`, `TENANT_ID_REGEX`) forbids `:` and every glob
 *     metacharacter, so the interpolated `<tenant>` can never widen the pattern
 *     over another tenant's keyspace, AND (b) `tenantId()` additionally rejects
 *     the reserved control-plane segments (`tenants`/`supervisor`, see
 *     `isReservedTenantId`) whose `~fugue:<id>:*` pattern would otherwise overlap
 *     the supervisor's own keyspace (the tenant roster / worker registry). Both
 *     invariants are re-asserted in `buildAclSpec` here as defense-in-depth.
 *   - The key pattern matches the key scheme in `domain/cache-keys.ts`
 *     (`fugue:<tenant>:…` via `tenantPrefix`) and `adapters/token-store.ts`
 *     (`fugue:<tenant>:tokens|teams:…`), so the ACL covers EVERY key a worker
 *     actually emits — cache, checkpoint, token, team, HITL — and nothing else.
 *   - COMMAND SCOPE, fail-closed: the user is reset (`reset`), granted the broad
 *     command set (`+@all`), then has the dangerous categories
 *     (`@admin`/`@dangerous`/`@scripting`) and explicit dangerous commands
 *     SUBTRACTED. There is NO curated data-plane allowlist — least-privilege is
 *     carried by the single KEY SCOPE (`~fugue:<tenant>:*`), not by the command
 *     grant. The subtractive `+@all`-minus-dangerous shape is fail-closed for
 *     ENUMERATION/admin (a worker cannot reconfigure the server, ENUMERATE the
 *     keyspace — `SCAN`/`RANDOMKEY`/`DBSIZE`/`KEYS` are denied, see banner —
 *     flush data, run Lua, inspect internals, or touch ACLs) while still letting
 *     a worker read/write any data command WITHIN its own keyspace.
 */

import { internalInvariantViolated } from "../../domain/host-error.js";
import type { HostError } from "../../domain/host-error.js";
import { TENANT_ID_REGEX, isReservedTenantId, type TenantId } from "../../domain/tenant.js";
import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";

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
   * ready to forward verbatim to the admin connection. Emitted in this exact
   * order (see `buildAclSpec`): `reset` (clear all perms) → `on` (enable user) →
   * `resetchannels` (no pub/sub — workers do not use cross-tenant pub/sub) → the
   * single key scope (`~fugue:<tenant>:*`) → command grants/denials.
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

/**
 * The per-tenant Redis ACL credential the supervisor mints (provisioner) and
 * injects into the owning worker's spawn env (ADR-0067). Present ⇒ the worker
 * authenticates as its OWN `~fugue:<tenant>:*`-scoped user, so a cross-tenant key
 * access is refused with NOPERM. Both fields are always set together — see
 * `parseAclCredential`.
 *
 * Lives HERE (next to the env-var contract and `buildAclSpec`) rather than in the
 * worker binary so the full per-tenant ACL credential story — what the supervisor
 * provisions, the env-var names it hands over, and how the worker parses them —
 * is one cohesive module, and the worker binary stays a thin composition root.
 */
export interface AclCredential {
  readonly username: string;
  readonly password: string;
}

/**
 * PURE: validate the ACL credential PAIRING the worker reads from its spawn env.
 *
 * The supervisor injects the username and password TOGETHER or not at all
 * (`worker-lifecycle-manager` — it always sets both env vars in the spawn env),
 * so exactly three states are legal-to-observe and the rest are faults:
 *   - BOTH non-blank → `Ok(credential)`: connect as the scoped per-tenant user.
 *   - NEITHER set    → `Ok(undefined)`: ACL disabled — fall back to the shared
 *                      `REDIS_URL` credential (single-tenant / no-ACL deployment).
 *   - ANYTHING ELSE  → `Err`: a partial/broken injection — exactly one set, OR one
 *                      (or both) set to a BLANK value. We FAIL CLOSED — booting
 *                      anyway would fall back to the shared `REDIS_URL` credential
 *                      and silently connect the worker UNSCOPED, a fail-OPEN on the
 *                      tenant-isolation boundary. Refusing to boot is the safe path.
 *
 * A present-but-BLANK value (`FUGUE_REDIS_ACL_USERNAME=""`) is treated as a fault,
 * NOT as "disabled": an empty username is never a valid scoped ACL user, and
 * forwarding it to ioredis can authenticate the worker as `default` (potentially
 * UNSCOPED) — the same fail-open this constructor exists to close. Blank therefore
 * fails closed rather than silently degrading to the shared credential.
 *
 * Encoding the all-or-nothing invariant as a smart constructor (rather than an
 * inline XOR check + non-null assertions) means any caller reading the two env
 * vars must go through this Result, so the half-injected path cannot be
 * re-introduced by a future independent reader.
 */
export const parseAclCredential = (
  username: string | undefined,
  password: string | undefined,
): Result<AclCredential | undefined, HostError> => {
  // Neither env var present → ACL disabled (the only legal "absent" state).
  if (username === undefined && password === undefined) {
    return ok(undefined);
  }
  // At least one present: require BOTH present AND BOTH non-blank, else fail closed.
  if (
    username !== undefined &&
    password !== undefined &&
    username.trim() !== "" &&
    password.trim() !== ""
  ) {
    // Trim the USERNAME before forwarding: a Redis ACL username is an identifier,
    // never whitespace-significant, and the blank check above already tests the
    // trimmed form. Forwarding a padded value verbatim (e.g. `"…acme\n"`) to
    // ioredis could mismatch the provisioner's whitespace-free `aclUsername(tenant)`
    // and authenticate as `default` (potentially UNSCOPED) — the exact fail-open
    // this constructor exists to close. The PASSWORD is forwarded byte-exact: it is
    // a secret where surrounding whitespace could be significant, so we never mutate it.
    return ok({ username: username.trim(), password });
  }
  return err({
    kind: "config-invalid",
    message:
      `worker bootstrap: ${WORKER_REDIS_ACL_USERNAME_ENV}/${WORKER_REDIS_ACL_PASSWORD_ENV} must be set together and both non-blank, ` +
      `or both absent — a partial/blank per-tenant ACL credential injection was observed. Refusing to boot unscoped ` +
      `(fail-closed): falling back to the shared REDIS_URL credential would silently connect the worker across the ` +
      `tenant-isolation boundary.`,
  });
};

// ── Command scoping (+@all minus dangerous; least-privilege via key scope) ───

/**
 * Dangerous command categories REMOVED after the broad `+@all` grant. Subtracting
 * categories (not just commands) is fail-closed: a future Redis command added to
 * `@admin`/`@dangerous` is denied by default, not silently granted.
 *
 * The example commands below are ILLUSTRATIVE, not the contract: exact category
 * membership is server/version-defined, and the enforceable allowlist is the
 * explicit `DENIED_COMMANDS` set, not these parentheticals.
 *
 *   - `@admin`     — CONFIG, SHUTDOWN, SLAVEOF/REPLICAOF, FAILOVER, ACL, CLIENT KILL…
 *   - `@dangerous` — FLUSHALL, FLUSHDB, KEYS, DEBUG, SWAPDB, MIGRATE…
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
 * intersection we want (everything EXCEPT the denied set). This list assumes the
 * `reset` token that `buildAclSpec` prepends — that clean slate (cleared keys/
 * channels/commands/passwords) is what makes the assembled rule list independent
 * of any prior state on the user; `commandRules` itself emits no `reset`.
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
 *   - granted the full command set (`+@all`) minus dangerous categories/commands
 *     (least-privilege is carried by the key scope, not a command allowlist),
 *   - given NO pub/sub channels (`resetchannels`, already implied by `reset`,
 *     restated for clarity/audit).
 *
 * @throws internal-invariant-violated if `tenant` somehow violates
 *   `TENANT_ID_REGEX` OR is a reserved control-plane namespace (a producer
 *   bypassed the `tenantId` smart constructor with a cast). Defense-in-depth: a
 *   malformed id (could carry `:`/glob) or a reserved id (`tenants`/`supervisor`,
 *   whose `~fugue:<id>:*` pattern overlaps the supervisor's own keyspace) must
 *   NEVER reach an ACL pattern where it could widen the keyspace. Mirrors
 *   `markTenant`'s re-assertion.
 */
export const buildAclSpec = (tenant: TenantId): RedisAclSpec => {
  if (!TENANT_ID_REGEX.test(tenant) || isReservedTenantId(tenant)) {
    throw internalInvariantViolated(
      "buildAclSpec called with an invalid TenantId (regex-violating or a reserved control-plane namespace) — a producer bypassed the tenantId() smart constructor with a cast; refusing to build an ACL pattern that could widen the tenant keyspace",
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
    // `+@all` grant minus dangerous categories/commands (see commandRules).
    ...commandRules(),
  ];

  return {
    username: aclUsername(tenant),
    tenant,
    keyPattern,
    rules,
  };
};
