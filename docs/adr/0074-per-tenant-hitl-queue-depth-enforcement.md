# ADR-0074: Per-tenant HITL queue-depth enforcement via a durable active-run index SET

## Status

Accepted — `maxQueuedRuns` is enforced at the worker's `HitlRunService.startRun`
boundary against a durable per-tenant active-run index SET.

## Date

2026-06-20

## Context

The tenant registry (ADR-0068) carries a per-tenant `TenantLimits` value object
with two axes: `maxConcurrentRuns` and `maxQueuedRuns`. As of the multi-tenant
single-host work, only `maxConcurrentRuns` was actually enforced — by the
supervisor's pure `admitTenant` admission ADT, which holds a slot for the lifetime
of the proxied HTTP request (ADR-0072).

That enforcement is correct for **synchronous** DAG runs: the supervisor proxy
holds the request open for the whole run, so admit-on-request / release-on-response
genuinely bounds concurrency. But a **HITL** DAG (ADR-0060) returns `202 {runId}`
the instant it is enqueued; the proxy resolves, and the supervisor releases the
per-tenant slot while the run continues durably in the background (queued →
running → suspended-at-gate → … → terminal). The supervisor never observes the
run's terminal transition, so it cannot bound the number of outstanding HITL runs.

`maxQueuedRuns` was parsed, validated, persisted, and equality-compared, but had
**no consumer** — a first-class admission limit that advertised a guarantee
(bounded per-tenant outstanding HITL runs) the system did not provide. A tenant
spamming HITL DAGs could accumulate unbounded queued/suspended runs regardless of
its configured ceiling, defeating the anti-starvation intent (SC-011 / US8) for
the durable path.

The enforcement point is forced by where the run lifecycle is observable:

- The supervisor cannot do it — it does not see durable completion.
- The per-tenant **worker** owns the full HITL lifecycle (`HitlRunService`:
  `startRun` / `processRun` / `recordDecision`). It is the only place that sees a
  run created and a run settled. So enforcement must live in the worker.

Counting "outstanding HITL runs for this tenant" is the hard part. The obvious
approach — `SCAN`/`KEYS fugue:<tenant>:hitl:run:*` — is **unavailable**: under the
per-tenant Redis ACL (ADR-0067) `scan`/`keys`/`randomkey`/`dbsize` are DENIED
(keyspace enumeration is not reliably constrained by a key-pattern ACL across
Redis/Valkey versions). The codebase already established the alternative for
tenant-scoped enumeration: a per-tenant **index SET** read with `sMembers`
(`adapters/token-store.ts` `listTeams`, `ports.ts` `RedisPort` security note).

## Decision

Enforce `maxQueuedRuns` in the worker at `HitlRunService.startRun`, against a
durable per-tenant **active-run index SET** maintained by the `RunStore`.

### The active-run SET

A single Redis SET per tenant, `fugue:<tenant>:hitl:active`, holding the run ids of
all NON-terminal runs (queued / running / suspended). It is maintained by the
`RunStore` adapter, co-located with the run records it indexes:

- `create(record)` → `SADD` the run id (a fresh non-terminal run joins the index).
- `setStatus(runId, terminal)` → `SREM` the run id when the status is `completed`
  or `failed` (the run leaves the index). Non-terminal status writes do not touch
  the index.
- `countActiveRuns()` → `SMEMBERS` the set; **self-healing**: any member whose
  `fugue:<tenant>:hitl:run:<id>` metadata key no longer exists (TTL-expired or
  hard-deleted) is pruned (`SREM`) and excluded from the count. Returns the count
  of members backed by a live run record.

All four operations act on keys under `~fugue:<tenant>:*`, so they are permitted by
the per-tenant ACL and physically cannot name another tenant's runs — the
isolation invariant of ADR-0067 holds unchanged.

### The gate

`startRun` reads `countActiveRuns()` and, if it is `>= maxQueuedRuns`, refuses with
`tenant-over-quota` (429 + per-tenant `Retry-After`, the same error the
synchronous ceiling uses, ADR-0073) BEFORE seeding/creating the run. `maxQueuedRuns`
reaches the worker as `FUGUE_MAX_QUEUED_RUNS` in the spawn env (the same channel as
`FUGUE_SECRETS_REF` / the ACL credential), sourced from the active tenant config's
`admission.maxQueuedRuns`, parsed by `HostConfigSchema`, and threaded into
`createHitlRunService`. When unset (the single-tenant `main.ts` path, or a worker
spawned before this field is configured) the limit is **unlimited** — backwards
compatible, fail-open ONLY on the queue-depth soft limit (never on isolation).

### Why a SET, not a counter

A free-standing `INCR`/`DECR` counter drifts: a suspended run whose record TTLs out
without ever settling would never be decremented, so the counter inflates
monotonically and eventually rejects every legitimate run. The SET is **idempotent**
(`SADD` of a present member and `SREM` of an absent member are no-ops, so
double-create / double-settle do not drift) and **self-healing** (`countActiveRuns`
reconciles against the actual run records, so a TTL-expired suspended run is pruned
on the next count rather than leaking a slot forever). Reconciliation is `O(N)` in
the set size, which is bounded by `maxQueuedRuns` — small by construction.

### Semantics and accepted limits

- **What counts:** every non-terminal run (queued / running / suspended). A run
  parked at a human gate still occupies a slot — that is the intended meaning of a
  per-tenant outstanding-HITL-run ceiling.
- **Soft limit under concurrent initiation:** the check-then-create is not a single
  atomic Redis transaction. Within one worker, Bun is single-threaded, but two
  `startRun`s can interleave at `await` points and both observe `count < max`,
  admitting one run over the ceiling. This is an accepted, bounded overshoot for a
  queue-depth soft limit; it never UNDER-counts in a way that breaks isolation. A
  strict cap would require a Lua/`MULTI` SADD-and-check, deferred as unnecessary for
  the anti-starvation intent.

## Consequences

- `maxQueuedRuns` becomes a live guarantee instead of dead config; the durable HITL
  path gains the same per-tenant anti-starvation protection the synchronous path has
  (SC-011 / US8 across both run modes).
- The `RunStorePort` contract gains `countActiveRuns()`; `create`/`setStatus` gain
  the index side-effect. Both the in-memory and Redis adapters implement it; the
  index is a pure function of the runs the store already owns.
- A new spawn-env axis (`FUGUE_MAX_QUEUED_RUNS`) plus `HostConfigSchema` field and
  `TenantSpawnConfig` field carry the limit from the registry to the worker.
- Enforcement is a pure predicate (`activeCount, limit → admit | refuse`),
  unit-testable with plain numbers, and the SET behavior is testable against the
  in-memory run store with no Redis.

## Related

- [ADR 0060](0060-hitl-suspend-resume-primitive.md) — the durable HITL engine whose
  `startRun` this gates.
- [ADR 0067](0067-per-tenant-redis-acl-isolation.md) — the ACL that denies `scan`,
  forcing the index-SET approach.
- [ADR 0068](0068-tenant-registry-redis-pubsub-fail-closed.md) — the registry that
  carries `maxQueuedRuns`.
- [ADR 0072](0072-resource-enforcement-single-pod-admission-heap-cap.md) — the
  supervisor admission that enforces the `maxConcurrentRuns` (synchronous) axis.
- [ADR 0073](0073-tenant-branded-principal-extended-error-taxonomy.md) — the
  `tenant-over-quota` error this refusal reuses.
