# ADR 0031: Immutable Registry Snapshot

**Status:** Accepted  
**Date:** 2026-05-20  
**Spec ref:** `.claude/specs/2026-05-20-fugue-host/spec.md`  
**Related:** ADR 0030 (state machine with pure transitions), ADR 0033 (DagRegistration as host contract)

## Context

The host maintains a registry of all currently-loaded DAGs. This registry is read on every incoming HTTP request (to look up a DAG by ID) and written on every sync cycle (when the git repo is polled and DAGs are reloaded). These two access patterns are concurrent: HTTP handlers serve requests continuously while the sync loop periodically discovers, loads, and validates DAGs.

The fundamental tension is between serving requests with minimal latency (no locks, no coordination) and safely updating the registry when new DAG code arrives. A naive mutable `Map` would allow HTTP handlers to observe a half-loaded registry mid-sync (some DAGs from the old commit, some from the new), violating consistency.

The registry is small (tens to low hundreds of DAGs) and updates are infrequent (every 30s poll interval, only when the git SHA changes). The hot path is reads; writes are rare.

## Options Considered

1. **Immutable `ReadonlyMap` frozen per sync cycle with atomic reference swap (chosen)**
   - Pros:
     - Zero coordination on the read path — HTTP handlers hold a stable reference that never changes underfoot.
     - No locks, no mutexes, no read-write contention. JavaScript's single-threaded event loop guarantees atomic reference assignment.
     - Sync loop builds a complete new `Registry` from all successful loads, then swaps the reference in one assignment. No partial states observable.
     - Trivially testable — constructing a registry is a pure function call.
   - Cons:
     - Every sync cycle allocates a new `Map` and new `RegisteredDag` objects, even if nothing changed. Acceptable given the small size and low frequency.
     - Stale reads possible: a handler that captured the old reference before swap completes its request against the old registry. This is acceptable — the request was initiated before the update.

2. **Mutable `Map` with a read-write lock**
   - Pros:
     - Single data structure; no duplication.
     - Guaranteed fresh reads (if you acquire the read lock, you see the latest).
   - Cons:
     - JavaScript has no native read-write lock. Would need a custom async lock or `Atomics` with `SharedArrayBuffer`, adding complexity.
     - Contention: sync writes block reads (or vice versa). Under load, sync could delay request handling.
     - Race conditions if lock discipline is imperfect. Subtle bugs.
     - Overkill for a single-threaded runtime where reference swap is already atomic.

3. **Copy-on-write with structural sharing (persistent data structure)**
   - Pros:
     - Efficient for large collections with small deltas — shares unchanged subtrees.
     - Libraries like `immer` or `immutable.js` provide this.
   - Cons:
     - The registry is small (< 100 entries). Structural sharing provides no meaningful benefit.
     - Adds a library dependency for a problem solved by a plain `ReadonlyMap` + reference swap.
     - Increased complexity for debugging (proxy objects, custom serialization).

## Decision

**The registry is an immutable `ReadonlyMap<DagId, RegisteredDag>` frozen per sync cycle. HTTP handlers read the current snapshot reference; sync produces a new snapshot and swaps it atomically.**

Concrete design:

- **File:** `packages/host/src/domain/registry.ts`
- **Type:** `Registry` is a readonly interface with `dags: ReadonlyMap<DagId, RegisteredDag>`, `loadedAt: number`, and `sha: string`.
- **Builders:** Pure functions `emptyRegistry()`, `withDag(r, dag)`, `withoutDag(r, id)`, `freeze(dags[], sha, now)` — each returns a new `Registry` instance without mutating the input.
- **Swap mechanism:** The imperative shell holds a `let currentRegistry: Registry` reference. After sync completes and builds a new registry, a single `currentRegistry = newRegistry` assignment swaps it. JavaScript's single-threaded event loop guarantees this is atomic with respect to concurrent async operations.
- **Handler access:** HTTP handlers receive the registry reference at the start of request processing. Even if a swap occurs mid-request, the handler completes against the consistent snapshot it captured.
- **Key invariant:** Once `freeze()` returns a `Registry`, no mutation occurs to that instance. The `ReadonlyMap` type enforces this at compile time; no runtime `Object.freeze()` needed (TypeScript's structural typing is sufficient for internal code).

## Consequences

**Positive:**

- Zero-cost reads on the hot path. No lock acquisition, no contention, no blocking.
- Consistency guarantee: every HTTP request sees a complete, valid registry — never a mix of old and new DAGs.
- Simple mental model: registry is a value, not a mutable container. Easy to reason about, log, snapshot for debugging.
- Testability: building a registry for test fixtures is a single pure function call.

**Negative:**

- Memory duplication during sync: old registry stays alive until all in-flight requests referencing it complete. For a small registry (< 100 entries, each a few KB), this is negligible.
- A request initiated just before a swap will execute against the old registry. This is a design choice, not a bug — the alternative (blocking requests during sync) is worse for latency. The staleness window is bounded by request duration (max 120s timeout).
- No incremental updates: even if only one DAG changed, we rebuild the entire registry. Given the small size and 30s minimum sync interval, this is acceptable. If the registry ever grows to thousands of DAGs, incremental loading would be warranted.

## Prerequisite: ESM Module Cache Busting

The immutable snapshot pattern is necessary but **insufficient** for hot-reload. Bun (and all ESM runtimes) cache Module Records by resolved specifier. If the host pulls a new commit that modifies `dag.ts` and re-imports the same file path, the runtime returns the cached module — the "new" registry wraps the same closure as the old one.

The module loader addresses this via query-string cache busting:

```typescript
await import(`${modulePath}?v=${commitSha}`);
```

Each new git SHA produces a different specifier, forcing a fresh module evaluation. This is the critical mechanism that makes the immutable snapshot meaningful — without it, `freeze()` would produce a "new" registry containing identical stale references.

**Falsifiable invariant:** After a git pull that modifies `dag.ts`, the assertion `(await import(path + '?v=' + newSha)).default !== (await import(path + '?v=' + oldSha)).default` must hold. If equal, hot-reload is broken and the host ships first-seen DAG code frozen until process restart. This is tested in `module-loader.test.ts`.
