/**
 * Token Cache — pure, time-injected freshness logic for minted downstream
 * tokens. The functional core of the Keycloak-backed broker
 * (`adapters/keycloak-broker.ts`, which holds two cache cells over this module
 * and is selected at boot when `REALM_JWT_ISSUER` is set; the cache itself is
 * mandated by FR-W2-007): this
 * module decides WHETHER a cached token may be reused and HOW its lookup key is
 * built, with zero I/O and zero ambient clock — `now` is always injected so the
 * decision is a deterministic function of its inputs (Constraint: functional
 * core stays pure).
 *
 * Two invariants live here in TYPES, not comments:
 *   - A cache MISS is the absence of a value (`undefined`), never an `Err`
 *     (FR-X-003) — a miss is a normal control-flow signal to mint, not a
 *     failure. `lookup` returns `CachedToken | undefined`; there is no error
 *     channel to misuse.
 *   - A `CachedToken` carries its OWN absolute expiry (`expiresAt`), so
 *     freshness is the entry's property, not a separate TTL the caller must
 *     remember to thread. `isFresh` therefore needs only `(entry, now)`.
 *
 * @satisfies FR-X-003 — token cache miss is NOT an error; it triggers a mint
 * @satisfies SC-008 — ≤ 1 token request per (identity,audience,scope) per TTL
 *   window: a key resolves to the same cached token for every lookup inside its
 *   freshness window, so the broker mints at most once per window (property-
 *   tested in token-cache.test.ts).
 */

/**
 * Delimiter for the composite cache key. U+001F (UNIT SEPARATOR) is a C0
 * control character that cannot appear in an OIDC identity (`sub`/client id),
 * an audience URI, or a scope name — all of which are printable ASCII/URI
 * tokens — so it can NEVER collide a delimiter with key material. (A plain `:`
 * would collide: a scope like `msgraph:mail.send` already contains one, so
 * `a:b` + `c` and `a` + `b:c` would otherwise alias.)
 */
const KEY_DELIMITER = "";

/**
 * Join identity/key parts into one composite key, injectively. This is the ONLY
 * place the delimiter (and its injectivity argument) lives: every caller
 * composing a security-relevant identity — `cacheKey` below, the broker's
 * `(sub, agentClientId)` dedup identity — goes through here, so the "delimiter
 * never appears in key material" invariant has a single owner. Injective for
 * delimiter-free parts: part counts and boundaries are unambiguous, so distinct
 * part lists never produce the same composite.
 */
export const compositeKey = (...parts: readonly string[]): string => parts.join(KEY_DELIMITER);

/**
 * Deterministic composite cache key for one (identity, audience, scope) triple.
 *
 * The triple is exactly the SC-008 mint-deduplication unit: two invocations
 * that share identity + audience + scope must hit the SAME cache entry so the
 * second reuses the first's token. Order is fixed and the separator is
 * collision-proof (see `KEY_DELIMITER`), so the mapping is injective: distinct
 * triples never produce the same key.
 */
export const cacheKey = (identity: string, audience: string, scope: string): string =>
  compositeKey(identity, audience, scope);

/**
 * A minted token together with its absolute expiry. `expiresAt` is an absolute
 * epoch-millis instant (NOT a relative TTL): freshness is then a pure
 * comparison against the injected `now`, independent of when the entry is read.
 * Both fields are readonly — a cached token is an immutable value.
 */
export type CachedToken = {
  readonly token: string;
  /** Absolute expiry instant, epoch milliseconds. The entry is fresh while `now < expiresAt`. */
  readonly expiresAt: number;
};

/**
 * Construct a `CachedToken` from a mint time, a relative TTL, and the token.
 * Centralises the `expiresAt = storedAt + ttl` arithmetic so callers never
 * thread a raw TTL alongside the entry. `storedAt` and `ttlMs` are injected
 * (no ambient clock).
 */
export const cacheToken = (token: string, storedAt: number, ttlMs: number): CachedToken => ({
  token,
  expiresAt: storedAt + ttlMs,
});

/**
 * Freshness predicate with an EXPLICIT boundary: an entry is fresh iff
 * `now < entry.expiresAt` — strictly less-than. At the exact expiry instant
 * (`now === expiresAt`) the entry is STALE. Rationale: `expiresAt` is the first
 * instant at which the token is no longer guaranteed valid, so the half-open
 * window `[storedAt, expiresAt)` is the safe reuse window — reusing a token AT
 * its expiry risks presenting an already-rejected token downstream.
 */
export const isFresh = (entry: CachedToken, now: number): boolean => now < entry.expiresAt;

/**
 * The pure cache store: an immutable map from composite key to cached token.
 * Modelled as a plain readonly record so the whole cache is a value (no mutable
 * Map identity to leak). Mutations (`store`) return a new store.
 */
export type TokenCache = {
  readonly entries: Readonly<Record<string, CachedToken>>;
};

/** The empty cache — no entries. */
export const emptyCache: TokenCache = { entries: {} };

/**
 * Look up a key in the cache, returning the FRESH entry or `undefined`.
 *
 * "Miss" is first-class absence, NOT an error (FR-X-003): an absent key and an
 * expired-but-present key both read as `undefined`, because to the caller they
 * mean the same thing — "no reusable token, go mint". The return type has no
 * error channel, so a miss can never be mistaken for a failure.
 */
export const lookup = (cache: TokenCache, key: string, now: number): CachedToken | undefined => {
  const entry = cache.entries[key];
  if (entry === undefined) return undefined;
  return isFresh(entry, now) ? entry : undefined;
};

/**
 * Return a new cache with `key` bound to `entry`, SWEEPING every entry already
 * stale at `now`. Pure — the input cache is unchanged (immutability).
 * Overwrites any existing entry for the key, which is exactly the post-mint
 * refresh path.
 *
 * The sweep bounds the cache: without it, every distinct (identity, audience,
 * scope) triple ever minted is retained forever — unbounded growth AND
 * retention of expired bearer strings long past their useful (and safe)
 * lifetime. A store is the only mutation point, so sweeping here keeps the
 * cache's live size proportional to the FRESH triples, with `now` injected
 * like everywhere else in this module (no ambient clock).
 */
export const store = (
  cache: TokenCache,
  key: string,
  entry: CachedToken,
  now: number,
): TokenCache => {
  const entries: Record<string, CachedToken> = {};
  for (const [k, e] of Object.entries(cache.entries)) {
    if (isFresh(e, now)) entries[k] = e;
  }
  entries[key] = entry;
  return { entries };
};
