# Claude Code Session: Fugue Host PR Review

**Session ID:** 019e50f3-3fae-7608-b2ca-f7ed573ad782  
**Timestamp:** 2026-05-22T18:29:39.375Z  
**Branch:** feat/fugue-host  
**Scope:** 135 files, 18,840 insertions(+), 461 deletions(-)

---

## Architecture Decisions Captured

### AD-1: Pure State Machine Pattern
**Decision:** Model host lifecycle as discriminated union of states (HostState) with pure transition functions.
- **States:** booting, syncing, ready, degraded, draining, stopped
- **Benefit:** 90%+ testability without mocks; property-testable transitions
- **Implementation:** ts-pattern exhaustiveness checking prevents missing cases

### AD-2: Immutable Registry Snapshot
**Decision:** Registry is frozen ReadonlyMap<DagId, RegisteredDag> per sync cycle.
- **Builders:** Pure functions (emptyRegistry, withDag, withoutDag, freeze) return fresh instances
- **Benefit:** No concurrent mutation bugs; HTTP handlers see consistent registry
- **Atomic Swap:** Reference update at HostState level ensures no half-loaded state

### AD-3: Framework Independence
**Decision:** @fugue/framework has zero imports from @fugue/host.
- **Dependency:** Host imports framework types (not the reverse)
- **Benefit:** Framework usable standalone in tests, CLI, other runtimes
- **Implication:** No circular coupling; host is optional infrastructure

---

## Key Patterns

### Port/Adapter Pattern
All I/O abstracted behind port interfaces:
- **GitPort:** clone, pull, currentSha, hasLockfileChanged, install
- **ModuleLoaderPort:** loadDagModule, discoverDagPaths, loadAll
- **RedisPort/RedisConnectivityPort:** cache/checkpoint operations
- **LogPort:** unified logger for all subsystems
- **TokenStorePort:** team token persistence (resolve, store, listTeams, revoke)
- **CircuitPort:** mutable circuit breaker state handle
- **Benefit:** Domain has zero concrete I/O dependencies; testable with in-memory fakes

### Result-Based Error Handling
- All domain functions return Result<T, HostError> (Either pattern)
- No thrown exceptions cross module boundaries
- HostError is discriminated union of 24+ kinds
- formatHostError() and httpStatusFor() are exhaustive (compile-error if kind missing)

### Circuit Breaker State Machine
```
closed --[threshold exceeded]--> open --[cooldown elapsed]--> half-open
  ^                                                                |
  |---[test success]--------------------------------------------<
  ^                                                                |
  |---[forceReset() on new sync]-----[test failure]----->[open]--
```
- Three states: closed, open (with OpenReason), half-open (with testRequestAllowed)
- Pure transitions record success/failure within sliding window (default: 5 failures in 60s)
- forceReset() called on new sync to re-enable disabled DAGs

### Concurrency Limiter with Branded Tokens
- Two levels: global (default 50) and per-DAG (default 10)
- acquire() returns Result<{state, token}, ConcurrencyError>
- Token is branded via unique symbol __acquireTokenBrand (prevents forgery)
- release(token) uses token to decrement counters
- Defensive clamping prevents negative counts from malformed state

