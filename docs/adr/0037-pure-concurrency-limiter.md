# ADR-0037: Pure Concurrency Limiter

## Status
Accepted

## Date
2026-05-20

## Context

The host must enforce capacity limits at two levels: global (max 50 concurrent executions across all DAGs) and per-DAG (default 10, overridable via `fugue.yaml`). When limits are reached, the HTTP layer must reject new requests with 429 and a `Retry-After` header.

The concurrency subsystem sits on the critical path of every request — the HTTP handler calls `acquire` before dispatching and `release` in a finally block. This makes it a hotspot for correctness bugs (double-release, leaked tokens, races). We need a design that is trivially testable and cannot silently corrupt counts.

The host is single-instance (ADR-0040), so there is no distributed coordination requirement — the limiter only needs to manage in-process counts.

## Options Considered

1. **Semaphore class with internal async queue**
   - Pros: Familiar pattern, backpressure built in (waiters queue up)
   - Cons: Internal mutable state is opaque to tests, timing-dependent behavior with async queues, harder to reason about edge cases (e.g. abort during wait), interleaved awaits can mask bugs

2. **External rate limiter (Redis-backed, e.g. rate-limiter-flexible)**
   - Pros: Would work for multi-instance, battle-tested
   - Cons: Overkill for single instance, adds network latency per request, Redis dependency for something that should be in-memory, couples rate limiting to infrastructure availability

3. **Pure counter state with acquire/release returning Result**
   - Pros: All transitions are pure functions over immutable state, fully deterministic (no timers, no async), 100% testable with property tests, token-based release prevents double-decrement, state inspection trivial for debugging
   - Cons: Caller must manage the state reference (imperative shell concern), no built-in backpressure (request is rejected, not queued)

## Decision
**Pure counter state with acquire/release returning `Result<{state, token}, ConcurrencyError>`.**

The concurrency limiter is modeled as an immutable `ConcurrencyState` record with pure transition functions:

- **`ConcurrencyState`** holds `global: {current, max}`, `perDag: ReadonlyMap<DagId, {current, max}>`, and `defaultDagMax`.
- **`acquire(state, dagId, now)`** checks both global and per-DAG capacity. Returns `ok({state, token})` on success or `err("global-at-capacity" | "dag-at-capacity")` when full.
- **`release(state, token)`** decrements using the opaque `AcquireToken` (which carries `dagId`). Clamps to 0 defensively.
- **`withDagLimit(state, dagId, max)`** registers custom per-DAG limits at DAG registration time.
- **Query helpers** (`hasCapacity`, `globalUtilization`, `dagUtilization`) read state without mutation.

Implementation lives at `packages/host/src/domain/concurrency.ts`. The imperative shell (HTTP middleware at `packages/host/src/http/middleware/concurrency-guard.ts`) holds the mutable state reference, calls acquire before dispatch, and release in finally.

Key invariants:
- `acquire` is the only function that increments counts.
- `release` is the only function that decrements counts.
- Global current always equals the sum of all per-DAG currents.
- No async operations within the pure core.

## Consequences

**Positive:**
- Every state transition is a pure function — property testing can verify invariants like "release after acquire always returns to prior count" without mocks or timers.
- Token-based release prevents double-decrement bugs (caller cannot release without a valid token from acquire).
- State is inspectable at any point — debugging capacity issues is trivial.
- No timing dependencies — tests run deterministically and instantly.

**Negative:**
- No built-in backpressure. Rejected requests fail immediately with 429 rather than queuing. This is acceptable for the current use case (AI agent callers can retry) but would need rethinking if human-interactive UIs consume the API.
- The imperative shell must correctly maintain the mutable state reference. A bug in the shell (e.g. missing `release` in an error path) could leak slots. Mitigated by the finally-block pattern in the concurrency-guard middleware.
- Adding distributed concurrency later requires replacing this with a Redis-backed limiter — the pure interface doesn't extend to multi-instance.
