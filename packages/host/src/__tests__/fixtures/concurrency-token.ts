import type { DagId } from "@fuguejs/framework";
import type { AcquireToken } from "../../domain/concurrency.js";

/**
 * Forge an AcquireToken for tests that exercise release()/drift behavior with
 * manufactured tokens. Production code obtains tokens ONLY via `acquire()`.
 *
 * This deliberately lives in the test tree (not the production module) so the
 * production surface offers no way to mint a branded token, closing the forgery
 * gap flagged in type-design review.
 */
export const unsafeTestToken = (dagId: DagId, acquiredAt: number): AcquireToken =>
  ({ dagId, acquiredAt } as unknown as AcquireToken);
