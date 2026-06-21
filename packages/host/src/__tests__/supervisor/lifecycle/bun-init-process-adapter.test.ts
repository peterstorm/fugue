/**
 * Tests for the production thin-init wiring (AD-2):
 *   - PURE helpers (`parseThinInitEnv`, `muslArchName`, `libcCandidates`) — always.
 *   - The REAL `createBunInitProcessAdapter` behavior (spawn → exit code,
 *     beginTermination forwards a signal, onSigchld install/uninstall) — always.
 *   - End-to-end PID-1 reaping under a real PID namespace via `init-reap-harness.ts`
 *     — gated on `unshare` (skipped where PID namespaces are unavailable, e.g. some
 *     CI sandboxes); the harness asserts zero zombies + a non-hanging restart loop.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  muslArchName,
  libcCandidates,
  resolveReaper,
  drainReap,
  broadcastSignalToWorkers,
  createBunInitProcessAdapter,
} from "../../../supervisor/lifecycle/bun-init-process-adapter.js";
import {
  parseThinInitEnv,
  createShutdownHandler,
  decidePostLoopExit,
  createGlobalErrorHandlers,
} from "../../../main-thin-init.js";
import { runThinInit } from "../../../supervisor/lifecycle/thin-init.js";
import type { LogPort } from "../../../ports.js";

const noopLogger: LogPort = { info: () => {}, warn: () => {}, error: () => {} };

/** A LogPort that records every call so tests can assert observability. */
interface CapturedLog {
  readonly level: "info" | "warn" | "error";
  readonly msg: string;
  readonly data?: Record<string, unknown>;
}
const capturingLogger = (): { logger: LogPort; logs: CapturedLog[] } => {
  const logs: CapturedLog[] = [];
  return {
    logs,
    logger: {
      info: (msg, data) => logs.push({ level: "info", msg, data }),
      warn: (msg, data) => logs.push({ level: "warn", msg, data }),
      error: (msg, data) => logs.push({ level: "error", msg, data }),
    },
  };
};

// ── Pure: parseThinInitEnv ──────────────────────────────────────────────────────

describe("parseThinInitEnv (pure)", () => {
  test("empty env → safe defaults", () => {
    expect(parseThinInitEnv({})).toEqual({ maxRestartsPerWindow: 5, windowMs: 60_000, shutdownGraceMs: 10_000 });
  });

  test("valid overrides are honoured", () => {
    const cfg = parseThinInitEnv({
      THIN_INIT_MAX_SUPERVISOR_RESTARTS: "3",
      THIN_INIT_SUPERVISOR_RESTART_WINDOW_MS: "30000",
      THIN_INIT_SHUTDOWN_GRACE_MS: "0",
    });
    expect(cfg).toEqual({ maxRestartsPerWindow: 3, windowMs: 30_000, shutdownGraceMs: 0 });
  });

  test("invalid / out-of-range values fall back to defaults (PID 1 never refuses to start over a typo)", () => {
    const cfg = parseThinInitEnv({
      THIN_INIT_MAX_SUPERVISOR_RESTARTS: "0", // below min 1
      THIN_INIT_SUPERVISOR_RESTART_WINDOW_MS: "500", // below min 1000
      THIN_INIT_SHUTDOWN_GRACE_MS: "abc", // not a number
    });
    expect(cfg).toEqual({ maxRestartsPerWindow: 5, windowMs: 60_000, shutdownGraceMs: 10_000 });
  });

  test("empty / whitespace-only values mean 'use the default', NOT 0 (Number('')===0 would otherwise disable the grace window)", () => {
    const cfg = parseThinInitEnv({
      THIN_INIT_MAX_SUPERVISOR_RESTARTS: "",
      THIN_INIT_SUPERVISOR_RESTART_WINDOW_MS: "   ",
      THIN_INIT_SHUTDOWN_GRACE_MS: "", // must NOT become a 0ms drain window
    });
    expect(cfg).toEqual({ maxRestartsPerWindow: 5, windowMs: 60_000, shutdownGraceMs: 10_000 });
  });
});

// ── Pure: libc resolution candidates ────────────────────────────────────────────

describe("libc resolution (pure)", () => {
  test("muslArchName maps Node arch tokens to musl arch tokens", () => {
    expect(muslArchName("arm64")).toBe("aarch64");
    expect(muslArchName("x64")).toBe("x86_64");
    expect(muslArchName("riscv64")).toBe("riscv64"); // pass-through for unknowns
  });

  test("linux candidates put glibc first then musl variants (covers debian + alpine)", () => {
    const c = libcCandidates("linux", "x64");
    expect(c[0]).toBe("libc.so.6");
    expect(c).toContain("libc.musl-x86_64.so.1");
    expect(c).toContain("/lib/ld-musl-x86_64.so.1");
  });

  test("darwin candidates use libSystem (keeps local bun test working on macOS)", () => {
    expect(libcCandidates("darwin", "arm64")).toEqual([
      "libSystem.B.dylib",
      "/usr/lib/libSystem.B.dylib",
      "libc.dylib",
    ]);
  });
});

