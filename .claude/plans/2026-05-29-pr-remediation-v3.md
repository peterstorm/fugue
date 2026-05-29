# PR Remediation Plan — v3

**Date:** 2026-05-29
**Branch:** feat/fugue-host
**Scope chosen by user:** Everything (real bugs + missing tests + type hardening + WIRE dead surface)
**Findings:** 0 critical, ~14 advisory (5 review agents)

All findings were filed advisory; several are genuine correctness bugs with bounded blast
radius. User selected the maximal "Everything" remediation.

## Fixes (priority order)

### 1. Circuit-breaker half-open wedge (correctness)
- **Source:** code-reviewer
- **File:** `packages/host/src/http/handlers/run-dag.ts:131-155`
- **Issue:** `checkCircuit` consumes the single half-open probe before `acquire`. A 429
  concurrency rejection returns without `markSuccess`/`markFailure`, stranding the breaker
  at `half-open{testRequestAllowed:false}` → permanent 503 until next git sync.
- **Fix:** Acquire concurrency first; only consume the circuit probe once a slot is held.
  Release the token if the circuit denies. The probe is then only spent on a request we
  actually execute.

### 2. Per-DAG concurrency never enforced (FR-051)
- **Source:** architecture, pr-test-analyzer
- **Files:** `dag-factory.ts:82`, `concurrency.ts:71`, `host.ts:84-87`, `sync-callbacks.ts`
- **Issue:** Resolved `maxConcurrency` never folded into `ConcurrencyState`; `withDagLimit`
  has zero production callers — all DAGs collapse to `DEFAULT_DAG_CONCURRENCY`.
- **Fix:** `reconcileDagLimits(state, limits)` (pure) preserving in-flight `current` and
  retaining entries with `current>0` even when dropped from the registry (also closes the
  release-drift gap). Apply at boot + on every successful sync.

### 3. DagRegistrationSchema manufactures unearned DagId brand
- **Source:** type-design
- **File:** `dag-registration.ts:118-163`
- **Fix:** Refine `dag.id` against `DAG_ID_REGEX` (via `tryDagId`) so the `as DagRegistration`
  cast is honest at the public `/contract` boundary.

### 4. fugue.ts top-level unhandled rejection
- **File:** `packages/framework/bin/fugue.ts:75`
- **Fix:** `main().then(exit).catch(stderr + exit 1)`.

### 5. Wire runtime Redis liveness probe (redisDied/redisRecovered)
- **Source:** architecture
- **Issue:** Pure transitions exist + exported + tested but never invoked; `degraded:redis-disconnected`
  unreachable.
- **Fix:** New `lifecycle/redis-probe.ts` (timer + handle, mirrors sync-loop); `REDIS_PROBE_INTERVAL_MS`
  config; callbacks invoke `redisDied`/`redisRecovered` via `setState`, guarded against draining/stopped.

### 6. Wire TTL + per-DAG config (FR-040/041) — also fixes latent no-expiry bug
- **Source:** type-design, architecture
- **Issue:** `ResolvedDagConfig.cacheTtlMs/checkpointTtlMs/circuitBreaker` declared but never
  populated. `resolveTtl` already consumes them, so host-default TTLs are never applied →
  cache/checkpoint entries written with NO expiry (FR-040 violated).
- **Fix:** Extend `DagRegistrationConfig` with `cacheTtlMs`/`checkpointTtlMs`/`circuitBreaker`.
  Thread host-default TTLs into `HostTimeoutDefaults`; populate `ResolvedDagConfig` as
  `perDagOverride ?? hostDefault`. Wire per-DAG `circuitBreaker` through `checkCircuit`/`markFailure`.

### 7. Type hardening
- `GitSha` → `GitSha | null`, replace `""`/`EMPTY_SHA` sentinel.
- `__unsafeTestToken` → test-only helper module.
- Port `interface` → `type` aliases.
- Remove deprecated `RedisPort.keys()` from port + adapter + fakes (scan() is the prod path).

### 8. Missing tests + investigate
- `dag-factory.test.ts`: extractTeam fallback, timeout clamp, TTL population.
- Router-level `/admin/*` 403 negative case.
- 408 timeout path e2e.
- `extractTeam` `lastIndexOf("dags")` misattribution + unused `inferred` flag.

## Outcome (all applied)
- **Circuit wedge**: fixed by acquiring concurrency before consuming the circuit probe;
  releasing the token if the circuit denies. +2 regression tests.
- **FR-051**: `reconcileDagLimits` folds registry per-DAG limits at boot + every sync;
  also closes the release-drift gap by retaining busy entries. +5 tests.
- **DagId brand**: schema now refines `dag.id` via `tryDagId`. +3 tests.
- **fugue.ts**: top-level `.then/.catch`.
- **Redis probe**: new `lifecycle/redis-probe.ts` + `REDIS_PROBE_INTERVAL_MS`; wired in
  host start/shutdown; `redisDied`/`redisRecovered` now reachable. +3 unit + 1 integration test.
- **TTL/per-DAG config**: `DagRegistrationConfig` extended; host-default TTLs threaded;
  `ResolvedDagConfig` cacheTtlMs/checkpointTtlMs made REQUIRED (no-expiry state now
  unrepresentable — fixes latent FR-040 bug). Per-DAG `circuitBreaker` wired through
  `checkCircuit`/`markFailure` as a partial override. +14 dag-factory tests.
- **Type hardening**: `GitSha` rejects empty + `GitSha | null` replaces the `""` sentinel;
  `__unsafeTestToken` moved to test fixtures; ports converted to `type` aliases; deprecated
  `RedisPort.keys()` removed from the production surface + adapter.
- **Tests/investigate**: dag-factory.test.ts, router.test.ts (admin 403 defense-in-depth),
  408 timeout-path test, extractTeam hardened (first-`dags` + full-tail, dropped unused
  `inferred` flag).
- **CI risk**: root cause was `signals.test.ts` poisoning the shared runner (emits real
  process events → bun reports 0 tests, exits 0). Package `test` script now runs it isolated;
  `bun run test` reliably runs all 547 host tests and fails loudly.

## Deliberate deviations
- Per-DAG `circuitBreaker` is wired (not dropped). Its `windowMs` still comes from the host
  config (the override carries only `failureThreshold` → threshold and `resetTimeoutMs` →
  cooldownMs); a per-DAG window had no source and was out of scope.
- The deprecated `keys()` method is removed from the production `RedisPort`; test fakes keep
  a harmless `keys` property (the "uses scan not keys" guard test still passes meaningfully).

## Validation (green)
- framework: typecheck ✓, 1289 pass / 0 fail
- host: typecheck ✓, 547 pass / 0 fail
- customer-summary: typecheck ✓ (no downstream breakage)

## Validation
```bash
cd packages/host && bun test
cd packages/framework && bun test
bun run typecheck   # or tsc --noEmit per package
```
