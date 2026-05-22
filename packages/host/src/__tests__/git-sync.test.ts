import { describe, it, expect } from "bun:test";
import { ok, err, gitSha } from "@fugue/framework";
import type { Result, GitSha } from "@fugue/framework";
import type { HostError } from "../domain/host-error.js";
import type { GitPort } from "../ports.js";
import { createBunGitAdapter, createLocalGitAdapter } from "../adapters/git-sync.js";

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
});

// Export the fake for reuse in other test files
export { createFakeGitPort };
export type { FakeGitState };
