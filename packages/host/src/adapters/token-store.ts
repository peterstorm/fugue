/**
 * Token Store adapters — in-memory (tests) and Redis (production).
 *
 * Implements TokenStorePort for team token persistence.
 *
 * Redis key layout:
 *   fugue:tokens:<hash>   →  JSON TokenGrant  (lookup by hash — hot path)
 *   fugue:teams:<team>    →  JSON { hash, grant }  (reverse index for revocation/listing)
 */

import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { redisUnavailable, teamAlreadyExists } from "../domain/host-error.js";
import type { TokenGrant, TokenHash } from "../domain/auth.js";
import type { TokenStorePort, RedisPort, LogPort } from "../ports.js";

// ── Redis Key Prefixes ─────────────────────────────────────────────────────

const TOKEN_KEY_PREFIX = "fugue:tokens:";
const TEAM_KEY_PREFIX = "fugue:teams:";

const tokenKey = (hash: TokenHash): string => `${TOKEN_KEY_PREFIX}${hash}`;
const teamKey = (team: string): string => `${TEAM_KEY_PREFIX}${team}`;

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
 * Uses RedisPort for get/set/del/scan/setNx operations.
 *
 * listTeams uses cursor-based SCAN — production-safe, non-blocking.
 * store uses SETNX for atomic team claim — race-free under concurrency.
 */
export const createRedisTokenStore = (redis: RedisPort, logger?: LogPort): TokenStorePort => {
  return {
    resolve: async (hash) => {
      const result = await redis.get(tokenKey(hash));
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
      const claimResult = await redis.setNx(teamKey(team), teamJson);
      if (!claimResult.ok) {
        return err(redisUnavailable("token-store-claim"));
      }
      if (!claimResult.value) {
        // Another request already claimed this team
        return err(teamAlreadyExists(team));
      }

      // Team slot claimed — now store token → grant mapping
      const grantJson = JSON.stringify(grant);
      const tokenSetResult = await redis.set(tokenKey(hash), grantJson);
      if (!tokenSetResult.ok) {
        // Rollback: delete the team index we just claimed
        const rollbackResult = await redis.del(teamKey(team));
        if (!rollbackResult.ok) {
          logger?.error("[token-store] CRITICAL: Failed to rollback team claim — team slot is occupied but token is not stored", {
            team,
            hashPrefix: String(hash).slice(0, 8),
          });
        }
        return err(redisUnavailable("token-store-set"));
      }

      return ok(undefined);
    },

    listTeams: async () => {
      // Cursor-based SCAN — production-safe, non-blocking alternative to KEYS.
      const pattern = `${TEAM_KEY_PREFIX}*`;
      const allKeys: string[] = [];
      let cursor = "0";

      do {
        const scanResult = await redis.scan(pattern, cursor);
        if (!scanResult.ok) {
          return err(redisUnavailable("token-list-teams"));
        }
        allKeys.push(...scanResult.value.keys);
        cursor = scanResult.value.cursor;
      } while (cursor !== "0");

      const grants: TokenGrant[] = [];
      for (const key of allKeys) {
        const valueResult = await redis.get(key);
        if (!valueResult.ok || valueResult.value === null || valueResult.value === "") {
          continue; // Skip unreadable entries — best effort
        }
        try {
          const parsed = JSON.parse(valueResult.value) as { hash: string; grant: TokenGrant };
          grants.push(parsed.grant);
        } catch {
          logger?.warn("[token-store] Skipping corrupt team index entry", { key });
        }
      }

      return ok(grants);
    },

    revoke: async (team) => {
      // Look up the team's hash from the reverse index
      const teamResult = await redis.get(teamKey(team));
      if (!teamResult.ok) {
        return err(redisUnavailable("token-revoke-lookup"));
      }
      if (teamResult.value === null || teamResult.value === "") {
        // Idempotent — revoking non-existent team is fine
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

      // Delete token hash key
      const tokenDelResult = await redis.del(tokenKey(hash as TokenHash));
      if (!tokenDelResult.ok) {
        return err(redisUnavailable("token-revoke-hash-delete"));
      }

      // Delete team reverse index key
      const teamDelResult = await redis.del(teamKey(team));
      if (!teamDelResult.ok) {
        return err(redisUnavailable("token-revoke-team-delete"));
      }

      return ok(undefined);
    },
  };
};
