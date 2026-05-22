/**
 * Git Sync — Port interface and Bun.spawn adapter.
 *
 * The GitPort interface is the boundary between the sync subsystem and git.
 * The BunGitAdapter implements it by shelling out to `git` via Bun.spawn.
 *
 * Dev mode: When `DAGS_LOCAL_PATH` is set, LocalGitAdapter reads the directory
 * directly and hashes file mtimes for SHA comparison.
 *
 * @satisfies FR-001 — Poll git branch and detect new commits by comparing SHAs
 * @satisfies FR-005 — Run bun install if bun.lockb changed between commits
 * @satisfies ADR-0034 — Raw git via Bun.spawn
 */

import { ok, err } from "@fugue/framework";
import type { Result } from "@fugue/framework";
import type { HostError } from "../domain/host-error.js";
import type { GitPort } from "../ports.js";

// Re-export for backwards compatibility
export type { GitPort } from "../ports.js";

// ── Bun.spawn Adapter ──────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;

interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

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
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
    });

    const result = await Promise.race([proc.exited, timeout]);

    if (result === "timeout") {
      proc.kill();
      // Wait for process to actually terminate before draining
      await proc.exited.catch(() => {});
      // Drain streams to release file descriptors
      await Promise.allSettled([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return err({
        kind: "git-timeout",
        operation: `git ${args.join(" ")}`,
      });
    }

    clearTimeout(timeoutId);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    return ok({ exitCode: result, stdout: stdout.trim(), stderr: stderr.trim() });
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

    return ok(sha);
  },

  hasLockfileChanged: async (repoPath, fromSha, toSha) => {
    const result = await spawnGit(
      ["diff", "--name-only", fromSha, toSha, "--", "bun.lockb"],
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

    // If stdout contains "bun.lockb", the lockfile changed
    return ok(result.value.stdout.includes("bun.lockb"));
  },

  install: (repoPath) => runBunInstall(repoPath),
});

// ── Local (Dev Mode) Adapter ───────────────────────────────────────────────

/**
 * Create a local filesystem adapter for dev mode.
 * Skips clone/pull — reads directory directly.
 * currentSha returns a hash of file modification times.
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

      return ok(Math.abs(mtimeHash).toString(16).padStart(8, "0"));
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
 * @satisfies FR-005 — Run bun install --frozen-lockfile when bun.lockb has changed
 */
export const runBunInstall = async (
  cwd: string,
  timeoutMs: number = 60_000,
): Promise<Result<void, HostError>> => {
  try {
    const proc = Bun.spawn(["bun", "install", "--frozen-lockfile"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
    });

    const result = await Promise.race([proc.exited, timeout]);

    if (result === "timeout") {
      proc.kill();
      // Wait for process to terminate before draining streams
      await proc.exited.catch(() => {});
      await Promise.allSettled([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return err({
        kind: "bun-install-failed",
        message: "bun install timed out",
      });
    }

    clearTimeout(timeoutId);

    if (result !== 0) {
      const stderr = await new Response(proc.stderr).text();
      await new Response(proc.stdout).text(); // drain stdout
      return err({
        kind: "bun-install-failed",
        message: stderr.trim() || `exit code ${result}`,
      });
    }

    // Drain streams on success path too
    await Promise.allSettled([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return ok(undefined);
  } catch (e) {
    return err({
      kind: "bun-install-failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
};
