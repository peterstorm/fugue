# PR Remediation Plan — Pass 14 (thin-init delta)

**Date:** 2026-06-21
**Branch:** feat/multi-tenant-single-host
**Scope:** thin-init production-wiring delta (`6aa0970^..HEAD`, 17 files / 1703 insertions)
**Findings:** 1 critical, 9 advisory (across 6 review agents)

Review cohort (6 agents): code-reviewer, silent-failure-hunter, pr-test-analyzer,
type-design-analyzer, comment-analyzer, architecture-tech-lead.
code-reviewer + comment-analyzer came back clean (0/0 actionable).

## Critical Fixes

### Fix 1: Zombie-reaper torn down during the shutdown grace window
- **Source:** architecture-tech-lead (CRITICAL)
- **File:** `src/supervisor/lifecycle/thin-init.ts:150,185-187` + `src/main-thin-init.ts`
- **Issue:** `runThinInit` owns the SIGCHLD reaper lifecycle: it installs in the body
  and `finally { uninstall() }`s on return. In the **shutdown-driven give-up** race
  (a pod SIGTERM drives the crash-loop budget to give-up on the same iteration), the
  loop RETURNS, `finally` tears down the reaper + safety-net interval, and then
  `decidePostLoopExit(true) === "defer-to-grace-timer"` makes `main()` return WITHOUT
  exiting — deferring to the grace timer. During that grace window (≤ `shutdownGraceMs`,
  default 10s) the per-tenant workers that received the SIGTERM broadcast drain, exit,
  re-parent to PID 1 — and NOTHING reaps them. They accumulate as zombies until the
  grace timer's `exit(0)`. Bounded + self-heals at namespace teardown, but it is a
  reap gap in the exact path (graceful shutdown) the whole grace mechanism exists to
  keep clean, and a zombie still answers `kill(pid,0)` → reads as ALIVE to any observer.
- **Fix:** Make the reaper a PROCESS-LIFETIME concern owned by the binary (matching
  how `createGlobalErrorHandlers` is already a process-lifetime concern in `main()`):
  - `thin-init.ts`: remove the `onSigchld` install + `try/finally { uninstall() }` from
    `runThinInit`; keep the per-iteration boundary `reapZombies()`. The loop becomes
    purely spawn/await/reap-on-iteration/apply-policy.
  - `main-thin-init.ts`: add an exported, testable `installProcessLifetimeReaper(proc)`
    that installs the always-on SIGCHLD reaper and deliberately DISCARDS the uninstaller
    (never torn down → survives the parked loop AND the post-give-up grace window).
    Call it in `main()` before `runThinInit`.
  - `init-reap-harness.ts`: install the same always-on reaper before `runThinInit` so
    the real-PID-namespace harness stays faithful to production (still proves the
    SIGCHLD-driven reap, not only the explicit final reap).

## Advisory Fixes (applied)

### Fix 2: `parseIntEnv` non-integer branch untested
- **Source:** pr-test-analyzer (ADVISORY 1)
- **File:** `src/__tests__/.../bun-init-process-adapter.test.ts` (parseThinInitEnv describe)
- **Fix:** add a case asserting a finite-but-non-integer value (`"3.5"`) takes the
  `Number.isInteger` rejection branch and falls back to the default (guards against a
  future `parseInt`-style truncation regression).

### Fix 3: `decideSupervisorRestart` exact window-edge untested
- **Source:** pr-test-analyzer (ADVISORY 3)
- **File:** `src/__tests__/.../thin-init.test.ts` (decideSupervisorRestart describe)
- **Fix:** add a case at the exact `now - windowStartedAt === windowMs` boundary (the
  `>=` edge) asserting a window reset (restart, counter→1, windowStartedAt advances).

### Fix 4: SIGCHLD *signal*-driven reap asserted only via the interval
- **Source:** pr-test-analyzer (ADVISORY 2)
- **File:** `src/__tests__/.../bun-init-process-adapter.test.ts` (real-adapter describe)
- **Fix:** add an in-process test that delivers a real `SIGCHLD` (interval disabled via
  a huge `reapIntervalMs`) and asserts the handler ran — isolating the signal path the
  skippable namespace harness otherwise covers.

### Fix 5: contract test for the relocated reaper
- **File:** `src/__tests__/.../thin-init.test.ts` (runThinInit describe) +
  `bun-init-process-adapter.test.ts`
- **Fix:** replace the now-obsolete "runThinInit installs and uninstalls a SIGCHLD
  handler" test with one pinning the NEW contract (runThinInit does NOT touch
  `onSigchld`; reaper is the binary's concern), and add a direct test for
  `installProcessLifetimeReaper` (installs a reaping handler; never uninstalls).

## Considered, deferred (with rationale)

- **type-design ADVISORY 1 — `RestartBudget` invariant (`restartsInWindow ≤ max`,
  positive bounds) in runtime logic + env-clamp, not the type.** Deferred: the boundary
  (`parseThinInitEnv`, min 1) already validates per parse-don't-validate; encoding a
  `PositiveInt` brand would break the deliberate `initialRestartBudget(0, …)` test idiom
  used to force immediate give-up, and the only misbehavior (one extra restart at
  max=0, unreachable in production) is benign.
- **type-design ADVISORY 2/3/4** (rename give-up `budget`; spawn-outcome ADT vs synthetic
  `-1`; `decidePostLoopExit` via `.exhaustive()`): cosmetic / inert today / over-weight
  for a 2-variant terminal union. No current defect.
- **silent-failure ADVISORY — `loadWaitpidReaper` discards per-candidate dlopen error.**
  Deferred: pure observability on an already-loud fail-fast path (`resolveReaper` throws
  naming every tried candidate). The hunter rated it defensible as-is.
- **comment-analyzer ADVISORY 1/2** (inline `(file.ts)` cross-refs can rot; musl leg
  validated by candidate-list + CI image): both "no change required" per the analyst.

## Validation Commands
```bash
cd packages/host
bun run typecheck
bun test src/__tests__/supervisor/lifecycle/thin-init.test.ts \
         src/__tests__/supervisor/lifecycle/bun-init-process-adapter.test.ts
```
