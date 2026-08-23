/**
 * Lazy, single-flight JWKS resolver caching with reset-on-failure.
 *
 * Both JWT verifiers in this codebase — the Bot Framework one (`hitl/adapters/
 * bot/verify.ts`) and the Keycloak realm one (`realm-jwt-verifier.ts`) — need the
 * identical caching protocol around `jose.createRemoteJWKSet`, and each
 * hand-rolled it. The two are documented as deliberately mirroring each other,
 * which is exactly the argument for ONE definition rather than two copies kept in
 * sync by hand: they are supposed to be the same, so make them the same.
 *
 * Two properties make this more than a memo, and both are easy to lose in a copy:
 *
 *   - SINGLE FLIGHT: the PROMISE is cached, not the resolved value, so N
 *     concurrent requests arriving on a cold cache share one construction (and
 *     one metadata fetch) instead of stampeding the identity provider.
 *   - RESET ON FAILURE: a rejected build clears the cache, so a transient
 *     metadata outage is retried on the next call. Caching the rejected promise
 *     would wedge the verifier permanently — every subsequent token rejected for
 *     a network blip that has long since passed.
 */

/**
 * A `jose` remote JWKS resolver, in the shape `jwtVerify` consumes.
 *
 * Typed structurally rather than importing `jose`'s type, because `jose` is a
 * dynamic import in both verifiers (it must not be pulled into the module graph
 * of a host that never verifies a JWT).
 */
export type JwksResolver = (protectedHeader: unknown, token: unknown) => Promise<unknown>;

/**
 * Wrap `build` so it runs at most once per successful result, and is retried
 * after a failure. The returned thunk never throws synchronously; a build
 * failure surfaces as a rejection the caller converts to its own typed error.
 */
export const lazyJwks = (build: () => Promise<JwksResolver>): (() => Promise<JwksResolver>) => {
  let pending: Promise<JwksResolver> | null = null;
  return () => {
    if (pending === null) {
      pending = build().catch((error: unknown) => {
        pending = null;
        throw error;
      });
    }
    return pending;
  };
};
