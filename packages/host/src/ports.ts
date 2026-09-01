/**
 * Port Interfaces — boundary contracts for all infrastructure adapters.
 *
 * Lives outside domain/ because ports define the shape of external systems,
 * not domain logic. Both domain and adapter layers import from here.
 *
 * Convention: Ports are grouped by subsystem. Each port returns Result<T, HostError>
 * for operations that can fail, making failure explicit at the type level.
 */

import type {
  Result,
  DagId,
  GitSha,
  LlmClient,
  LlmPricingModel,
  Tracer,
  PromptAccess,
  RunId,
  Spend,
} from "@fuguejs/framework";
import type { CapabilityHandle } from "@fuguejs/framework";
import type { HostError } from "./domain/host-error.js";
import type { DagRegistration } from "./domain/dag-registration.js";
import type { ContentFilter } from "@fuguejs/framework";
import type { TokenGrant, TokenHash } from "./domain/auth.js";

// ── Logger ──────────────────────────────────────────────────────────────────

/**
 * Unified logger port for all host subsystems.
 * Avoids coupling to a specific logging library.
 */
export type LogPort = {
  readonly info: (msg: string, data?: Record<string, unknown>) => void;
  readonly warn: (msg: string, data?: Record<string, unknown>) => void;
  readonly error: (msg: string, data?: Record<string, unknown>) => void;
}

// ── Clock ──────────────────────────────────────────────────────────────────────

/** Injectable time source — enables deterministic testing. */
export type Clock = () => number;

// ── Module Loader ────────────────────────────────────────────────────────────

export type LoadResult = {
  readonly id: DagId;
  readonly registration: DagRegistration;
  readonly modulePath: string;
  /** Pre-loaded prompt templates from sibling prompts/ directory (empty map if none found). */
  readonly prompts: ReadonlyMap<string, string>;
  /** Team from a sibling fugue.yaml `team` field, if present — overrides path-derived team. */
  readonly team?: string;
  /** Owner from a sibling fugue.yaml `owner` field, if present — surfaced as DAG metadata. */
  readonly owner?: string;
}

export type LoadError = {
  readonly path: string;
  readonly error: HostError;
}

export type BulkLoadResult = {
  readonly loaded: readonly LoadResult[];
  readonly errors: readonly LoadError[];
}

/**
 * Port interface for module loading — enables testing with fake loaders.
 */
export type ModuleLoaderPort = {
  readonly loadDagModule: (
    modulePath: string,
    sha: GitSha,
  ) => Promise<Result<LoadResult, HostError>>;

  readonly discoverDagPaths: (dagsRoot: string) => Promise<Result<string[], HostError>>;

  readonly loadAll: (
    dagsRoot: string,
    sha: GitSha,
  ) => Promise<BulkLoadResult>;
}

// ── Git ──────────────────────────────────────────────────────────────────────

/**
 * Port interface for git operations — enables testing with fakes.
 * All methods return Result — never throw.
 */
export type GitPort = {
  readonly clone: (
    url: string,
    target: string,
    opts?: { branch?: string; depth?: number },
  ) => Promise<Result<void, HostError>>;

  readonly pull: (repoPath: string) => Promise<Result<void, HostError>>;

  readonly currentSha: (repoPath: string) => Promise<Result<GitSha, HostError>>;

  readonly hasLockfileChanged: (
    repoPath: string,
    fromSha: string,
    toSha: string,
  ) => Promise<Result<boolean, HostError>>;

  readonly install: (repoPath: string) => Promise<Result<void, HostError>>;
}

// ── Redis ────────────────────────────────────────────────────────────────────

/** Mutually exclusive Redis expiry units for atomic write operations. */
export type RedisExpiry =
  | { readonly expiresInSec: number; readonly expiresInMs?: never }
  | { readonly expiresInMs: number; readonly expiresInSec?: never };

/**
 * Complete Redis spend append owned by the Spend Ledger consumer.
 *
 * The adapter commits marker fields, numeric sums, and optional retention in
 * one `MULTI`/`EXEC` against ONE hash key. Keeping the complete delta in this
 * request makes split-key marker/value races unrepresentable to the caller.
 */
export type RedisSpendAppend = {
  readonly key: string;
  readonly delta: Spend;
  readonly ttlSec?: number;
};

/** One atomic checkpoint write plus retention refresh for its run spend hash. */
export type RedisCheckpointSpendCommit = {
  readonly checkpointKey: string;
  readonly checkpointValue: string;
  readonly spendKey: string;
  readonly checkpointTtlSec: number;
  readonly spendTtlSec: number;
};

