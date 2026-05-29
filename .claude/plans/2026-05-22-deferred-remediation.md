# Deferred Items Remediation Plan — feat/fugue-host

**Date:** 2026-05-22
**Scope:** 5 deferred items from the comprehensive PR review

## Items

1. **GitSha branded type** — Replace raw `string` with branded `GitSha` across state machine, registry, sync-loop
2. **Full port consolidation** — Move all port interfaces to `ports/` directory
3. **CircuitPermit token pattern** — Type-enforce the check→execute→mark protocol
4. **HostInstance phase distinction** — Split into `RunningHost` / narrowed shutdown
5. **RedisPort → Result return type** — Encode failures at the type level

## Strategy

3 waves, ordered by dependency (ports consolidation first since others depend on it).

---

## Wave A — Port Consolidation + GitSha Brand

Move all port interfaces to `ports.ts` (single file, not directory — keeps import paths short).
Add `GitSha` branded type.

### A.1: Add GitSha to framework ids
- `packages/framework/src/types/ids.ts` — add `GitSha` type + constructor
- `packages/framework/src/types/index.ts` — export it
- No validation (SHAs can be any hex string or `""` sentinel)

### A.2: Consolidate ports into `ports.ts`
Move to `ports.ts`:
- `GitPort` (from `adapters/git-sync.ts`)
- `RedisPort` + `SharedInfra` (from `adapters/node-context-factory.ts`)
- `CircuitPort` + `CircuitConfig` (from `domain/circuit-guard.ts`)
- `RedisConnectivityPort` (from `lifecycle/startup.ts`)

Keep re-exports in original locations for backwards compatibility.

### A.3: Apply GitSha across host-state, registry, sync-loop
Replace `lastSyncSha: string` and `sha: string` with `GitSha`.

---

## Wave B — RedisPort → Result + CircuitPermit Token

### B.1: RedisPort returns Result
Change from throwing `Promise<string | null>` to `Promise<Result<string | null, HostError>>`.
Update all call sites (createNamespacedCache, createNamespacedCheckpointWriter).
Remove try/catch from call sites (no longer needed).

### B.2: CircuitPermit token pattern
`checkCircuit` returns a `CircuitPermit` token when allowed.
`markSuccess` and `markFailure` consume the permit — calling without one is a compile error.

---

## Wave C — HostInstance Typestate

### C.1: Split HostInstance into RunningHost
After `shutdown()` is called, the instance is consumed. Return a narrowed type that only exposes `getState`.

---

## Execution Order
```
Wave A → commit "refactor(host): consolidate ports, add GitSha branded type"
Wave B → commit "refactor(host): RedisPort Result type, CircuitPermit token"
Wave C → commit "refactor(host): HostInstance typestate (running/stopped)"
```
