# ADR-0038: Pure Circuit Breaker

## Status
Accepted

## Date
2026-05-20

## Context

When a DAG fails repeatedly (e.g. a broken deployment, an external dependency down), it should not continue consuming host resources or polluting error logs. The host needs a per-DAG circuit breaker that automatically disables failing DAGs and re-enables them when a new version is synced from git.

The circuit breaker must support three behaviors: (1) counting failures within a time window, (2) disabling the DAG after threshold breach, and (3) allowing a test request after a cooldown to check recovery. Time-based decisions (window expiry, cooldown elapsed) require a clock — but embedding `Date.now()` directly makes testing non-deterministic.

The host is single-instance, so the breaker state is in-memory. It must integrate with the git sync loop: when a new commit SHA is detected for a DAG, the circuit resets regardless of current state (new code = new chance).

## Options Considered

1. **Library-based circuit breaker (opossum, cockatiel)**
   - Pros: Battle-tested, feature-rich (metrics, events, fallback functions)
   - Cons: Hidden mutable state, non-functional API (methods with side effects), difficult to test deterministically, timer-based recovery hard to advance in tests, doesn't integrate with git-version reset naturally

2. **Simple failure counter without half-open state**
   - Pros: Simpler implementation
   - Cons: No recovery path without manual intervention or git push, once open stays open until external reset, overly aggressive for transient failures

3. **Pure state machine with deterministic clock injection**
   - Pros: Three explicit states (closed/open/half-open) with pure transitions, clock injected as `now: number` parameter, fully deterministic tests, force-reset function for git-sync integration, exhaustive pattern matching on state type
   - Cons: Caller (imperative shell) must manage clock injection and state reference, no built-in timers for automatic recovery probing

## Decision
**Pure three-state circuit breaker with deterministic clock injection and force-reset on new git version.**

The circuit breaker is a discriminated union (`CircuitState`) with pure transition functions:

- **States:** `closed` (tracking failures within a window), `open` (rejecting all requests, recording reason), `half-open` (allowing one test request)
- **`recordSuccess(state, now)`** — closed stays closed (resets count), half-open transitions to closed (healed), open stays open
- **`recordFailure(state, now, threshold, windowMs)`** — closed increments count (opens if threshold exceeded within window), half-open returns to open, open stays open
- **`attemptReset(state, now, cooldownMs)`** — open transitions to half-open if cooldown elapsed, others unchanged
- **`forceReset(now)`** — unconditionally returns closed state; called when git sync detects a new SHA for the DAG (FR-092)
- **`isAllowed(state)`** — query: closed=true, open=false, half-open=testRequestAllowed
- **`consumeTestRequest(state)`** — marks the single test request as consumed in half-open

Implementation at `packages/host/src/domain/circuit-breaker.ts`. Defaults: threshold=5, window=60s, cooldown=30s.

Clock is never called internally — always passed as `now` parameter, enabling tests to advance time arbitrarily without timers or fake clocks.

## Consequences

**Positive:**
- Every state transition is deterministic — property tests can verify invariants like "N+1 failures always opens" and "forceReset always returns closed" without wall-clock dependencies.
- Git-version reset (FR-092) is a single function call, naturally integrated with the sync loop.
- Exhaustive pattern matching on the state DU ensures all transitions are handled — adding a fourth state forces all call sites to update.
- Cooldown/window configuration is per-call, making tests trivial and allowing per-DAG tuning.

**Negative:**
- The imperative shell must periodically call `attemptReset` to probe for recovery — there's no internal timer that triggers half-open transition. The sync loop or a dedicated tick handles this.
- More ceremony than a library for the initial implementation — but the testability payoff is immediate.
- If a DAG has no new git pushes and the half-open test request keeps failing, it oscillates between open and half-open forever. This is acceptable — the operator must either fix the code (push) or investigate manually.
