import type { TenantId } from "../../domain/tenant.js";
import type { AdmitToken } from "../../supervisor/admission.js";
import type { AcquireToken } from "../../domain/concurrency.js";
import { unsafeTestToken } from "./concurrency-token.js";

/**
 * Forge an AdmitToken for tests that exercise releaseTenant() with manufactured
 * tokens. Production code obtains tokens ONLY via `admitTenant`.
 *
 * Lives in the test tree (mirroring `concurrency-token.ts`) so the production
 * surface offers no way to mint a branded AdmitToken, closing the forgery gap.
 */
export const unsafeTestAdmitToken = (
  tenant: TenantId,
  claimedWorker: boolean,
  admittedAt: number,
): AdmitToken => {
  const innerToken: AcquireToken<TenantId> = unsafeTestToken<TenantId>(tenant, admittedAt);
  return { tenant, innerToken, claimedWorker, admittedAt } as unknown as AdmitToken;
};
