# PR Remediation Plan — Round 38

**Branch:** `feat/f6-file-durable-runtime`
**Review HEAD:** `3ac4144a928df4f0cb4cdbb50b4f6a73f9026860`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-review-20260823T153900Z-raf`
**Canonical result:** `<run>/result.json` (digest `696740af75dea44a13e42d4a7c88911f685f7bd8e265922e11a674fe…`)
**Scope:** frozen 464-file list published by the registered Standalone Review Program (`kind: all`, `files: null`).
**Panel:** 3 lenses (`reproduction`, `intent`, `blast-radius`), refutation threshold 2.

Counts: 7 reviewers → 3 critical claims, 46 advisories.
Panel outcome: **2 surviving critical**, **1 refuted critical**, 46 advisories to disposition.

Baseline before any edit: `bun run typecheck` clean across all 12 workspaces; `bun run test` `0 fail` across all 12 workspaces.

---

## 1. Surviving critical findings (mandatory)

### SC-1 — `type-design-analyzer-1`: "Review output parsing failed — 1 of 3 critical findings not captured"

Panel: upheld by `reproduction`, refuted by `intent` (1 < threshold 2), `blast-radius` uncertain → **survives**.

**What actually happened.** The type-design reviewer's machine summary declared `CRITICAL_COUNT: 3` but emitted only two `severity: "critical"` entries. The third rated deep-dive block — the
`serializeValue`/`deserializeValue` depth ceiling — was self-labelled *advisory* (it is
`type-design-analyzer-4` in `result.json`). No content was lost by the parser; the emitter
under-rated its own third block.

**Remediation.** The honest response to "a critical was not captured" is to treat the
under-captured third block at critical weight and fix the defect it names, rather than to
"fix" a count. That defect is real and in scope:

`packages/framework/src/state-machine/serialize.ts` documents `MAX_SAFE_RECORD_DEPTH` (512) as
"the shared depth ceiling of **every** recursive walk in this grammar (`serializeValue`,
`deserializeValue`, `deepJsonEqual`, `validateSerializedValueGrammar`)". `deepJsonEqual` and
`validateSerializedValueGrammar` are iterative and enforce it. `serializeValue`/`deserializeValue`
are plain unbounded recursion with **no** internal check — the ceiling is enforced only by
callers that pre-scan. The `file/*` layer pre-scans; the Redis/BullMQ layer does not:

- `packages/framework/src/queue-bullmq/job.ts:137` (`deserializeValue(bullJob.data)`)
- `packages/framework/src/queue-bullmq/job.ts:159` (`serializeValue(d)` → `updateData`)
- `packages/framework/src/queue-bullmq/job.ts:189` (`serializeValue(envelope)` → XADD payload)
- `packages/framework/src/queue-bullmq/event-log.ts:132` (`deserializeValue(JSON.parse(raw))`)
- `packages/framework/src/queue-bullmq/adapter.ts:151` (`serializeValue(data)` → `queue.add`)

A hostile/deep tenant payload on the Redis backend therefore reaches the recursive walk unbounded
and overflows the stack (a `RangeError` at ~20k–50k frames) instead of failing closed at the
documented ceiling.

**Fix.** Push the ceiling into the grammar itself, where the module's own doc already claims it
lives: give `serializeValue` and `deserializeValue` an internal depth counter using **exactly**
`validateSerializedValueGrammar`'s counting convention (root at depth 0; containers count a hop;
primitive leaves do not), and fail closed with a typed `Error` when a container is reached at
`depth > MAX_SAFE_RECORD_DEPTH`.

Safety argument for "never tighter than an existing pre-scan": every file-layer pre-scan uses
`initialDepth` 0 or 1 with the same `maxDepth`, so a backstop rooted at 0 admits at least as much
as any pre-scan admits. Every one of the five Redis call sites above already wraps the call in a
`try`/`catch` that re-throws a named, loud error, so the new failure mode is delivered fail-closed
at each of them with no new silent path.

Regression pins: depth `512` round-trips; depth `513` fails closed in both directions; nesting via
plain objects, arrays, `Map` values and `Set` items each count a hop identically to the validator.

### SC-2 — `type-design-analyzer-3`: `checkpoint-write-failed` fabricates branded ids behind a doc-only contract

Panel: upheld by all three lenses → **survives** unanimously.

`packages/framework/src/types/errors.ts:71-93` declares:

```ts
readonly runId: RunId;      // may be the fabricated CHECKPOINT_INVALID_RUN_ID
readonly nodeId: NodeId;    // may be the fabricated CHECKPOINT_INVALID_NODE_ID
readonly invalidRunId?: string;
readonly invalidNodeId?: string;
```

with the guard stated only as prose: *"CONSUMER CONTRACT: inspect `invalidRunId` FIRST"*. A value
typed `RunId` that is not the address of a run is a representable illegal state, and the only
in-repo consumer that honours the contract (`formatFrameworkError`, `errors.ts:701`) does so by
convention. The `blast-radius` lens confirmed the variant round-trips through
`PersistedFrameworkErrorSchema` and reaches API/status consumers.

**Fix (type-enforced, wire-identical).** Replace the doc contract with a *correlated* union so the
narrowing is compulsory, without renaming or moving a single persisted field:

```ts
/** Inhabitant of the required legacy `runId` field when the raw boundary value
 *  was rejected. Deliberately NOT a `RunId`. */
