/**
 * Concurrency guard middleware — checks the GLOBAL concurrency limit
 * before allowing a request through to handlers.
 *
 * Per-DAG concurrency is checked in the run-dag handler itself (after
 * the DAG lookup), but the global limit is a gateway check.
 *
 * FR-026: Global concurrency limit (50) exceeded returns 429 with Retry-After header
 */

import type { MiddlewareHandler } from "hono";
import type { HostEnv } from "../router.js";
import { errorResponse } from "../response.js";

/**
 * Creates a middleware that enforces the global concurrency limit.
 * Returns 429 with Retry-After if the global limit is reached.
 */
export const concurrencyGuard = (): MiddlewareHandler<HostEnv> => {
  return async (c, next) => {
    const concurrency = c.get("concurrency");

    if (concurrency.global.current >= concurrency.global.max) {
      return errorResponse(c, 429, "concurrency-exceeded", "Global concurrency limit exceeded", {
        details: { scope: "global", current: concurrency.global.current, max: concurrency.global.max },
        headers: { "Retry-After": "5" },
      });
    }

    await next();
  };
};
