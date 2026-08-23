# PR Remediation — Round 37 (Deferred-Backlog Closeout)

**Branch:** `feat/f6-file-durable-runtime`
**Predecessor:** round 36 (`a201818`), plan `.claude/plans/2026-08-23-pr-remediation-round-36.md`
**Source review:** `.claude/reviews/review-and-fix-runs/standalone-review-20260823T000001Z-raf`

Round 36 fixed all 7 surviving criticals and 29 advisories, and **deferred 24**
advisories with reasons. This round closes that backlog: every deferred item is
now either implemented or dismissed with evidence. Nothing from the review
remains open.

No new review was run — the frozen scope and `result.json` from
`standalone-review-20260823T000001Z-raf` remain the authority, and every item
here is one of its `advisory_findings`.

## The two items that needed a decision, not a refactor

Round 36 flagged these as blocked on a judgment call. Both are now decided.

### `code-simplifier-27` — `host.ts` boot-abort cleanup vs `shutdown()`

The two teardown paths had **already diverged**, so merging required deciding
which behavior was correct. They disagreed on exactly two points, and each side
was right about one:

| | boot-abort | `shutdown()` | Correct |
|---|---|---|---|
| Logger failure | guarded (`try`/`catch` per log) | unguarded | **boot-abort** — a broken logger must not abort teardown; the resulting resource leak is worse than a lost line |
| Error rendering | `safeErrorMessage` | `e instanceof Error ? … : String(e)` | **boot-abort** — the same hostile-value hole `silent-failure-hunter-4` closed in the Redis adapters |
| `closeAll` failures | discarded | counted + named in a warn | **`shutdown()`** — a capability that failed to close during a failed boot left no record of which one |

**Resolved:** one `teardownAfterServerStop(context)` closure carrying the
**union of the stronger halves**. Stopping the server stays with each caller,
which is a genuine difference: `shutdown` calls `server.stop()`, while the
boot-abort path uses `stopBoundServerAfterBindFailure`, whose failure string is
folded into the returned error.

### `code-simplifier-4` — `capability-manager.checkHealth` unused

Round 36 framed this as "wire it in or delete". **Deleting it was the wrong
call**: `healthCheck()` is implemented by six adapters (pg, oracle, ms-graph,
fs, http-auth, and the path-resolving Graph wrapper) and is a documented
`CapabilityHandle` port field. `checkHealth` is its only consumer, so removing
it would have orphaned all six implementations — strictly *more* dead surface.

Wiring it onto a kubelet probe would also be wrong: each `healthCheck()` does
real I/O (a `SELECT 1`, a token re-acquisition, a `stat`), so hanging it off
`/health` puts unbounded I/O on the **liveness** path, where a slow-but-working
dependency gets the pod restarted. `/readiness` is polled just as often.

**Resolved:** wired as `GET /admin/capabilities/health` — operator-driven, run
on demand when someone is diagnosing, and admin-gated because the report names
every wired capability and echoes failure reasons. Three tests pin it: the admin
gate, the aggregation (including `overall: "degraded"` on one unhealthy
dependency without failing the request), and that handles are read at request
time rather than captured at wiring time.

Periodic polling feeding the host's degraded state remains a separate, unbuilt
feature — it needs a poll interval, a cached report and a state transition, none
of which this diagnostic invents.

## Structural items

| ID | Resolution |
|---|---|
| `code-simplifier-26` | `createHost` **763 → 611 lines**. The ~170-line HITL durable run engine became `wireHitlRunEngine`, with one deliberate improvement: the reconciliation sweep is returned as an explicit `HitlReconciliationHandle` (`stop`/`settle`) instead of two `let`s shared between wiring and teardown. The sweep's in-flight promise is now owned by the closure that creates it. |
| `code-simplifier-24` | `main.ts` / `worker-main.ts` share `buildRuntimeDeps`. This was a correctness hazard, not just noise: each optional capability is **gated**, so a capability wired in one entrypoint and not the other would make the same DAG boot under one topology and be rejected under the other, with the failure pointing at the DAG rather than the wiring. |
| `code-simplifier-31` | `checkpointer.load`'s inline 70-line file loop became `collectNodeEntries`. Its three failure channels stay distinct: an unreadable path fails the load (it is NOT evidence of malformed bytes), a parser **throw** fails the load (implementation defect), and a `corrupt` **verdict** is recorded and reading continues. |
| `architecture-tech-lead-1` | The inbound Bot Framework activity is parsed once into `ParsedActivity` at the entry point. `runId`/`nodeId` deliberately stay out of it — they go through `tryRunId`/`tryNodeId` at point of use, so a malformed id is a branded-type failure rather than a string that merely looks present. |
| `code-simplifier-43` | One `lazyJwks` primitive for both verifiers. Its two properties are the point: **single-flight** (the promise is cached, so N cold-cache requests share one metadata fetch instead of stampeding the IdP) and **reset-on-failure** (a cached rejection would wedge the verifier permanently). The two verifiers were documented as deliberately mirroring each other — which is the argument for one definition, not two. |

