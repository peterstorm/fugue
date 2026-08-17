/**
 * Integration tests for `src/file/atomic.ts` — the file backend's two
 * durability primitives (AD-2 / AD-4, spec FR-006/FR-007/FR-013/FR-029/FR-031):
 *
 * - `atomicWriteFile`: tmp+rename atomic commit — a reader observes either the
 *   prior-complete or the new-complete snapshot, never a partial write;
 *   interrupted writes leave only `.tmp.<unique-token>` litter that `*.json`
 *   readers never see; each call owns its temp path, and a failed rename OR
 *   failed write unlinks only that caller's tmp (best-effort)
 *   and rethrows the original error.
 * - lock release: an owned-lock cleanup failure is an observable typed
 *   `FrameworkError`; successful critical sections reject, while a primary
 *   critical-section failure remains authoritative if cleanup also fails.
 * - `withFileLock`: rename-born directory lock — mutual exclusion under
 *   concurrent `Promise.all` callers, stale-lock steal (dead pid) with
 *   per-attempt staleness re-probing (a holder dying mid-wait is reaped
 *   within `RETRY_MS`), permanently fenced stale recovery, re-entrant
 *   acquisition failing cleanly at the documented ~5s ceiling, and
 *   pid-plus-token ownership-checked release.
 *
 * Cleanup-masking regression coverage: a forced failure of the birth-staging
 * cleanup is warned and never masks the original ENOTEMPTY (the acquire retry
 * loop continues instead of aborting), and a forced failure of the
 * tomb-reap cleanup still reports the steal as successful (a successful reap
 * never turns into a spurious acquire failure).
 */

import { describe, test, expect, afterEach, mock } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  atomicWriteFile,
  acquireFileLock,
  releaseFileLock,
  stealStaleFileLock,
  withFileLock,
} from "../file/atomic.js";
import { setFrameworkLogger, __resetFrameworkLogger } from "../logger.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const cleanup: string[] = [];
afterEach(() => {
  __resetFrameworkLogger();
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Fresh temp directory, removed after the test. */
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "file-atomic-"));
  cleanup.push(dir);
  return dir;
};

/** A reader that lists only `*.json` — the same filter the event-log uses. */
const listJson = (dir: string): readonly string[] =>
  readdirSync(dir).filter((name) => name.endsWith(".json")).sort();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errnoFailure = (code: string, message: string): Error & { readonly code: string } =>
  Object.assign(new Error(`${code}: ${message}`), { code });

/**
 * A pid that is as good as dead at the moment of the call: spawn a throwaway
 * process and wait for it to be reaped. (A hard-coded fake pid could, on an
 * exotic machine, name a live unrelated process — a reaped child cannot.)
 * Modulo the OS pid-reuse window: the pid is only re-allocated after the
 * system wraps around `pid_max` (default ~4M on Linux), so within a test run
 * it still names the reaped child.
 */
const deadPid = (): number =>
  spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" }).pid;

// ---------------------------------------------------------------------------
// atomicWriteFile
// ---------------------------------------------------------------------------

