# ADR 0025 — Freshness Witness Contract

**Status:** Accepted
**Date:** 2026-05-14
**Relates to:** State-Transition Observability Phase 3

## Context

Fugue's DAG runtime tracks *what* happened and *in what order* via its event
log. It does not detect the most common class of agentic failure: a step acts on
a belief produced by an upstream step, and that belief has quietly gone stale
because the external world mutated between read and write.

The bug lives at the boundary between steps — not in any single step's code —
and is invisible in the event log unless the framework explicitly captures the
version state of external resources at each handoff.

## Decision

### Witness schema

The framework defines a `Witness` type:

```ts
type WitnessKind = "version" | "etag" | "timestamp" | "lsn" | "idempotency-key" | "custom";

interface Witness {
  readonly kind: WitnessKind;
  readonly resource: string;   // must match NodeDef.sideEffects.resource
  readonly value: string;      // opaque to the framework
}
```

The framework **never parses or compares** witness values beyond string equality.
Domain-specific ordering (monotonic versions, LSN comparison) is the node
author's responsibility. The framework's job is to detect *any* intervening
write to the same resource, not to evaluate version ordering.

### Extractor placement on `NodeDef`

Node authors declare extractors as optional fields on `NodeDef`:

- **`reads` nodes:** `extractWitness: (output: O) => Witness` — called after
  successful execution, emits `WitnessCapturedEvent`.
- **`writes` nodes:** `extractConditionedOn: (input: I) => Witness` and
  `extractNewWitness: (output: O) => Witness` — called before/after write,
  emits `WriteAttemptedEvent` and optionally `FreshnessViolationEvent`.

Extractors are optional rather than required (differing from the original plan)
to avoid breaking every existing node definition. Nodes that omit extractors
silently skip freshness tracking — this is a documented, intentional degradation.

### Three new event variants

1. **`WitnessCapturedEvent`** — emitted after a `reads` node completes.
2. **`WriteAttemptedEvent`** — emitted after a `writes` node completes.
   Records both `conditionedOn` (the witness the write assumed) and
   `newWitness` (the version produced by the write).
3. **`FreshnessViolationEvent`** — emitted when the framework detects that a
   write's `conditionedOn` witness was superseded by a conflicting write.
   The write **still proceeds** — the policy of "abort vs. proceed" is owned
   by the node author via routing on `freshness-violation` events.

### Detection mechanism

**Single-process (default):** `InMemoryFreshnessIndex` — a per-resource in-memory
write log. Zero overhead for nodes that don't declare extractors. For nodes that
do, one Map lookup per write.

**Cross-process:** `RedisFreshnessIndex` — uses a ZSET per resource:
- Key: `fugue:freshness:{resource}`
- Score: `succeededAtMs`
- Member: `{runId}|{nodeId}|{witnessValue}`
- TTL: 24h (matches checkpoint TTL)

`recordWrite` is an atomic ZADD + EXPIRE (Lua script). `findConflict` is a
ZRANGEBYSCORE scan. Both operations are O(log N + M).

Both implementations satisfy the `FreshnessIndex` interface:

```ts
interface FreshnessIndex {
  recordWrite(event: WriteAttemptedEvent): void | Promise<void>;
  findConflict(resource: string, conditionedOnValue: string, sinceMs: number):
    WriteEntry | null | Promise<WriteEntry | null>;
}
```

The executor `await`s all calls, so sync (in-memory) and async (Redis)
implementations are interchangeable.

### Non-blocking violation policy

A detected freshness violation emits an event but does **not** abort the write.
Rationale:

1. The framework cannot know whether the violation is semantically meaningful
   (a version bump on an unrelated column of the same table may be harmless).
2. Aborting would require the node author to handle a new error path that the
   framework introduced without their opt-in.
3. The event log captures the violation for offline analysis and alerting.
   Node authors who want abort semantics can route on `freshness-violation`
   events in their DAG predicates.

### What's on the node author vs. the framework

| Concern | Owner |
|---|---|
| Minting witness values (version extraction) | Node author |
| Defining `extractWitness` / `extractConditionedOn` / `extractNewWitness` | Node author |
| Calling extractors at the right time | Framework |
| Emitting witness/write/violation events | Framework |
| Maintaining the write index (in-memory or Redis) | Framework |
| Deciding whether to abort on violation | Node author (via routing) |

## Cost

- **In-memory:** One Map lookup per `writes` node per wave. Negligible.
- **Redis:** One ZADD + EXPIRE per write, one ZRANGEBYSCORE per write.
  Adds one round-trip per write node. Acceptable given writes are already I/O-bound.
- **Event payload:** Three new event types add to event-log volume. Bounded by
  the existing per-event size cap (64 KB default).

## Alternatives considered

### Distributed locks

Rejected. Locks are slower (two round-trips: acquire + release), don't give
you the audit log (the event stream has no record of what was locked or why),
and introduce deadlock risk in a DAG that may have multiple concurrent writes.
The witness contract is cheaper, gives better observability, and doesn't block.

### Required extractors (discriminated union on `NodeDef`)

The original plan specified a discriminated `NodeDef` union where `reads` nodes
*must* declare `extractWitness` and `writes` nodes *must* declare both
extractors. We relaxed this to optional fields because:

1. Every existing node definition would break.
2. Gradual adoption is more practical — teams add extractors as they identify
   resources that need freshness tracking.
3. The type system still catches extractor signature mismatches; only the
   *presence* check is relaxed.

### Witness comparison beyond string equality

Rejected. The framework has no domain knowledge to compare version numbers,
ETags, or LSNs semantically. String equality on `(resource, value)` is
sufficient to detect *any* intervening write. Node authors who need ordering
semantics can implement them in their extractors or predicate logic.

## Consequences

- Operators can answer "did the world change between read and write?" from a
  single event-log query.
- Node authors pay zero cost until they add extractors.
- The `FreshnessIndex` port enables cross-process detection without changing
  any node code.
- Property tests pin the invariant: for any sequence of read/write events,
  the framework's violation set equals the reference implementation's.
