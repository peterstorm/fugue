# PR Remediation Plan — thin-init PID-1 wiring

**Date:** 2026-06-21
**Branch:** feat/multi-tenant-single-host
**Scope:** the unreviewed delta = commit `6aa0970` (thin-init production wiring, 1029 insertions / 15 files). Everything else in PR #27 was reviewed across 11 prior passes.
**Cohort:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-agent (all 6).
**Findings:** 1 critical, 22 advisory (heavily overlapping; deduped below).

## Critical Fixes

### Fix 1: silent `/proc` enumeration failure aborts the worker-drain broadcast
- **Source:** silent-failure-hunter
- **File:** `supervisor/lifecycle/bun-init-process-adapter.ts:220-224`
- **Issue:** In `beginTermination`, `readdirSync("/proc")` throwing is swallowed with a bare `return` (no log). The caller has already armed the grace timer, whose `exit(0)` tears down the PID namespace and SIGKILLs every worker mid-drain — the exact failure the grace window exists to prevent — with zero observability.
- **Fix:** Extract `broadcastSignalToWorkers(sig, seams)` with injected OS seams (`selfPid`, `enumerate`, `kill`, `logger`). Log the enumeration failure at `error` (workers will NOT drain → grace-timer SIGKILL). Emit an `info` summary (`enumerated`/`signalled`) so a systematic EPERM signalling zero workers is distinguishable from a clean broadcast. Makes the PID-1-only path unit-testable without a namespace.

## Advisory Fixes (deduped)

### Fix 2: reaper closure can throw out of a signal handler / interval (→ kills PID 1)
- **Source:** silent-failure-hunter (A3), pr-test-analyzer (T4)
- **File:** `bun-init-process-adapter.ts:84-91`
- **Fix:** Extract pure `drainReap(reapOne)` that wraps the FFI call in try/catch (a throw ends the cycle, never escapes; interval/SIGCHLD retries) and documents EINTR-as-ECHILD recovery (A4). Add last-resort `uncaughtException`/`unhandledRejection` handlers in `main-thin-init.ts` (PID 1 logs + survives — a stray async throw must not kill the pod). Unit-test the multi-reap drain + throw-safety.

### Fix 3: `/health` degraded branch + `/readiness` 503 branch untested
- **Source:** pr-test-analyzer (T2/T3), type-design-analyzer (TD4)
- **File:** `supervisor/supervisor.ts:271-286`
- **Fix:** Extract pure `buildLivenessResponse(state)` / `buildReadinessResponse(state)` over the `HostState` ADT; handler dispatches to them. Unit-test across ALL phases (degraded→200, booting/draining/stopped→503). Also resolves TD4 (the non-exhaustive ternary becomes a tested, greppable pure builder).

### Fix 4: optional-signing branch duplicated across the two request builders
- **Source:** type-design-analyzer (TD1)
- **File:** `supervisor/uds-proxy.ts:113-119, 149-170`
- **Fix:** Factor `applySignedTenantHeader(headers, hmacKey, tenant)` — one decision point for "sign iff key present", matching the canonical-contract module's single-point-signing intent. Behavior-preserving.

### Fix 5: stale/incorrect spec citations
- **Source:** comment-analyzer (C1/C2)
- **Files:** `bun-init-process-adapter.ts:138`, `init-broadcast-harness.ts:6` (FR-060 → FR-017; FR-060 does not exist, spec tops at FR-042); `thin-init.ts:37`, `Dockerfile:60` (FR-035 is "reuse the control plane", NOT "preserve a single-tenant entrypoint" → reword as a design decision).

### Fix 6: `THIN_INIT_SHUTDOWN_GRACE_MS=0` reintroduces immediate-exit/SIGKILL
- **Source:** architecture-agent (AR3)
- **File:** `main-thin-init.ts:59-64`, `.env.example`
- **Fix:** Document the consequence of grace=0 (immediate exit → SIGKILLs draining workers) in the parse comment + `.env.example`. Keep 0 a valid deliberate choice (parse-don't-validate; the default 10s is safe).

### Fix 7: doc polish
- **Source:** architecture-agent (AR1/AR4/AR5)
- **Fix:** Comment the benign supervisor double-signal (explicit kill + broadcast overlap); cross-reference the mirrored `terminating`/`terminated` flags; clarify the Dockerfile HEALTHCHECK now probes the supervisor's unauthenticated `/health`.

## Not Fixed (noted acceptable by the analysts)
- TD2/TD3 (typestate for `terminating`/`currentPid`) — runtime-guarded; idempotency latched by `createShutdownHandler`.
- TD5 (`parseIntEnv` bare numbers), TD6 (`decidePostLoopExit` boolean input), T6 (`buildEnv` filter test) — minor, low risk.
- AR2 (broadcast races the reaper) — ESRCH-swallowed and safe; no change.
- code-reviewer: 0 findings (clean).

## Validation Commands
```bash
cd packages/host && bunx tsc --noEmit
cd packages/host && bun test
```
