/**
 * Git Sync — Port interface and Bun.spawn adapter.
 *
 * The GitPort interface is the boundary between the sync subsystem and git.
 * The BunGitAdapter implements it by shelling out to `git` via Bun.spawn.
 *
 * Dev mode: When `DAGS_LOCAL_PATH` is set, LocalGitAdapter reads the directory
 * directly and hashes file mtimes and sizes for SHA comparison.
 *
 * @satisfies FR-001 — Poll git branch and detect new commits by comparing SHAs
 * @satisfies FR-005 — Run bun install if the lockfile (bun.lock / bun.lockb) changed between commits
 * @satisfies ADR-0034 — Raw git via Bun.spawn
 */

import { join } from "node:path";
import { ok, err, gitSha as brandGitSha } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../domain/host-error.js";
import type { GitPort } from "../ports.js";


// ── Bun.spawn Adapter ──────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * How long a timed-out child gets after the initial SIGTERM before cleanup
 * escalates to SIGKILL. The timeout ERROR is never gated on this — the grace
 * window only bounds the background cleanup so a SIGTERM-ignoring child
 * (wedged git, D-state process) cannot turn the bounded timeout into an
 * unbounded hang.
 */
const KILL_GRACE_MS = 2_000;

interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Start bounded background cleanup without delaying delivery of a timeout error.
 * The caller retains operation-specific error construction; this helper owns the
 * shared SIGTERM → grace race → SIGKILL → stream-drain lifecycle.
 *
 * The whole cleanup is best-effort by design — the timeout error has ALREADY
 * been delivered when this runs — so a fault inside the IIFE (a rejecting
 * `drainStreams` under its `Promise<unknown>` contract, or a throwing
 * `forceKill`) must not escape as a process-level unhandled rejection with no
 * operator breadcrumb: terminal catch, logged, done.
 */