// ── resolveReaper: candidate resolution + fail-fast (injected loader) ────────────

describe("resolveReaper (candidate resolution + fail-fast)", () => {
  test("returns the first candidate that yields a reaper, stopping early", () => {
    const tried: string[] = [];
    const reap = resolveReaper(["a", "b", "c"], (c) => {
      tried.push(c);
      return c === "b" ? () => {} : null;
    });
    expect(typeof reap).toBe("function");
    expect(tried).toEqual(["a", "b"]); // stopped at the first success
  });

  test("throws fail-fast naming the tried candidates when NONE provide waitpid", () => {
    expect(() => resolveReaper(["x.so", "y.so"], () => null)).toThrow(/could not load a libc.*x\.so, y\.so/s);
  });

  test("resolves a REAL waitpid on this platform — the FFI binding is live, not a stub", () => {
    const reap = resolveReaper(libcCandidates(process.platform, process.arch));
    expect(typeof reap).toBe("function");
    expect(() => reap()).not.toThrow(); // callable against the real libc
  });
});

// ── drainReap: multi-reap drain loop + throw-safety (no real PID namespace) ──────

describe("drainReap (pure drain loop)", () => {
  test("drains a burst of coalesced exits, stopping when waitpid reports nothing left (r=0)", () => {
    // r>0 reaped a pid; r===0 children exist but none exited → stop. 2 reaps + stop.
    const results = [10, 11, 0];
    let i = 0;
    let calls = 0;
    drainReap(() => {
      calls++;
      return results[i++] ?? 0;
    });
    expect(calls).toBe(3); // 10 → reap, 11 → reap, 0 → stop
  });

  test("stops immediately on ECHILD (r<0 — no children)", () => {
    let calls = 0;
    drainReap(() => {
      calls++;
      return -1;
    });
    expect(calls).toBe(1);
  });

  test("a throw from the FFI call is CAUGHT — never escapes into the SIGCHLD handler / interval (would kill PID 1)", () => {
    let calls = 0;
    expect(() =>
      drainReap(() => {
        calls++;
        throw new Error("simulated ffi marshalling fault");
      }),
    ).not.toThrow();
    expect(calls).toBe(1); // faulted once, then ended the cycle (no infinite loop)
  });
});

// ── broadcastSignalToWorkers: PID-1-only drain broadcast + observability ──────────

