/**
 * Tenant keyspace purge (multi-tenant spec FR-030, SC-010) — the scan + delete leaf that reclaims
 * every `fugue:<tenant>:*` key for a deregistered tenant during the grace-window
 * sweep. Factored out of the supervisor composition root (`main-supervisor.ts`)
 * so its best-effort enumeration invariant is unit-testable WITHOUT a real Redis.
 *
 * Runs over the SUPERVISOR/admin connection: `scan` is denied on the per-tenant
 * worker ACL (see `secrets/redis-acl.ts`) and the scoped tenant user is being
 * revoked alongside this purge anyway.
 */

import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import type { RedisPort } from "../../ports.js";
import type { TenantId } from "../../domain/tenant.js";

/** The minimal admin-Redis surface the purge needs: enumerate + delete. */
export type KeyspacePurgeRedis = Pick<RedisPort, "scan" | "del">;

/**
 * Scan + delete every `fugue:<tenant>:*` key. Idempotent: purging an already-empty
 * keyspace is a no-op success returning 0.
 *
 * BEST-EFFORT per key: a single failing `del` must NOT abort the whole
 * enumeration — that would leave the rest of the tenant's keys unreclaimed and let
 * one persistently-bad key wedge reclamation of all the others. The FIRST `del`
 * failure is kept and returned AFTER attempting every key, so the grace-purge
 * sweep still marks the step failed (idempotent retry) while every reclaimable key
 * is actually reclaimed this pass. A `scan` failure, by contrast, aborts
 * immediately — without a cursor there is no safe way to continue enumeration.
 *
 * Returns the count of keys deleted on full success, or the first `del`/`scan`
 * error encountered (the count is discarded on error — the sweep retries).
 */
export const purgeTenantKeyspace = async (
  redis: KeyspacePurgeRedis,
  tenant: TenantId,
): Promise<Result<number, HostError>> => {
  const pattern = `fugue:${tenant}:*`;
  let cursor = "0";
  let deleted = 0;
  let firstError: HostError | undefined;
  do {
    const scanR = await redis.scan(pattern, cursor);
    if (!scanR.ok) return err(scanR.error);
    for (const key of scanR.value.keys) {
      const delR = await redis.del(key);
      if (!delR.ok) {
        if (firstError === undefined) firstError = delR.error;
        continue;
      }
      deleted += delR.value;
    }
    cursor = scanR.value.cursor;
  } while (cursor !== "0");
  return firstError !== undefined ? err(firstError) : ok(deleted);
};
