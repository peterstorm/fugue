/**
 * @fuguejs/host — thin-init binary entry point (multi-tenant single-host, AD-2).
 *
 * The PID-1 of the multi-tenant pod. Spawns + supervises the supervisor binary
 * (`main-supervisor.ts`), restarting it across crashes within a crash-loop budget
 * WITHOUT killing the per-tenant workers: when the supervisor exits, its worker
 * children re-parent to THIS process (PID 1) and keep serving; the replacement
 * supervisor re-adopts them from the Redis registry (`reconcileReadopt`, SC-006).
 * Re-parented workers that exit are reaped here so the pod never leaks zombies. See
 * `supervisor/lifecycle/thin-init.ts` for the topology rationale + pure restart
 * policy, and `bun-init-process-adapter.ts` for the spawn/reap OS seam.
 *
 * Deliberately MINIMAL: it does NOT `parseHostConfig` (that is the supervisor's
 * job). A PID 1 must be ROBUST, so it reads only its own three knobs from env with
 * safe validated defaults and otherwise just keeps the supervisor up. All
 * tenant/Redis/auth config is the supervisor's concern, validated THERE
 * (fail-closed) — a bad value must not crash-loop PID 1.
 *
 * @satisfies AD-2  — production PID-1 that survives supervisor restarts.
 * @satisfies FR-019/FR-020/FR-021, SC-006 — live workers persist + are re-adopted.
 */

import path from "node:path";
import { runThinInit } from "./supervisor/lifecycle/thin-init.js";
import type { ThinInitConfig, InitProcessPort } from "./supervisor/lifecycle/thin-init.js";
import { createBunInitProcessAdapter } from "./supervisor/lifecycle/bun-init-process-adapter.js";
import type { LogPort } from "./ports.js";

// ── Logger (mirrors main-supervisor.ts) ─────────────────────────────────────────

const safeStringify = (obj: unknown): string => {
  try { return JSON.stringify(obj); } catch { return `[unserializable: ${typeof obj}]`; }
};

const createLogger = (): LogPort => ({
  info: (msg, data) => console.info(safeStringify({ level: "info", msg, ...data, ts: new Date().toISOString() })),
  warn: (msg, data) => console.warn(safeStringify({ level: "warn", msg, ...data, ts: new Date().toISOString() })),
  error: (msg, data) => console.error(safeStringify({ level: "error", msg, ...data, ts: new Date().toISOString() })),
});

// ── Pure: env → config (testable without a process) ─────────────────────────────

interface ThinInitEnvConfig extends ThinInitConfig {
  /** Bounded grace (ms) after forwarding SIGTERM before PID 1 exits the pod. */
  readonly shutdownGraceMs: number;
}

const parseIntEnv = (raw: string | undefined, fallback: number, min: number): number => {
  // An unset OR empty/whitespace-only var → the default. `Number("")` and
  // `Number("   ")` are BOTH 0, which would otherwise pass `>= min 0` and silently
  // yield 0 (e.g. THIN_INIT_SHUTDOWN_GRACE_MS="" → a 0ms drain window instead of
  // the 10s default) — an empty env var is common in k8s/compose and must mean
  // "use the default", not "0".
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
};

/**
 * PURE: read thin-init's knobs from env with safe, validated defaults. An invalid
 * value falls back to the default (PID 1 never refuses to start over a typo).
 *   - THIN_INIT_MAX_SUPERVISOR_RESTARTS      (default 5, min 1)
 *   - THIN_INIT_SUPERVISOR_RESTART_WINDOW_MS (default 60_000, min 1000)
 *   - THIN_INIT_SHUTDOWN_GRACE_MS            (default 10_000, min 0)
 *
 * `min 0` for the grace is deliberate: 0 is a VALID (if rarely wanted) choice
 * meaning "exit the pod immediately on SIGTERM". The CONSEQUENCE is that draining
 * workers are hard-SIGKILLed by PID-namespace teardown with no drain window — so
 * leave it at the safe 10s default unless you explicitly want fast, ungraceful
 * pod exit. (This is config, not the old unref'd-timer BUG, which exited
 * immediately regardless of the configured grace.)
 */
export const parseThinInitEnv = (env: Readonly<Record<string, string | undefined>>): ThinInitEnvConfig => ({
  maxRestartsPerWindow: parseIntEnv(env.THIN_INIT_MAX_SUPERVISOR_RESTARTS, 5, 1),
  windowMs: parseIntEnv(env.THIN_INIT_SUPERVISOR_RESTART_WINDOW_MS, 60_000, 1000),
  shutdownGraceMs: parseIntEnv(env.THIN_INIT_SHUTDOWN_GRACE_MS, 10_000, 0),
});

