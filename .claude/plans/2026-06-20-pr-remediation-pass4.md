# PR Remediation Plan — Pass 4

**Date:** 2026-06-20
**Branch:** feat/multi-tenant-single-host (PR #27)
**Review scope:** full branch diff vs `main` (~68 source files), 12-agent fan-out
(10 subsystems + architecture + test-gap) with adversarial verification of EVERY
finding (criticals double-verified).
**Findings:** 18 raw → **14 confirmed (2 critical, 12 advisory)**, 4 refuted/dropped.

Fourth remediation pass on an already-green PR. The two criticals are genuine
concurrency/availability defects that only manifest under the *intended production*
config (Redis-ACL on / liveness-probe wired); the advisories are a mix of
correctness sharp-edges, one silent-failure, two stale comments, and test gaps on
new fail-closed/security branches.

Dropped (correctly refuted, no action): non-finite `deregisteredAt` (unreachable —
`JSON.parse` rejects `NaN`/`Infinity`); `ensureWorker` re-spawn over `draining`
(gated behind un-wired `drain()` dead code); two false "zero tests" claims
(`realm-jwt-verifier`, `parse-json-object` are both well covered).

## Critical Fixes

### Fix 1 (worker-lifecycle): TOCTOU lets concurrent cold spawns exceed `SUPERVISOR_MAX_LIVE_WORKERS`
- **File:** `supervisor/lifecycle/worker-lifecycle-manager.ts:296-343`
- **Issue:** `lazySpawn` checks the live-worker cap synchronously (296) but commits
  the `spawning` slot only at 343 — AFTER `await provisionRedisAcl` (319). The
  single-flight dedupes per-tenant, so N concurrent first-requests for N DISTINCT
  cold tenants all read the same pre-commit count, all pass, all yield at the ACL
  await, then all commit — overshooting the cap by up to N-1. `liveWorkerCount()`
  is the SOLE FR-033 enforcer (admission's LiveWorkers axis was removed in pass 3),
  so this fails OPEN on the only host-memory bound, only in the ACL-on prod config.
- **Fix:** Reserve the `spawning` placeholder (`requestWorker`, which `occupiesSlot`
  counts) SYNCHRONOUSLY right after the admission check and before any `await`; mint
  the ACL after, and `workers.delete(tenant)` on provisioning failure (fail-closed).
  Check-and-reserve is then atomic on Bun's single thread. Update the now-stale
  "minted BEFORE claiming the slot" comment.
- **Test:** concurrent distinct-tenant cold spawns under a provisioner + cap assert
  the ceiling holds.

### Fix 2 (architecture): `writeDegraded` latch wedges new-run admission for ALL tenants
- **File:** `supervisor/registry/redis-registry-adapter.ts:319-340, 395-403`
- **Issue:** `resolveForNewRun` gates on `writeDegraded || probeDegraded`.
  `probeDegraded` is cleared CONTINUOUSLY by the liveness probe; `writeDegraded` is
  cleared ONLY by a SUCCESSFUL write/hydrate (event-driven, not continuous). A
  single transient write blip latches `writeDegraded`; once Redis recovers the probe
  clears its own flag but `writeDegraded` stays set with no continuous clearer →
  every tenant's NEW runs are refused (404) indefinitely while liveness shows green.
- **Fix:** Have `markRedisDegraded(false)` — the probe's authoritative continuous
  recovery edge — also clear `writeDegraded`. Keep the deliberate asymmetry that a
  successful WRITE never clears a probe-asserted outage. Correct the "monotonic until
  the responsible signal recovers" comment block.
- **Test:** `resolveForNewRun` recovers after `markRedisDegraded(false)` following a
  failed write, with no intervening successful write.

## Advisory Fixes

### Fix 3 (worker-lifecycle): a drained worker's clean exit is misclassified as a crash → respawn
- **File:** `supervisor/lifecycle/worker-lifecycle-manager.ts:411-418, 521-549`
- **Issue:** `drain` keeps the entry as `draining`; the crash watcher's guard accepts
  `draining`, so a drained worker's exit drives `onCrash` → respawn, contradicting
  FR-017 drain-then-stop. (Latent: `drain` has no prod caller, but it is on the
  public port.)
- **Fix:** In the crash watcher, route a `draining` exit through the pure
  `drainComplete` transition (terminal `evicted`) + drop the entry + remove the
  record — NO respawn; keep the `live` exit → `onCrash` (respawn) path unchanged.
- **Test:** a `draining` worker whose `exited` resolves is NOT respawned.

### Fix 4 (worker-lifecycle): crash-watcher comment falsely describes a "drain SIGKILL"
- **File:** `supervisor/lifecycle/worker-lifecycle-manager.ts:404-409`
- **Fix:** Rewrite the comment — only `evict`/idle-evict delete the entry before
  signalling (SIGKILL); `drain` leaves a `draining` entry that the watcher now routes
  to `drainComplete` (clean stop, no respawn). Co-located with Fix 3.

### Fix 5 (registry): `deserialize` truthy-coerces `eagerPin` instead of parsing it
- **File:** `supervisor/registry/redis-registry-adapter.ts:233`
- **Issue:** `eagerPin: Boolean(o.eagerPin)` is the lone field violating the module's
  own "never coerce" contract: a corrupt `"false"`/`1` becomes `true`, silently
  pinning a worker against idle eviction. Siblings use strict reads.
- **Fix:** Guard `typeof o.eagerPin !== "boolean"` → skip-as-corrupt (mirrors every
  sibling field), then read `o.eagerPin`.

### Fix 6 (registry): concurrent mutations RMW-race the in-memory `registry` across the I/O await
- **File:** `supervisor/registry/redis-registry-adapter.ts:405-489`
- **Issue:** Each mutator snapshots `registry`, awaits Redis, then commits
  `registry = next`. Two concurrent cross-tenant mutations both snapshot the same
  base and the second commit drops the first tenant from the in-memory view (the
  supervisor's new-run admission source) until process restart.
- **Fix:** Serialize all mutators (`register`/`deregister`/`reconfigure`/`hardDelete`)
  through a single per-instance promise chain so a mutation's commit is based on
  post-await state.
- **Test:** two concurrent `register()`s for different tenants → both survive in
  `snapshot()`.

### Fix 10 (hitl): active-run index leaks a quota slot when the terminal SREM fails
- **File:** `hitl/adapters/run-store.ts:253-274`
- **Issue:** On a terminal status the meta write lands first, then `sRem`; if the
  `sRem` errors (transient blip) the run stays indexed. `processRun`'s terminal guard
  never retries it, and `countActiveRuns`' self-heal only prunes members whose meta
  is ABSENT — a terminal-but-present meta is counted live, leaking a `maxQueuedRuns`
  slot for up to `ttlSec` (7 days default).
- **Fix:** Make `countActiveRuns`' self-heal authoritative: detect a TERMINAL
  persisted status and prune+exclude it (mirroring the missing-meta prune). Keep the
  corrupt/Redis-error behavior unchanged (no new total-block failure mode).
- **Test:** a terminal run left in the active set is pruned and not counted.

### Fix 11 (entrypoints): chmod failure after a successful UDS bind leaks the listening socket
- **File:** `host.ts:782-824`
- **Issue:** `Bun.serve` binds, then `chmodSync` can throw; the catch closes
  capabilities + `onShutdown` but never `bunServer.stop()`, leaving a mis-permissioned
  socket listening — contradicting the FR-007 "fail-closed boot abort" the comment
  promises. (Masked today only because both binaries `process.exit(1)`.)
- **Fix:** Type `bunServer` as `| undefined`; in the catch `bunServer?.stop()` and
  `hitlWorker?.close()` before `closeAll`/`onShutdown`, matching the happy-path order.
- **Test:** chmod-fails-after-bind → boot returns `internal-invariant-violated` AND
  no server remains listening on the socket.

### Fix 13 (architecture): `ensureWorker` runs before routing folds admission → spawn storm during outage
- **File:** `supervisor/supervisor.ts:298-326`
- **Issue:** `ensureWorker` is called unconditionally before `routeRequest` folds the
  admission decision. During a Redis outage every new-run request for an active
  tenant cold-spawns a worker (UDS bind + ACL + child) that can't reach Redis and is
  SIGKILLed — pure fault amplification — then the request 404s anyway.
- **Fix:** Only call `ensureWorker` when `admission.decision.kind === "admitted"`;
  otherwise set `presence = { kind: "unavailable" }` and let `routeRequest` produce
  the identical refusal.
- **Test:** `ensureWorker` is NOT invoked for `unknown`/`over-quota` admission.

### Fix 7 (secrets test): comment mislabels the ACL credential handoff
- **File:** `__tests__/supervisor/secrets/redis-acl.test.ts:13, 349`
- **Fix:** "for SecretsSource handoff" → "for spawn-env handoff to the owning worker"
  (the credential travels the spawn-env channel, deliberately SEPARATE from the
  SecretsSource port — the load-bearing threat-model narrative).

### Fix 8 (domain test): `markSecretsRef` blank-ref throw branch untested
- **File:** `domain/tenant.ts:209-217` (new test in `__tests__/domain/tenant.test.ts`)
- **Fix:** Mirror the `markTenant` throw test — assert `markSecretsRef("")` /
  `markSecretsRef("   ")` throw with `kind === "internal-invariant-violated"`.

### Fix 9 (http test): 5xx-HostError info-disclosure sanitization branch untested
- **File:** `http/middleware/error-handler.ts:133-149` (new test in `__tests__/middleware/error-handler.test.ts`)
- **Fix:** Throw a ≥500 HostError through `createErrorHandler`; assert the body is the
  generic message with no `details`/raw context and the full detail is logged.

### Fix 14 (registry test): `hardDelete` (grace-window T10 final delete) untested at the adapter level
- **File:** `__tests__/supervisor/registry/redis-registry-adapter.test.ts`
- **Fix:** Add adapter tests for hardDelete: idempotent absent no-op; success
  (key removed, `deregistered` published, gone from snapshot); fail-closed on
  del/publish failure (memory NOT advanced).

## Validation Commands
```bash
cd packages/host
bunx tsc --noEmit
bun test
bun run check:docs   # from repo root
```
