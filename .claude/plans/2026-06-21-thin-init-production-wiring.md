# Thin-init production wiring — multi-tenant pod is now deployable

**Date:** 2026-06-21
**Branch:** feat/multi-tenant-single-host (PR #27)
**Context:** Resolves the CRITICAL deferred in pass-11 (`2026-06-20-pr-remediation-pass11.md`):
the multi-tenant topology had no production composition root — `runThinInit` + the
supervisor binary existed but nothing ran them; `bin`/Dockerfile ran single-tenant
`main.ts`. This builds the real PID-1 binary and, in doing so, fixes a chain of
deployment bugs the wiring surfaced (all masked because every test injected a fake probe).

## What was built

- **`src/supervisor/lifecycle/bun-init-process-adapter.ts`** — the real `InitProcessPort`:
  `Bun.spawn` the supervisor + a `bun:ffi` `waitpid(-1, WNOHANG)` reaper for re-parented
  orphan workers, SIGCHLD + safety-net interval, `beginTermination` (signals supervisor +
  broadcasts SIGTERM to workers when `pid===1`). `resolveReaper` takes an injectable loader
  (testable fail-fast); `libcCandidates` covers glibc/musl/darwin.
- **`src/main-thin-init.ts`** — the PID-1 binary: minimal (no `parseHostConfig`), fail-safe
  env parsing, testable `createShutdownHandler` + pure `decidePostLoopExit`.
- **Dockerfile `CMD`** → thin-init (multi-tenant default); **`package.json` `bin`** adds
  `fugue-supervisor`; single-tenant `main.ts` remains supported (FR-035).
- **`.env.example`** documents `THIN_INIT_*`.

## Empirical validation (not assumed)

Spiked on a real PID namespace (`unshare -rpf --mount-proc`) + the `oven/bun:1.2-alpine` image:
- Bun does NOT auto-reap re-parented orphans → FFI `waitpid` reaps them (zero zombies).
- The reaper does NOT steal the supervisor's `proc.exited` (pidfd) → restart loop never hangs.
- `dlopen("libc.so.6")` resolves on glibc AND the alpine image.
- The real `thin-init → main-supervisor` chain boots as PID 1, restarts within budget, exits non-zero on give-up.
- Worker-broadcast harness: 3 workers catch SIGTERM and drain (`codes [0,0,0]`).

## Bugs found by adversarial review (2 rounds) and fixed

Round 1 (6 confirmed critical) — all pre-existing-but-latent, activated by wiring the topology:
1. **Grace timer `unref`'d** → PID 1 exited immediately on SIGTERM, SIGKILLing workers. (removed unref; extracted testable `createShutdownHandler`)
2. **UDS probe GET `/healthz`** but worker serves `/health` → every worker probed dead → 503. (→ `/health`)
3. **UDS probe unsigned** → worker rejects 401 under HMAC → every worker dead. (sign `X-Fugue-Tenant`; new `buildProbeRequest`)
4. **Supervisor had no `/health`** → Docker HEALTHCHECK always 401 → container permanently unhealthy. (unauthenticated `/health`+`/readiness` before auth)
5. **Workers never got SIGTERM on pod shutdown** (supervisor doesn't propagate, AD-2) → hard-SIGKILLed. (`beginTermination` broadcast, `pid===1`-guarded)
6. **Reaping proof + resolveReaper throw path testability.** (injectable loader, strengthened tests)

Round 2 (1 confirmed advisory): **give-up-during-shutdown** could exit before the grace
window → SIGKILL workers mid-drain. (`decidePostLoopExit` defers to the grace timer)

Dismissed (verified non-issues): double-SIGTERM to a draining worker (`drain()` has no prod
callers; evict/idle SIGTERM+SIGKILL anyway); supervisor double-signal (idempotent); harness
child-vs-grandchild fidelity (broadcast hits all pids); bin-name cosmetics.

## Validation
- `bun run typecheck` — clean.
- 650 unit tests pass (incl. PID-namespace reaping + worker-broadcast e2e, gated on `unshare`).
- Real boot chain smoke confirmed.