/**
 * PURE: how PID 1 ends once the supervise loop RETURNS. The loop returns only on
 * crash-loop give-up — but a pod SIGTERM can drive that give-up (the shutdown
 * signal kills the live supervisor at the instant the budget is exhausted). In that
 * case we must NOT exit immediately: the shutdown handler already armed the grace
 * timer + broadcast SIGTERM to the workers, and exiting now would tear down the PID
 * namespace and SIGKILL those workers mid-drain (the exact failure the grace window
 * exists to prevent). So during shutdown, DEFER to the grace timer's own exit(0);
 * otherwise it is a genuine crash-loop give-up → exit non-zero for orchestrator backoff.
 */
export const decidePostLoopExit = (terminated: boolean): "defer-to-grace-timer" | "crash-loop-exit" =>
  terminated ? "defer-to-grace-timer" : "crash-loop-exit";

// ── Shutdown handler (testable: injected exit + grace-timer seams) ───────────────

interface ShutdownDeps {
  /** Forward shutdown to the supervisor + workers and park the supervise loop. */
  readonly beginTermination: (sig: "SIGTERM" | "SIGINT") => void;
  readonly graceMs: number;
  readonly logger: LogPort;
  /** Injected for tests; production passes `process.exit`. */
  readonly exit: (code: number) => void;
  /** Injected for tests; production passes a NON-unref'd `setTimeout`. */
  readonly setGraceTimer: (fn: () => void, ms: number) => void;
}

interface ShutdownHandler {
  readonly onSignal: (sig: "SIGTERM" | "SIGINT") => void;
  readonly isTerminated: () => boolean;
}

/**
 * Build the idempotent pod-shutdown handler. On the FIRST signal it forwards
 * shutdown to the supervisor + workers (`beginTermination`) and schedules a hard
 * `exit(0)` after the grace window. Repeated signals are no-ops — a second SIGTERM
 * must NOT re-arm the grace timer. Factored out with injected `exit`/`setGraceTimer`
 * seams so the grace sequencing is unit-tested (the exact path a missing test let
 * regress: an unref'd grace timer let PID 1 exit immediately, SIGKILLing workers).
 */
export const createShutdownHandler = (deps: ShutdownDeps): ShutdownHandler => {
  // `terminated` here and the adapter's `terminating` flag model the SAME fact
  // ("the pod is shutting down"); they are intentionally separate so each layer is
  // independently testable (the handler owns idempotency; the adapter owns parking
  // `spawnSupervisor`) and are set together via `beginTermination`. Keep them in sync.
  let terminated = false;
  return {
    onSignal: (sig) => {
      if (terminated) return;
      terminated = true;
      deps.logger.warn("[thin-init] shutdown signal received — draining supervisor + workers, exiting pod", {
        sig,
        graceMs: deps.graceMs,
      });
      deps.beginTermination(sig);
      deps.setGraceTimer(() => deps.exit(0), deps.graceMs);
    },
    isTerminated: () => terminated,
  };
};

// ── Last-resort PID-1 error nets (testable: no exit seam ⇒ cannot exit) ───────────

interface GlobalErrorHandlers {
  readonly onUncaughtException: (e: unknown) => void;
  readonly onUnhandledRejection: (reason: unknown) => void;
}

/**
 * Build PID 1's last-resort error handlers. A stray throw in a signal handler /
 * timer callback (i.e. OUTSIDE the awaited startup chain `main().catch` already
 * covers) would otherwise CRASH PID 1 and take the whole pod down. These LOG the
 * fault with full context and KEEP SUPERVISING — the supervise loop + grace timer
 * carry on. This is an INTENTIONAL survive, not a swallow: the error is logged at
 * `error` so it stays diagnosable. Crucially they have NO exit seam, so "PID 1
 * stays up on a stray async fault" is a STRUCTURAL property (the handler cannot
 * exit), not a comment — and it is unit-tested as such. (The reaper is already
 * throw-safe via `drainReap`; this covers everything else.)
 */
export const createGlobalErrorHandlers = (logger: LogPort): GlobalErrorHandlers => ({
  onUncaughtException: (e) =>
    logger.error("[thin-init] uncaught exception (PID 1 surviving — pod stays up)", {
      error: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    }),
  onUnhandledRejection: (reason) =>
    logger.error("[thin-init] unhandled rejection (PID 1 surviving — pod stays up)", {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    }),
});

// ── PID-1 zombie reaper (PROCESS lifetime — never uninstalled) ────────────────────

/**
 * Install the always-on SIGCHLD zombie-reaper for the WHOLE process lifetime and
 * deliberately DISCARD the uninstaller. The reaper MUST outlive the supervise loop:
 *   - while the loop is PARKED on shutdown (terminating) it never iterates, so its
 *     per-iteration boundary reap never runs; and
 *   - on a shutdown-driven give-up the loop RETURNS but PID 1 lives on through the
 *     grace window (`decidePostLoopExit` defers to the grace timer) while the workers
 *     it just broadcast SIGTERM to drain and exit.
 * In both windows a re-parented worker that exits would become a zombie with NO reaper
 * if teardown were loop-scoped (a zombie still answers `kill(pid,0)` → reads as ALIVE).
 * Owning it here — like `createGlobalErrorHandlers` — makes "PID 1 always reaps, start
 * to exit" a STRUCTURAL property, not the loop's concern; `runThinInit` only does the
 * prompt boundary reaps, this is the continuous one. No exit/teardown seam by design.
 */
