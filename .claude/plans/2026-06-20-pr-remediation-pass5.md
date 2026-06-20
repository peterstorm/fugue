# PR Remediation Plan — Pass 5

**Date:** 2026-06-20
**Branch:** feat/multi-tenant-single-host (PR #27)
**Method:** 15 subsystem reviewers (architectural-intent briefed) → adversarial verification of every finding
**Findings:** 0 critical, 4 advisory (5 + 1 raw → 4 confirmed; 0 false positives reached implementation)

This PR has been through 4 prior remediation passes. Pass 5 added **per-finding adversarial
verification** to eliminate the false-positive cycles that plagued earlier passes. Every reviewer
and verifier was briefed that Fugue's never-throw / fail-closed / ADT / idempotency / parse-don't-
validate patterns are deliberate (ADR-0044/45/51/60/63/67/68) and must not be flagged.

Result: the codebase is genuinely clean of critical issues. The 4 surviving findings are all
narrow, well-evidenced advisories.

## Advisory Fixes

### Fix 1: Draining worker re-adopted as `live` across a supervisor restart
- **Source:** worker-lifecycle reviewer → confirmed
- **File:** `src/supervisor/lifecycle/worker-lifecycle-manager.ts` (reconcileReadopt, livenessSweep);
  `src/supervisor/lifecycle/worker-lifecycle.ts` (new `adoptDraining`)
- **Issue:** `reconcileReadopt` calls `adoptLive` for every adopted record, discarding `record.health`.
  A worker that was SIGTERM'd to drain (FR-017) but still answers its UDS gets resurrected as `live`,
  so `canServe` is true and `ensureWorker` routes NEW traffic to it — defeating the drain. The
  persistable `health: "draining"` is a discarded type hole.
- **Reachability:** `lifecycle.drain()` has no production caller today (tests only), so a draining
  record is never persisted in production — latent, not live. Still a real type hole + invariant gap.
- **Fix (faithful, not prune):** add a pure `adoptDraining` constructor (phase `draining`,
  `drainStartedAt = record.startedAt`); branch `reconcileReadopt` on `record.health` to use it.
  The survivor is tracked (occupiesSlot accounting + SC-006 crash-net preserved) but `canServe`
  is false → no new traffic. Teach `livenessSweep` to finalize a dead re-adopted **draining** worker
  via `drainComplete` (terminal `evicted`, remove record, NO restart) — mirroring the spawned-worker
  exit watcher — instead of `onCrash` (which would spuriously restart a deliberately-drained worker).
- **Tests:** re-adopt-draining → not routable + slot counted; draining liveness-death → evicted, no restart.

### Fix 2: `hydrate()` bypasses the `serializeMutation` invariant
- **Source:** registry reviewer → confirmed
- **File:** `src/supervisor/registry/redis-registry-adapter.ts` (hydrate, ~573)
- **Issue:** Every other mutator (register/deregister/reconfigure/hardDelete) wraps its read-modify-
  write of the shared in-memory `registry` in `serializeMutation` (documented invariant, lines 395-404).
  `hydrate` reassigns `registry = registryOf(configs)` outside the gate. The interface advertises it
  as a runtime resync (line 314); a concurrent resync + register could drop a persisted tenant from
  the in-memory view until restart — the exact divergence serializeMutation prevents.
- **Reachability:** dormant — only caller is startup (main-supervisor.ts:216), before the HTTP
  listener/admin handlers are wired. Advisory.
- **Fix:** wrap hydrate's final commit (`registry = registryOf(configs); alive(); return ok(registry)`)
  in `serializeMutation`. Scan/get reads stay outside; only the commit is ordered against the chain.

### Fix 3: Bot approve path authz-ordering metadata leak
- **Source:** hitl reviewer → confirmed
- **File:** `src/hitl/adapters/bot/messages-handler.ts` (~205-254)
- **Issue:** The inbound card handler checks run existence/status BEFORE team authorization — the
  reverse of the HTTP approve path it claims to mirror. A Bot-Framework-verified clicker who is a
  mapped approver of ANY team can probe arbitrary runIds and learn existence + lifecycle stage of
  runs owned by OTHER teams (distinct "not found" / "already completed" / "still preparing" /
  "moved on" replies) before any team check. `recordDecision` is never reached → disclosure-only.
  The block comment ("mirrors the HTTP 404 path... Mirror it EXACTLY") is factually wrong.
- **Fix:** run authorization immediately after `getRun` succeeds and BEFORE the run-state checks;
  return the generic "You are not authorized to act on this review." for null/unauthorized so
  existence/status is never disclosed to an unauthorized clicker. Correct the stale comment.
- **Tests:** unauthorized clicker (Mallory / unknown aadObjectId) probing completed / moved-on /
  not-found runs all receive the generic refusal and `recordDecision` is never called.

### Fix 4: Lifecycle test fakes omit required `WorkerLifecyclePort` methods
- **Source:** supervisor-core reviewer (tests) → confirmed
- **File:** `src/__tests__/supervisor/supervisor.test.ts` (lifecycleLive/lifecycleDown),
  `src/__tests__/supervisor/admission-wiring.test.ts` (lifecycleLiveByTenant)
- **Issue:** Three fakes annotated `: WorkerLifecyclePort` omit the non-optional `idleEvictSweep`
  and `livenessSweep` members (spawn-port.ts:149,160). Never caught because `tsconfig.json`
  excludes `src/__tests__`, so `tsc --noEmit` never typechecks these files — the annotation is a
  silent type-lie providing no protection.
- **Fix:** add `idleEvictSweep: async () => []` and `livenessSweep: async () => []` to each fake so
  they honor their annotation.

## Validation Commands
```bash
cd packages/host
bun run typecheck        # tsc --noEmit
bun test                 # full host suite (some integration tests need Redis)
```
