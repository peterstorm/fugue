/**
 * Token Store adapters — in-memory (tests) and Redis (production).
 *
 * Implements TokenStorePort for team token persistence.
 *
 * Redis key layout:
 *   fugue:tokens:<hash>   →  JSON TokenGrant  (lookup by hash — hot path)
 *   fugue:teams:<team>    →  JSON { hash, grant }  (reverse index for revocation/listing)
 */

import { ok, err } from "@fugue/framework";
import type { Result } from "@fugue/framework";
import type { HostError } from "../domain/host-error.js";
import type { TokenGrant, TokenHash } from "../domain/auth.js";
import type { TokenStorePort, RedisPort } from "../ports.js";

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

    resolve: async (hash) => byHash.get(hash) ?? null,

    store: async (team, hash, grant) => {
      if (byTeam.has(team)) {
        return err({ kind: "team-already-exists", team } as HostError);
      }
      byHash.set(hash, grant);
      byTeam.set(team, { hash, grant });
      return ok(undefined);
    },

    listTeams: async () => Array.from(byTeam.values()).map((v) => v.grant),

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
 * Uses the existing RedisPort interface for get/set operations.
 *
 * Limitation: listTeams requires SCAN which RedisPort doesn't expose.
 * For the initial implementation, the in-memory adapter tracks a mirror
 * of team grants populated at boot from Redis keys. The Redis adapter's
 * listTeams returns only teams provisioned since last boot.
 * Production deployments with many teams should extend RedisPort with SCAN.
 */
export const createRedisTokenStore = (redis: RedisPort): TokenStorePort => {
  // In-process mirror for listTeams (populated on store, cleared on revoke)
  const knownTeams = new Map<string, TokenGrant>();

  return {
    resolve: async (hash) => {
      const result = await redis.get(tokenKey(hash));
      if (!result.ok) return null;
      if (result.value === null) return null;
      try {
        return JSON.parse(result.value) as TokenGrant;
      } catch {
        return null;
      }
    },

    store: async (team, hash, grant) => {
      // Check if team already exists (via reverse index)
      const existingResult = await redis.get(teamKey(team));
      if (!existingResult.ok) {
        return err({ kind: "redis-unavailable", operation: "token-store-check" } as HostError);
      }
      if (existingResult.value !== null && existingResult.value !== "") {
        return err({ kind: "team-already-exists", team } as HostError);
      }

      // Store token → grant mapping
      const grantJson = JSON.stringify(grant);
      const tokenSetResult = await redis.set(tokenKey(hash), grantJson);
      if (!tokenSetResult.ok) {
        return err({ kind: "redis-unavailable", operation: "token-store-set" } as HostError);
      }

      // Store team → { hash, grant } reverse index
      const teamJson = JSON.stringify({ hash, grant });
      const teamSetResult = await redis.set(teamKey(team), teamJson);
      if (!teamSetResult.ok) {
        return err({ kind: "redis-unavailable", operation: "token-store-team-index" } as HostError);
      }

      knownTeams.set(team, grant);
      return ok(undefined);
    },

    listTeams: async () => Array.from(knownTeams.values()),

    revoke: async (team) => {
      // Look up the team's hash from the reverse index
      const teamResult = await redis.get(teamKey(team));
      if (!teamResult.ok) {
        return err({ kind: "redis-unavailable", operation: "token-revoke-lookup" } as HostError);
      }
      if (teamResult.value === null || teamResult.value === "") {
        // Idempotent — revoking non-existent team is fine
        return ok(undefined);
      }

      let hash: string;
      try {
        const parsed = JSON.parse(teamResult.value) as { hash: string };
        hash = parsed.hash;
      } catch {
        return ok(undefined);
      }

      // Delete both keys (set to empty with 1-second expiry via RedisPort)
      await redis.set(tokenKey(hash as TokenHash), "", { expiresInSec: 1 });
      await redis.set(teamKey(team), "", { expiresInSec: 1 });

      knownTeams.delete(team);
      return ok(undefined);
    },
  };
};