describe("broadcastSignalToWorkers (pod-shutdown worker drain)", () => {
  test("off PID 1 (selfPid !== 1) is a NO-OP — never enumerates or signals host processes", () => {
    let enumerated = false;
    const killed: number[] = [];
    const { logger, logs } = capturingLogger();
    broadcastSignalToWorkers("SIGTERM", {
      selfPid: 4242,
      enumerate: () => {
        enumerated = true;
        return [];
      },
      kill: (pid) => killed.push(pid),
      logger,
    });
    expect(enumerated).toBe(false);
    expect(killed).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("as PID 1: signals every numeric pid except self, skipping non-numeric entries, and logs a summary", () => {
    const killed: Array<{ pid: number; sig: string }> = [];
    const { logger, logs } = capturingLogger();
    broadcastSignalToWorkers("SIGTERM", {
      selfPid: 1,
      enumerate: () => ["1", "2", "3", "42", "cpuinfo", "self"],
      kill: (pid, sig) => killed.push({ pid, sig }),
      logger,
    });
    expect(killed).toEqual([
      { pid: 2, sig: "SIGTERM" },
      { pid: 3, sig: "SIGTERM" },
      { pid: 42, sig: "SIGTERM" },
    ]); // pid 1 (self) and non-numeric entries skipped
    const summary = logs.find((l) => l.level === "info");
    expect(summary?.data).toMatchObject({ sig: "SIGTERM", enumerated: 3, signalled: 3 });
  });

  test("a /proc enumeration failure is LOGGED at error (not swallowed) — a dropped broadcast must be diagnosable, since the grace timer then SIGKILLs workers", () => {
    const killed: number[] = [];
    const { logger, logs } = capturingLogger();
    broadcastSignalToWorkers("SIGTERM", {
      selfPid: 1,
      enumerate: () => {
        throw new Error("EACCES: /proc not readable");
      },
      kill: (pid) => killed.push(pid),
      logger,
    });
    expect(killed).toEqual([]); // could not enumerate → no workers signalled
    const errLog = logs.find((l) => l.level === "error");
    expect(errLog).toBeDefined();
    expect(errLog?.msg).toContain("cannot enumerate /proc");
    expect(errLog?.data).toMatchObject({ error: "EACCES: /proc not readable" });
  });

  test("a systematic kill failure (EPERM) signals ZERO workers but is distinguishable from success via the summary (signalled=0)", () => {
    const { logger, logs } = capturingLogger();
    broadcastSignalToWorkers("SIGINT", {
      selfPid: 1,
      enumerate: () => ["2", "3"],
      kill: () => {
        throw new Error("EPERM");
      },
      logger,
    });
    const summary = logs.find((l) => l.level === "info");
    expect(summary?.data).toMatchObject({ sig: "SIGINT", enumerated: 2, signalled: 0 });
  });
});

// ── createShutdownHandler: grace sequencing (the path the unref bug regressed) ────

describe("createShutdownHandler (grace sequencing + idempotency)", () => {
  test("first signal forwards termination, then schedules exit(0) after the grace window (not immediately)", () => {
    let begun: string | undefined;
    let exitCode: number | undefined;
    let timerFn: (() => void) | undefined;
    let timerMs: number | undefined;
    const h = createShutdownHandler({
      beginTermination: (s) => { begun = s; },
      graceMs: 7000,
      logger: noopLogger,
      exit: (c) => { exitCode = c; },
      setGraceTimer: (fn, ms) => { timerFn = fn; timerMs = ms; },
    });
    h.onSignal("SIGTERM");
    expect(begun).toBe("SIGTERM");
    expect(h.isTerminated()).toBe(true);
    expect(timerMs).toBe(7000);
    expect(exitCode).toBeUndefined(); // exit ONLY when the grace timer fires
    timerFn?.();
    expect(exitCode).toBe(0);
  });

  test("repeated signals are idempotent — the grace timer is never re-armed", () => {
    let beginCount = 0;
    let timerCount = 0;
    const h = createShutdownHandler({
      beginTermination: () => { beginCount++; },
      graceMs: 1000,
      logger: noopLogger,
      exit: () => {},
      setGraceTimer: () => { timerCount++; },
    });
    h.onSignal("SIGTERM");
    h.onSignal("SIGTERM");
    h.onSignal("SIGINT");
    expect(beginCount).toBe(1);
    expect(timerCount).toBe(1);
  });

  test("decidePostLoopExit defers to the grace timer during shutdown (give-up must not SIGKILL draining workers)", () => {
    // A pod SIGTERM can drive the supervise loop to give-up; PID 1 must then defer
    // to the already-armed grace timer, NOT exit immediately.
    expect(decidePostLoopExit(true)).toBe("defer-to-grace-timer");
    // A genuine crash-loop give-up (no shutdown) exits non-zero for orchestrator backoff.
    expect(decidePostLoopExit(false)).toBe("crash-loop-exit");
  });
});

// ── createGlobalErrorHandlers: PID-1 survive-don't-exit nets ─────────────────────

describe("createGlobalErrorHandlers (PID 1 survives stray async faults)", () => {
  test("uncaughtException is LOGGED at error with message + stack — and the handler has no way to exit", () => {
    const { logger, logs } = capturingLogger();
    const h = createGlobalErrorHandlers(logger);
    const boom = new Error("stray throw from a timer callback");
    h.onUncaughtException(boom);
    const errLog = logs.find((l) => l.level === "error");
    expect(errLog?.msg).toContain("uncaught exception");
    expect(errLog?.msg).toContain("PID 1 surviving");
    expect(errLog?.data).toMatchObject({ error: "stray throw from a timer callback" });
    expect(typeof errLog?.data?.stack).toBe("string");
    // Structural survival: the handler returns normally (no throw, no exit seam to call).
  });

  test("unhandledRejection is LOGGED at error; a non-Error reason is stringified, not dropped", () => {
    const { logger, logs } = capturingLogger();
    const h = createGlobalErrorHandlers(logger);
    h.onUnhandledRejection("plain string rejection");
    const errLog = logs.find((l) => l.level === "error");
    expect(errLog?.msg).toContain("unhandled rejection");
    expect(errLog?.data).toMatchObject({ reason: "plain string rejection", stack: undefined });
  });

  test("both handlers return normally (never throw) so a faulty fault-handler can't itself crash PID 1", () => {
    const { logger } = capturingLogger();
    const h = createGlobalErrorHandlers(logger);
    expect(() => h.onUncaughtException(null)).not.toThrow();
    expect(() => h.onUnhandledRejection(undefined)).not.toThrow();
  });
});

// ── Real adapter behavior (spawns real `bun run` subprocesses) ───────────────────

describe("createBunInitProcessAdapter (real spawn/exit/terminate)", () => {
  let dir: string;
  let fakeExit7: string;
  let fakeSleep: string;
  let fakeSigterm: string;
  let sigtermReady: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "thininit-adapter-"));
    fakeExit7 = join(dir, "exit7.ts");
    fakeSleep = join(dir, "sleep.ts");
    fakeSigterm = join(dir, "sigterm.ts");
    sigtermReady = join(dir, "sigterm-ready");
    writeFileSync(fakeExit7, `process.exit(7);\n`);
    // Long-lived, NO SIGTERM handler → default disposition terminates it on signal.
    writeFileSync(fakeSleep, `await Bun.sleep(60000); process.exit(0);\n`);
    // Long-lived WITH a SIGTERM handler that exits 42 — proves the signal was
    // actually DELIVERED + handled (not merely that the process died somehow). It
    // writes a ready-marker AFTER installing the handler so the test only signals
    // once the handler is in place (else SIGTERM hits the default disposition → 143).
    writeFileSync(
      fakeSigterm,
      `process.on("SIGTERM", () => process.exit(42)); await Bun.write(${JSON.stringify(sigtermReady)}, "1"); await Bun.sleep(60000);\n`,
    );
  });

  const waitForFile = async (path: string, timeoutMs = 5000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(path)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
      await Bun.sleep(20);
    }
  };

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("spawnSupervisor spawns the entry and resolves its real exit code", async () => {
    const adapter = createBunInitProcessAdapter({ supervisorEntry: fakeExit7 });
    const code = await adapter.spawnSupervisor().exited;
    expect(code).toBe(7);
  });

  test("reapZombies is callable without throwing (libc waitpid resolved at construction)", () => {
    const adapter = createBunInitProcessAdapter({ supervisorEntry: fakeExit7 });
    expect(() => adapter.reapZombies()).not.toThrow();
  });

  test("onSigchld installs a SIGCHLD listener AND a safety-net interval; the uninstaller removes both", async () => {
    const before = process.listenerCount("SIGCHLD");
    const adapter = createBunInitProcessAdapter({ supervisorEntry: fakeExit7, reapIntervalMs: 20 });
    let calls = 0;
    const uninstall = adapter.onSigchld(() => { calls++; });
    expect(process.listenerCount("SIGCHLD")).toBe(before + 1);
    await Bun.sleep(80);
    expect(calls).toBeGreaterThan(0); // the safety-net interval drove the handler
    const atUninstall = calls;
    uninstall();
    expect(process.listenerCount("SIGCHLD")).toBe(before); // listener removed
    await Bun.sleep(60);
    expect(calls).toBe(atUninstall); // interval cleared — no further calls
  }, 10_000);

  test("beginTermination forwards SIGTERM to the current supervisor — it is DELIVERED + handled", async () => {
    const adapter = createBunInitProcessAdapter({ supervisorEntry: fakeSigterm });
    const exited = adapter.spawnSupervisor().exited;
    await waitForFile(sigtermReady); // child has installed its SIGTERM handler
    adapter.beginTermination("SIGTERM");
    // The fake's SIGTERM handler exits 42 — observing 42 proves the signal landed
    // (not merely that the process died via default disposition → 143), without hang.
    expect(await exited).toBe(42);
  }, 10_000);

  test("beginTermination after the child already exited does not throw (ESRCH swallowed)", async () => {
    const adapter = createBunInitProcessAdapter({ supervisorEntry: fakeExit7 });
    await adapter.spawnSupervisor().exited; // child is already gone
    expect(() => adapter.beginTermination("SIGTERM")).not.toThrow();
  });

  test("beginTermination with no prior spawnSupervisor does not throw (currentPid undefined; no broadcast off PID 1)", () => {
    const adapter = createBunInitProcessAdapter({ supervisorEntry: fakeExit7 });
    // Test runner is NOT pid 1, so the worker broadcast is correctly skipped — this
    // must never enumerate + signal host processes.
    expect(() => adapter.beginTermination("SIGTERM")).not.toThrow();
  });

  test("after beginTermination, spawnSupervisor PARKS instead of respawning (no shutdown spawn-storm)", async () => {
    const adapter = createBunInitProcessAdapter({ supervisorEntry: fakeExit7 });
    adapter.beginTermination("SIGTERM");
    const parked = adapter.spawnSupervisor().exited;
    const race = await Promise.race([
      parked.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("parked"), 300)),
    ]);
    expect(race).toBe("parked");
  });
});

