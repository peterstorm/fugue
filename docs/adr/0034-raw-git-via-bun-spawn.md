# ADR 0034: Raw Git via Bun.spawn

**Status:** Accepted  
**Date:** 2026-05-20  
**Spec ref:** `.claude/specs/2026-05-20-fugue-host/spec.md`  
**Related:** ADR 0030 (state machine with pure transitions), ADR 0036 (layered error handling)

## Context

The host platform clones a separate git repository containing DAG code at startup, then periodically polls for new commits. Git operations required: `clone` (initial), `pull` (update), `rev-parse HEAD` (detect changes), and `diff --name-only` (detect lockfile changes between SHAs).

These are simple, well-defined git operations — not complex graph traversals or merge resolution. The host needs a reliable way to invoke them with proper error handling (timeout, exit code mapping, stderr capture).

The host runs in a Docker container (`oven/bun:1.2-alpine` with `git` installed via `apk`). Git CLI is guaranteed available in the production environment. The question is whether to use a JavaScript git library or shell out to the CLI.

## Options Considered

1. **Shell out to `git` via `Bun.spawn` with a `GitPort` interface for testability (chosen)**
   - Pros:
     - Zero library dependencies for git operations. No version skew between JS git implementation and actual git.
     - Full feature parity with git CLI — shallow clone, sparse checkout, SSH auth, credential helpers all work exactly as documented.
     - Simple implementation: spawn process, collect stdout/stderr, map exit code to `Result<T, HostError>`.
     - `GitPort` interface decouples the domain from the implementation — tests use a fake that returns predetermined results.
     - `Bun.spawn` is fast (no Node.js `child_process` overhead) and provides native `AbortSignal` support for timeouts.
   - Cons:
     - Requires `git` binary in the runtime environment. Docker image must include it (already accounted for in Dockerfile: `apk add --no-cache git`).
     - String parsing of git output (e.g., parsing SHA from `rev-parse`) is fragile if git changes output format. Mitigated: `rev-parse HEAD` output format hasn't changed in 15+ years.
     - Process spawning has higher latency than in-process calls. Acceptable — git operations happen at most once per poll interval (30s), not on the request path.

2. **isomorphic-git (JavaScript git implementation)**
   - Pros:
     - Pure JavaScript; no binary dependency.
     - Works in any runtime (browser, Node, Bun) without system git.
   - Cons:
     - Incomplete implementation: no shallow clone support, limited SSH auth, missing some transport protocols.
     - Heavy library (250KB+ minified) for operations we need four commands from.
     - Performance issues with large repos — JavaScript reimplementation of pack/unpack is slower than native git.
     - API is different from git CLI — team must learn a new abstraction for familiar operations.
     - Active maintenance concerns — library has periods of low activity.

3. **simple-git (Node.js wrapper around git CLI)**
   - Pros:
     - TypeScript types, promise-based API.
     - Handles process spawning and output parsing.
   - Cons:
     - Adds a dependency that provides no value over direct `Bun.spawn`. The library is a thin wrapper; we'd be depending on someone else's spawn + parse logic when ours is ~50 lines.
     - Node.js-oriented: uses `child_process` under the hood, not `Bun.spawn`. May not leverage Bun's faster process spawning.
     - Another package to audit, update, and track CVEs for.
     - The `GitPort` interface already gives us a clean API boundary — `simple-git` would sit between our port and the CLI with no added value.

## Decision

**Shell out to `git` CLI via `Bun.spawn` for all git operations. Wrap in a `GitPort` interface for testability.**

Concrete design:

- **Port interface:** `packages/host/src/adapters/git-sync.ts` exports `GitPort`:
  ```typescript
  interface GitPort {
    readonly clone: (url: string, target: string, opts?: { branch?: string; depth?: number }) => Promise<Result<void, HostError>>;
    readonly pull: (repoPath: string) => Promise<Result<void, HostError>>;
    readonly currentSha: (repoPath: string) => Promise<Result<string, HostError>>;
    readonly hasLockfileChanged: (repoPath: string, fromSha: string, toSha: string) => Promise<Result<boolean, HostError>>;
  }
  ```
- **Implementation:** `BunGitAdapter` implements `GitPort` using `Bun.spawn("git", [...args])`.
  - Each operation has a configurable timeout (default 60s for clone, 30s for pull/rev-parse).
  - Non-zero exit codes map to specific `HostError` variants (`git-clone-failed`, `git-pull-failed`, `git-timeout`).
  - stderr is captured and included in error messages for debugging.
  - `AbortSignal` passed to `Bun.spawn` for timeout enforcement.
- **Test fake:** `FakeGitPort` in test utilities returns predetermined `Result` values. No actual git processes in unit tests.
- **Integration tests:** Create temporary bare repos with `git init --bare`, push fixture DAGs, exercise the real `BunGitAdapter` against them.
- **Dev mode:** When `DAGS_LOCAL_PATH` is configured, a `LocalGitAdapter` implements `GitPort` with no-ops for clone/pull and a file-mtime hash for `currentSha`. Same interface, different behavior.

## Consequences

**Positive:**

- Zero library dependencies for git. Smaller install size, no supply chain risk from git libraries.
- Full git feature set available — SSH keys, credential helpers, sparse checkout, shallow clone. No library limitations.
- `GitPort` interface makes the adapter trivially replaceable. If a compelling git library emerges, swap the implementation without touching any consumer.
- Integration tests exercise real git behavior in temp repos — high confidence that production clone/pull works correctly.

**Negative:**

- Runtime dependency on `git` binary. The Dockerfile must install it. If someone tries to run the host without git installed, they get a cryptic "command not found" error. Mitigated: startup validates git is available before attempting clone.
- String parsing of git output (e.g., trimming newline from `rev-parse` output). If git ever changes output format, parsing breaks. Risk is near-zero for the commands we use.
- Process spawn overhead per git operation (~5-10ms). Irrelevant for a 30s poll interval.
- Error messages from git are unstructured text. We capture stderr but can't programmatically distinguish between "auth failed" and "network unreachable" without string matching. Current approach: include raw stderr in `HostError.message` and let operators read it.
