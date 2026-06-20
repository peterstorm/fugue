/**
 * thin-init — the minimal PID 1 for the single multi-tenant pod (AD-2).
 *
 * TOPOLOGY (why a separate init exists):
 *   In one pod we run: [thin-init (PID 1)] → spawns [supervisor] and [workers].
 *   The KEY property the spec demands (FR-019/FR-020, SC-006): the SUPERVISOR can
 *   restart WITHOUT killing the workers, so in-flight runs keep being served and
 *   the new supervisor RE-ADOPTS the still-live workers from the Redis registry.
 *
 *   In a naive single-process topology, workers would be children of the
 *   supervisor and would die (SIGHUP/orphan-reap) when the supervisor exits. The
 *   thin-init fixes this by being the long-lived PID 1 that:
 *     1. PARENTS the supervisor (spawns it, restarts it on ANY exit — clean exit
 *        and crash alike, subject to a crash-loop budget; see `decideSupervisorRestart`), and
 *     2. RE-PARENTS orphaned workers to itself — when the supervisor exits, the
 *        OS re-parents its worker children to PID 1 (standard Unix orphan
 *        re-parenting). Because thin-init is PID 1 and does NOT kill its inherited
 *        children on supervisor exit, the workers survive. The replacement
 *        supervisor re-adopts them via `reconcileReadopt` (worker-registry-redis).
 *     3. REAPS zombies — as PID 1 it must `wait()` on every re-parented child that
 *        exits, or the pod accumulates zombie PIDs. (In Bun, `proc.exited`
 *        resolution performs the reap for children we hold a handle to; for
 *        re-parented grandchildren we install a SIGCHLD-driven reap loop.)
 *
 * This module is deliberately MINIMAL: it owns process topology only, no business
 * logic. The PURE decision — "given the supervisor just exited with code C, should
 * I restart it, and have I exceeded the restart budget?" — is factored into
 * `decideSupervisorRestart` so it is unit-testable without spawning processes.
 *
 * @satisfies AD-2  — thin init is PID 1; supervisor restart does NOT kill workers.
 * @satisfies FR-019 — live workers continue serving across a supervisor restart.
 * @satisfies FR-021 — in-flight runs survive a supervisor restart (workers persist).
 */

import { match } from "ts-pattern";
import type { LogPort } from "../../ports.js";

// ── Pure: supervisor restart decision ──────────────────────────────────────────

/**
 * The crash-loop guard's state: how many times the supervisor has restarted
 * within the current window, and when the window opened. Immutable.
 */
export interface RestartBudget {
  readonly restartsInWindow: number;
  readonly windowStartedAt: number;
  readonly maxRestartsPerWindow: number;
  readonly windowMs: number;
}

export const initialRestartBudget = (
  maxRestartsPerWindow: number,
  windowMs: number,
  now: number,
): RestartBudget => ({
  restartsInWindow: 0,
  windowStartedAt: now,
  maxRestartsPerWindow,
  windowMs,
});

export type SupervisorRestartDecision =
  | { readonly action: "restart"; readonly budget: RestartBudget }
  | { readonly action: "give-up"; readonly reason: "crash-loop"; readonly budget: RestartBudget };

/**
 * PURE: decide whether to restart the supervisor after it exited, applying a
 * crash-loop budget. A clean exit (code 0) is treated the same as a crash for
 * restart purposes — PID 1's job is to keep the supervisor up (the pod is the
 * unit of liveness) — but the budget prevents a hot crash-loop from pinning the
 * CPU: if the window's restart budget is exhausted, return `give-up` so the pod
 * exits and the orchestrator (k8s) can recreate it with backoff.
 *
 * The window SLIDES: if `now` is past the current window, the counter resets.
 */
export const decideSupervisorRestart = (
  budget: RestartBudget,
  now: number,
): SupervisorRestartDecision => {
  // Window expired → reset the counter, this restart starts a fresh window.
  if (now - budget.windowStartedAt >= budget.windowMs) {
    return {
      action: "restart",
      budget: { ...budget, restartsInWindow: 1, windowStartedAt: now },
    };
  }
  // Within window: do we have budget left?
  if (budget.restartsInWindow >= budget.maxRestartsPerWindow) {
    return { action: "give-up", reason: "crash-loop", budget };
  }
  return {
    action: "restart",
    budget: { ...budget, restartsInWindow: budget.restartsInWindow + 1 },
  };
};

// ── Imperative shell: the init loop ────────────────────────────────────────────

/**
 * Injectable process seams so the init loop is testable without a real OS. The
 * production wiring binds these to `Bun.spawn` / signal handlers.
 */
export interface InitProcessPort {
  /** Spawn the supervisor process; resolves the exit code (null on signal) when it exits. */
  readonly spawnSupervisor: () => { readonly exited: Promise<number | null> };
  /**
   * Reap any re-parented zombie children (orphaned workers that have since
   * exited). PID 1 MUST call this on SIGCHLD so the pod never accumulates
   * zombies. No-op for children we already awaited.
   */
  readonly reapZombies: () => void;
  /** Install a SIGCHLD handler driving `reapZombies`. Returns an uninstaller. */
  readonly onSigchld: (handler: () => void) => () => void;
}

export interface ThinInitConfig {
  readonly maxRestartsPerWindow: number;
  readonly windowMs: number;
}

/**
 * Run the thin-init supervise loop: keep the supervisor alive across crashes
 * (within the crash-loop budget) while NEVER taking down the workers (they are
 * re-parented to this PID-1 process and reaped here, not killed). Resolves only
 * when the crash-loop budget is exhausted (caller then exits the pod).
 *
 * IMPERATIVE SHELL — all the restart POLICY is the pure `decideSupervisorRestart`
 * above; this function only spawns, waits, reaps, and applies the decision.
 */
export const runThinInit = async (
  proc: InitProcessPort,
  config: ThinInitConfig,
  now: () => number,
  logger?: LogPort,
): Promise<{ readonly stoppedReason: "crash-loop" }> => {
  const uninstall = proc.onSigchld(() => proc.reapZombies());
  let budget = initialRestartBudget(config.maxRestartsPerWindow, config.windowMs, now());

  try {
    // eslint-disable-next-line no-constant-condition
    for (;;) {
      const child = proc.spawnSupervisor();
      const code = await child.exited;
      // Reap any orphaned workers that exited while the supervisor was down. The
      // LIVE workers stay running and are re-adopted by the next supervisor.
      proc.reapZombies();

      const decision = decideSupervisorRestart(budget, now());
      budget = decision.budget;

      const stop = match(decision)
        .with({ action: "restart" }, (d) => {
          logger?.warn("[thin-init] supervisor exited; restarting (workers preserved)", {
            exitCode: code,
            restartsInWindow: d.budget.restartsInWindow,
          });
          return false;
        })
        .with({ action: "give-up" }, () => {
          logger?.error("[thin-init] supervisor crash-loop budget exhausted; exiting pod", {
            exitCode: code,
            maxRestartsPerWindow: config.maxRestartsPerWindow,
            windowMs: config.windowMs,
          });
          return true;
        })
        .exhaustive();

      if (stop) break;
    }
  } finally {
    uninstall();
  }

  return { stoppedReason: "crash-loop" };
};