export type RedisValueGuard = {
  readonly key: string;
  readonly expectedValue: string;
};

/**
 * Redis-like interface for cache/checkpoint operations.
 * Returns Result to make failures explicit — no try/catch required at call sites.
 */
export type RedisPort = {
  readonly get: (key: string) => Promise<Result<string | null, HostError>>;
  readonly set: (key: string, value: string, opts?: { expiresInSec?: number }) => Promise<Result<string | null, HostError>>;
  /** Atomically delete one or more keys with a single Redis DEL command. */
  readonly del: (key: string, ...additionalKeys: readonly string[]) => Promise<Result<number, HostError>>;
  /**
   * Cursor-based key scanning — a keyspace-enumeration primitive.
   *
   * SECURITY NOTE: `scan` enumerates the keyspace and is NOT reliably constrained
   * by a per-tenant key-pattern ACL across Redis/Valkey versions (key-pattern
   * ACLs gate commands that ACCESS a key's value, not enumeration). It is
   * therefore DENIED on the per-tenant worker ACL (see `supervisor/secrets/redis-acl.ts`)
   * and only the SUPERVISOR/admin connection may call it (e.g. tenant-registry
   * hydrate over `fugue:tenants:*`). Tenant-scoped adapters MUST NOT use `scan` to
   * enumerate keys — use a per-tenant index SET + `sMembers` instead (see
   * `adapters/token-store.ts` `listTeams`). The blocking O(N) `KEYS` command is
   * intentionally NOT exposed.
   *
   * Returns a batch of matching keys plus the next cursor. Cursor "0" signals completion.
   * Call iteratively until cursor returns "0" to retrieve all matching keys.
   */
  readonly scan: (pattern: string, cursor?: string) => Promise<Result<{ cursor: string; keys: string[] }, HostError>>;
  /**
   * Add a member to a set (`SADD`). Returns the number of members ADDED (0 if it
   * was already present). Used for tenant-scoped index sets (e.g. the team index
   * `fugue:<tenant>:teams-index`) so a per-tenant worker can enumerate its OWN
   * keys via a single key the ACL DOES scope (`sMembers`), without `scan`.
   */
  readonly sAdd: (key: string, member: string) => Promise<Result<number, HostError>>;
  /**
   * Remove a member from a set (`SREM`). Returns the number of members REMOVED
   * (0 if it was absent). Idempotent — removing an absent member is fine.
   */
  readonly sRem: (key: string, member: string) => Promise<Result<number, HostError>>;
  /**
   * Read all members of a set (`SMEMBERS`). Reads ONE key, which a per-tenant
   * key-pattern ACL DOES constrain, so it is the version-independent, isolation-
   * safe alternative to `scan` for tenant-scoped enumeration.
   */
  readonly sMembers: (key: string) => Promise<Result<string[], HostError>>;
  /**
   * Set key only if it does not already exist (atomic check-and-set).
   * Returns `true` if the key was set, `false` if it already existed.
   *
   * Pass `{ expiresInSec }` to acquire the key AND its TTL atomically
   * (`SET key val NX EX ttl`). This is the ONLY crash-safe way to take a lock:
   * a `setNx` followed by a separate `set …EX` leaves the key with no expiry if
   * the process dies in the gap, so the key (e.g. a single-flight lock) is held
   * forever and never self-heals.
   */
  readonly setNx: (key: string, value: string, opts?: { expiresInSec?: number }) => Promise<Result<boolean, HostError>>;
  /**
   * Delete `key` only while its value still equals `expectedValue`.
   *
   * This is one atomic Redis transaction, not `GET` followed by `DEL`: lease
   * expiry may let a successor acquire the same key between those commands,
   * and an expired holder must never delete that successor's lock. Returns
   * `true` only when this caller's value was present and deleted.
   */
  readonly compareAndDelete: (key: string, expectedValue: string) => Promise<Result<boolean, HostError>>;
  /** Atomically renew a lease only while its ownership token still matches. */
  readonly compareAndExpire?: (key: string, expectedValue: string, expiresInSec: number) => Promise<Result<boolean, HostError>>;
  /**
   * Set `key` only while `guardKey` still equals `expectedValue`.
   *
   * The comparison and write are one optimistic Redis transaction. HITL uses
   * this to fence checkpoint/status writes with the worker's live lease token
   * and to commit notification-delivery state without a GET/SET gap.
   */
  readonly setIfValue?: (
    guardKey: string,
    expectedValue: string,
    key: string,
    value: string,
    opts: RedisExpiry,
  ) => Promise<Result<boolean, HostError>>;
  /** Atomically set a value only while every supplied guard still matches. */
  readonly setIfValues?: (
    guards: readonly [RedisValueGuard, ...RedisValueGuard[]],
    key: string,
    value: string,
    opts: RedisExpiry,
  ) => Promise<Result<boolean, HostError>>;
  /**
   * Atomically verify that `guardKey` exists and create `key` only if absent.
   * The outcomes distinguish a closed gate, a newly persisted value, and a
   * competing writer without leaking Redis transaction mechanics to HITL.
   */
  readonly setNxIfPresent?: (
    guardKey: string,
    key: string,
    value: string,
    opts: { expiresInSec: number },
  ) => Promise<Result<"not-present" | "created" | "exists", HostError>>;
  /** Read every field of a hash. An absent key yields an empty record, not an error. */
  readonly hGetAll?: (key: string) => Promise<Result<Readonly<Record<string, string>>, HostError>>;
  /**
   * Atomically append one complete Spend Record in a single `MULTI`/`EXEC`.
   *
   * The transaction queues every unpriced-model marker `HSET` first, then
   * nonzero `HINCRBY` values cost-first (`micros`, `tokens`, `calls`), then ONE
   * `EXPIRE` when `ttlSec` is configured. Implementations inspect every EXEC
   * result and return one typed failure for an aborted, malformed,
   * command-failed, or ambiguously acknowledged transaction. Callers and the
   * Redis driver must not retry/replay because acknowledgement loss cannot
   * prove absence of commit.
   */
  readonly appendSpend?: (append: RedisSpendAppend) => Promise<Result<void, HostError>>;
  /**
   * Atomically write one checkpoint and extend the corresponding spend hash.
   * The two explicit TTLs preserve their independent DAG-checkpoint and
   * resumable-run lifecycles. An absent spend hash is valid before the
   * run's first LLM call; EXPIRE then reports zero without aborting the write.
   */
  readonly commitCheckpointAndRetainSpend?: (
    commit: RedisCheckpointSpendCommit,
  ) => Promise<Result<string | null, HostError>>;
}

