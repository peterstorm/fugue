/**
 * Token Store adapters — in-memory (tests) and Redis (production).
 *
 * Implements TokenStorePort for team token persistence.
 *
 * SECURITY INVARIANT (load-bearing for AD-4 / US2 / SC-001):
 *   EVERY key is tenant-prefixed `fugue:<tenant>:…`. A per-tenant Redis ACL user
 *   is scoped to `~fugue:<tenant>:*`; that scoping is only SOUND if no key here
 *   escapes the tenant prefix. The Redis store is constructed bound to ONE
 *   `TenantId`, so a single store instance can only ever read/write its own
 *   tenant's token & team keys — a compromised worker holding tenant A's store
 *   physically cannot name tenant B's keys.
 *
 * Redis key layout (per tenant):
 *   fugue:<tenant>:tokens:<hash>   →  JSON TokenGrant  (lookup by hash — hot path)
 *   fugue:<tenant>:teams:<team>    →  JSON { hash, grant }  (reverse index)
 *   fugue:<tenant>:teams-index     →  SET of team names   (enumeration index)
 *
 * WHY A TEAM-INDEX SET (and NOT `SCAN fugue:<tenant>:teams:*`):
 *   The per-tenant Redis ACL DENIES `scan`/`randomkey`/`dbsize`/`keys`. Key-pattern
 *   ACLs do NOT reliably scope keyspace-enumeration commands across Redis/Valkey
 *   versions, so a scoped `SCAN` could leak other tenants' key names (see
 *   `supervisor/secrets/redis-acl.ts`). `listTeams` instead reads ONE key — the
 *   per-tenant index SET `fugue:<tenant>:teams-index` via `SMEMBERS` — which the
 *   key ACL DOES constrain (it is under `~fugue:<tenant>:*`). The index is kept in
 *   sync: `SADD` on store, `SREM` on revoke.
 */

import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { redisUnavailable, teamAlreadyExists } from "../domain/host-error.js";
import { markTeam } from "../domain/auth.js";
import type { TokenGrant, TokenHash } from "../domain/auth.js";
import type { TenantId } from "../domain/cache-keys.js";
import type { TokenStorePort, RedisPort, LogPort } from "../ports.js";

// ── Redis Key Prefixes (tenant-scoped) ──────────────────────────────────────
//
// The prefixes are derived from the bound `TenantId`, so every key a store
// instance emits is forced under `fugue:<tenant>:`. There is no code path that
// builds a token/team key without a tenant.

const tokenKeyPrefix = (tenant: TenantId): string => `fugue:${tenant}:tokens:`;
const teamKeyPrefix = (tenant: TenantId): string => `fugue:${tenant}:teams:`;

const tokenKey = (tenant: TenantId, hash: TokenHash): string => `${tokenKeyPrefix(tenant)}${hash}`;
const teamKey = (tenant: TenantId, team: string): string => `${teamKeyPrefix(tenant)}${team}`;

/**
 * The per-tenant team-index SET key. A single key (under `~fugue:<tenant>:*`, so
 * the ACL scopes it) holding every provisioned team name — read with `SMEMBERS`
 * so `listTeams` never needs a denied keyspace-enumeration command.
 */
const teamsIndexKey = (tenant: TenantId): string => `fugue:${tenant}:teams-index`;

interface StoredTeamRecord {
  readonly hash: string;
  readonly grant: TokenGrant;
}

const parseStoredTeamRecord = (json: string): Result<StoredTeamRecord, string> => {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return err("malformed JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err("record must be an object");
  }
  const record = value as Record<string, unknown>;
  const grant = record.grant;
  if (
    typeof record.hash !== "string" || record.hash.length === 0 ||
    typeof grant !== "object" || grant === null || Array.isArray(grant)
  ) {
    return err("record must contain hash and grant");
  }
  const grantRecord = grant as Record<string, unknown>;
  if (
    typeof grantRecord.team !== "string" ||
    typeof grantRecord.label !== "string" ||
    typeof grantRecord.createdAt !== "number" ||
    !Number.isFinite(grantRecord.createdAt)
  ) {
    return err("grant fields are invalid");
  }
  return ok({
    hash: record.hash,
    grant: {
      team: markTeam(grantRecord.team),
      label: grantRecord.label,
      createdAt: grantRecord.createdAt,
    },
  });
};