### Git Sync with Error Isolation
**executeSyncCycle flow:**
1. Pull changes (remote mode only, after initial sync)
2. Read current SHA (rev-parse HEAD)
3. Short-circuit if SHA unchanged
4. Check lockfile changes → bun install (defensive install if detection fails)
5. Discover and load all DAGs (error isolation: single failure doesn't block others)
6. Freeze new immutable registry
7. Return SyncResult with registry + load errors

**Resilience:**
- Unexpected throws trigger onError callback to unstick state machine from "syncing"
- Partial success: successfully loaded DAGs proceed to registry even if some fail
- Defensive bun install: runs if change detection fails (prevents silent module errors)

### Team-Scoped Bearer Token Auth
- Tokens are hashed before storage (never plain text persisted)
- resolve(hash) returns Option<TokenGrant> from TokenStorePort
- Admin handlers provision/revoke tokens per team
- Auth middleware validates bearer header, looks up team, checks DAG ownership
- Forbidden (403) if caller's team ≠ DAG's team

### NodeContext Factory
- Pre-wires shared infrastructure singleton: llm, redis, tracer, contentFilter, logger
- Per-request unique fields: runId, signal, team
- Namespaced keys prevent collisions:
  - Cache: `fugue:{dagId}:cache:*`
  - Checkpoint: `fugue:{dagId}:{runId}:{nodeId}`

---

## Critical Edge Cases & Gotchas

### 1. SHA Tracking
- lastSyncSha uses branded empty string (EMPTY_SHA) to indicate "never synced"
- After first sync, always contains 40-char git SHA
- Prevents logic errors from comparing to undefined
- Preserved through degraded states to avoid forcing unnecessary resync on Redis recovery

### 2. Circuit Breaker Window Expiration
```typescript
const windowExpired = now - current.windowStart > windowMs;
const effectiveCount = windowExpired ? 1 : baseCount + 1;
```
- Must handle expired window (resets to 1 failure)
- Defensive clamping: Math.max(0, current.failureCount) prevents NaN propagation

### 3. Half-Open Test Request Consumption
- consumeTestRequest() atomically prevents duplicate test requests
- After consumption, no more requests allowed until success/failure
- Without this, half-open state could allow uncontrolled throughput

### 4. Sync Loop Recovery from Stuck State
- If executeSyncCycle throws unexpectedly, onError callback is called
- Without this, host remains in "syncing" phase permanently
- Finally block ensures running flag cleared for next cycle
- Callback may throw — wrapped in try/catch to prevent cascade

### 5. Defensive Bun Install
- If lockfile change detection fails, bun install runs anyway
- Rationale: Cannot determine if lockfile changed → assume it did
- Prevents silent "Cannot find module" errors on new dependencies

### 6. SHA Short-Circuiting
- currentSha === lastSha short-circuits DAG discovery/loading
- Avoids expensive filesystem scan and module imports
- Returns {kind: "no-change", currentSha} immediately

---

## Test Coverage

**34 test files** covering:
- **Domain:** auth.test.ts, concurrency.test.ts, circuit-breaker.test.ts, host-state.test.ts, registry.test.ts, config.test.ts, dag-registration.test.ts, host-error.test.ts
- **Handlers:** health.test.ts, list-dags.test.ts, run-dag.test.ts, admin/teams.test.ts
- **Middleware:** auth.test.ts, error-handler.test.ts
- **Lifecycle:** startup.test.ts, signals.test.ts
- **Integration:** dag-isolation.test.ts, full-lifecycle.test.ts
- **Property Tests:** concurrency.property.test.ts, circuit-breaker.property.test.ts, host-state.property.test.ts, registry.property.test.ts, diff.property.test.ts
- **Fixtures:** fake-module-loader.ts

---

## Requirements Traceability

**FR-001:** Poll git branch at configurable interval; detect new commits  
**FR-002:** Discover DAGs by convention (dags/{team}/{name}/dag.ts)  
**FR-003:** Dynamically import with SHA cache-busting  
**FR-004:** Only validated DAGs in registry  
**FR-005:** bun install if bun.lockb changed  
**FR-050/051:** Global (default 50) and per-DAG (default 10) concurrency limits  
**FR-090/091/092:** Circuit breaker with failure tracking and auto-enable on sync  

**NFR-003:** Git sync SLA: poll interval + 5s; per-op timeout 30s  
**NFR-010:** Single DAG load failure cannot corrupt existing registry  
**NFR-012:** Sync failure transitions to degraded, preserves existing DAGs  

---

## Framework Separation

**Zero Coupling Between Framework and Host:**
- @fugue/framework ← no imports from host
- @fugue/host → imports framework types only
- DAG code (dags repo) → imports @fugue/framework directly

**Result:** Framework is fully standalone and reusable; host is optional infrastructure for shared hosting.

---

## Integration: customer-summary Migration

This PR migrates the existing customer-summary DAG (a real production workload) into the host:
- Proves the host model works with a known-working baseline
- MLflow traces land with same structure
- Checkpointing/resume works identically
- Custom route `/summarize` remains backwards-compatible

---

## Detected Issues & Review Scope

**PR Automatically Triggers:**
- Architecture review (>500 additions AND >10 files changed)
- Code review (general quality, CLAUDE.md compliance)
- Silent failure hunter (error handling review)
- Test analyzer (coverage quality)
- Type design analyzer (invariants, encapsulation)
- Comment analyzer (documentation accuracy)

**File Counts:**
- 32 production source files (domain/ + adapters/ + http/ + sync/)
- 34 test files (unit + integration + property tests)
- 10+ planning documents (.claude/plans/)
- Multiple ADRs documenting architectural decisions

---

## Key Memories for Future Work

1. **Pure State Machines:** Discrimination unions + pure transitions enable property-testing entire lifecycle
2. **Immutable Snapshots:** Frozen registries prevent concurrent mutation; atomic reference swaps at state level
3. **Error Isolation:** Single DAG failure doesn't block others; partial success is better than no registry
4. **Sync Resilience:** Short-circuit on SHA unchanged; defensive installs on detection failure; callback-based recovery
5. **Type Safety:** Branded types prevent token forgery; exhaustiveness checking catches missing error kinds
6. **Namespaced Keys:** Cache/checkpoint isolation prevents cross-DAG/cross-run collisions
7. **Port Abstraction:** All I/O behind ports; domain testable with in-memory fakes
8. **Auth by Team:** Bearer tokens with team scoping; DAG ownership checked at handler level
