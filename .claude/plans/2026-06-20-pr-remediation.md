# PR Remediation Plan

**Date:** 2026-06-20
**Branch:** feat/multi-tenant-single-host (PR #27, stacked on #25)
**Review scope:** NEW multi-tenant work vs `origin/feat/keycloak-entra-wiring` (50 source files, ~22k insertions)
**Findings:** 1 critical, 13 advisory (after dedup across 6-agent cohort)

The PR is exceptionally high quality — 1674 tests pass, clean tsc, passed all loom wave gates.
Reviewers confirmed the defensive patterns (never-throw, fail-closed, ADTs, parse-don't-validate,
non-dereferenceable SecretsRef) are correctly implemented, not just present. Findings below are the
genuine residue.

## Critical Fixes

### Fix 1: Re-adopted workers have no crash detection → permanent 503
- **Source:** silent-failure-hunter + architecture-tech-lead (independent, ~88% confidence each)
- **File:** `packages/host/src/supervisor/lifecycle/worker-lifecycle-manager.ts:371` (watcher) vs `:523-544` (adoptLive)
- **Issue:** The crash-exit watcher `handle.exited.then(onCrash)` is attached ONLY in `lazySpawn`.
  `reconcileReadopt` adopts re-parented workers (post supervisor restart) via `adoptLive` using
  only `pid`+`udsPath` from the Redis registry — no `exited` handle, no PID poll. If a re-adopted
  worker later crashes (OOM per ADR-0072, any exit), `onCrash` is never invoked. The entry stays
  `live`, `ensureWorker` keeps routing to the dead socket → 503 forever. Eager-pinned re-adopted
  workers are never idle-evicted either, so they wedge permanently. Violates FR-014/FR-015 on the
  re-adoption path (the exact scenario ADR-0065/0070 exist to support).
- **Fix:** Add `livenessSweep()` to the lifecycle manager: poll `proc.isAlive(pid)` for every
  `live`/`draining` worker that has NO crash watcher (adopted), and drive `onCrash(tenant, null)`
  for dead ones. Track watched (spawned-this-process) tenants in a `Set<TenantId>` so the sweep
  never double-fires against a worker the `handle.exited` watcher already covers. Wire a timer in
  `main-supervisor.ts` (mirrors the idle-evict sweep). Add `WORKER_LIVENESS_SWEEP_MS` config.

## Advisory Fixes (applied)

### Fix 2: onCrash respawn bypasses single-flight spawn dedup
- **Source:** architecture-tech-lead (~80%)
- **File:** `worker-lifecycle-manager.ts:460`
- **Issue:** `onCrash` calls `lazySpawn(tenant)` directly, outside `ensureWorker`'s `inFlightSpawns`
  map. A crash + concurrent request can both spawn onto the same UDS → bind contention, orphan,
  double-charged slot.
- **Fix:** Extract `spawnSingleFlight(tenant)`; both `ensureWorker` and `onCrash` route through it.

### Fix 3: Keyspace purge aborts on first del failure
- **Source:** silent-failure-hunter
- **File:** `main-supervisor.ts:483-485`
- **Issue:** First failing `del` returns err mid-enumeration, leaving the rest of the tenant's keys.
  The grace-purge sweep retries (idempotent) so nothing is lost, but one persistently-bad key blocks
  reclamation of all the tenant's other keys.
- **Fix:** Continue on per-key failure; return err after attempting all (still marks the step failed
  for retry, but does not wedge on one key).

### Fix 4: Documentation inaccuracies
- `worker-lifecycle-manager.ts:113-115` — config-field comment says budget "reset once worker reaches
  live"; contradicts the impl (window-based, never reset on live). → correct the comment.
- `docs/adr/0070-...md:218-219` — claims `secretsRef` is "carried on every WorkerState"; the ADT
  carries only `tenant`+`eagerPin`. → fix.
- `docs/adr/0069-...md` + `secrets-source.ts` + `redis-acl-provisioner.ts` — describe the minted ACL
  credential as handed through "the SecretsSource channel"; it actually transits the spawn env. → clarify.
- `docs/migrations/tenant-key-namespacing.md:84-87` — stale "Until ... (plan T6)" framing; routedTenant
  is now wired. → update.
- `host.ts` UDS chmod comment overstates the 0600-before-reachable guarantee (TOCTOU window). → soften.
- `docs/adr/0072-...md` — add a note that per-tenant admission counters are process-local and reset on
  supervisor restart while in-flight runs survive (transient over-admission, bounded per-tenant).

## Deferred (documented, not fixed)

- **env-file-secrets-source.ts directory placement** (architecture advisory): a worker-only adapter
  under `supervisor/secrets/`. FR-005 holds today (verified: no supervisor source imports it) and the
  structural import-boundary check is the proper fix (deferred to plan T11 per the code). Moving files
  now is a riskier change than the residual foot-gun warrants on a green PR.
- **subscribeTenantEvents dead pub/sub seam** (silent-failure advisory): not a bug in the single-host
  topology (one process performs all registry writes and reads its own snapshot). Intentional seam for
  a future second reader.
- **drain/drainComplete no production driver** (architecture advisory): FR-017 graceful drain is
  modelled but deregister/idle use `evict`. Documented as modelled-not-driven in ADR-0070.
- **Test gaps** (pr-test-analyzer): symlink/traversal rejection test for env-file secrets; real
  Bun.spawn smoke test for the heap cap. The pure planners are fully covered; these are I/O-shell
  smoke tests. Worth a follow-up but out of this remediation's risk budget.
- **Audit-only `rawId as TenantId`** (type-design advisory): contained, feeds only the audit sink.

## Validation Commands
```bash
cd packages/host
bunx tsc --noEmit
bun test 2>&1 | tail -30
```