// ── Fork-failure resilience: a synchronous spawn throw must NOT crash PID 1 ───────

describe("createBunInitProcessAdapter (fork-failure resilience)", () => {
  test("a synchronous spawn throw (EAGAIN/ENOMEM) becomes a -1 synthetic exit — the crash-loop budget governs, PID 1 does NOT crash", async () => {
    const { logger, logs } = capturingLogger();
    const adapter = createBunInitProcessAdapter(
      {
        supervisorEntry: "/irrelevant/main-supervisor.ts",
        spawn: () => {
          const e: NodeJS.ErrnoException = new Error("spawn EAGAIN");
          e.code = "EAGAIN";
          throw e;
        },
      },
      logger,
    );
    // MUST NOT throw: a throw would escape runThinInit → main().catch → process.exit(1),
    // tearing down the PID namespace and SIGKILLing every live worker with no drain.
    // Instead it resolves a synthetic crash exit so `decideSupervisorRestart` retries /
    // gives up cleanly within the budget.
    const code = await adapter.spawnSupervisor().exited;
    expect(code).toBe(-1);
    const errLog = logs.find((l) => l.level === "error");
    expect(errLog?.msg).toContain("supervisor spawn failed");
    expect(errLog?.data).toMatchObject({ error: "spawn EAGAIN", supervisorEntry: "/irrelevant/main-supervisor.ts" });
  });

  test("after a spawn failure the adapter stays in a safe state — beginTermination forwards no stale pid and does not throw", async () => {
    const adapter = createBunInitProcessAdapter({
      supervisorEntry: "/irrelevant/main-supervisor.ts",
      spawn: () => {
        throw new Error("ENOMEM: cannot fork");
      },
    });
    expect(await adapter.spawnSupervisor().exited).toBe(-1); // currentPid stays undefined
    // No current supervisor pid → nothing to forward; the test runner is not PID 1 so
    // the worker broadcast is skipped. The guard must never throw or signal a stale pid.
    expect(() => adapter.beginTermination("SIGTERM")).not.toThrow();
  });

  test("a persistent spawn failure drives the supervise loop to a clean crash-loop give-up (never hangs, never throws)", async () => {
    // INTEGRATION: the adapter's -1 synthetic exit must compose with runThinInit's
    // pure budget so a node that can NEVER fork ends the pod cleanly (give-up) rather
    // than hanging or crashing PID 1.
    const adapter = createBunInitProcessAdapter({
      supervisorEntry: "/irrelevant/main-supervisor.ts",
      spawn: () => {
        throw new Error("spawn EAGAIN");
      },
    });
    const result = await runThinInit(
      adapter,
      { maxRestartsPerWindow: 3, windowMs: 60_000 },
      () => 1000, // frozen clock → all retries fall inside one window, budget exhausts
      noopLogger,
    );
    expect(result.stoppedReason).toBe("crash-loop");
  }, 10_000);
});