const cleanupTimedOutChild = (
  terminate: () => void,
  forceKill: () => void,
  exited: Promise<number>,
  drainStreams: () => Promise<unknown>,
): void => {
  terminate();
  const settled = exited.catch(() => 0);
  void (async () => {
    try {
      const winner = await Promise.race([
        settled,
        new Promise<"grace">((resolve) =>
          setTimeout(() => resolve("grace"), KILL_GRACE_MS),
        ),
      ]);
      if (winner === "grace") forceKill();
      await drainStreams();
    } catch (e) {
      console.warn(`[git-sync] bounded cleanup of timed-out child failed (timeout error already delivered): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
};

const runBoundedProcess = async (
  command: readonly string[],
  cwd: string | undefined,
  timeoutMs: number,
): Promise<SpawnResult | "timeout"> => {
  const proc = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe" });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const result = await Promise.race([proc.exited, timeout]);
  const drainStreams = async (): Promise<readonly [string, string]> =>
    Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

  if (result === "timeout") {
    cleanupTimedOutChild(
      () => proc.kill(),
      () => proc.kill("SIGKILL"),
      proc.exited,
      drainStreams,
    );
    return "timeout";
  }

  clearTimeout(timeoutId);
  const [stdout, stderr] = await drainStreams();
  return { exitCode: result, stdout: stdout.trim(), stderr: stderr.trim() };
};

/**
 * Execute a git command via Bun.spawn with timeout and stderr capture.
 * Returns exit code, stdout, stderr.
 */
const spawnGit = async (
  args: readonly string[],
  cwd?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Result<SpawnResult, HostError>> => {
  try {
    const result = await runBoundedProcess(["git", ...args], cwd, timeoutMs);
    if (result === "timeout") {
      return err({
        kind: "git-timeout",
        operation: `git ${args.join(" ")}`,
      });
    }
    return ok(result);
  } catch (e) {
    return err({
      kind: "git-spawn-failed",
      operation: `git ${args[0]}`,
      message: e instanceof Error ? e.message : String(e),
    });
  }
};

/**
 * Create a BunGitAdapter that shells out to the git binary.
 * All operations have configurable timeout and map errors to HostError.
 */
export const createBunGitAdapter = (timeoutMs: number = DEFAULT_TIMEOUT_MS): GitPort => ({
  clone: async (url, target, opts) => {
    const args: string[] = ["clone"];
    if (opts?.branch) args.push("--branch", opts.branch);
    if (opts?.depth) args.push("--depth", String(opts.depth));
    args.push(url, target);

    const result = await spawnGit(args, undefined, timeoutMs);
    if (!result.ok) return result;

    if (result.value.exitCode !== 0) {
      return err({
        kind: "git-clone-failed",
        url,
        message: result.value.stderr || `exit code ${result.value.exitCode}`,
      });
    }

    return ok(undefined);
  },

  pull: async (repoPath) => {
    const result = await spawnGit(["pull", "--ff-only"], repoPath, timeoutMs);
    if (!result.ok) return result;

    if (result.value.exitCode !== 0) {
      return err({
        kind: "git-pull-failed",
        message: result.value.stderr || `exit code ${result.value.exitCode}`,
      });
    }

    return ok(undefined);
  },

  currentSha: async (repoPath) => {
    const result = await spawnGit(["rev-parse", "HEAD"], repoPath, timeoutMs);
    if (!result.ok) return result;

    if (result.value.exitCode !== 0) {
      return err({
        kind: "git-spawn-failed",
        operation: "rev-parse HEAD",
        message: result.value.stderr || `exit code ${result.value.exitCode}`,
      });
    }

    const sha = result.value.stdout;
    if (!sha || sha.length < 7 || /^0+$/.test(sha)) {
      return err({
        kind: "git-spawn-failed",
        operation: "rev-parse HEAD",
        message: `rev-parse returned invalid or empty SHA: "${sha}"`,
      });
    }

    return ok(brandGitSha(sha));
  },

  hasLockfileChanged: async (repoPath, fromSha, toSha) => {
    // Bun ≥1.2 writes the text lockfile `bun.lock` by default; older repos
    // carry the binary `bun.lockb`. Watch both — missing the text variant
    // means dependency bumps never trigger reinstall and DAG imports break.
    const result = await spawnGit(
      ["diff", "--name-only", fromSha, toSha, "--", "bun.lock", "bun.lockb"],
      repoPath,
      timeoutMs,
    );
    if (!result.ok) return result;

    if (result.value.exitCode !== 0) {
      return err({
        kind: "git-pull-failed",
        message: `diff check failed: ${result.value.stderr || `exit code ${result.value.exitCode}`}`,
      });
    }

    // Non-empty stdout means at least one lockfile changed between the SHAs
    return ok(result.value.stdout.length > 0);
  },

  install: (repoPath) => runBunInstall(repoPath, timeoutMs),
});

// ── Local (Dev Mode) Adapter ───────────────────────────────────────────────

/**
 * Create a local filesystem adapter for dev mode.
 * Skips clone/pull — reads directory directly.
 * currentSha returns a hash of file modification times and sizes.
 *
 * NOTE: The mtime hash uses a simplified djb2-like algorithm. Hash collisions
 * are possible (two different file states → same hash → sync skipped).
 * Acceptable for dev mode. Workaround: touch any .ts file to force different mtime.
 */
export const createLocalGitAdapter = (): GitPort => ({
  clone: async () => ok(undefined),

  pull: async () => ok(undefined),

  currentSha: async (repoPath) => {
    try {
      const glob = new Bun.Glob("**/*.ts");
      let mtimeHash = 0;

      for await (const file of glob.scan({ cwd: repoPath })) {
        const stat = Bun.file(`${repoPath}/${file}`);
        const size = stat.size;
        const lastModified = stat.lastModified;
        // Simple djb2-like hash combining file modification times and sizes
        mtimeHash = ((mtimeHash << 5) - mtimeHash + lastModified + size) | 0;
      }

      return ok(brandGitSha(Math.abs(mtimeHash).toString(16).padStart(8, "0")));
    } catch (e) {
      return err({
        kind: "git-pull-failed",
        message: `local mtime hash failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  },

  hasLockfileChanged: async () => ok(false),

  install: async () => ok(undefined),
});

// ── Bun Install ────────────────────────────────────────────────────────────

/**
 * Run `bun install --frozen-lockfile` in the given directory.
 *
 * A directory without a `package.json` is a no-op success — a dags repo with
 * zero dependencies has nothing to install, and `bun install` erroring on it
 * must not block host startup.
 *
 * @satisfies FR-005 — Run bun install --frozen-lockfile when the lockfile has changed
 */
export const runBunInstall = async (
  cwd: string,
  timeoutMs: number = 60_000,
): Promise<Result<void, HostError>> => {
  try {
    if (!(await Bun.file(join(cwd, "package.json")).exists())) {
      return ok(undefined);
    }
    const result = await runBoundedProcess(
      ["bun", "install", "--frozen-lockfile"],
      cwd,
      timeoutMs,
    );
    if (result === "timeout") {
      return err({
        kind: "bun-install-failed",
        message: "bun install timed out",
      });
    }
    if (result.exitCode !== 0) {
      return err({
        kind: "bun-install-failed",
        message: result.stderr || `exit code ${result.exitCode}`,
      });
    }
    return ok(undefined);
  } catch (e) {
    return err({
      kind: "bun-install-failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
};