// ── In-Memory Adapter (tests) ──────────────────────────────────────────────

/**
 * In-memory token store for unit and integration tests.
 * No Redis required. Exposes internal state for test assertions.
 */
export const createInMemoryTokenStore = (
  seed: ReadonlyArray<{ team: string; hash: TokenHash; grant: TokenGrant }> = [],
): TokenStorePort & { readonly _grants: ReadonlyMap<string, { hash: TokenHash; grant: TokenGrant }> } => {
  const byHash = new Map<string, TokenGrant>();
  const byTeam = new Map<string, { hash: TokenHash; grant: TokenGrant }>();

  for (const entry of seed) {
    byHash.set(entry.hash, entry.grant);
    byTeam.set(entry.team, { hash: entry.hash, grant: entry.grant });
  }

  return {
    get _grants() {
      return byTeam as ReadonlyMap<string, { hash: TokenHash; grant: TokenGrant }>;
    },

    resolve: async (hash) => ok(byHash.get(hash) ?? null),

    store: async (team, hash, grant) => {
      if (byTeam.has(team)) {
        return err(teamAlreadyExists(team));
      }
      byHash.set(hash, grant);
      byTeam.set(team, { hash, grant });
      return ok(undefined);
    },

    listTeams: async () => ok(Array.from(byTeam.values()).map((v) => v.grant)),

    revoke: async (team) => {
      const entry = byTeam.get(team);
      if (entry) {
        byHash.delete(entry.hash);
        byTeam.delete(team);
      }
      return ok(undefined);
    },
  };
};

// ── Redis Adapter (production) ─────────────────────────────────────────────

/**
 * Redis-backed token store for production.
 * Uses RedisPort for get/set/del/setNx + sAdd/sRem/sMembers operations.
 *
 * listTeams reads the per-tenant team-index SET (`SMEMBERS`) — NOT `SCAN`, which
 * the per-tenant ACL denies (keyspace enumeration is not reliably ACL-scoped).
 * store uses SETNX for atomic team claim — race-free under concurrency — then
 * adds the team to the index SET; revoke removes it.
 */
