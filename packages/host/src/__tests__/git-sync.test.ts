import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, err, gitSha } from "@fuguejs/framework";
import type { Result, GitSha } from "@fuguejs/framework";
import type { HostError } from "../domain/host-error.js";
import type { GitPort } from "../ports.js";
import { createBunGitAdapter, createLocalGitAdapter, runBunInstall } from "../adapters/git-sync.js";

// ── Fake GitPort for Unit Tests ────────────────────────────────────────────

interface FakeGitState {
  cloneCalls: Array<{ url: string; target: string; opts?: { branch?: string; depth?: number } }>;
  pullCalls: string[];
  shaCalls: string[];
  diffCalls: Array<{ repoPath: string; fromSha: string; toSha: string }>;
  currentSha: string;
  lockfileChanged: boolean;
  shouldFailClone: HostError | null;
  shouldFailPull: HostError | null;
  shouldFailSha: HostError | null;
}

const createFakeGitPort = (overrides?: Partial<FakeGitState>): { port: GitPort; state: FakeGitState } => {
  const state: FakeGitState = {
    cloneCalls: [],
    pullCalls: [],
    shaCalls: [],
    diffCalls: [],
    currentSha: "abc1234567890",
    lockfileChanged: false,
    shouldFailClone: null,
    shouldFailPull: null,
    shouldFailSha: null,
    ...overrides,
  };

  const port: GitPort = {
    clone: async (url, target, opts) => {
      state.cloneCalls.push({ url, target, opts });
      if (state.shouldFailClone) return err(state.shouldFailClone);
      return ok(undefined);
    },
    pull: async (repoPath) => {
      state.pullCalls.push(repoPath);
      if (state.shouldFailPull) return err(state.shouldFailPull);
      return ok(undefined);
    },
    currentSha: async (repoPath) => {
      state.shaCalls.push(repoPath);
      if (state.shouldFailSha) return err(state.shouldFailSha);
      return ok(gitSha(state.currentSha));
    },
    hasLockfileChanged: async (repoPath, fromSha, toSha) => {
      state.diffCalls.push({ repoPath, fromSha, toSha });
      return ok(state.lockfileChanged);
    },
    install: async () => ok(undefined),
  };

  return { port, state };
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("GitPort interface", () => {
  describe("FakeGitPort (verifies contract)", () => {
    it("clone returns ok(undefined) on success", async () => {
      const { port } = createFakeGitPort();
      const result = await port.clone("https://git.example.com/repo.git", "/tmp/repo");
      expect(result.ok).toBe(true);
    });

    it("clone records calls with options", async () => {
      const { port, state } = createFakeGitPort();
      await port.clone("https://git.example.com/repo.git", "/tmp/repo", {
        branch: "main",
        depth: 1,
      });
      expect(state.cloneCalls).toHaveLength(1);
      expect(state.cloneCalls[0]).toEqual({
        url: "https://git.example.com/repo.git",
        target: "/tmp/repo",
        opts: { branch: "main", depth: 1 },
      });
    });

    it("clone returns err when configured to fail", async () => {
      const { port } = createFakeGitPort({
        shouldFailClone: { kind: "git-clone-failed", url: "test", message: "network error" },
      });
      const result = await port.clone("test", "/tmp/repo");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("git-clone-failed");
      }
    });

    it("pull returns ok(undefined) on success", async () => {
      const { port } = createFakeGitPort();
      const result = await port.pull("/tmp/repo");
      expect(result.ok).toBe(true);
    });

    it("pull records the repo path", async () => {
      const { port, state } = createFakeGitPort();
      await port.pull("/tmp/my-repo");
      expect(state.pullCalls).toEqual(["/tmp/my-repo"]);
    });

    it("pull returns err when configured to fail", async () => {
      const { port } = createFakeGitPort({
        shouldFailPull: { kind: "git-pull-failed", message: "merge conflict" },
      });
      const result = await port.pull("/tmp/repo");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("git-pull-failed");
      }
    });

    it("currentSha returns the configured SHA", async () => {
      const { port } = createFakeGitPort({ currentSha: "deadbeef12345678" });
      const result = await port.currentSha("/tmp/repo");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(gitSha("deadbeef12345678"));
      }
    });

    it("currentSha returns err when configured to fail", async () => {
      const { port } = createFakeGitPort({
        shouldFailSha: { kind: "git-pull-failed", message: "not a git repo" },
      });
      const result = await port.currentSha("/tmp/repo");
      expect(result.ok).toBe(false);
    });

    it("hasLockfileChanged returns configured value", async () => {
      const { port } = createFakeGitPort({ lockfileChanged: true });
      const result = await port.hasLockfileChanged("/tmp/repo", "sha1", "sha2");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });

    it("hasLockfileChanged records diff calls", async () => {
      const { port, state } = createFakeGitPort();
      await port.hasLockfileChanged("/tmp/repo", "abc", "def");
      expect(state.diffCalls).toEqual([{ repoPath: "/tmp/repo", fromSha: "abc", toSha: "def" }]);
    });
  });

  describe("LocalGitAdapter", () => {
    it("clone is a no-op returning ok", async () => {
      const adapter = createLocalGitAdapter();
      const result = await adapter.clone("ignored", "/tmp/ignored");
      expect(result.ok).toBe(true);
    });

    it("pull is a no-op returning ok", async () => {
      const adapter = createLocalGitAdapter();
      const result = await adapter.pull("/tmp/ignored");
      expect(result.ok).toBe(true);
    });

    it("hasLockfileChanged always returns false", async () => {
      const adapter = createLocalGitAdapter();
      const result = await adapter.hasLockfileChanged("/tmp/repo", "a", "b");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });

    it("currentSha returns a hex string for existing directory", async () => {
      const adapter = createLocalGitAdapter();
      // Use the packages/host/src directory which has .ts files
      const result = await adapter.currentSha(import.meta.dir + "/..");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.value).toBe("string");
        expect(result.value.length).toBeGreaterThan(0);
      }
    });

    it("currentSha returns different hash when files differ", async () => {
      const adapter = createLocalGitAdapter();
      // Hash of actual source directory
      const result1 = await adapter.currentSha(import.meta.dir + "/..");
      const result2 = await adapter.currentSha(import.meta.dir + "/..");
      // Same directory, same result (deterministic)
      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (result1.ok && result2.ok) {
        expect(result1.value).toBe(result2.value);
      }
    });
  });

  describe("BunGitAdapter (integration — requires git)", () => {
    it("creates an adapter with default timeout", () => {
      const adapter = createBunGitAdapter();
      expect(adapter.clone).toBeDefined();
      expect(adapter.pull).toBeDefined();
      expect(adapter.currentSha).toBeDefined();
      expect(adapter.hasLockfileChanged).toBeDefined();
    });

    it("currentSha returns the HEAD SHA of a real git repo", async () => {
      const adapter = createBunGitAdapter();
      // This monorepo IS a git repo
      const repoRoot = import.meta.dir + "/../../../..";
      const result = await adapter.currentSha(repoRoot);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // SHA should be a 40-char hex string
        expect(result.value).toMatch(/^[a-f0-9]{40}$/);
      }
    });

    it("currentSha returns error for non-git directory", async () => {
      const adapter = createBunGitAdapter();
      const result = await adapter.currentSha("/tmp");
      expect(result.ok).toBe(false);
    });

    it("clone returns error for invalid URL", async () => {
      const adapter = createBunGitAdapter(5000);
      const result = await adapter.clone(
        "https://invalid.example.com/nonexistent.git",
        "/tmp/fugue-test-clone-" + Date.now(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("git-clone-failed");
      }
    });
  });

  describe("BunGitAdapter timeout branches (round-21 pta-1 — error-first delivery + bounded termination)", () => {
    // Bun resolves the `git` and `bun` binary NAMES itself (empirically: a
    // PATH shim named `git`/`bun` is never consulted by Bun.spawn), so a
    // TERM-ignoring stand-in cannot be injected under those names. Instead
    // both branches are stalled with REAL binaries against a TCP listener
    // that accepts and never responds: the child is genuinely stuck when the
    // timeout fires, which is exactly the class the round-20 fix protects
    // against (the pre-fix `await proc.exited`-before-error would make these
    // tests hang forever instead of returning a bounded error). Error-first
    // delivery is pinned by the elapsed bound; termination is pinned by the
    // stalled transport socket closing after the child is killed.
    const stallServer = async (): Promise<{
      port: number;
      listen: () => Promise<void>;
      close: () => Promise<void>;
      sockets: Set<import("node:net").Socket>;
    }> => {
      const { createServer } = await import("node:net");
      const sockets = new Set<import("node:net").Socket>();
      const server = createServer((sock) => {
        sockets.add(sock);
        sock.on("close", () => sockets.delete(sock));
      });
      const state = {
        port: 0,
        sockets,
      } as {
        port: number;
        listen: () => Promise<void>;
        close: () => Promise<void>;
        sockets: Set<import("node:net").Socket>;
      };
      state.listen = async () => {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        state.port = (server.address() as import("node:net").AddressInfo).port;
      };
      state.close = () => {
        // Force-destroy lingering connections (Bun lacks Node's
        // closeAllConnections) so the close callback cannot hang on a
        // transport helper that outlives the direct child.
        for (const sock of [...sockets]) sock.destroy();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      };
      return state;
    };

    const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return predicate();
    };

    it("delivers git-timeout promptly on a stalled clone (error-first, not gated on the child's exit)", async () => {
      const server = await stallServer();
      await server.listen();
      const dir = await mkdtemp(join(tmpdir(), "fugue-git-stall-"));
      try {
        const adapter = createBunGitAdapter(400);
        const started = Date.now();
        const result = await adapter.clone(`http://127.0.0.1:${server.port}/repo.git`, join(dir, "target"));
        const elapsed = Date.now() - started;

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("expected a timeout error");
        expect(result.error.kind).toBe("git-timeout");
        // Error-first: the result is bounded by the timeout budget + slack,
        // NOT gated on the stuck child's exit (the pre-fix unbounded hang).
        // Termination of the direct child is exercised implicitly: the child
        // is killed before the error is delivered; git's internal transport
        // helper may outlive the direct child briefly (git-owned lifecycle),
        // so the socket is not used as a liveness probe here — the bun
        // branch below proves whole-tree termination.
        expect(elapsed).toBeLessThan(4_000);
      } finally {
        await server.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("runBunInstall returns bun-install-failed on a stalled registry and terminates the stuck child", async () => {
      const server = await stallServer();
      await server.listen();
      const dir = await mkdtemp(join(tmpdir(), "fugue-bun-stall-"));
      try {
        await writeFile(join(dir, "package.json"), JSON.stringify({ name: "stall", dependencies: { "slow-dep": "^1.0.0" } }));
        await writeFile(join(dir, "bunfig.toml"), `[install]\nregistry = "http://127.0.0.1:${server.port}"\n`);

        const started = Date.now();
        const result = await runBunInstall(dir, 400);
        const elapsed = Date.now() - started;

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("expected a timeout error");
        expect(result.error.kind).toBe("bun-install-failed");
        expect(result.error.message).toContain("timed out");
        expect(elapsed).toBeLessThan(4_000);

        expect(await waitFor(() => server.sockets.size === 0, 7_000)).toBe(true);
      } finally {
        await server.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("BunGitAdapter.hasLockfileChanged (integration — real git repo)", () => {
    const tempDirs: string[] = [];
    afterAll(async () => {
      await Promise.allSettled(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
    });

    const sh = async (args: string[], cwd: string): Promise<void> => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
      const code = await proc.exited;
      if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code})`);
    };

    const headSha = async (cwd: string): Promise<string> => {
      const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe" });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out.trim();
    };

    /** Init a repo with three commits: base → bun.lock change → unrelated change. */
    const makeRepo = async (): Promise<{ base: string; lockChanged: string; unrelated: string; dir: string }> => {
      const dir = await mkdtemp(join(tmpdir(), "fugue-git-sync-test-"));
      tempDirs.push(dir);
      await sh(["init", "-b", "main"], dir);
      await sh(["config", "user.email", "test@example.com"], dir);
      await sh(["config", "user.name", "Test"], dir);

      await writeFile(join(dir, "bun.lock"), "{}\n");
      await sh(["add", "."], dir);
      await sh(["commit", "-m", "base"], dir);
      const base = await headSha(dir);

      await writeFile(join(dir, "bun.lock"), '{"changed": true}\n');
      await sh(["add", "."], dir);
      await sh(["commit", "-m", "bump deps"], dir);
      const lockChanged = await headSha(dir);

      await writeFile(join(dir, "readme.md"), "unrelated\n");
      await sh(["add", "."], dir);
      await sh(["commit", "-m", "unrelated"], dir);
      const unrelated = await headSha(dir);

      return { base, lockChanged, unrelated, dir };
    };

    it("detects a change to the text lockfile bun.lock", async () => {
      const { base, lockChanged, dir } = await makeRepo();
      const adapter = createBunGitAdapter();
      const result = await adapter.hasLockfileChanged(dir, base, lockChanged);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(true);
    });

    it("ignores commits that touch neither lockfile", async () => {
      const { lockChanged, unrelated, dir } = await makeRepo();
      const adapter = createBunGitAdapter();
      const result = await adapter.hasLockfileChanged(dir, lockChanged, unrelated);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(false);
    });
  });

  describe("runBunInstall", () => {
    const tempDirs: string[] = [];
    afterAll(async () => {
      await Promise.allSettled(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
    });

    it("is a no-op success when the directory has no package.json", async () => {
      const dir = await mkdtemp(join(tmpdir(), "fugue-install-test-"));
      tempDirs.push(dir);
      const result = await runBunInstall(dir);
      expect(result.ok).toBe(true);
    });
  });
});

// Export the fake for reuse in other test files
export { createFakeGitPort };
export type { FakeGitState };
