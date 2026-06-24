# PR Remediation Plan — Pass 11

**Date:** 2026-06-20
**Branch:** feat/multi-tenant-single-host (PR #27)
**Scope:** full branch diff vs `main` (179 files, ~33.8k insertions)
**Findings:** 1 critical, 5 advisory (after dedup across 6 review agents)

Review cohort (all 6): code-reviewer (0/0), silent-failure-hunter (0/1),
pr-test-analyzer (0/1), type-design-analyzer (0/0), comment-analyzer (0/2),
architecture-tech-lead (1/1). Typecheck was already green per code-reviewer.

---

## Critical

### Fix 1 (DEFERRED): Multi-tenant topology has no production composition root
- **Source:** architecture-tech-lead
- **File:** `supervisor/lifecycle/thin-init.ts`, `main-supervisor.ts`, `packages/host/package.json` (`bin`), `packages/host/Dockerfile` (`CMD`)
- **Issue:** `runThinInit` (PID-1 supervise loop) and `main-supervisor.ts` (supervisor
  binary) are fully implemented and fake-tested, but there is **no production
  `InitProcessPort` adapter and no binary that calls `runThinInit`**. `bin` and the
  Dockerfile `CMD` still run the single-tenant `main.ts`. So the AD-2 property
  ("supervisor restarts WITHOUT killing workers", FR-019/020/021, SC-006) is verified
  only against fakes, never end-to-end, and the multi-tenant pod is not deployable.
- **Decision: DEFER the build; document the gap explicitly.**
  - Building a real PID-1 thin-init binary + `Bun.spawn`-backed `InitProcessPort`
    (orphan re-parenting + SIGCHLD reaping) is a feature, not a minimal review-fix,
    and is **not validatable in this environment** — it needs a real multi-process
    pod. Shipping an unverified PID-1 reaper is worse than an explicit gap (zombie
    leak / worker-kill risk), and `main-supervisor.ts:440` already fails-closed
    *assuming* a thin-init parent that does not yet exist.
  - The repo's established pattern for not-yet-live seams is to ship them **explicitly
    unwired** (`unwired-token-endpoint.ts`, `unwired-entra-wif.ts`, host.ts "not
    wired" warnings). The architecture agent's own fallback recommendation was: "add
    a tracking note so the gap is explicit." That is the verifiable deliverable.
- **Fix applied:** DEPLOYMENT-STATUS note in `thin-init.ts` header (with the exact
  required shape of the follow-up binary) + a pointer in `Dockerfile` near `CMD`.
- **Follow-up (out of this pass):** add `src/main-thin-init.ts` constructing a real
  `InitProcessPort` (`spawnSupervisor` → `Bun.spawn(["bun","run","main-supervisor.ts"])`;
  `onSigchld`/`reapZombies` via a SIGCHLD reap loop), call `runThinInit`, and repoint
  the multi-tenant Dockerfile/`bin` at it. Validate against a real pod (kill the
  supervisor; assert workers survive and are re-adopted).

---

## Advisory Fixes

### Fix 2: Silent prune failure in `countActiveRuns` self-heal
- **Source:** silent-failure-hunter
- **File:** `hitl/adapters/run-store.ts:285,295`
- **Issue:** The self-heal `sRem` prune discards its `Result` with no log — the only
  swallowed best-effort path in the PR. A persistently-failing prune silently inflates
  the active-run count toward `maxQueuedRuns` and 429s legitimate `startRun` calls with
  no diagnostic trail.
- **Fix:** bind the result and `logger?.warn?.()` on `!pruned.ok` (logger already in
  closure scope; passed from `host.ts:565`).

### Fix 3: `SUPERVISOR_MAX_LIVE_WORKERS` doc claims LRU eviction that doesn't exist
- **Source:** comment-analyzer
- **File:** `domain/config.ts:488-490`
- **Issue:** Doc says the supervisor "evicts an idle worker before admitting a new
  tenant (LRU)" at the cap. Verified false: `worker-lifecycle-manager.ts:297-299`
  REFUSES with `worker-unavailable` (503) at the cap; idle eviction is a separate TTL
  sweep, not LRU-on-cap.
- **Fix:** reword to describe refuse-at-cap + separate TTL idle-evict.

### Fix 4: `onRedisProbeEdge` doc says "503" but admission maps to 404
- **Source:** comment-analyzer
- **File:** `supervisor/supervisor.ts:176`
- **Issue:** Doc says new-run admission "fails closed (503)" while degraded, but
  `main-supervisor.ts:290-291` collapses `resolveForNewRun`'s error to
  `{ kind: "unknown" }` → `tenant-unknown` → 404 (matching sibling comments at lines
  24/288/310 and main-supervisor.ts:597).
- **Fix:** change "(503)" to "(→ tenant-unknown, 404)".

### Fix 5: Bot-side transient (queued/running) branch untested
- **Source:** pr-test-analyzer
- **File:** `hitl/adapters/bot/messages-handler.ts:259-261` (test added to bot.test.ts)
- **Issue:** The bot-side lost-wakeup window (authorized click lands while status is
  still `queued`/`running`) returns "still being prepared" and renders NO resolved
  card — but no test exercises it; all resolved-card tests use `completed`/moved-on.
- **Fix:** add a test asserting the message-activity response (not an adaptive card)
  and that `recordDecision` is never called, for both `running` and `queued`.

### Fix 6: `startRun` queue-depth gate is a soft (non-atomic) ceiling
- **Source:** architecture-tech-lead
- **File:** `hitl/service.ts:93-106`
- **Issue:** `countActiveRuns()` then `create()` is a non-atomic check-then-act over a
  Redis SET; concurrent durable starts can transiently overshoot `maxQueuedRuns`.
- **Decision:** document the soft-ceiling semantics (the agent's recommended pragmatic
  option). An atomic `INCR`/`DECR` counter would introduce a new counter-vs-SET
  consistency invariant that can drift on crashes and would undermine the existing
  SET self-heal — worse than a small, bounded, self-healing overshoot on a
  single-threaded worker. The per-tenant ACL also forbids Lua (`eval`).
- **Fix:** add a SOFT-CEILING note to the admission comment in `startRun`.

---

## Validation Commands
```bash
cd packages/host && bun run typecheck
cd packages/host && bun test src/hitl/adapters/bot/__tests__/bot.test.ts src/hitl/__tests__ src/__tests__/domain/config.test.ts
```

## Deferred
- **Fix 1** — production thin-init binary + `InitProcessPort` adapter + Dockerfile/bin
  repoint. Reason: feature-scope + unverifiable without a real multi-process pod;
  documented as an explicit gap instead. See follow-up shape above.