## Mechanical dedups

All collapse repeated shapes whose divergence would be a real fault, not just noise.

| ID | Resolution |
|---|---|
| `code-simplifier-5` | One 404 shape in `run-dag`; `available` derived from the registry (empty when absent). |
| `code-simplifier-7`, `-8` | `requireAuthIdentity` + `callerTeamLabel` in `dag-access.ts`, used by `runs.ts` and `list-dags.ts`. Each site keeps its own `details` — they describe different resources. |
| `code-simplifier-13`, `-41` | `watchGuarded` + `compareAndRun` in both Redis adapters. The UNWATCH is load-bearing: these turns share a connection, so a watch left dangling by a throwing turn would still be armed when the next turn's MULTI runs, silently aborting an unrelated caller's transaction. |
| `code-simplifier-14` | Ten hand-rolled try/catch wrappers → one `redisCall`. The port's whole contract is "never throw"; one method missing its catch would break it as an unhandled rejection far from the cause. |
| `code-simplifier-15`, `-16` | `hardStopAndForget` (evict / idle-evict) and `abortSpawn` (four `lazySpawn` aborts). Deleting the map entry BEFORE signalling is load-bearing — the crash watcher keys on it, so a deliberate SIGKILL must not read as a crash and respawn. |
| `code-simplifier-19` | `cleanEnvRecord` shared by both spawn adapters. |
| `code-simplifier-21` | `redisStep` in the registry adapter: a throw and a `!ok` are the same condition, and both must fail closed so the in-memory view is never advanced on a partial write. |
| `code-simplifier-22` | `normalizedField` for the six required config fields. A non-string folds to `""` rather than `String(...)`-coercing, so `{ dagsRoot: 123 }` is rejected as missing, not accepted as the path `"123"`. |
| `code-simplifier-23` | `loadRegistryAt` shared by `initialSync` / `executeSyncCycle`, so boot and steady-state cannot disagree about what a loaded registry is. |
| `code-simplifier-28` | `findUnsupportedKey` in `layout.ts` for four option parsers. The `typeof key !== "string"` half matters: a `Symbol` own key would pass a naive `has()` against a `Set<string>`. |
| `code-simplifier-30` | `readonlyContainer` for the Map/Set snapshot proxies. Its four steps are order-sensitive (memoize before populating, or a self-containing container recurses forever). |
| `code-simplifier-33` | `asNodeFrameworkError` in `types/errors.ts`. An already-typed error passes through unchanged; an untyped throw is `non-retriable` because replaying an unclassifiable failure re-runs the node's side effects. |
| `code-simplifier-34` | `eventEmission` constructor; the measurements key must be ABSENT, not present-and-empty. |
| `code-simplifier-38` | `failureEscalator` for the three Redis-backed counters. A copy that forgot to RESET on success would escalate forever after one bad minute. |
| `code-simplifier-39` | `requestGrant` for both Keycloak grants. The fail-closed credential check is the reason to share it — a grant that forgot it would reach Keycloak, and on to Entra, with nothing to present. |
| `code-simplifier-42` | `serializeLossless` for the three HITL durable records; a copy that skipped the round-trip proof would look identical at the call site while removing the guarantee. |
| `code-simplifier-46` | `rowValidationError` across all eight sites in adapter-oracle/adapter-pg. Omitting `retriability` would turn a deterministic schema mismatch into a retry storm. |

## Dismissed

- **`code-simplifier-45`** (`takeValue` in `cli/compose.ts` / `cli/new.ts`) — the
  reviewer's own assessment was "marginal — short and readable in place", and it
  is right. The closure **mutates the enclosing loop index**; sharing it would
  mean threading a mutable `{ index }` object through both loops, trading eight
  duplicated lines for a less readable mutation protocol. Left as-is.

## Validation

```bash
bun run typecheck   # clean, all 12 packages
bun run test        # 0 fail, all 12 packages
```

Round-36 baseline carried forward unchanged except for the three new
capability-health tests: framework 3071, host **2209** + 10 (was 2206 + 10),
adapter-fs 25, customer-summary 231, others green.
