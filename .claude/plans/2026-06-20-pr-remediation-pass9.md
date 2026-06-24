# PR Remediation Plan (Pass 9)

**Date:** 2026-06-20
**Branch:** feat/multi-tenant-single-host
**Review method:** scoped, adversarially-verified multi-agent review (11 scopes → 15 raw findings → 9 confirmed → 0 critical + 8 advisory; 1 claimed-critical dismissed). Every finding survived an independent refuter briefed on the documented architectural intent (never-throw / fail-closed / ADTs / parse-don't-validate / backwards-compat), which is what broke the false-positive churn of passes 2–8.

> Supersedes `2026-06-20-pr-remediation.md` (the earlier 6-agent-cohort pass on this date); kept separate to preserve that record.

## Outcome

- **0 criticals** survived verification.
- **8 advisories** confirmed; user approved fixing 6 outright + resolving 1 design fork (#6) by deletion. #2 deferred with a documented condition.

## Dismissed (claimed critical, refuted)

**"Deregister token-revoke is a silent no-op (wrong tenant keyspace)"** — A verifier traced the premise to be false: `/admin/teams` (the per-tenant mint at `host.ts:648`) is wired ONLY in the *worker* router (`http/router.ts:115-117`), never reachable through the supervisor binary (`main-supervisor.ts` never imports the worker router). The supervisor authenticates and revokes via the SAME platform-bound `tokenStore`, so a token that can authenticate is a token revoke can delete. Confirmed by `integration/runtime-onboarding-e2e.test.ts` (one shared store backs auth + revoke + mint). The only real item here is the openly-documented future-work note at `main-supervisor.ts:447-450` (per-tenant token keying for later waves) — a deferral, not a defect.

## Fixes applied

### Fix 1 — `unquote()` fail-closed on unterminated escaped quote (`bug`)
- **File:** `packages/host/src/supervisor/secrets/env-file-secrets-source.ts`
- **Issue:** `SECRET="abc\"` (opening quote, `abc`, an escaped `\"`, no real closing quote) enters the double-quote branch (`startsWith('"') && endsWith('"')`) and parses to `abc\` — a wrong/truncated secret instead of the documented `config-invalid` Left. Violates the module's fail-closed contract; surfaces later as an opaque auth failure.
- **Fix:** count consecutive trailing backslashes in `inner`; if odd, the closing quote was escaped → return `undefined` (fail closed). Preserves `"abc\""`→`abc"` and `"abc\\"`→`abc\`. + test.

### Fix 2 — team uniqueness across active tenants (`security`)
- **File:** `packages/host/src/supervisor/registry/tenant-registry.ts`
- **Issue:** `register`/`reconfigure` key only by tenant id; nothing rejects a team already owned by a DIFFERENT active tenant. The supervisor's `teamToTenant` index (`main-supervisor.ts:244-256`) then resolves a team token first-writer-wins by Map insertion order — a nondeterministic, security-load-bearing routing ambiguity (ADR-0061/0064 assume team↔tenant 1:1). Admin-only trigger, so not externally exploitable.
- **Fix:** in the pure core `register`/`reconfigure`, scan `activeTenants` for the same team under a different id; if found return `config-invalid` (admin handler → 400). The Redis adapter delegates to the core, so this is enforced end-to-end. + tests (reject duplicate, idempotent re-register ok, deregister-then-reuse allowed).

### Fix 3 — `WORKER_UDS_DIR` rebind guard (`security`)
- **File:** `packages/host/src/worker-main.ts`
- **Issue:** the secrets merge `{ ...env, ...resolved }` lets an operator-mounted secrets file set `WORKER_UDS_DIR`, moving the worker's bound socket off the path the supervisor force-injects and probes → `waitForUds` timeout → SIGKILL → self-DoS (503) for that tenant. There is a sibling `TENANT_ID` guard but none for `WORKER_UDS_DIR`.
- **Fix:** mirror the `TENANT_ID` guard — fail closed (`config-invalid`) if the resolved secrets set the supervisor-reserved `WORKER_UDS_DIR` key. + test.

### Fix 4 — `eagerPin` corrupt-record skip test (`tests`)
- **File:** `packages/host/src/__tests__/supervisor/registry/redis-registry-adapter.test.ts`
- **Issue:** `deserialize`'s `typeof o.eagerPin !== "boolean" → undefined` guard is load-bearing (eagerPin is the authoritative pin source) but is the only per-field skip branch with no test; a regression to `Boolean(o.eagerPin)` (so `"false"`→true) ships silently.
- **Fix:** add an `expectSkipped` case for non-boolean `eagerPin` (`"false"`, `1`).

### Fix 5 — admission-state reclamation (`architecture`)
- **Files:** `packages/host/src/domain/concurrency.ts`, `packages/host/src/supervisor/admission.ts`, `packages/host/src/main-supervisor.ts`
- **Issue:** `tenantConc.perTenant` (and the mirrored inner `perDag`) accumulate a permanent entry per distinct tenant id ever admitted; no terminal lifecycle path reclaims it — a slow unbounded leak reclaimed only by restart.
- **Fix:** pure `forgetDagLimit` (concurrency) + `forgetTenant` (admission), both guarded on `current === 0` (preserve drain-down); wire `forgetTenant` onto the grace-purge `registry.hardDelete` success (the final, post-grace removal). + tests.

### Fix 6 — delete dead `canAccessDagForTenant` gate + soften ADR-0073 (`architecture`)
- **Files:** `packages/host/src/domain/auth.ts`, `packages/host/src/domain/tenant.ts`, `packages/host/src/__tests__/domain/tenant.test.ts`, `docs/adr/0073-tenant-branded-principal-extended-error-taxonomy.md`
- **Issue:** the ADR-0073 conjunctive second isolation gate is defined, documented, and tested but has ZERO production callers — isolation today is purely structural (each worker serves one tenant, so the `tenant.team === dagTeam` conjunct is always true). Dead public-surface code + an ADR overstatement.
- **Fix (user decision):** delete `canAccessDagForTenant` and its now-unused `Tenant` type-only import from `auth.ts`, drop its tests, and amend ADR-0073 / `tenant.ts` so they no longer assert a wired gate — documenting that the extension was designed but isolation is structural in this slice (re-addable when a shared-worker / multi-DAG topology needs per-request tenant scoping). The error-taxonomy half of ADR-0073 (shipped + used) is untouched.

### Fix 7 — notifier JSDoc accuracy (`comments`)
- **File:** `packages/host/src/hitl/adapters/bot/notifier.ts`
- **Issue:** `resolveDagTeam` JSDoc says it returns `undefined` "when the DAG is unregistered OR the team has no configured channel" — the wired impl (`host.ts:528-531`) is a pure registry lookup that returns the team whenever the DAG is registered and never consults channel config.
- **Fix:** correct the docstring to match the wired contract (the other two docstrings already do).

## Deferred

### #2 — `ensureWorker` on a draining worker spawns a duplicate over the same UDS (`bug`, latent)
- **File:** `packages/host/src/supervisor/lifecycle/worker-lifecycle-manager.ts`
- **Why deferred:** genuine latent defect in the published `WorkerLifecyclePort.drain` contract, but **UNREACHABLE today** — the sole producer of a `draining` entry/record is `lifecycle.drain()`, which has zero production callers (deregister uses `evict()`; ADR-0070:156-160 documents drain as modelled-but-not-driven). Fixing it also requires overriding `worker-lifecycle-manager.test.ts:560-585`, which currently asserts the fresh-spawn behavior as intended.
- **Condition:** land the `ensureWorker` draining-phase guard alongside any future wiring of `lifecycle.drain()` (reconfigure-triggered drain).

### Follow-up: is `drain()` being unwired itself a bug? (investigated 2026-06-20)
**No — deliberate, ADR-0070-documented deferral, not silently-missing required behavior.** Decisive test: no shipped FR/NFR/SC mandates an *active* graceful drain that nothing provides.
- **FR-017** ("On graceful drain, allow in-flight runs to complete…") is *conditional* on a drain being initiated, and that *behavior* IS implemented (`drain()` → `draining` phase, SIGTERM-only, `drainComplete` on actual exit, never SIGKILLs). Only the **trigger** is absent — and no operator drain endpoint is spec'd (admin lifecycle API US5 = register/deregister/reconfigure).
- **Deregister** is spec'd as *immediate kill* (FR-029/NFR-012) and correctly uses `evict()` (SIGTERM→SIGKILL, no grace). Using `drain()` there would *violate* the spec.
- **Reconfigure** is spec'd *lazy* (AD-5/spec.md:81 — new config applies on next spawn); AD-5 explicitly names "immediate apply = drain+respawn" as the road **not** taken.
- Unlike `canAccessDagForTenant` (deleted because isolation was already structural — pure redundancy), `drain()`'s "let in-flight finish" semantic has **no structural equivalent** (`evict` force-kills), so deleting it would discard a tested state machine with a *named* future trigger. Kept as scaffolding.
- **Two genuine soft spots closed** (doc/comment accuracy, not behavior): the `evict()` comment overstated SIGTERM grace (worker-lifecycle-manager.ts:595); the US4 graceful-drain acceptance scenario lacked a `[DEFERRED]` marker (spec.md:67).
- **Wiring drain now is NOT recommended:** it is a large, unspecified *feature* (drain+respawn orchestration + `ensureWorker` draining guard + `drainComplete`/timeout handling + tests) implementing behavior no shipped requirement demands — it belongs in the reconfigure feature's own spec, not a remediation pass.

## Validation Commands

```bash
bun run typecheck
bun run test
```
