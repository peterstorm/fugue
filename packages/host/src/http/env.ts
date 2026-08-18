/**
 * The Hono context shape every host route shares.
 *
 * This type lives in a leaf, not in `router.ts`, and the distinction is
 * structural rather than cosmetic. `router.ts` is the composition root: it
 * imports every handler in order to register them. When the shared context
 * type also lived there, each handler had to import it back, so all five
 * handler modules formed an import cycle with the module whose whole job is to
 * depend on them. A handler could not be read or type-checked without pulling
 * in the router, and the one arrow the layering guarantees — root depends on
 * parts, never the reverse — was inverted for every part.
 *
 * Nothing here imports from `router.ts` or from any handler, so the cycle
 * cannot come back.
 */
import type { AuthIdentity } from "../domain/auth.js";
import type { HostState } from "../domain/host-state.js";

export type HostEnv = {
  Variables: {
    hostState: HostState;
    authIdentity: AuthIdentity;
  };
};

/**
 * The narrower context the auth middleware alone establishes.
 *
 * Middleware tests mount the middleware without a host, so they can set
 * `authIdentity` and nothing else. Typing those apps as `HostEnv` would claim
 * a `hostState` the test never provides. This is a real second shape, not a
 * legacy alias — it lives beside `HostEnv` so both context shapes are declared
 * in one place rather than one per consumer.
 */
export type AuthEnv = {
  Variables: {
    authIdentity: AuthIdentity;
  };
};
