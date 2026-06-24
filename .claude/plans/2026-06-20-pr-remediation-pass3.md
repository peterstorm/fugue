# PR Remediation Plan — Pass 3

**Date:** 2026-06-20
**Branch:** feat/multi-tenant-single-host (PR #27)
**Review scope:** full branch diff vs `main` (~68 source files), 6-agent cohort
**Findings:** 0 critical, 8 advisory (after dedup); comment-analyzer's "critical" reclassified advisory (doc-accuracy)

Third remediation pass on an already-green PR. code-reviewer and silent-failure-hunter
returned essentially clean; the residue was genuine but mostly small, plus one
finding the user elected to build out as a full feature (maxQueuedRuns enforcement).
All 8 selected findings were addressed.

## Fixes (applied)

### Fix 1+2 (comment-analyzer): ACL provisioner doc drift
- `secrets/redis-acl-provisioner.ts:178` — step-(5) comment said the credential is
  pushed "to the SecretsSource channel"; corrected to the **spawn-env channel**
  (distinct from the `SecretsSource` port) — the surviving instance of the pass-2 drift.
- `secrets/redis-acl-provisioner.ts:12` — docblock said the env-file port "resolves
  `vault://` refs"; corrected (it dereferences a secrets ref — env-file path today,
  Vault later).

### Fix 3 (type-design): admission limits coerced instead of parsed
- `registry/redis-registry-adapter.ts` deserialize + `http/handlers/admin/tenants.ts`
  parse — `maxConcurrentRuns`/`maxQueuedRuns` were `Number(...)`-coerced, so `"5"`/
  `true`/`null`/`[]` silently became valid-looking limits. Now `typeof === "number"`
  guarded: deserialize skips-as-corrupt; the handler 400s. Parse-don't-validate parity
  with the pass-2 string-field fix in the same functions.
- Tests: corrupt-admission skip branches (registry) + non-number → 400 (handler).

### Fix 4+5 (pr-test-analyzer): run-executor HITL-resume coverage
- Added tests proving `createRunExecutor` forwards `deps.tenant` → the factory's
  `routedTenant` (a resumed run's cache/checkpoint keys land under the tenant id,
  never the `dag.team` fallback — an SC-001 escape guard when id != team), and that a
  user-identity run resumes/completes on the no-broker path (no subject token rebound).

### Fix 6 (code-reviewer): worker env inheritance — documented, NOT scrubbed
- Investigation showed the reviewer's suggested scrub is unsafe: the worker REQUIRES
  both `REDIS_URL` (its Redis connection target; the ACL credential only overrides the
  embedded credential) and `ADMIN_TOKEN` (required by `parseHostConfig` AND used —
  `createHost` wires it into the worker's auth middleware to validate admin runs
  proxied over UDS). Scrubbing either breaks the worker. Documented the required
  inheritance in `bun-spawn-adapter.ts` so a future reader sees it is deliberate, not
  a leak (isolation rests on the Redis ACL + signed tenant header, not withheld config).

### Fix 7 (architecture, user elected "build it"): per-tenant HITL queue-depth enforcement
- **ADR-0074** — design: a durable per-tenant active-run index SET
  (`fugue:<tenant>:hitl:active`) read via `sMembers` (NOT `scan`, denied by the ACL),
  self-healing against TTL-leaks, idempotent SADD/SREM. Enforced at
  `HitlRunService.startRun` (429 `tenant-over-quota`); `maxQueuedRuns` plumbed via the
  spawn env (`FUGUE_MAX_QUEUED_RUNS`) from the registry config.
- Files: `hitl/ports.ts` (`countActiveRuns`), `hitl/adapters/run-store.ts` (both
  adapters), `hitl/service.ts` (gate), `host.ts` (wiring), `domain/config.ts`
  (`FUGUE_MAX_QUEUED_RUNS`), `supervisor/lifecycle/worker-lifecycle-manager.ts` +
  `main-supervisor.ts` + `TenantSpawnConfig` (spawn-env plumbing).
- Tests: active-index behavior + self-heal + tenant isolation (redis-stores); the
  startRun gate (over-quota at ceiling, slot frees on terminal, suspended occupies a
  slot, unset → unlimited) (service).

### Fix 8 (architecture): remove the vestigial admission LiveWorkers axis
- The admission ADT carried a live-worker bound sized to `Number.MAX_SAFE_INTEGER`
  (never binds) — a dead, drift-prone mirror of the worker-lifecycle manager's
  authoritative `liveWorkerCount()`. Removed the `LiveWorkers` interface, the
  `liveWorkers` field, `maxLiveWorkers` config, and the `claimedWorker` token field;
  the lifecycle manager remains the SOLE FR-033 enforcer.
- Tests: deleted the live-worker-specific tests (behavior removed); preserved/rewrote
  the per-tenant ceiling, drain-down, canAdmit, and SC-011 anti-starvation property
  (now isolation-only).

## Validation
```bash
cd packages/host
bunx tsc --noEmit   # exit 0
bun test            # exit 0 (changed files: 141 pass / 0 fail; supervisor+integration: 352 pass / 0 fail)
bun run check:docs  # 16 docs, all links resolve
```
