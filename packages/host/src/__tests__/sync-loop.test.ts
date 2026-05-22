import { describe, it, expect } from "bun:test";
import { ok, err, gitSha, EMPTY_SHA } from "@fugue/framework";
import type { GitSha } from "@fugue/framework";
import type { HostError } from "../domain/host-error.js";
import type { GitPort, ModuleLoaderPort, BulkLoadResult } from "../ports.js";
import { executeSyncCycle, startSyncLoop } from "../sync/sync-loop.js";
import type { SyncConfig, SyncLogger } from "../sync/sync-loop.js";

// ── Fakes ──────────────────────────────────────────────────────────────────

const noopLogger: SyncLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const sha1 = gitSha("a".repeat(40));
const sha2 = gitSha("b".repeat(40));

const config: SyncConfig = {
  repoPath: "/tmp/dags",
  repoUrl: "https://github.com/test/dags.git",
  branch: "main",
  pollIntervalMs: 30_000,
  isLocalMode: false,
};

const localConfig: SyncConfig = { ...config, isLocalMode: true };

const fakeGit = (overrides?: Partial<GitPort>): GitPort => ({
  clone: async () => ok(undefined),
  pull: async () => ok(undefined),
  currentSha: async () => ok(sha2),
  hasLockfileChanged: async () => ok(false),
  install: async () => ok(undefined),
  ...overrides,
});

const fakeLoader = (overrides?: Partial<ModuleLoaderPort>): ModuleLoaderPort => ({
  loadDagModule: async () => ok({ id: "x" } as never),
  discoverDagPaths: async () => ok([]),
  loadAll: async (): Promise<BulkLoadResult> => ({ loaded: [], errors: [] }),
  ...overrides,
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("executeSyncCycle", () => {
  it("returns no-change when SHA is unchanged", async () => {
    const git = fakeGit({ currentSha: async () => ok(sha1) });
    const result = await executeSyncCycle(git, fakeLoader(), config, sha1, noopLogger);
    expect(result.kind).toBe("no-change");
    if (result.kind !== "no-change") return;
    expect(result.currentSha).toBe(sha1);
  });

  it("returns updated with new registry when SHA changes", async () => {
    const git = fakeGit({ currentSha: async () => ok(sha2) });
    const result = await executeSyncCycle(git, fakeLoader(), config, sha1, noopLogger);
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") return;
    expect(result.newSha).toBe(sha2);
    expect(result.registry).toBeDefined();
  });

  it("returns error when currentSha fails", async () => {
    const git = fakeGit({
      currentSha: async () => err({ kind: "git-spawn-failed", operation: "rev-parse", message: "fail" } as HostError),
    });
    const result = await executeSyncCycle(git, fakeLoader(), config, sha1, noopLogger);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.previousSha).toBe(sha1);
  });

  it("returns error when pull fails", async () => {
    const git = fakeGit({
      currentSha: async () => ok(sha2),
      pull: async () => err({ kind: "git-pull-failed", message: "network" } as HostError),
    });
    const result = await executeSyncCycle(git, fakeLoader(), config, sha1, noopLogger);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.syncError.kind).toBe("git-pull-failed");
  });

  it("skips pull in local mode", async () => {
    let pullCalled = false;
    const git = fakeGit({
      currentSha: async () => ok(sha2),
      pull: async () => { pullCalled = true; return ok(undefined); },
    });
    await executeSyncCycle(git, fakeLoader(), localConfig, sha1, noopLogger);
    expect(pullCalled).toBe(false);
  });

  it("runs install when lockfile changed", async () => {
    let installCalled = false;
    const git = fakeGit({
      currentSha: async () => ok(sha2),
      hasLockfileChanged: async () => ok(true),
      install: async () => { installCalled = true; return ok(undefined); },
    });
    await executeSyncCycle(git, fakeLoader(), config, sha1, noopLogger);
    expect(installCalled).toBe(true);
  });

  it("does not install when lockfile unchanged", async () => {
    let installCalled = false;
    const git = fakeGit({
      currentSha: async () => ok(sha2),
      hasLockfileChanged: async () => ok(false),
      install: async () => { installCalled = true; return ok(undefined); },
    });
    await executeSyncCycle(git, fakeLoader(), config, sha1, noopLogger);
    expect(installCalled).toBe(false);
  });

  it("runs defensive install when lockfile check fails (fail-safe)", async () => {
    let installCalled = false;
    const git = fakeGit({
      currentSha: async () => ok(sha2),
      hasLockfileChanged: async () => err({ kind: "git-spawn-failed", operation: "diff", message: "fail" } as HostError),
      install: async () => { installCalled = true; return ok(undefined); },
    });
    await executeSyncCycle(git, fakeLoader(), config, sha1, noopLogger);
    expect(installCalled).toBe(true);
  });

  it("returns error when defensive install fails", async () => {
    const git = fakeGit({
      currentSha: async () => ok(sha2),
      hasLockfileChanged: async () => err({ kind: "git-spawn-failed", operation: "diff", message: "fail" } as HostError),
      install: async () => err({ kind: "bun-install-failed", message: "install failed" } as HostError),
    });
    const result = await executeSyncCycle(git, fakeLoader(), config, sha1, noopLogger);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.syncError.kind).toBe("bun-install-failed");
  });

  it("isolates DAG load errors from successful loads", async () => {
    const loader = fakeLoader({
      loadAll: async () => ({
        loaded: [],
        errors: [{ path: "/bad/dag.ts", error: { kind: "import-failed", path: "/bad/dag.ts", message: "oops" } as HostError }],
      }),
    });
    const git = fakeGit({ currentSha: async () => ok(sha2) });
    const result = await executeSyncCycle(git, loader, config, sha1, noopLogger);
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") return;
    expect(result.errors.length).toBe(1);
    expect(result.registry.dags.size).toBe(0);
  });

  it("skips lockfile check on initial sync (lastSha is empty)", async () => {
    let lockfileChecked = false;
    const emptySha = gitSha("");
    const git = fakeGit({
      currentSha: async () => ok(sha2),
      hasLockfileChanged: async () => { lockfileChecked = true; return ok(false); },
    });
    await executeSyncCycle(git, fakeLoader(), config, emptySha, noopLogger);
    expect(lockfileChecked).toBe(false);
  });

  it("pulls before reading SHA in remote mode — detects remote changes", async () => {
    const calls: string[] = [];
    // Simulate remote: pull advances HEAD from sha1 → sha2
    const git = fakeGit({
      pull: async () => { calls.push("pull"); return ok(undefined); },
      currentSha: async () => {
        calls.push("currentSha");
        // After pull, local HEAD reflects remote
        return ok(sha2);
      },
    });
    const result = await executeSyncCycle(git, fakeLoader(), config, sha1, noopLogger);
    expect(result.kind).toBe("updated");
    // Verify pull happens BEFORE currentSha
    expect(calls[0]).toBe("pull");
    expect(calls[1]).toBe("currentSha");
  });

  it("skips pull on initial sync (lastSha is EMPTY_SHA) even in remote mode", async () => {
    let pullCalled = false;
    const git = fakeGit({
      currentSha: async () => ok(sha2),
      pull: async () => { pullCalled = true; return ok(undefined); },
    });
    await executeSyncCycle(git, fakeLoader(), config, EMPTY_SHA, noopLogger);
    expect(pullCalled).toBe(false);
  });
});

