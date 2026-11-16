/**
 * Token Cell — a single-flight, freshness-cached cell of minted tokens, the
 * stateful shell over the pure `domain/token-cache.ts`.
 *
 * One cell holds one egress's tokens (the Keycloak broker keeps two: the SA
 * token and the Entra app-only token). `obtain(key, acquire)` is the whole
 * interface:
 *   - a FRESH cached token for `key` is reused (`cache-reuse`), no `acquire`;
 *   - else, when an acquisition for `key` is already in flight, the caller
 *     joins it and reports the shared token as `cache-reuse` (it did not
 *     perform the egress itself);
 *   - else the caller LEADS: it runs `acquire`, stores the token and reports
 *     `minted`, carrying the witness `acquire` returned.
 * So at most one `acquire` per key runs at a time and the count of `minted`
 * results equals the count of real token requests (SC-008).
 *
 * Invariants held by construction, not by caller convention:
 *   - I1 (no lost update): the cache lives in this closure and its only write
 *     re-reads the live value at write time, after the `acquire` await. No
 *     caller can hand back a snapshot taken before the await, so a mint for key
 *     A can never clobber a concurrent mint for key B.
 *   - Never rejects, never throws: a throwing `acquire` (a port-contract
 *     violation) or a throwing clock (at lookup or at store time) becomes
 *     `err(onThrow(thrown))` on the Result channel. The promise shared with
 *     waiters therefore cannot reject and poison them or escape as an
 *     unhandledRejection, and `obtain` itself never throws synchronously.
 *   - The lookup, the in-flight check and the leader's registration run in one
 *     synchronous step, so no second caller can slip between a miss and the
 *     registration.
 *
 * Cache freshness, the early-refresh margin, the store-time sweep and the
 * "uncacheable lifetime" rule (a TTL of 0 is never stored) are the pure
 * `token-cache` functions; only the closure cell mutates and the clock is
 * injected.
 *
 * @satisfies SC-008 FR-503
 */

import type { Result } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";
import {
  cacheToken,
  effectiveTtlMs,
  emptyCache,
  lookup,
  store,
  type TokenCache,
} from "../domain/token-cache.js";

/** What an acquisition returns: the token, its issuer-reported lifetime and the caller's witness. */
export type FreshToken<W> = {
  readonly token: string;
  readonly expiresInSec: number;
  /** Caller-defined evidence of how the token was minted (the broker's `via` strategy). */
  readonly witness: W;
};

/**
 * How `obtain` produced its token. Only `minted` carries a witness: a reused
 * token was not minted by this call, so there is no branch to witness.
 */
export type TokenAcquisition<W> =
  | { readonly acquisition: "minted"; readonly token: string; readonly witness: W }
  | { readonly acquisition: "cache-reuse"; readonly token: string };

export interface TokenCell<W, E> {
  /** Reuse, join or lead an acquisition for `key`; never rejects (see module doc). */
  readonly obtain: (
    key: string,
    acquire: () => Promise<Result<FreshToken<W>, E>>,
  ) => Promise<Result<TokenAcquisition<W>, E>>;
}

export interface TokenCellDeps<E> {
  /** Injected clock (epoch millis). Read once per lookup and once per store. */
  readonly now: () => number;
  /** Map a value thrown by `acquire` (or by the clock at lookup or store time) onto the error channel. */
  readonly onThrow: (thrown: unknown) => E;
}

export const createTokenCell = <W, E>(deps: TokenCellDeps<E>): TokenCell<W, E> => {
  let cache: TokenCache = emptyCache;
  const inFlight = new Map<string, Promise<Result<TokenAcquisition<W>, E>>>();

  const lead = async (
    key: string,
    acquire: () => Promise<Result<FreshToken<W>, E>>,
  ): Promise<Result<TokenAcquisition<W>, E>> => {
    try {
      const acquired = await acquire();
      if (!acquired.ok) return acquired;
      const { token, expiresInSec, witness } = acquired.value;
      const storedAt = deps.now();
      // I1: `cache` is read HERE, after the await — the live value, never a snapshot.
      cache = store(cache, key, cacheToken(token, storedAt, effectiveTtlMs(expiresInSec)), storedAt);
      return ok({ acquisition: "minted", token, witness });
    } catch (thrown) {
      return err(deps.onThrow(thrown));
    }
  };

  const obtain: TokenCell<W, E>["obtain"] = (key, acquire) => {
    // Total: the lookup-time clock read is guarded like the store-time one, so a
    // throwing clock is `err(onThrow(...))`, never a synchronous throw. Nothing
    // in the guarded step awaits, so the lookup, the in-flight check and the
    // leader's registration stay one synchronous step.
    try {
      const cached = lookup(cache, key, deps.now());
      if (cached !== undefined) return Promise.resolve(ok({ acquisition: "cache-reuse", token: cached.token }));

      const shared = inFlight.get(key);
      if (shared !== undefined) {
        return shared.then((r) => (r.ok ? ok({ acquisition: "cache-reuse", token: r.value.token }) : r));
      }

      const led = lead(key, acquire);
      inFlight.set(key, led);
      // `led` never rejects, so the cleanup derived from it cannot reject either.
      void led.then(() => {
        if (inFlight.get(key) === led) inFlight.delete(key);
      });
      return led;
    } catch (thrown) {
      return Promise.resolve(err(deps.onThrow(thrown)));
    }
  };

  return { obtain };
};