export const installProcessLifetimeReaper = (
  proc: Pick<InitProcessPort, "onSigchld" | "reapZombies">,
): void => {
  // Discard the uninstaller on purpose: this handler lives until `process.exit`.
  proc.onSigchld(() => proc.reapZombies());
};

// ── Imperative shell: the binary ────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const logger = createLogger();

  // LAST-RESORT nets for PID 1 (see `createGlobalErrorHandlers`): a stray throw in a
  // signal handler / timer callback — OUTSIDE the awaited startup chain that
  // `main().catch` already covers — must NOT crash PID 1 and take the whole pod down.
  const errorHandlers = createGlobalErrorHandlers(logger);
  process.on("uncaughtException", errorHandlers.onUncaughtException);
  process.on("unhandledRejection", errorHandlers.onUnhandledRejection);

  const cfg = parseThinInitEnv(process.env);
  // The supervisor binary is a sibling of this file (src/ in dev, dist/ in build),
  // mirroring how main-supervisor resolves the worker entrypoint.
  const supervisorEntry = path.join(path.dirname(process.argv[1] ?? ""), "main-supervisor.ts");

  const adapter = createBunInitProcessAdapter({ supervisorEntry }, logger);

  // Install the always-on PID-1 zombie reaper for the PROCESS lifetime (never
  // uninstalled) BEFORE the supervise loop. It must keep reaping re-parented workers
  // that exit while the loop is parked on shutdown OR during the post-give-up grace
  // window — see `installProcessLifetimeReaper`. `runThinInit` itself only boundary-reaps.
  installProcessLifetimeReaper(adapter);

  // PID 1 does NOT receive default signal dispositions — without an explicit
  // handler, SIGTERM is IGNORED and the pod never terminates gracefully (k8s then
  // SIGKILLs after the grace period). Forward shutdown to the supervisor + workers
  // (beginTermination), stop respawning, and exit the pod after a bounded grace.
  const shutdown = createShutdownHandler({
    beginTermination: (sig) => adapter.beginTermination(sig),
    graceMs: cfg.shutdownGraceMs,
    logger,
    exit: (code) => process.exit(code),
    // The grace timer is the ONE timer that MUST keep PID 1 alive through the
    // shutdown window — do NOT unref it. When the supervise loop parks on a
    // never-resolving promise (terminating), an unref'd timer would let Bun exit
    // IMMEDIATELY, tearing down the namespace and SIGKILLing the very workers the
    // grace window exists to drain.
    setGraceTimer: (fn, ms) => {
      setTimeout(fn, ms);
    },
  });
  process.on("SIGTERM", () => shutdown.onSignal("SIGTERM"));
  process.on("SIGINT", () => shutdown.onSignal("SIGINT"));

  logger.info("[thin-init] starting (PID 1)", {
    pid: process.pid,
    supervisorEntry,
    maxRestartsPerWindow: cfg.maxRestartsPerWindow,
    windowMs: cfg.windowMs,
  });

  const result = await runThinInit(
    adapter,
    { maxRestartsPerWindow: cfg.maxRestartsPerWindow, windowMs: cfg.windowMs },
    () => Date.now(),
    logger,
  );

  if (decidePostLoopExit(shutdown.isTerminated()) === "defer-to-grace-timer") {
    // Shutdown already armed the (non-unref'd) grace timer AND broadcast SIGTERM to
    // the workers; the loop also returning here (give-up driven by the shutdown
    // signal) must NOT short-circuit that. Return and let the grace timer's exit(0)
    // end the pod after the worker-drain window — exiting now would SIGKILL the
    // workers we just signalled, mid-drain.
    logger.info("[thin-init] supervise loop ended during shutdown — deferring to the grace timer for a clean drain+exit");
    return;
  }

  // The loop returned because the crash-loop budget was exhausted (give-up). Exit
  // non-zero so the orchestrator (k8s) recreates the pod with backoff.
  logger.error("[thin-init] exiting after supervisor crash-loop budget exhausted", { stoppedReason: result.stoppedReason });
  process.exit(1);
};

// Execute main only when this file is the process entrypoint (mirrors
// worker-main.ts) — never when a test imports the pure `parseThinInitEnv`.
const invokedScript = process.argv[1] ?? "";
if (invokedScript.endsWith("main-thin-init.ts") || invokedScript.endsWith("main-thin-init.js")) {
  main().catch((e) => {
    console.error("Fatal error during thin-init startup:", e);
    process.exit(1);
  });
}
