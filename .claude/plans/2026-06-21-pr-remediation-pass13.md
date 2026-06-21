# PR Remediation Plan — Pass 13 (thin-init wiring delta)

**Date:** 2026-06-21
**Branch:** feat/multi-tenant-single-host
**PR:** #27
**Scope:** delta since pass 11 (`0fce2a3..HEAD`) — thin-init production wiring, 16 files / 1419 insertions
**Findings:** 1 critical (by impact), 4 advisory worth fixing; 3 advisory deliberate-by-design (left as-is)

## Review cohort

6-agent parallel review (code-reviewer, silent-failure-hunter, pr-test-analyzer,
type-design-analyzer, comment-analyzer, architecture-tech-lead), each briefed on
the codebase's deliberate defensive patterns (never-throw, fail-closed, ADTs,
idempotency, FC/IS) to avoid the false-positive cycles of prior passes.

All six reported **0 hard-CRITICAL**. comment-analyzer was fully clean (0/0).
One silent-failure-hunter finding is rated HIGH by impact (labeled "advisory"
only because it fails loudly, not silently) — escalated to CRITICAL here.

## Critical Fixes

### Fix 1: Unprotected `Bun.spawn` fork failure tears down all workers
- **Source:** silent-failure-hunter (HIGH impact)
- **File:** `packages/host/src/supervisor/lifecycle/bun-init-process-adapter.ts:268`
- **Issue:** `Bun.spawn` in `spawnSupervisor` is uncaught. A transient fork failure
  (EAGAIN/ENOMEM under memory pressure, EMFILE on fd exhaustion, ENOENT) throws
  synchronously → escapes the `runThinInit` supervise loop → `main().catch` →
  `process.exit(1)`. This bypasses BOTH the crash-loop budget (no retry of a
  self-healing blip) AND the grace-drain (no SIGTERM broadcast), so PID-namespace
  teardown SIGKILLs every live per-tenant worker mid-flight — defeating the exact
  AD-2/FR-019/FR-021 invariant thin-init exists to protect, at the worst moment
  (memory pressure is when fork failure is most likely).
- **Fix:** Wrap `Bun.spawn` in try/catch. On throw: reset `currentPid`, log at
  `error`, and `return { exited: Promise.resolve(-1) }` so the supervise loop
  treats it as a supervisor crash and `decideSupervisorRestart` applies the
  crash-loop budget (which exhausts fast on a persistent failure → clean pod exit
  → k8s backoff). Keeps the budget + grace machinery in control of every
  supervisor non-start, symmetric with `bun-spawn-adapter.ts`.
- **Test:** unit test driving an injected spawn-throw → asserts a `-1` synthetic
  exit and that `currentPid` is cleared (no stray signal target).

## Advisory Fixes

### Fix 2: `parseIntEnv` coerces empty string to 0
- **Source:** code-reviewer
- **File:** `packages/host/src/main-thin-init.ts:48`
- **Issue:** `Number("") === 0` passes `>= min 0`, so `THIN_INIT_SHUTDOWN_GRACE_MS=""`
  yields a 0ms grace instead of the 10s default — an empty env var (common in
  k8s/compose) silently disables the worker-drain window.
- **Fix:** treat empty/whitespace-only `raw` as `undefined` (fall back to default).

### Fix 3: `/readiness` 503 branch untested through real `handle`
- **Source:** pr-test-analyzer
- **File:** `packages/host/src/supervisor/supervisor.ts:248` (test in supervisor.test.ts)
- **Issue:** the 503 branch is covered only via the pure `buildReadinessResponse`
  builder; the integration test through `createSupervisor().handle` only hits 200.
  A regression mis-wiring the 503 status into `handle` would slip.
- **Fix:** add an integration test that runs the real `shutdown()` (ready→draining
  →stopped) then asserts `handle(GET /readiness)` returns 503 with `ready:false`.

### Fix 4: PID-1 survive-don't-exit handlers asserted only by comment
- **Source:** pr-test-analyzer
- **File:** `packages/host/src/main-thin-init.ts:146`
- **Issue:** the `uncaughtException`/`unhandledRejection` "PID 1 survives" handlers
  encode a real behavioral claim but are inline in `main()` with no test.
- **Fix:** extract `createGlobalErrorHandlers(logger)` (no exit seam → structurally
  cannot exit), wire `process.on` to it, and unit-test that it logs at `error`
  (message + stack, Error and non-Error inputs).

### Fix 5: misleading bin name
- **Source:** code-reviewer
- **File:** `packages/host/package.json:12`
- **Issue:** bin `fugue-supervisor` points to `main-thin-init.ts` (the PID-1
  thin-init, not the supervisor) — confusing alongside `main-supervisor.ts`.
- **Fix:** rename bin to `fugue-thin-init`; update the one doc reference in
  `thin-init.ts`. (Dockerfile invokes the file path, so no deploy impact.)

## Not fixed — deliberate design (endorsed by reviewers)

- **Dual shutdown flag** (`terminating`/`terminated`): type-design + architecture
  both call it intentional and documented; "no change recommended."
- **Raw-number env knobs / pid** (no `Millis`/`Pid` brand): pre-existing house
  convention (`spawn-port.ts`); introducing a brand in one new file only would be
  inconsistent.
- **`broadcastSignalToWorkers` signal-broad + `selfPid===1` guard:** "sound as
  written" per type-design + architecture.

## Validation Commands
```bash
cd packages/host
bunx tsc --noEmit
bun test src/__tests__/supervisor/lifecycle/bun-init-process-adapter.test.ts \
         src/__tests__/supervisor/supervisor.test.ts \
         src/__tests__/supervisor/lifecycle/thin-init.test.ts
# plus any main-thin-init pure-config test file
```
