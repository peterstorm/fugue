/**
 * TenantId value object — the cycle-free grammar shared by tenant registration
 * and HostError parsing. Runtime consumers depend only on this pure module.
 */

import type { Result } from "@fuguejs/framework";
import { err, ok } from "@fuguejs/framework";

declare const __tenantIdBrand: unique symbol;

/**
 * A tenant identifier proven safe for Redis key and ACL interpolation.
 * Construction is restricted to `tenantId`.
 */
export type TenantId = string & { readonly [__tenantIdBrand]: void };

/**
 * Shape of a tenant id. No Redis delimiter or glob metacharacter can match.
 */
export const TENANT_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

/** Fixed control-plane namespaces that no tenant may claim. */
export const RESERVED_TENANT_IDS: ReadonlySet<string> = new Set([
  "tenants",
  "supervisor",
]);

/** True when the id collides case-insensitively with the control plane. */
export const isReservedTenantId = (value: string): boolean =>
  RESERVED_TENANT_IDS.has(value.toLowerCase());

export type TenantIdParseError = {
  readonly kind: "config-invalid";
  readonly message: string;
};

/** Parse an untrusted string into the canonical TenantId value object. */
export const tenantId = (
  value: string,
): Result<TenantId, TenantIdParseError> => {
  if (!TENANT_ID_REGEX.test(value)) {
    return err({
      kind: "config-invalid",
      message: `invalid tenant id "${value}": must match ${TENANT_ID_REGEX.source} (no ':' or glob metacharacters — required for Redis key/ACL scoping)`,
    });
  }
  if (isReservedTenantId(value)) {
    return err({
      kind: "config-invalid",
      message: `invalid tenant id "${value}": reserved control-plane namespace — its ~fugue:${value}:* ACL pattern would overlap the supervisor's own fugue:${value}:* keyspace`,
    });
  }
  return ok(value as TenantId);
};