// ── startSyncLoop tests ───────────────────────────────────────────────────────

describe("startSyncLoop", () => {
  it("recovers if onStarted throws — next sync not deadlocked", async () => {
    let onStartedCallCount = 0;
    const git = fakeGit({ currentSha: async () => ok(sha2) });
    const handle = startSyncLoop(
      git,
      fakeLoader(),
      config,
      noopLogger,
      () => {
        onStartedCallCount++;
        if (onStartedCallCount === 1) throw new Error("onStarted boom");
      },
      () => {},
      () => {},
      () => {},
      sha1,
    );

    // First sync: onStarted throws, should recover
    const result1 = await handle.triggerSync();
    expect(result1.kind).toBe("error");

    // Second sync: should NOT be deadlocked
    const result2 = await handle.triggerSync();
    expect(result2.kind).not.toBe("skipped");

    handle.stop();
  });

  it("returns skipped when sync is already in progress", async () => {
    let resolve: (() => void) | undefined;
    const blockingGit = fakeGit({
      pull: () => new Promise((r) => { resolve = () => r(ok(undefined)); }),
    });
    const handle = startSyncLoop(
      blockingGit,
      fakeLoader(),
      config,
      noopLogger,
      () => {},
      () => {},
      () => {},
      () => {},
      sha1,
    );

    // Start a sync that blocks on pull
    const p1 = handle.triggerSync();

    // Try another sync immediately — should be skipped
    const result2 = await handle.triggerSync();
    expect(result2.kind).toBe("skipped");

    // Unblock and cleanup
    resolve?.();
    await p1;
    handle.stop();
  });
});