/**
 * Construction-proven Redis capability required by durable HITL adapters.
 * The generic Redis port keeps transaction methods optional for unrelated
 * consumers; host composition parses it once so no HITL worker can start with
 * a partially implemented transaction surface.
 */
export type HitlRedisPort = Pick<
  RedisPort,
  "get" | "del" | "sAdd" | "sRem" | "sMembers" | "setNx" | "compareAndDelete"
> & {
  readonly compareAndExpire: NonNullable<RedisPort["compareAndExpire"]>;
  readonly setIfValue: NonNullable<RedisPort["setIfValue"]>;
  readonly setIfValues: NonNullable<RedisPort["setIfValues"]>;
  readonly setNxIfPresent: NonNullable<RedisPort["setNxIfPresent"]>;
};

/**
 * Port for Redis connectivity validation (PING command).
 */
export type RedisConnectivityPort = {
  readonly ping: () => Promise<Result<void, HostError>>;
}

/**
 * Redis pub/sub — the propagation primitive for tenant-registry lifecycle
 * events (AD-5). `publish` fans a message out on a channel; `subscribe`
 * registers a handler and returns an unsubscribe handle. Kept SEPARATE from
 * `RedisPort` because a subscribing connection cannot serve normal commands in
 * Redis (subscriber mode), so the supervisor wires a dedicated subscriber
 * connection here while keeping `RedisPort` for read/write.
 *
 * Both operations return Result so a pub/sub failure is explicit — the tenant
 * registry adapter treats a publish failure as a Redis outage and fails closed
 * (FR-022) by routing through the host's `redisDied` degraded machine, never by
 * swallowing the error or throwing.
 */
export type RedisPubSubPort = {
  readonly publish: (channel: string, message: string) => Promise<Result<void, HostError>>;
  readonly subscribe: (
    channel: string,
    handler: (message: string) => void,
  ) => Promise<Result<{ readonly unsubscribe: () => Promise<void> }, HostError>>;
}

// ── Shared Infrastructure ────────────────────────────────────────────────────

/**
 * Shared boot resources initialized once at host startup. Their underlying
 * clients are reused; each run allocates its own authority, metered facades,
 * capability map, cache adapter, and checkpoint adapter.
 */