describe("atomicWriteFile", () => {
  test("commits new content via tmp+rename, leaving no litter", () => {
    const dir = tempDir();
    const target = join(dir, "checkpoint.json");

    atomicWriteFile(target, '{"v":1}');
    expect(readFileSync(target, "utf-8")).toBe('{"v":1}');
    expect(listJson(dir)).toEqual(["checkpoint.json"]);

    // Replacement: readers see the new snapshot, and no tmp remains.
    atomicWriteFile(target, '{"v":2}');
    expect(readFileSync(target, "utf-8")).toBe('{"v":2}');
    expect(listJson(dir)).toEqual(["checkpoint.json"]);
  });

  test("a crash between write and rename leaves the prior snapshot readable and only .tmp litter", () => {
    const dir = tempDir();
    const target = join(dir, "checkpoint.json");
    atomicWriteFile(target, "prior-complete");

    // Simulate a process crash mid-write: writeFileSync happened, renameSync
    // never did. The tmp file holds a torn write; the target is untouched.
    const tmp = `${target}.tmp.${process.pid}`;
    writeFileSync(tmp, '{"v":1,"partial": tru'); // torn write

    // A reader observes the complete prior snapshot — never the partial tmp.
    expect(readFileSync(target, "utf-8")).toBe("prior-complete");
    // And a `*.json` listing does not even see the litter.
    expect(listJson(dir)).toEqual(["checkpoint.json"]);
    expect(existsSync(tmp)).toBe(true); // the litter exists on disk...
  });

  test("interrupted-write .tmp litter is invisible to *.json readers", () => {
    const dir = tempDir();
    atomicWriteFile(join(dir, "000000-a.json"), "v1");
    atomicWriteFile(join(dir, "000001-b.json"), "v2");

    // Litter from crashed writers: torn writes and stray tmp files.
    writeFileSync(join(dir, "000002-c.json.tmp.1234"), "partial");
    writeFileSync(join(dir, "000003-d.json.tmp.99"), "partial");
    writeFileSync(join(dir, `000004-e.json.tmp.${process.pid}`), "partial");

    expect(listJson(dir)).toEqual(["000000-a.json", "000001-b.json"]);
  });

  test("same-target Promise.all writers use independent temps and leave one complete payload", async () => {
    const dir = tempDir();
    const target = join(dir, "checkpoint.json");
    const payloads = Array.from({ length: 32 }, (_, writer) =>
      JSON.stringify({ writer, payload: String(writer).repeat(4_096) }),
    );

    await Promise.all(payloads.map(async (payload) => atomicWriteFile(target, payload)));

    expect(payloads).toContain(readFileSync(target, "utf-8"));
    expect(readdirSync(dir).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  test("a reader under repeated atomic replacement observes only complete snapshots", () => {
    const dir = tempDir();
    const target = join(dir, "checkpoint.json");
    const payloads = Array.from({ length: 25 }, (_, i) =>
      JSON.stringify({ writer: i, payload: "x".repeat(512) }),
    );

    // After every commit, the target is byte-identical to exactly one of the
    // complete snapshots written so far — never a torn fragment.
    for (const payload of payloads) {
      atomicWriteFile(target, payload);
      const read = readFileSync(target, "utf-8");
      expect(payloads.slice(0, payloads.indexOf(payload) + 1)).toContain(read);
      expect(listJson(dir)).toEqual(["checkpoint.json"]);
    }
  });

  test("unlinks the tmp file and rethrows when the rename fails", () => {
    const dir = tempDir();
    // An existing non-empty directory at the target forces renameSync to fail
    // (rename cannot replace a directory with a file) — a real, deterministic
    // commit-point failure without mocking anything.
    const target = join(dir, "blocked");
    mkdirSync(target);
    writeFileSync(join(target, "occupied"), "x");

    // Sanity: the tmp write itself succeeds (it is a sibling path).
    expect(() => atomicWriteFile(target, "new")).toThrow();
    expect(readdirSync(dir).filter((name) => name.includes(".tmp."))).toEqual([]);
    expect(readdirSync(target).sort()).toEqual(["occupied"]); // target untouched
  });

  test("unlinks the tmp when the WRITE itself fails, and rethrows", () => {
    const dir = tempDir();
    // A component longer than NAME_MAX makes the tmp WRITE fail
    // (ENAMETOOLONG) — the failure mode the old code skipped (it only
    // unlinked on the rename-failure path). The tmp is never created, so
    // there is nothing to unlink, but the original error must propagate and
    // no litter may appear.
    const target = join(dir, "x".repeat(300));

    expect(() => atomicWriteFile(target, "new")).toThrow();
    expect(listJson(dir)).toEqual([]); // no tmp litter, no target
    expect(existsSync(target)).toBe(false); // failed write ⇒ no target at all
  });

  test("rethrows the original write error even when tmp cleanup itself fails", () => {
    const dir = tempDir();
    const target = join(dir, "checkpoint.json");
    const tmp = `${target}.tmp.forced-cleanup-failure`;
    // A directory squatting on the injected test temp path makes the tmp write
    // fail (EISDIR) AND makes a naive unlink fail too — the ORIGINAL error
    // must win, with cleanup failure only logged, never masking it.
    mkdirSync(tmp);

    expect(() => atomicWriteFile(target, "new", { temporaryPath: () => tmp })).toThrow();
    expect(existsSync(tmp)).toBe(true); // a dir cannot be unlinked — expected
    expect(existsSync(target)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withFileLock — mutual exclusion
// ---------------------------------------------------------------------------

describe("withFileLock — mutual exclusion", () => {
  test("serializes critical sections across concurrent Promise.all callers", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "append.lock");
    const stateFile = join(dir, "state");
    writeFileSync(stateFile, "0");

    // Each caller performs a read-modify-write with an await INSIDE the
    // critical section. Without serialization, two callers could observe the
    // same listing and both write the same value — the exact hazard AD-4
    // documents for concurrent appends (sequence collision).
    const tasks = Array.from({ length: 8 }, () =>
      withFileLock(lockPath, async () => {
        const current = Number(readFileSync(stateFile, "utf-8"));
        await sleep(10); // interleave point: a broken lock lets a second
        // caller read the same `current` before we write
        writeFileSync(stateFile, String(current + 1));
      }),
    );

    await Promise.all(tasks);

    // Every increment happened exactly once, in happens-before order.
    expect(readFileSync(stateFile, "utf-8")).toBe("8");
    expect(existsSync(lockPath)).toBe(false); // released by every holder
  });

  test("a second acquisition waits until the holder releases", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "append.lock");

    const ownershipToken = await acquireFileLock(lockPath);
    let ran = false;
    const pending = withFileLock(lockPath, () => {
      ran = true;
    });

    await sleep(250);
    expect(ran).toBe(false); // still held by us — the second caller is waiting

    releaseFileLock(lockPath, ownershipToken);
    await pending;
    expect(ran).toBe(true);
  });

  test("releases the lock when fn throws, and propagates the error", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "append.lock");

    await expect(withFileLock(lockPath, () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    expect(existsSync(lockPath)).toBe(false);
  });

  test("propagates fn's return value", async () => {
    const dir = tempDir();
    const value = await withFileLock(join(dir, "append.lock"), () => 42);
    expect(value).toBe(42);
  });

  test("rejects with a typed release failure when the critical section succeeded", async () => {
    const lockPath = join(tempDir(), "append.lock");
    let bodyRan = false;

    const failure = await withFileLock(
      lockPath,
      () => {
        bodyRan = true;
        return "committed";
      },
      {
        readOwnershipToken: () => {
          throw errnoFailure("EIO", "deterministic owned-lock release failure");
        },
      },
    ).then(() => null, (error: unknown) => error);

    expect(bodyRan).toBe(true);
    expect(failure).toMatchObject({
      kind: "cache-error",
      operation: "withFileLock",
      message: expect.stringMatching(/releaseFileLock.*EIO/),
    });
    expect(existsSync(lockPath)).toBe(true);

    const token = readFileSync(join(lockPath, "owner"), "utf-8");
    releaseFileLock(lockPath, token);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("acquisition with a missing parent directory fails fast instead of retry-spinning", async () => {
    const dir = tempDir();
    const started = Date.now();
    await expect(
      withFileLock(join(dir, "missing-parent", "append.lock"), () => {}),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------------------
// withFileLock — stale-lock steal and ownership-checked release
// ---------------------------------------------------------------------------

describe("withFileLock — stale steal and ownership", () => {
  test("steals a stale lock whose recorded pid is dead", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "append.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), String(deadPid()));

    // Captured as a string (not `string | null`) so the assertion below stays
    // free of narrowing noise.
    let holderPid = "";
    await withFileLock(lockPath, () => {
      // The dead holder's lock was reaped before fn ran; it is now OURS.
      holderPid = readFileSync(join(lockPath, "pid"), "utf-8");
    });

    expect(holderPid).toBe(String(process.pid));
    expect(existsSync(lockPath)).toBe(false); // cleaned up on release
  });

  test("steals a stale lock with no pid file", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "append.lock");
    mkdirSync(lockPath); // no pid file — a torn-old-style lock

    let ran = false;
    await withFileLock(lockPath, () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("release is ownership-checked: only the recorded owner releases", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "append.lock");
    const ownershipToken = await acquireFileLock(lockPath);

    // Simulate the lock being stale-reaped and re-born by another process
    // while we held it: the pid file now names a foreign process.
    const foreignPid = String(deadPid());
    writeFileSync(join(lockPath, "pid"), foreignPid);

    releaseFileLock(lockPath, ownershipToken); // must be a no-op — we are not the owner
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(join(lockPath, "pid"), "utf-8")).toBe(foreignPid);
  });

  test("release requires the acquisition token even for the same live pid", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "append.lock");
    const ownershipToken = await acquireFileLock(lockPath);

    releaseFileLock(lockPath, "wrong-same-process-token");
    expect(existsSync(lockPath)).toBe(true);

    releaseFileLock(lockPath, ownershipToken);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a holder whose lock was stolen cannot break the new holder's exclusion on release", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "append.lock");
    const foreignPid = String(deadPid());

    await withFileLock(lockPath, () => {
      // While we are "running", our lock is stolen and re-born by another
      // process (a hostile simulation pinning the ownership-token release
      // check independently of the fenced stale-reaping protocol).
      rmSync(lockPath, { recursive: true, force: true });
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "pid"), foreignPid);
    });

    // withFileLock's release ran in `finally` — and correctly no-oped.
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(join(lockPath, "pid"), "utf-8")).toBe(foreignPid);
  });

  test("stealStaleFileLock refuses a LIVE lock without moving it", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "append.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), String(process.pid)); // OUR live pid

    // The permanent reap fence is established first; the decisive stable
    // probe sees the live owner, so no victim rename happens at all.
    expect(await stealStaleFileLock(lockPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(join(lockPath, "pid"), "utf-8")).toBe(String(process.pid));
    // No tomb/birth litter anywhere in the directory.
    expect(readdirSync(dir).filter((n) => n.includes(".tomb-") || n.includes(".birth-"))).toEqual([]);
  });

  test("stealStaleFileLock reaps a dead holder's lock and leaves no tomb litter", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "append.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), String(deadPid()));

    expect(await stealStaleFileLock(lockPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(join(dir, "append.lock.fence"))).toEqual([]); // tomb was consumed
  });

  // Live-tomb reconcile coverage (ADR-0078 module contract: "an unrestorable
  // live tomb blocks acquisition rather than allowing a second holder"). The
  // hooks force every recorded pid to probe LIVE, so a tomb-* entry can be
  // constructed deterministically without real PID reuse — pinning (a) the
  // restore into an empty owner path, (b) the fail-closed fence when another
  // owner exists, and (c) the non-ENOENT restore-failure rethrow.
  const liveTomb = (fence: string, name: string, pid: string, token: string): string => {
    mkdirSync(fence, { recursive: true });
    const tomb = join(fence, name);
    mkdirSync(tomb);
    writeFileSync(join(tomb, "pid"), pid);
    writeFileSync(join(tomb, "owner"), token);
    return tomb;
  };
  const liveOwnerHooks = {
    readOwnerPid: (ownerPath: string) => readFileSync(join(ownerPath, "pid"), "utf-8"),
    probeOwnerProcess: () => {}, // every recorded pid proves alive
  };

  test("a live tomb is restored into an empty owner path and acquisition stays fenced", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "append.lock");
    // A reaper crashed AFTER renaming the victim lock into a tomb, and the
    // victim is still alive: the next reaper must restore the tomb into the
    // empty owner path (never delete a live lock) and remain fenced.
    liveTomb(join(dir, "append.lock.fence"), "tomb-live-1", String(process.pid), "victim-token");

    expect(await stealStaleFileLock(lockPath, liveOwnerHooks)).toBe(false);
    expect(existsSync(lockPath)).toBe(true); // restored, not deleted
    expect(readFileSync(join(lockPath, "pid"), "utf-8")).toBe(String(process.pid));
    expect(readFileSync(join(lockPath, "owner"), "utf-8")).toBe("victim-token");
    expect(readdirSync(join(dir, "append.lock.fence")).filter((n) => n.startsWith("tomb-"))).toEqual([]);
  });

  test("an unrestorable live tomb stays as a fail-closed fence when another owner exists", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "append.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), String(process.pid));
    writeFileSync(join(lockPath, "owner"), "current-token");
    const tomb = liveTomb(
      join(dir, "append.lock.fence"),
      "tomb-live-2",
      String(process.pid),
      "victim-token",
    );

    // The owner path is occupied, so the live tomb cannot be restored; it
    // must REMAIN as a durable fence (births refuse while a tomb exists).
    expect(await stealStaleFileLock(lockPath, liveOwnerHooks)).toBe(false);
    expect(existsSync(tomb)).toBe(true);
    expect(readFileSync(join(lockPath, "pid"), "utf-8")).toBe(String(process.pid));
    expect(readFileSync(join(lockPath, "owner"), "utf-8")).toBe("current-token");
  });

  test("a live-tomb restore failure with an unexpected errno rethrows instead of swallowing", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "append.lock");
    const fence = join(dir, "append.lock.fence");
    liveTomb(fence, "tomb-live-3", String(process.pid), "victim-token");

    // Remove directory write permission: the restore rename now fails with
    // EACCES — NOT one of the tolerated ENOENT/EEXIST/ENOTEMPTY races.
    chmodSync(fence, 0o500);
    try {
      await expect(stealStaleFileLock(lockPath, liveOwnerHooks)).rejects.toThrow();
    } finally {
      chmodSync(fence, 0o700);
    }
  });

  test("a holder that dies mid-wait is reaped by the next attempt (staleness re-probed per attempt)", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "append.lock");

    // A child process plays the holder: it births the lock (its own live
    // pid) and then dies WITHOUT releasing — a simulated crash ~400ms into
    // the parent's wait. Under the old probe-once-at-attempt-0 behavior this
    // wait would run out all 50 attempts (~5s) and THROW; per-attempt
    // re-probing must reap it within a couple of RETRY_MS ticks.
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const {mkdirSync, writeFileSync} = require("node:fs");
        mkdirSync(${JSON.stringify(lockPath)});
        writeFileSync(${JSON.stringify(join(lockPath, "pid"))}, String(process.pid));
        setTimeout(() => process.exit(0), 400);`,
      ],
      { stdio: "ignore" },
    );

    // Wait until the child's lock is observable on disk.
    const bornBy = Date.now() + 5_000;
    while (!existsSync(lockPath) && Date.now() < bornBy) await sleep(10);
    expect(existsSync(lockPath)).toBe(true);

    const started = Date.now();
    let ran = false;
    await withFileLock(lockPath, () => {
      ran = true;
    });
    const elapsed = Date.now() - started;

    expect(ran).toBe(true);
    expect(elapsed).toBeLessThan(3_000); // far under the 50 × 100ms ceiling
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
  });

  test("a permanently fenced three-process race never displaces the newly born live holder", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "append.lock");
    const signals = join(dir, "signals");
    const trace = join(dir, "trace");
    mkdirSync(signals);

    // The old race starts with A proving this owner stale, then pausing before
    // its victim rename. B reaps and becomes the new live owner; C waits to
    // exploit the pathname gap that the old tomb/restore protocol exposed.
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), String(deadPid()));

    const atomicUrl = pathToFileURL(join(__dirname, "..", "file", "atomic.js")).href;
    const script = join(dir, "lock-contender.ts");
    writeFileSync(
      script,
      [
        `import { appendFileSync, existsSync, writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `import { acquireFileLock, releaseFileLock } from ${JSON.stringify(atomicUrl)};`,
        `const role = process.env.ROLE!;`,
        `const lockPath = process.env.LOCK_PATH!;`,
        `const signals = process.env.SIGNALS!;`,
        `const trace = process.env.TRACE!;`,
        `const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));`,
        `const wait = async (name: string) => { while (!existsSync(join(signals, name))) await sleep(5); };`,
        `const signal = (name: string) => writeFileSync(join(signals, name), "1");`,
        `const hooks = role === "A" ? {`,
        `  afterUnfencedStaleProbe: async () => { signal("A_PROBED_STALE"); await wait("ALLOW_A_REAP"); },`,
        `  afterStableOwnerProbe: async (stale: boolean) => {`,
        `    if (!stale) { signal("A_SAW_FENCED_LIVE_OWNER"); await wait("ALLOW_A_CONTINUE"); }`,
        `  },`,
        `} : {};`,
        `const token = await acquireFileLock(lockPath, hooks);`,
        `appendFileSync(trace, \`ENTER \${role}\\n\`);`,
        `signal(\`\${role}_ENTERED\`);`,
        `await wait(\`RELEASE_\${role}\`);`,
        `appendFileSync(trace, \`EXIT \${role}\\n\`);`,
        `releaseFileLock(lockPath, token);`,
      ].join("\n"),
    );

    const children: ReturnType<typeof spawn>[] = [];
    const start = (role: string): ReturnType<typeof spawn> => {
      const child = spawn(process.execPath, [script], {
        env: { ...process.env, ROLE: role, LOCK_PATH: lockPath, SIGNALS: signals, TRACE: trace },
        stdio: ["ignore", "ignore", "pipe"],
      });
      children.push(child);
      return child;
    };
    const waitFor = async (name: string): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (!existsSync(join(signals, name)) && Date.now() < deadline) await sleep(5);
      expect(existsSync(join(signals, name)), `timed out waiting for ${name}`).toBe(true);
    };
    const allow = (name: string): void => writeFileSync(join(signals, name), "1");
    const waitForExit = (child: ReturnType<typeof spawn>): Promise<void> =>
      new Promise((resolve, reject) => {
        if (child.exitCode !== null) {
          child.exitCode === 0 ? resolve() : reject(new Error(`child exited ${child.exitCode}`));
          return;
        }
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${stderr}`)));
      });

    const a = start("A");
    await waitFor("A_PROBED_STALE");

    const b = start("B");
    await waitFor("B_ENTERED");
    const bornPid = readFileSync(join(lockPath, "pid"), "utf-8");
    const bornOwner = readFileSync(join(lockPath, "owner"), "utf-8");

    const c = start("C");
    allow("ALLOW_A_REAP");
    await waitFor("A_SAW_FENCED_LIVE_OWNER");

    // A's stale observation predates B's birth. The permanent birth/reap
    // handshake forces a second, stable probe while births are fenced, so B
    // remains exactly where it was and C has not entered.
    expect(readFileSync(join(lockPath, "pid"), "utf-8")).toBe(bornPid);
    expect(readFileSync(join(lockPath, "owner"), "utf-8")).toBe(bornOwner);
    expect(existsSync(join(signals, "C_ENTERED"))).toBe(false);
    allow("ALLOW_A_CONTINUE");

    allow("RELEASE_B");
    const firstFollower = await (async (): Promise<"A" | "C"> => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (existsSync(join(signals, "A_ENTERED"))) return "A";
        if (existsSync(join(signals, "C_ENTERED"))) return "C";
        await sleep(5);
      }
      throw new Error("neither follower acquired the lock");
    })();
    allow(`RELEASE_${firstFollower}`);
    const secondFollower = firstFollower === "A" ? "C" : "A";
    await waitFor(`${secondFollower}_ENTERED`);
    allow(`RELEASE_${secondFollower}`);

    await Promise.all(children.map(waitForExit));
    expect(readFileSync(trace, "utf-8").trim().split("\n")).toEqual([
      "ENTER B",
      "EXIT B",
      `ENTER ${firstFollower}`,
      `EXIT ${firstFollower}`,
      `ENTER ${secondFollower}`,
      `EXIT ${secondFollower}`,
    ]);
    expect(existsSync(lockPath)).toBe(false);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(c.exitCode).toBe(0);
  }, 30_000);

  test("a process crash leaves a stale owner that a fresh process safely recovers", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "append.lock");
    const acquired = join(dir, "holder-acquired");
    const atomicUrl = pathToFileURL(join(__dirname, "..", "file", "atomic.js")).href;
    const script = join(dir, "crash-holder.ts");
    writeFileSync(
      script,
      [
        `import { writeFileSync } from "node:fs";`,
        `import { acquireFileLock } from ${JSON.stringify(atomicUrl)};`,
        `await acquireFileLock(${JSON.stringify(lockPath)});`,
        `writeFileSync(${JSON.stringify(acquired)}, "1");`,
        `await new Promise(() => {});`,
      ].join("\n"),
    );
    const holder = spawn(process.execPath, [script], { stdio: "ignore" });
    const deadline = Date.now() + 10_000;
    while (!existsSync(acquired) && Date.now() < deadline) await sleep(5);
    expect(existsSync(acquired)).toBe(true);

    holder.kill("SIGKILL");
    await new Promise<void>((resolve) => holder.once("exit", () => resolve()));

    let entered = false;
    await withFileLock(lockPath, () => { entered = true; });
    expect(entered).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  }, 20_000);

  test("re-entrant acquisition of an already-held lock fails cleanly at the documented ceiling", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "append.lock");
    const ownershipToken = await acquireFileLock(lockPath); // WE hold it — our pid is provably live

    // Re-entrant acquisition can never succeed (the recorded pid is our own
    // live process, so the lock is never stale). The contract: fail cleanly
    // after MAX_ACQUIRE_ATTEMPTS × RETRY_MS ≈ 5s of backoff (the live-holder
    // ceiling — no stale/tomb attempt nests a fencedReap barrier wait here)
    // — never hang, and never break the holder's exclusion. The ceiling is
    // documented on `acquireFileLock`; this test pins the error and the bound.
    const started = Date.now();
    await expect(acquireFileLock(lockPath)).rejects.toThrow(/after \d+ attempts/);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(3_000); // it really retried
    expect(elapsed).toBeLessThan(15_000); // and it terminated

    releaseFileLock(lockPath, ownershipToken);
    expect(existsSync(lockPath)).toBe(false);
  }, 15_000); // bun's default 5s timeout ≈ the acquisition ceiling itself

  test("releaseFileLock throws typed and logs a real owned cleanup failure", async () => {
    const warnings: string[] = [];
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: (msg: string) => {
        warnings.push(msg);
      },
      error: () => {},
    });
    try {
      const dir = tempDir();
      const lockPath = join(dir, "append.lock");
      const ownershipToken = await acquireFileLock(lockPath);
      // Lock the lock directory against mutation: rmSync can read the pid
      // (ownership check passes — it IS ours) but cannot unlink the dir
      // entry (EACCES) — a real cleanup failure that must be loud, not
      // swallowed (ENOENT stays silent via `force`, but EACCES does not).
      chmodSync(lockPath, 0o500);

      let failure: unknown;
      try {
        releaseFileLock(lockPath, ownershipToken);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        kind: "cache-error",
        operation: "releaseFileLock",
        message: expect.stringContaining(lockPath),
      });

      expect(existsSync(lockPath)).toBe(true); // removal genuinely failed
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain(lockPath);

      // Restore permissions so the afterEach temp-dir sweep can remove it.
      chmodSync(lockPath, 0o700);
      // Our own lock, now removable: a second release cleans up silently.
      releaseFileLock(lockPath, ownershipToken);
      expect(existsSync(lockPath)).toBe(false);
      expect(warnings.length).toBe(1); // no second warning — this one succeeded
    } finally {
      __resetFrameworkLogger();
    }
  });

  test("releaseFileLock stays a SILENT no-op for a foreign pid even when cleanup would fail", () => {
    const warnings: string[] = [];
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: (msg: string) => {
        warnings.push(msg);
      },
      error: () => {},
    });
    try {
      const dir = tempDir();
      const lockPath = join(dir, "append.lock");
      const foreignPid = String(deadPid());
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "pid"), foreignPid); // NOT our pid
      chmodSync(lockPath, 0o500);

      releaseFileLock(lockPath, "not-the-foreign-owner");

      // The ownership check short-circuits before any rmSync: the foreign
      // holder's lock is untouched AND no warning fires (not our problem).
      expect(existsSync(lockPath)).toBe(true);
      expect(readFileSync(join(lockPath, "pid"), "utf-8")).toBe(foreignPid);
      expect(warnings.length).toBe(0);
      chmodSync(lockPath, 0o700);
    } finally {
      __resetFrameworkLogger();
    }
  });
});

// ---------------------------------------------------------------------------
// Lock diagnostics — fail closed, warn safely, never mask primary work
// ---------------------------------------------------------------------------

describe("file-lock diagnostics", () => {
  const recordingLogger = (warnings: string[]): void => {
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: (message: string) => { warnings.push(message); },
      error: () => {},
    });
  };

  test("an EACCES owner-metadata read remains live and emits an actionable warning", async () => {
    const warnings: string[] = [];
    recordingLogger(warnings);
    const lockPath = join(tempDir(), "append.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), String(process.pid));

    const result = await stealStaleFileLock(lockPath, {
      readOwnerPid: () => { throw errnoFailure("EACCES", "pid metadata denied"); },
    });

    expect(result).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("read pid metadata");
    expect(warnings[0]).toContain("treating owner as live");
    expect(warnings[0]).toContain("EACCES");
    expect(warnings[0]).toContain(lockPath);
  });

  test("an EIO process probe remains live and emits an actionable warning", async () => {
    const warnings: string[] = [];
    recordingLogger(warnings);
    const lockPath = join(tempDir(), "append.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), String(process.pid));

    const result = await stealStaleFileLock(lockPath, {
      probeOwnerProcess: () => { throw errnoFailure("EIO", "process table unavailable"); },
    });

    expect(result).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("probe owner process");
    expect(warnings[0]).toContain("treating owner as live");
    expect(warnings[0]).toContain("EIO");
    expect(warnings[0]).toContain(lockPath);
  });

  test("an EACCES owner-metadata probe is retained in the terminal acquire failure", async () => {
    const warnings: string[] = [];
    recordingLogger(warnings);
    const lockPath = join(tempDir(), "append.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), String(process.pid));

    const error = await acquireFileLock(lockPath, {
      readOwnerPid: () => { throw errnoFailure("EACCES", "pid metadata denied"); },
    }).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(error).toMatchObject({ kind: "cache-error", operation: "acquireFileLock" });
    expect((error as Error).message).toContain("last blocking owner probe");
    expect((error as Error).message).toContain("read pid metadata");
    expect((error as Error).message).toContain("EACCES");
    expect(warnings.length).toBeGreaterThan(0);
  }, 15_000);

  test("a live tomb blocking every acquire attempt is named in the terminal acquire failure", async () => {
    // The obscure-debugging trap: a live tomb (reaper suspended mid-reap)
    // plus a live foreign owner blocks every attempt with NO owner-probe
    // warning — the timeout must name the blocking fence entry or the
    // operator gets an unexplained ~5s timeout loop pointing nowhere.
    const warnings: string[] = [];
    recordingLogger(warnings);
    const dir = tempDir();
    const lockPath = join(dir, "append.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), String(process.pid));
    writeFileSync(join(lockPath, "owner"), "foreign-token");
    const tomb = join(dir, "append.lock.fence", "tomb-live-reaper");
    mkdirSync(tomb, { recursive: true });
    writeFileSync(join(tomb, "pid"), String(process.pid));
    writeFileSync(join(tomb, "owner"), "victim-token");

    const error = await acquireFileLock(lockPath).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(error).toMatchObject({ kind: "cache-error", operation: "acquireFileLock" });
    const message = (error as Error).message;
    expect(message).toContain("Could not acquire lock after 50 attempts");
    expect(message).toContain("blocking fence entries");
    expect(message).toContain("tomb-live-reaper");
    // Fail-closed: the live owner and its tomb are untouched.
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(tomb)).toBe(true);
  }, 15_000);

  test("an EIO process probe is retained in the terminal acquire failure", async () => {
    const warnings: string[] = [];
    recordingLogger(warnings);
    const lockPath = join(tempDir(), "append.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), String(process.pid));

    const error = await acquireFileLock(lockPath, {
      probeOwnerProcess: () => { throw errnoFailure("EIO", "process table unavailable"); },
    }).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(error).toMatchObject({ kind: "cache-error", operation: "acquireFileLock" });
    expect((error as Error).message).toContain("last blocking owner probe");
    expect((error as Error).message).toContain("probe owner process");
    expect((error as Error).message).toContain("EIO");
    expect(warnings.length).toBeGreaterThan(0);
  }, 15_000);

  test("the expected EPERM live-process probe remains silent", async () => {
    const warnings: string[] = [];
    recordingLogger(warnings);
    const lockPath = join(tempDir(), "append.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), String(process.pid));

    expect(await stealStaleFileLock(lockPath, {
      probeOwnerProcess: () => { throw errnoFailure("EPERM", "foreign live process"); },
    })).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(warnings).toEqual([]);
  });

  test("release warns and leaves the lock intact on EACCES pid metadata reads", async () => {
    const warnings: string[] = [];
    recordingLogger(warnings);
    const lockPath = join(tempDir(), "append.lock");
    const ownershipToken = await acquireFileLock(lockPath);

    expect(() => releaseFileLock(lockPath, ownershipToken, {
      readOwnerPid: () => { throw errnoFailure("EACCES", "release pid denied"); },
    })).toThrow();

    expect(existsSync(lockPath)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("verify ownership while reading pid");
    expect(warnings[0]).toContain("lock left in place");
    expect(warnings[0]).toContain("EACCES");
    expect(warnings[0]).toContain(lockPath);
    releaseFileLock(lockPath, ownershipToken);
  });

  test("release warns and leaves the lock intact on EIO owner-token reads", async () => {
    const warnings: string[] = [];
    recordingLogger(warnings);
    const lockPath = join(tempDir(), "append.lock");
    const ownershipToken = await acquireFileLock(lockPath);

    expect(() => releaseFileLock(lockPath, ownershipToken, {
      readOwnershipToken: () => { throw errnoFailure("EIO", "release token unreadable"); },
    })).toThrow();

    expect(existsSync(lockPath)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("verify ownership while reading ownership token");
    expect(warnings[0]).toContain("EIO");
    releaseFileLock(lockPath, ownershipToken);
  });

  test("release is silent only when ENOENT means the canonical lock is absent", () => {
    const warnings: string[] = [];
    recordingLogger(warnings);
    const dir = tempDir();
    const absentLock = join(dir, "absent.lock");

    releaseFileLock(absentLock, "already-released");
    expect(warnings).toEqual([]);

    const tornLock = join(dir, "torn.lock");
    mkdirSync(tornLock);
    writeFileSync(join(tornLock, "owner"), "token-without-pid");
    expect(() => releaseFileLock(tornLock, "token-without-pid")).toThrow();

    expect(existsSync(tornLock)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("verify ownership while reading pid");
    expect(warnings[0]).toContain(tornLock);
    expect(warnings[0]).toContain("ENOENT");
  });

  test("a release failure alongside a body failure preserves the primary and reports cleanup context", async () => {
    const warnings: string[] = [];
    recordingLogger(warnings);
    const lockPath = join(tempDir(), "append.lock");

    const failure = await withFileLock(
      lockPath,
      () => { throw new Error("primary critical-section failure"); },
      {
        readOwnershipToken: () => {
          throw errnoFailure("EIO", "secondary release failure");
        },
      },
    ).then(() => null, (error: unknown) => error);

    expect(failure).toMatchObject({
      kind: "cache-error",
      operation: "withFileLock",
      message: expect.stringContaining("primary critical-section failure"),
    });
    expect(warnings.some((warning) => warning.includes("secondary lock-release failure"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("EIO"))).toBe(true);
    expect(existsSync(lockPath)).toBe(true);

    const token = readFileSync(join(lockPath, "owner"), "utf-8");
    releaseFileLock(lockPath, token);
  });

  test("throwing logger and hostile errno diagnostics cannot break exclusion or mask the primary operation", async () => {
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: () => { throw new Error("logger transport failed"); },
      error: () => {},
    });
    const dir = tempDir();
    const stalePath = join(dir, "stale.lock");
    mkdirSync(stalePath);
    writeFileSync(join(stalePath, "pid"), String(process.pid));
    const hostileFailure = new Error("metadata transport failed");
    Object.defineProperty(hostileFailure, "code", {
      get: () => { throw new Error("code getter failed"); },
    });

    await expect(stealStaleFileLock(stalePath, {
      readOwnerPid: () => { throw hostileFailure; },
    })).resolves.toBe(false);
    expect(existsSync(stalePath)).toBe(true);

    const primaryPath = join(dir, "primary.lock");
    await expect(withFileLock(
      primaryPath,
      () => { throw new Error("primary critical-section failure"); },
      { readOwnerPid: () => { throw errnoFailure("EIO", "release read failed"); } },
    )).rejects.toMatchObject({
      kind: "cache-error",
      operation: "withFileLock",
      message: expect.stringContaining("primary critical-section failure"),
    });
    expect(existsSync(primaryPath)).toBe(true);
    rmSync(primaryPath, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Cleanup-failure regression — cleanup must never mask the original signal
// ---------------------------------------------------------------------------

describe("cleanup-failure masking regressions", () => {
  test("a forced birth-staging cleanup failure is warned and the original ENOTEMPTY still surfaces as a retry (acquire completes)", async () => {
    const warnings: string[] = [];
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: (msg: string) => {
        warnings.push(msg);
      },
      error: () => {},
    });
    try {
      const dir = tempDir();
      const lockPath = join(dir, "append.lock");
      // A stale holder (dead pid) whose directory makes every acquire birth
      // fail with ENOTEMPTY on the first attempt.
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "pid"), String(deadPid()));

      // Force rmSync to fail ONLY for birth-staging paths: the staging
      // cleanup inside tryBirthFileLock now throws EACCES. The factory
      // receives no real-module argument (Bun 1.3.x) and module mocks are
      // not restorable, so the replacement module spreads a SNAPSHOT of the
      // real node:fs captured BEFORE the mock — every other fs call stays
      // real, and every other rmSync passes through to the snapshot, making
      // the wrapper inert outside the target (any later code in this test
      // file is unaffected). Under the OLD code the staging cleanup's EACCES
      // escaped the catch BEFORE the errno classification, aborting the whole
      // acquire; the fix warns, classifies the ORIGINAL ENOTEMPTY as "held"
      // and the retry loop proceeds to the steal + re-birth.
      const realFs = { ...(await import("node:fs")) } as typeof import("node:fs");
      mock.module("node:fs", () => ({
        ...realFs,
        rmSync: (p: string | URL | Buffer, opts?: object) => {
          if (typeof p === "string" && p.includes(".birth-")) {
            throw Object.assign(new Error("EACCES: permission denied, unlink"), { code: "EACCES" });
          }
          return realFs.rmSync(p, opts);
        },
      }));

      const ownershipToken = await acquireFileLock(lockPath);

      // The acquire completed: the stale lock was reaped and re-born by us.
      expect(readFileSync(join(lockPath, "pid"), "utf-8")).toBe(String(process.pid));
      // The staging-cleanup failure was logged, not swallowed — and it did
      // not mask the original ENOTEMPTY (the acquire retried instead of
      // throwing the cleanup's EACCES).
      expect(warnings.some((w) => w.includes("birth staging"))).toBe(true);

      // Cleanup still works through the pass-through wrapper.
      releaseFileLock(lockPath, ownershipToken);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      __resetFrameworkLogger();
    }
  });

  test("a forced tomb-reap cleanup failure warns and keeps acquisition fail-closed", async () => {
    const warnings: string[] = [];
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: (msg: string) => {
        warnings.push(msg);
      },
      error: () => {},
    });
    try {
      const dir = tempDir();
      const lockPath = join(dir, "append.lock");
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "pid"), String(deadPid()));
      // Make the already-renamed tomb non-writable at the deterministic hook
      // between victim rename and reap. The stale owner has been displaced,
      // but acquisition must remain fenced until the tomb can be reconciled.
      expect(await stealStaleFileLock(lockPath, {
        afterVictimRename: () => {
          const fence = join(dir, "append.lock.fence");
          const tombName = readdirSync(fence).find((name) => name.startsWith("tomb-"));
          expect(tombName).toBeDefined();
          chmodSync(join(fence, tombName!), 0o500);
        },
      })).toBe(false);
      expect(existsSync(lockPath)).toBe(false); // canonical stale lock is gone
      expect(warnings.some((w) => w.includes("tomb"))).toBe(true);

      // Restore the tomb's permissions so the afterEach sweep can remove it.
      const fence = join(dir, "append.lock.fence");
      const tombName = readdirSync(fence).find((name) => name.startsWith("tomb-"));
      expect(tombName).toBeDefined();
      chmodSync(join(fence, tombName!), 0o700);
    } finally {
      __resetFrameworkLogger();
    }
  });
});

// ---------------------------------------------------------------------------
// Post-rename liveness re-probe (ADR-0078, defense in depth): after the
// victim lock is renamed to a tomb, the reaper re-probes the TOMB before
// deleting it — a PID that now proves live (PID reuse, or a legacy owner
// becoming readable) is restored to the canonical path and the acquisition
// stays fenced. This was the single untested safety branch of the lock suite.
// ---------------------------------------------------------------------------

describe("stealStaleFileLock — post-rename liveness re-probe (never delete a live tomb)", () => {
  test("a tomb that proves live on the re-probe is restored and the acquisition stays fenced", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "append.lock");
    mkdirSync(lockPath);
    // The pid value is irrelevant — every liveness probe is hook-driven.
    writeFileSync(join(lockPath, "pid"), "4242");
    let probes = 0;

    const result = await stealStaleFileLock(lockPath, {
      probeOwnerProcess: (pid: number) => {
        probes += 1;
        if (probes === 1) {
          // First probe (the canonical lock): the owner reads as dead, so the
          // reaper displaces it into a tomb.
          const dead: NodeJS.ErrnoException = new Error(`kill ${pid} failed: ESRCH`);
          dead.code = "ESRCH";
          throw dead;
        }
        // Second probe (the TOMB, after the victim rename): the same pid now
        // proves alive — PID reuse or a legacy owner becoming readable.
      },
    });

    // Acquisition stayed fenced: the reaper gave up rather than deleting a
    // lock that now proves live.
    expect(result).toBe(false);
    expect(probes).toBe(2);
    // The tomb was RESTORED to the canonical lock path — mutual exclusion is
    // intact, nothing was deleted.
    expect(existsSync(lockPath)).toBe(true);
    const fence = join(dir, "append.lock.fence");
    const tombs = existsSync(fence) ? readdirSync(fence).filter((n) => n.startsWith("tomb-")) : [];
    expect(tombs).toEqual([]);
  });

  test("atomicWriteFile rejects empty and NUL-bearing paths (defense-in-depth guard)", () => {
    const dir = tempDir();
    // The public factories reject NUL-bearing directories before any path is
    // constructed; this pins the last-line guard itself so a refactor cannot
    // silently drop it.
    expect(() => atomicWriteFile("", "{}")).toThrow();
    expect(() => atomicWriteFile(join(dir, "bad\u0000name"), "{}")).toThrow();
    // No tmp litter from the rejected calls.
    expect(readdirSync(dir)).toEqual([]);
  });

  test("atomicWriteFile rejects non-string contents with a typed cache-error (last-line guard)", () => {
    // Every internal caller passes strings; this pins the guard itself so a
    // refactor cannot silently drop it, and the typed surface (FR-040): the
    // raw string throw is converted to the AD-6 typed failure.
    const dir = tempDir();
    let failure: unknown = null;
    try {
      atomicWriteFile(join(dir, "x.json"), 42 as unknown as string);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ kind: "cache-error", operation: "atomicWriteFile" });
    expect((failure as Error).message).toContain("contents must be a string");
    // No file or tmp litter from the rejected call.
    expect(readdirSync(dir)).toEqual([]);
  });
});
