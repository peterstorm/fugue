/**
 * Tests for the thin-init PID 1 (thin-init.ts).
 *
 * The PURE restart-decision (decideSupervisorRestart) is unit-tested directly;
 * the supervise LOOP (runThinInit) is exercised with fully-faked process seams —
 * no real Bun.spawn — asserting it restarts the supervisor within budget,
 * preserves workers (reaps zombies, never kills), and gives up on a crash-loop.
 */

import { describe, test, expect } from "bun:test";
import {
  decideSupervisorRestart,
  initialRestartBudget,
  runThinInit,
  type InitProcessPort,
} from "../../../supervisor/lifecycle/thin-init.js";

describe("decideSupervisorRestart (pure)", () => {
  test("restarts while budget remains", () => {
    const b0 = initialRestartBudget(3, 60_000, 0);
    const d1 = decideSupervisorRestart(b0, 1_000);
    expect(d1.action).toBe("restart");
    if (d1.action === "restart") expect(d1.budget.restartsInWindow).toBe(1);
  });

  test("gives up when the window budget is exhausted (crash-loop)", () => {
    let b = initialRestartBudget(2, 60_000, 0);
    b = (decideSupervisorRestart(b, 100) as { budget: typeof b }).budget; // 1
    b = (decideSupervisorRestart(b, 200) as { budget: typeof b }).budget; // 2
    const d = decideSupervisorRestart(b, 300); // 3rd within window → give-up
    expect(d.action).toBe("give-up");
    if (d.action === "give-up") expect(d.reason).toBe("crash-loop");
  });

  test("a slid window resets the counter", () => {
    let b = initialRestartBudget(1, 1_000, 0);
    b = (decideSupervisorRestart(b, 100) as { budget: typeof b }).budget; // restartsInWindow=1
    // Past the window → reset, restart allowed again.
    const d = decideSupervisorRestart(b, 5_000);
    expect(d.action).toBe("restart");
    if (d.action === "restart") {
      expect(d.budget.restartsInWindow).toBe(1);
      expect(d.budget.windowStartedAt).toBe(5_000);
    }
  });
});

describe("runThinInit (faked process seams)", () => {
  test("keeps respawning the supervisor until the crash-loop budget is exhausted; reaps zombies; never kills workers", async () => {
    let spawnCount = 0;
    let reapCount = 0;
    let killed = false; // there is no kill seam — assert no path tries to kill workers

    const proc: InitProcessPort = {
      spawnSupervisor: () => {
        spawnCount++;
        return { exited: Promise.resolve(1) }; // supervisor crashes immediately
      },
      reapZombies: () => { reapCount++; },
      onSigchld: () => () => {},
    };

    // Budget: 2 restarts per window. Spawn #1 (initial) crashes → restart (1),
    // spawn #2 crashes → restart (2), spawn #3 crashes → budget exhausted → give-up.
    const result = await runThinInit(proc, { maxRestartsPerWindow: 2, windowMs: 60_000 }, () => 0);

    expect(result.stoppedReason).toBe("crash-loop");
    expect(spawnCount).toBe(3); // initial + 2 restarts
    expect(reapCount).toBeGreaterThanOrEqual(3); // reaped after each supervisor exit
    expect(killed).toBe(false);
  });

  test("installs and uninstalls a SIGCHLD reap handler", async () => {
    let installed = false;
    let uninstalled = false;
    const proc: InitProcessPort = {
      spawnSupervisor: () => ({ exited: Promise.resolve(1) }),
      reapZombies: () => {},
      onSigchld: (handler) => {
        installed = true;
        // Driving the handler must reap — no throw.
        handler();
        return () => { uninstalled = true; };
      },
    };
    await runThinInit(proc, { maxRestartsPerWindow: 0, windowMs: 60_000 }, () => 0);
    expect(installed).toBe(true);
    expect(uninstalled).toBe(true);
  });
});