// ── End-to-end PID-1 reaping (gated on PID-namespace support) ────────────────────

const canUnshare = (() => {
  try {
    return Bun.spawnSync(["unshare", "-rpf", "--mount-proc", "true"]).success;
  } catch {
    return false;
  }
})();

describe("thin-init reaping end-to-end (real PID namespace)", () => {
  test.skipIf(!canUnshare)(
    "restarts the supervisor within budget and reaps every orphan worker (zero zombies, loop never hangs)",
    async () => {
      const harness = join(__dirname, "init-reap-harness.ts");
      const proc = Bun.spawn(["unshare", "-rpf", "--mount-proc", "bun", "run", harness], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      expect(out).toContain("RESULT pid=1"); // ran as PID 1 in the namespace
      expect(out).toContain("RESULT stoppedReason=crash-loop"); // loop completed, never hung
      expect(out).toContain("RESULT zombies=0"); // FFI waitpid reaped all orphans
    },
    25_000,
  );

  test.skipIf(!canUnshare)(
    "beginTermination broadcasts SIGTERM to all pod workers so they drain gracefully (pid===1)",
    async () => {
      const harness = join(__dirname, "init-broadcast-harness.ts");
      const proc = Bun.spawn(["unshare", "-rpf", "--mount-proc", "bun", "run", harness], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      expect(out).toContain("RESULT pid=1"); // ran as PID 1
      expect(out).toContain("RESULT codes=[0,0,0]"); // all 3 workers caught SIGTERM and drained (exit 0)
    },
    25_000,
  );
});