export const createRedisTokenStore = (
  redis: RedisPort,
  tenant: TenantId,
  logger?: LogPort,
): TokenStorePort => {
  return {
    resolve: async (hash) => {
      const result = await redis.get(tokenKey(tenant, hash));
      if (!result.ok) {
        return err(redisUnavailable("token-resolve"));
      }
      if (result.value === null || result.value === "") return ok(null);
      try {
        return ok(JSON.parse(result.value) as TokenGrant);
      } catch (e) {
        logger?.error("[token-store] Corrupt grant data in Redis", {
          hashPrefix: String(hash).slice(0, 8),
          error: e instanceof Error ? e.message : String(e),
        });
        return err(redisUnavailable(`token-resolve: corrupt grant data for hash ${String(hash).slice(0, 8)}…`));
      }
    },

    store: async (team, hash, grant) => {
      // Atomic check-and-set: claim the team slot via SETNX to prevent races.
      // Two concurrent store() calls for the same team: exactly one wins.
      const teamJson = JSON.stringify({ hash, grant });
      const claimResult = await redis.setNx(teamKey(tenant, team), teamJson);
      if (!claimResult.ok) {
        return err(redisUnavailable("token-store-claim"));
      }
      if (!claimResult.value) {
        // Another request already claimed this team
        return err(teamAlreadyExists(team));
      }

      // Team slot claimed — now store token → grant mapping
      const grantJson = JSON.stringify(grant);
      const tokenSetResult = await redis.set(tokenKey(tenant, hash), grantJson);
      if (!tokenSetResult.ok) {
        // Rollback: delete the team index we just claimed
        const rollbackResult = await redis.del(teamKey(tenant, team));
        if (!rollbackResult.ok) {
          logger?.error("[token-store] CRITICAL: Failed to rollback team claim — team slot is occupied but token is not stored", {
            team,
            hashPrefix: String(hash).slice(0, 8),
          });
        }
        return err(redisUnavailable("token-store-set"));
      }

      // Add the team to the enumeration index SET so listTeams() (SMEMBERS) sees
      // it without a denied SCAN. Done AFTER the durable writes so the index never
      // names a team whose keys do not exist. A failure here rolls back both keys
      // to keep the index, team key, and token key consistent (fail-closed).
      const indexResult = await redis.sAdd(teamsIndexKey(tenant), team);
      if (!indexResult.ok) {
        const tokenRollback = await redis.del(tokenKey(tenant, hash));
        const teamRollback = await redis.del(teamKey(tenant, team));
        if (!tokenRollback.ok || !teamRollback.ok) {
          logger?.error("[token-store] CRITICAL: Failed to rollback after team-index SADD failure — token/team keys may be orphaned", {
            team,
            hashPrefix: String(hash).slice(0, 8),
          });
        }
        return err(redisUnavailable("token-store-index"));
      }

      return ok(undefined);
    },

    listTeams: async () => {
      // Read the per-tenant team-index SET (ONE key the ACL scopes) — NOT SCAN,
      // which the per-tenant ACL denies. SMEMBERS gives every provisioned team
      // name; we then read each team key to recover its grant.
      const indexResult = await redis.sMembers(teamsIndexKey(tenant));
      if (!indexResult.ok) {
        return err(redisUnavailable("token-list-teams"));
      }

      const grants: TokenGrant[] = [];
      for (const team of indexResult.value) {
        const valueResult = await redis.get(teamKey(tenant, team));
        if (!valueResult.ok) {
          // A failed read is not an absent key. Returning the grants collected
          // so far would misrepresent an incomplete admin listing as complete.
          return err(redisUnavailable(`token-list-teams: failed reading team '${team}'`));
        }
        if (valueResult.value === null || valueResult.value === "") {
          // Index names a team whose key is gone — best-effort skip.
          // (Self-heals on next revoke, which SREMs the stale member.)
          continue;
        }
        const parsed = parseStoredTeamRecord(valueResult.value);
        if (!parsed.ok || parsed.value.grant.team !== team) {
          try {
            logger?.warn("[token-store] Corrupt team index entry — refusing partial listing", {
              team,
              reason: parsed.ok ? "grant team does not match indexed team" : parsed.error,
            });
          } catch {
            // The typed corruption failure remains authoritative.
          }
          return err(redisUnavailable(`token-list-teams: corrupt team record for '${team}'`));
        }
        grants.push(parsed.value.grant);
      }

      return ok(grants);
    },

    revoke: async (team) => {
      // Look up the team's hash from the reverse index
      const teamResult = await redis.get(teamKey(tenant, team));
      if (!teamResult.ok) {
        return err(redisUnavailable("token-revoke-lookup"));
      }
      if (teamResult.value === null || teamResult.value === "") {
        // Idempotent — revoking a non-existent team is fine. Still SREM the
        // enumeration index so a stale member (e.g. left by a prior partial
        // failure) self-heals and never reappears in listTeams().
        const indexResult = await redis.sRem(teamsIndexKey(tenant), team);
        if (!indexResult.ok) {
          return err(redisUnavailable("token-revoke-index"));
        }
        return ok(undefined);
      }

      let hash: string;
      try {
        const parsed = JSON.parse(teamResult.value) as { hash: string };
        hash = parsed.hash;
      } catch (e) {
        logger?.error("[token-store] Corrupt team index data in Redis — revocation failed", {
          team,
          error: e instanceof Error ? e.message : String(e),
        });
        return err(redisUnavailable(`token-revoke: corrupt team index for '${team}' — manual cleanup required`));
      }

      // Remove the team from the enumeration index FIRST so listTeams() stops
      // reporting it even if a subsequent key delete fails (fail toward "not
      // listed" rather than leaving a dangling index member).
      const indexResult = await redis.sRem(teamsIndexKey(tenant), team);
      if (!indexResult.ok) {
        return err(redisUnavailable("token-revoke-index"));
      }

      // Delete token hash key
      const tokenDelResult = await redis.del(tokenKey(tenant, hash as TokenHash));
      if (!tokenDelResult.ok) {
        return err(redisUnavailable("token-revoke-hash-delete"));
      }

      // Delete team reverse index key
      const teamDelResult = await redis.del(teamKey(tenant, team));
      if (!teamDelResult.ok) {
        return err(redisUnavailable("token-revoke-team-delete"));
      }

      return ok(undefined);
    },
  };
};