export type SharedInfra = {
  readonly llm: LlmClient;
  /** Composition-owned model policy used for both provider egress and pricing. */
  readonly llmPricingModel: LlmPricingModel;
  readonly redis: RedisPort;
  /**
   * Selected ledger binding. Stock wiring supplies a `redis-fallback` memory
   * ledger, making Redis-first selection explicit. Embedders may inject an
   * `authoritative` durable ledger (for example file), which is never displaced
   * merely because Redis exposes ledger primitives.
   */
  readonly spendLedger: SpendLedgerPort;
  readonly tracer: Tracer;
  readonly contentFilter: ContentFilter | null;
  readonly prompts: PromptAccess | null;
  readonly logger: LogPort;
  /**
   * External capability handles registered at host creation.
   * Connected during boot, closed during shutdown.
   * Non-LLM clients may be injected directly into per-request NodeContexts;
   * boot-scoped LLM clients are transformed into run-scoped metered or
   * composed facades first.
   *
   * @satisfies ADR-0051 — Extensible capability registry
   */
  readonly capabilities: readonly CapabilityHandle[];
}

// NOTE: CircuitPort / CircuitConfig intentionally live in domain/circuit-guard.ts,
// NOT here. They are domain concepts (a handle over the circuit ADT + its thresholds),
// so keeping them in domain preserves the ports → domain dependency direction rather
// than inverting it. See circuit-guard.ts.

// ── Spend Ledger ────────────────────────────────────────────────────────────

/** Selection and durability facts carried by a spend-ledger adapter. */
export type SpendLedgerMetadata =
  | {
      readonly role: "redis-fallback";
      readonly backend: "memory";
      readonly durability: "process";
    }
  | {
      readonly role: "authoritative";
      readonly backend: "file" | "redis";
      readonly durability: "restart";
    };

/**
 * Per-run LLM spend persistence seam.
 *
 * The in-process meter is the authority WITHIN one execution slice. Whether
 * this seam survives a process restart is explicit in `metadata.durability`:
 * the memory adapter is process-local, while authoritative adapters survive
 * restart. A resumable run builds a
 * fresh NodeContext per slice, so without it a run that parks for a human
 * decision and resumes starts from zero — five parks, six budgets.
 *
 * Two operations, deliberately: hydrate once when a slice starts, append once
 * per settled call. The seam requires monotone commutative append semantics,
 * not one persistence protocol: Redis commits one complete additive
 * transaction; the file adapter serializes whole-snapshot replacement per run.
 */
export type SpendLedgerPort = {
  /** Selection and durability facts travel with the adapter they describe. */
  readonly metadata: SpendLedgerMetadata;
  /**
   * Spend already recorded for a run. An unknown run reads as `NO_SPEND`, not
   * an error — "never seen" and "seen, spent nothing" are the same fact, and
   * the budget check treats them identically.
   *
   * An infrastructure failure IS an error. Budget-enforcing callers must fail
   * closed because an unreadable ledger is indistinguishable from a spent one;
   * non-enforcing callers may explicitly degrade to metering from zero so a
   * metering outage does not become an availability outage.
   */
  readonly read: (runId: RunId) => Promise<Result<Spend, HostError>>;
  /**
   * Append one settled call's spend. Monotone and commutative — adapters must
   * preserve every delta under concurrent calls, whatever settlement order.
   *
   * Returns no total: the in-process meter already knows the run's figure and
   * this write seam only acknowledges persistence. A lost acknowledgement may
   * be ambiguous, so adapters must not retry additive writes.
   */
  readonly add: (runId: RunId, delta: Spend) => Promise<Result<void, HostError>>;
};

// ── Token Store ─────────────────────────────────────────────────────────────

/**
 * Port for team token persistence.
 * Stores token hashes mapped to team grants.
 * Used by auth middleware (resolve) and admin handlers (store/list/revoke).
 */
export type TokenStorePort = {
  /** Look up a token grant by its hash. Returns Ok(null) if not found, Err on infrastructure failure. */
  readonly resolve: (hash: TokenHash) => Promise<Result<TokenGrant | null, HostError>>;
  /** Store a new team token. Returns err if team already has a token. */
  readonly store: (team: string, hash: TokenHash, grant: TokenGrant) => Promise<Result<void, HostError>>;
  /** List all provisioned teams with their grants (excludes hashes). */
  readonly listTeams: () => Promise<Result<readonly TokenGrant[], HostError>>;
  /** Revoke a team's token. Idempotent — revoking non-existent team is ok. */
  readonly revoke: (team: string) => Promise<Result<void, HostError>>;
}
