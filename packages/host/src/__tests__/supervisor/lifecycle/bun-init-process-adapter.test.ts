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
  createBunInitProcessAdapter,
} from "../../../supervisor/lifecycle/bun-init-process-adapter.js";
import { parseThinInitEnv, createShutdownHandler, decidePostLoopExit } from "../../../main-thin-init.js";
import type { LogPort } from "../../../ports.js";

const noopLogger: LogPort = { info: () => {}, warn: () => {}, error: () => {} };

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
