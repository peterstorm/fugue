# ADR-0040: Single Instance In-Memory State

## Status
Accepted

## Date
2026-05-20

## Context

The host must maintain several pieces of mutable runtime state: the DAG registry (which DAGs are loaded), concurrency counters (how many runs are active), circuit breaker states (which DAGs are healthy), and the current host lifecycle phase. A fundamental architecture question is whether this state lives in-process or is externalized to a shared store (Redis, database) for multi-instance coordination.

The host serves an internal organization (~5 teams, ~20 DAGs, <100 concurrent requests). The workload is CPU-bound (LLM orchestration, not I/O fanout). There is no HA requirement in the initial deployment — a few seconds of downtime during deploys is acceptable.

Redis is already a hard dependency for DAG-level concerns (caching, checkpointing), but using it for host coordination adds latency to every request and complexity to every state transition.

## Options Considered

1. **Redis-backed state for high availability**
   - Pros: Enables multiple instances behind a load balancer, survives process restarts, state visible to external tooling
   - Cons: Adds network round-trip latency to every acquire/release, complicates pure state transitions (must serialize/deserialize on every op), distributed coordination (locks, CAS) needed for counters, premature for current scale

2. **Multi-instance with leader election**
   - Pros: Full HA, zero-downtime deploys
   - Cons: Requires consensus protocol (etcd/ZooKeeper) or Redis-based leader election, dramatically increases complexity, overkill for org-internal workload with <100 concurrent requests

3. **Single instance, all state in process memory**
   - Pros: Zero coordination overhead, pure functions operate on in-memory data structures, no serialization cost, simple mental model, deterministic behavior
   - Cons: Single point of failure (acceptable for current scale), vertical scaling only, restart loses all in-flight state (mitigated by Redis checkpoints at DAG level)

## Decision
**Single instance with all host-level state in process memory. Scale-up path is vertical (bigger box), then horizontal later if needed.**

All runtime state lives as TypeScript values in the host process:
- **Registry:** `ReadonlyMap<DagId, RegisteredDag>` — immutable snapshot, reference-swapped on sync
- **Concurrency:** `ConcurrencyState` — pure counter struct updated per-request
- **Circuit breakers:** `Map<DagId, CircuitState>` — per-DAG state machines
- **Host phase:** `HostState` discriminated union tracking lifecycle

Only DAG-level operational data persists to Redis:
- Cache entries (per-node LLM response caching)
- Checkpoints (run progress for resumption)
- Async run results (for P2 submit/poll pattern)

The imperative shell (`packages/host/src/host.ts`) holds mutable references to these state values. HTTP handlers read via closure; state transitions happen synchronously in the single-threaded Bun event loop (no races possible).

## Consequences

**Positive:**
- Pure domain functions operate on plain TypeScript values — no serialization, no network calls, no eventual consistency.
- Single-threaded event loop guarantees no data races on state — acquire/release are atomic within a tick.
- Startup is fast — no state recovery from external store needed. Git clone + DAG import is the only startup cost.
- Debugging is trivial — all state is inspectable in-process.

**Negative:**
- Single point of failure. Process crash loses all in-flight concurrency tokens (runs may have already started in LLM providers). Mitigated: DAG-level checkpoints in Redis allow resumption.
- Cannot horizontally scale. If request volume exceeds single-box capacity, architecture must change. Accepted: current scale is ~100 concurrent requests, well within single-instance capability.
- Deploy causes brief downtime (process restart). Acceptable for internal tooling. Could add rolling deploy later (but that requires multi-instance, which is deferred).
- No shared visibility — external monitoring must query the host's HTTP endpoints to see state. No external dashboard can read state directly from Redis.
