# ADR 0030: State Machine with Pure Transitions

**Status:** Accepted  
**Date:** 2026-05-20  
**Spec ref:** `.claude/specs/2026-05-20-fugue-host/spec.md`  
**Related:** ADR 0031 (immutable registry snapshot), ADR 0036 (layered error handling)

## Context

The `@fugue/host` platform manages a non-trivial lifecycle: boot → initial git clone → DAG loading → ready to serve → periodic sync → possible degradation → graceful shutdown. Each phase has different invariants (e.g., HTTP handlers must not serve until DAGs are loaded; sync must not run concurrently with another sync; a degraded host must still serve from its last-known-good registry).

Without an explicit model, lifecycle state ends up scattered across mutable boolean flags (`isReady`, `isSyncing`, `isShuttingDown`) checked ad-hoc throughout the codebase. This pattern is fragile: illegal combinations of flags are representable, transitions are implicit, and testing requires constructing complex mutable object graphs.

The host is a single-instance process (AD-11) with no distributed coordination, so the state machine is local. The core question is whether to model lifecycle as explicit states with guarded transitions, or as imperative controller code with scattered state.

## Options Considered

1. **Discriminated union (`HostState`) with pure transition functions (chosen)**
   - Pros:
     - Every state transition is a pure function `(currentState, event) → newState | HostError`, testable without I/O or mocks.
     - Illegal state combinations are unrepresentable — the type system enforces phase-specific data (e.g., `registry` only exists after boot completes).
     - Exhaustive pattern matching (`ts-pattern`) ensures all states are handled in readiness checks, sync guards, and HTTP responses.
     - Property-testable: generate random transition sequences, assert invariants hold.
   - Cons:
     - Slightly more ceremony for simple cases (creating new state objects instead of flipping a flag).
     - Requires discipline to keep side effects out of transition functions.

2. **Event-sourced lifecycle**
   - Pros:
     - Full audit trail of every state change; replayable.
     - Familiar pattern from the framework's durable state machine runtime.
   - Cons:
     - Overkill for a single-instance process where state is ephemeral (resets on restart).
     - Adds replay complexity and persistence requirements for zero production benefit — the host doesn't need crash-resume of its own lifecycle.
     - The framework uses event sourcing for *DAG execution* durability; conflating host lifecycle with that substrate would muddy boundaries.

3. **Imperative controller with mutable fields**
   - Pros:
     - Familiar OOP pattern; less upfront design.
     - No type ceremony — just set `this.state = "ready"`.
   - Cons:
     - State scattered across fields; impossible to enumerate valid combinations at the type level.
     - Transitions are implicit method calls, not inspectable pure functions.
     - Testing requires instantiating the full controller with its dependencies; no way to unit-test transitions in isolation.
     - Bugs from concurrent access to mutable fields (e.g., sync loop and HTTP handler both mutating state) are subtle and hard to reproduce.

## Decision

**Model the host lifecycle as a discriminated union `HostState` with pure transition functions that return either a new state or a `HostError`.**

Concrete design:

- **File:** `packages/host/src/domain/host-state.ts`
- **States:** `booting | syncing | ready | degraded | draining | stopped` — each variant carries only the data relevant to that phase.
- **Transitions:** Named pure functions (`bootComplete`, `syncStarted`, `syncCompleted`, `syncFailed`, `beginDrain`, `drainComplete`, `redisDied`, `redisRecovered`) that accept the current state + event data and return a new `HostState` or a `HostError` for invalid transitions (e.g., calling `syncStarted` when already syncing).
- **Side effects:** Happen exclusively in the imperative shell (`host.ts`) *after* a successful transition. The shell calls a transition, inspects the result, then performs I/O (start HTTP server, schedule next poll, etc.).
- **Invariant enforcement:** Invalid transitions return `Result` errors, not thrown exceptions. The imperative shell decides whether to log and continue or escalate.
- **Testing:** Pure transitions are property-tested with `fast-check` — generate valid transition sequences, assert no invalid state is reachable.

## Consequences

**Positive:**

- 90%+ of lifecycle logic is unit-testable without mocks, timers, or I/O.
- Illegal states are unrepresentable at the type level — `draining` always carries `inflightCount`, `ready` always carries `lastSyncSha`.
- Debugging is straightforward: log the state DU on each transition; the entire host lifecycle is a sequence of inspectable values.
- The pattern is already proven in the codebase (framework's state machine runtime uses the same approach for DAG execution).

**Negative:**

- Every state transition allocates a new object. Acceptable — transitions happen at most once per poll interval (30s) or per request lifecycle event; this is not a hot path.
- Contributors must understand the pattern: side effects belong in the shell, never in transitions. A misplaced `await` in a transition function would violate the purity invariant silently (no lint rule catches this automatically, unlike the framework's import-graph lint).
- Adding a new state requires updating all exhaustive matches across the codebase. This is a feature (forces consideration) but adds friction to future state additions.