export type CheckpointPlaceholderRunId = string & { readonly __checkpointPlaceholder: "run" };
export type CheckpointPlaceholderNodeId = string & { readonly __checkpointPlaceholder: "node" };

type CheckpointWriteRunAddress =
  | { readonly runId: RunId;                    readonly invalidRunId?: undefined }
  | { readonly runId: CheckpointPlaceholderRunId; readonly invalidRunId: string };

type CheckpointWriteNodeAddress =
  | { readonly nodeId: NodeId;                     readonly invalidNodeId?: undefined }
  | { readonly nodeId: CheckpointPlaceholderNodeId; readonly invalidNodeId: string };

| ({ readonly kind: "checkpoint-write-failed"; readonly message: string }
   & CheckpointWriteRunAddress & CheckpointWriteNodeAddress)
```

Before narrowing, `e.runId` is `RunId | CheckpointPlaceholderRunId` and is **not** assignable where
a `RunId` is required — the compiler now enforces what the comment asked for. Verified with a
standalone `tsc --strict` probe that TypeScript distributes the intersection over both unions, so
`if (e.invalidRunId === undefined)` narrows `e.runId` to `RunId`.

`CHECKPOINT_INVALID_RUN_ID` / `CHECKPOINT_INVALID_NODE_ID` change type from `RunId`/`NodeId` to the
placeholder types. `META_RECORD_NODE_ID` stays a `NodeId` (the meta-record case carries no
`invalidNodeId`, so it inhabits the first node arm).

**Residual, stated rather than hidden:** the *meta-record* placeholder (`checkpoint_meta`) remains a
fabricated `NodeId` indistinguishable at the type level from a real node of that name. Separating it
requires an additive on-the-wire discriminant, which is a persisted-format change beyond this
finding's claim; it is recorded here as a known residual, not fixed in this round.

Regression pins: a `tsc` type-level test asserting the unnarrowed field is rejected and the narrowed
one is accepted; the existing value-level corpora in
`__tests__/error-factories.test.ts`, `__tests__/file-checkpointer-codec.test.ts`,
`__tests__/file-checkpointer.test.ts` and `__tests__/redis-checkpointer.test.ts` must stay green
byte-for-byte (the wire shape does not change).

---

## 2. Refuted critical finding (audited — never fixed)

### `type-design-analyzer-2` — "`RunLease` is forgeable with a single `as` assertion"

**Verdict:** refuted 2/3 (`intent`, `blast-radius`), upheld only by `reproduction`.

- **`intent`:** `RunLease`'s own doc locates the ownership proof in the token, not the brand — *"The
  random owner token is checked atomically by persistence adapters"* — and the adapters do exactly
  that (`hitl/adapters/run-store.ts:385-393, 662-670` via `redis.setIfValue`; the in-memory
  authority compares `owners.get(lease.runId) === lease.ownerToken` at `:202`). The comment
  *"callers cannot build a lease by shape"* is literally true: `RUN_LEASE` is an unexported
  `unique symbol`, so a structural literal does not compile. Only an explicit `as` succeeds — and
  TypeScript permits `as` against every type, WeakSet-backed brands included.
- **`blast-radius`:** a forged lease grants **zero** effective authority. `hitl/service.ts:217-218`
  performs the lease-gated `setStatus running` write *before* any DAG execution ("Fail closed
  before executing"), and every lease-gated operation revalidates the token against Redis, returning
  `leaseLost` on mismatch. The type is confined to `packages/host/src/hitl` (the package exports only
  `./src/index.ts` and `./src/contract.ts`), with non-test construction only at
  `run-queue.ts:204` and `run-store.ts:199`.
- **`reproduction`** upheld the literal compile fact but itself recorded two caveats: the exact
  literal in the report names `RunLeaseOwnerToken`, which is **not exported**, so that repro compiles
  only inside `ports.ts`; and "a forged lease buys nothing at runtime".

**No code change.** The claimed security consequence does not hold; the runtime proof the type
delegates to is present, atomic and tested.

---

## 3. Advisory dispositions (46)

Decided autonomously from evidence, correctness impact, risk and reviewed scope, per the workflow
default. No operator input was requested.

### Accepted (36, one of them in part)

**Correctness / diagnostics**

| ID | Fix |
|----|-----|
| `silent-failure-hunter-1` | `supervisor/secrets/redis-acl-provisioner.ts` `apply`/`revoke` return the admin port's own (already credential-redacted) `HostError` instead of manufacturing a generic `redisUnavailable(<literal>)`; a new `redis-acl-provisioner.test.ts` pins that the original `operation` diagnostic survives. |
| `type-design-analyzer-4` | Same change as **SC-1** (this advisory *is* the under-rated third block). |
| `type-design-analyzer-7` | Brand the **compiled** `DagRetryState.retryLimits` to `Readonly<Record<NodeId, number>>`; the public authoring input stays `Record<string, number>` and `validate-dag.ts` performs the parse. |
| `type-design-analyzer-13` | Apply the `RawCheckpointJson` brand on the parallel read path `file/resume.ts` uses (`readCheckpointFile`), so the ADR-0077 consumer carries the same "must strict-parse" obligation in its type. |
| `type-design-analyzer-16` (in part) | `capability-manager.ts` keeps the narrower `Capability` typing on the handle map and through the whole topological traversal (`byName`, `visited`, `visiting`, `visit`). The finding's second half — making `extractClients` return a `Result` — is dismissed below with its reason. |

**Missing test branches**

| ID | Fix |
|----|-----|
| `pr-test-analyzer-1` | Test for `freshness-emission.ts:113` — a `writes` node declaring exactly one of `extractConditionedOn`/`extractNewWitness`. |
| `pr-test-analyzer-2` | Test for `human-review-hook.ts:116` — `markNotified` returning `ok(false)` (concurrent resolution), distinct from the store-error branch. |
| `pr-test-analyzer-3` | Test for `journal.ts:306` — per-entry `statSync` EACCES inside `appendEvent`'s listing loop, via the `0o600` chmod technique already used for the sibling branch in `event-log.ts`. |

**Structural extraction (long-deferred; pure moves, existing suites prove behaviour preservation)**

| ID | Fix |
|----|-----|
| `architecture-tech-lead-1` | Extract `planAppend` as a pure core from `file/journal.ts`'s `appendEvent`; `appendEvent` becomes the lock/I/O shell that executes the returned plan. |
| `architecture-tech-lead-2` | Extract `file/freshness-codec.ts` (types, `TTL_MS`, `isExpired`, `parseWitnessFields`, `prepareFreshnessWrite`, `parseConditionedOn`, `serializeStoredFreshnessEntry`, `parseStoredFreshnessEntry`, `selectLatestWrite`, `decideConflict`), mirroring the existing `checkpointer.ts` → `checkpointer-codec.ts` split. |

**Mechanical de-duplication / comment placement (`code-simplifier`, all 26)**

| ID | Fix |
|----|-----|
| `code-simplifier-1` | One `node-error` emit helper in `run-node.ts` replacing eight near-copies — this also closes a real inconsistency: two of the eight omit `sideEffects` the other six include. |
| `code-simplifier-2` | One routing-decision emit helper in `route-emission.ts` replacing three copies. |
| `code-simplifier-3` | Name the `onHumanReview` hook type once in `executor.ts` instead of declaring it inline twice. |
| `code-simplifier-4` | Collapse `validate-dag.ts`'s mirrored `sideEffects.kind === "writes"` guards ahead of the XOR check. |
| `code-simplifier-5` | `tryRunId`/`tryNodeId` reuse the factored check instead of re-inlining it. |
| `code-simplifier-6` | `witnessValue`/`witness` share the kind + non-empty-value check. |
| `code-simplifier-7` | `checkpointNodeId`/`buildCheckpointWriteFailed` compute the `ID_PATTERN` verdict once. |
| `code-simplifier-8` | One `conflictingWrite` projection shared by `freshness-check.ts` and `freshness-emission.ts`. |
| `code-simplifier-9` | One `WriteAttemptedEvent → WriteEntry` mapping in `freshness-check.ts`. |
| `code-simplifier-10` | One swallow-and-log helper shared by `freshness-emission.ts`, `node-span.ts` and `run-telemetry.ts`. |
| `code-simplifier-11` | `releaseFileLock`'s corrupt-pid and normal-pid branches share the token-read/gate/rmSync/throw block. |
| `code-simplifier-12` | One `readClock` shared by `InMemoryCheckpointer` and `RedisCheckpointer`. |
| `code-simplifier-13` | Move the misplaced JSDoc in `foundry-event-mapping.ts` onto `metricEmission`. |
| `code-simplifier-14` | One positive-integer range guard shared by `createQueue`/`createWorker`. |
| `code-simplifier-15` | One log-then-throw helper in `human-review-hook.ts` replacing six copies. |
| `code-simplifier-16` | `requireAuthIdentity` references `DagAccessDecision` instead of restating it. |
| `code-simplifier-17` | `authorizeRunAccess` reuses the imported `DagAccessDecision`. |
| `code-simplifier-18` | One 401 response helper in `http/middleware/auth.ts`. |
| `code-simplifier-19` | One shared `disconnectRedis`-failure handler for `main.ts` and `worker-main.ts`. |
| `code-simplifier-20` | One sweep-timer helper for `idleSweepTimer`/`livenessSweepTimer`. |
| `code-simplifier-21` | `hardDelete`/`hydrate` route through the adjacent `redisStep` helper. |
| `code-simplifier-22` | Move the misplaced `persistAndAnnounce` doc comment onto its subject. |
| `code-simplifier-23` | `onNoChange` calls the existing `isShuttingDown()` helper. |
| `code-simplifier-24` | Share the parse-SQL/execute/catch and row-validation loop across `adapter-oracle`'s real and fake clients. |
| `code-simplifier-25` | Share the try/catch-around-`pool.query` and row-validation loop across `adapter-pg`'s real and fake clients. |
| `code-simplifier-26` | Drop the two no-translation aliases for `encodePathSegments` in `adapter-ms-graph`. |

### Deferred (4) — sound, but the complete fix is a deepening-round-sized change

| ID | Reason |
|----|--------|
| `architecture-tech-lead-3` | A persisted brand for the `RecordedEvent` envelope changes the on-disk/on-stream event bytes and every reader seam (`replay.ts` fold, `file/resume-proof.ts:418`, the BullMQ stream reader). Not a live bug today — every current reader routes through the strict fail-closed reader first — and closing it is a migration round, not a local edit. |
| `type-design-analyzer-10` | Branding `sub`/`azp` crosses the JWT parse boundary, `RealmJwtClaims`, `AuthenticatedUser`, `AuthIdentity`, the auth middleware and the RFC 8693 token-exchange path. Worth doing, but it is a security-critical surface that deserves its own round rather than riding along with thirty other edits. |
| `type-design-analyzer-11` | The `worker-lifecycle-manager.ts` phase comparisons are guards interleaved with `await`s and early returns; a faithful conversion to an exhaustive `match` restructures the manager's control flow rather than editing an expression. |
| `type-design-analyzer-12` | Branding `keyDigest`/sequence in `file/layout.ts` against `JournalSequence` (defined one layer up in `event-record.ts`) requires moving the brand to avoid an import cycle; the reviewer confirms runtime digest/sequence revalidation means there is no live bug. |

### Dismissed (6, one of them in part) — the claim does not survive contact with the code, or restates a disclosed decision

| ID | Reason |
|----|--------|
| `type-design-analyzer-5` | `isFrameworkError`'s doc states it *is* discriminant inspection by design (ADR-0080), for a boundary whose only producer is the framework itself. Structural validation is `PersistedFrameworkErrorSchema`'s job at the persistence seam; tightening the guard would let a schema mismatch reject values the framework legitimately throws. |
| `type-design-analyzer-6` | `__brand*Unchecked` / `__brandWitness` are `@internal`, `__`-prefixed, and deliberately not re-exported from the package barrel. Bypassing validation on profiled hot paths is their entire purpose; "importable from any module in the package" is TypeScript's scoping limit, not a defect in these functions. |
| `type-design-analyzer-8` | TypeScript already refuses `event.rerouteActiveSet` after a bare `event.type === "human-responded"` check, and `reroute.ts:93-110` demonstrates the intended narrowing, so no consumer can mis-route today. Splitting the discriminant would rename a persisted event for no correctness gain. |
| `type-design-analyzer-14` | `file/job.ts:67-83`'s own comment already states in full that the marker is compile-time-only with no WeakSet guard, and argues the proportionality (in-package blast radius vs. `FileCheckpointCommit` crossing a port). The finding restates the module's disclosed decision. |
| `type-design-analyzer-15` | `circuit-guard.ts`'s comment already scopes the claim ("the type does not claim linear consumption"). Forging a `CircuitPermit` requires the same `CircuitPort` the forger would already hold, so it confers no authority. |
| `type-design-analyzer-9` | **Re-dispositioned during implementation** (originally accepted). `witness()`/`witnessValue()` are smart constructors, and `architecture.md` explicitly sanctions a throw for a constructor invariant. The only framework call path (`stampWitness` ← `dag-runtime/freshness-emission.ts`) already catches that throw and converts it into a typed `node-crash` at the wave boundary, so the Result-at-boundary discipline is honoured where it applies. Adding `tryWitness`/`tryWitnessValue` would export two functions with zero callers — the speculative generality `distill` exists to remove. |
| `type-design-analyzer-16` (in part) | The other half of this finding — `extractClients` returning a `Result` — is dismissed. Its throw guards an invariant `topoSortHandles` has already rejected at boot, its sole caller (`adapters/node-context-factory.ts`) is not Result-returning, and the module's own comment documents the branch as defence-in-depth. Converting it would push an unreachable error arm onto that caller. |

Every one of the 46 advisory IDs appears exactly once above: 37 accepted + 4 deferred + 5 dismissed.

---

## 3b. Deliberate behaviour changes

Two accepted fixes change observable behaviour rather than only its expression.
Both are named by their finding and are recorded here rather than left implicit:

1. **`code-simplifier-1`** — every `node-error` event `run-node.ts` emits now carries
   `sideEffects`. Two of the eight emission sites (checkpoint-replay rejection and
   input-validation failure) previously omitted it, so a buffered-observer post-mortem
   could not tell whether a node that failed those two ways was a writer. The field is a
   static property of the node, so carrying it uniformly adds information and removes
   none. No test pinned the omission.
2. **SC-1 (`serializeValue`/`deserializeValue`)** — a value nested past
   `MAX_SAFE_RECORD_DEPTH` now fails with a named, typed error where it previously
   recursed until the call stack overflowed with a raw `RangeError` (or, below ~20k, ran
   to completion). The five `queue-bullmq/*` call sites all already wrap the call in a
   `try`/`catch` that re-throws a named error, so the new failure is delivered fail-closed
   at each of them.

## 4. Validation

- `bun run typecheck` — all 12 workspaces, must stay at 0 errors.
- `bun run test` — all 12 workspaces, must stay at `0 fail`.
- New regression pins listed under SC-1, SC-2 and the accepted advisories.
- Green baseline captured before the first edit (typecheck clean, `0 fail` everywhere).

## 5. Remediation run

Support paths to register at remediation `start` (outside the frozen review scope):

- `.claude/plans/2026-08-23-pr-remediation-round-38.md`
- any new regression-test file added for an accepted advisory that is not already in the frozen list.
