# PR Remediation Plan — Round 15 (standalone review)

- **Branch:** `feat/f6-file-durable-runtime`
- **Review run:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-18-121200-f6-file-durable-runtime`
  (registered standalone-review, kind `all`, files null, dryRun false)
- **Frozen scope:** 308 files = full branch diff vs `origin/main` (merge-base `6c316cb53a9b7dfd88f2908b26108979eddbb04a`), HEAD `4d0f419` (post round-14).
- **result.json:** published by the registered program, digest `563847a7fed951365b416b92354f568d48ee2c97deebf8423a9cf9a1dfb406b6` (32,533 bytes).
- **Reviewers:** 7/7 (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead, code-simplifier).
  All seven attempt-1 captures were terminally rejected by the harness (`agent-failed: <role> exited without a successful result` — the local SGLang endpoint dropped every child connection under 7-way parallel load); the engine advanced all seven slots to attempt 2 and the retries were re-spawned **serially** (same requests, same task bytes, harness-level scheduling change only). All seven attempt-2 transcripts were captured and admitted.

## Surviving critical findings

**None.** `surviving_critical_findings: []`. No Refutation Panel was routed (empty critical set).

## Refuted-finding audit

**None.** `refuted_critical_findings: []` — nothing was refuted, nothing is carried as refuted evidence.

## Advisory dispositions (15 total: 12 accepted, 3 deferred, 0 dismissed)

Every claim was verified against the frozen source before disposition.

### Accepted — 12

| ID | Finding | Concrete fix |
|----|---------|--------------|
| code-reviewer-1 | `drain()` (`packages/host/src/supervisor/lifecycle/worker-lifecycle-manager.ts:592-600`) returns `ok(undefined)` for the `draining.ok && phase !== "draining"` arm, contradicting its own invariant comment ("surface it as a worker-unavailable rather than silent success"). Verified unreachable: `beginDrain` (`worker-lifecycle.ts:239`) hardcodes `phase: "draining"` in its ok value. | Collapse the guard to `if (!draining.ok)` and return `err(workerUnavailable(tenant))` on that single arm. Behavior-identical today (the other arm is unrepresentable); makes the comment true and the unreachable branch unrepresentable. This is the round-13 accepted distill that did not land. |
| silent-failure-hunter-1 | `WorkerRegistry.get` (`worker-registry-redis.ts:202`) maps a corrupt persisted record to `ok(null)` with no log and no prune — the `deserialize` contract ("caller treats as corrupt: best-effort prune") is honored by `reconcileReadopt` (warn + prune) but not by `get`. Verified. | In `get`, when `deserialize` yields `undefined`: emit `logger?.warn("[worker-registry] corrupt worker record — treating as absent, pruning", { tenant, key })` and prune the key (best-effort `del`, mirroring the reconcile path), then return `ok(null)`. Pin with the in-memory redis fake (corrupt raw value → ok(null) + warn + key pruned). |
| silent-failure-hunter-2 | `drainReap` (`bun-init-process-adapter.ts:87-96`) breaks the drain cycle on an FFI call-time fault with no log, counter, or escalation — a persistently broken `waitpid` seam leaks zombies indefinitely with zero signal. Verified. | Keep `drainReap` pure: add an optional `onFault?: () => void` invoked exactly once when a fault breaks the drain. In `createBunInitProcessAdapter`, wrap the resolved reaper with a consecutive-fault counter: on fault `faultCount += 1` and `logger?.error("[thin-init] waitpid FFI fault — reap cycle stopped; zombies will accumulate until the next SIGCHLD/interval", { faultCount })` on the first fault and every 10th; reset the counter on a fault-free cycle. Update the `drainReap` doc block (fault is now signaled, still retried by SIGCHLD/interval). Pin: `drainReap` with a throwing `reapOne` invokes `onFault` exactly once and stops; adapter-level pin of the counter/escalation via the injected seam. |
| pr-test-analyzer-1 | `data` getter's documented Map/Set/Date clone-isolation guarantee (`file/job.ts:172`) is unpinned — every snapshot-contract test uses plain objects only. Verified (`deepFreeze(structuredClone(snapshot))`). | Add a test: seed state with a `Map` (and `Set`/`Date` members), read `data` twice, mutate the first clone's `Map`, assert the second read and a subsequent durable checkpoint are untouched. |
| pr-test-analyzer-2 | The strict reader's per-file read errno branch for `EACCES` on an individual record file (`file/event-log.ts:102`) is unpinned — `EISDIR` is pinned permanent at per-file level, but the environment/retriable class (no `permanent` flag) is pinned only at the readdir level. Verified. | Add a test: single record file `chmod 0o000` (skip when running as root, where DAC is bypassed) → typed reader failure with no `permanent` flag (retriable), distinct from the EISDIR squat pin. |
| pr-test-analyzer-3 | The file freshness index follows symlinks when reading a digest-addressed singleton (`recordWrite` `readFileSync` ~:492, `findConflict` ~:555), unlike the file checkpointer's `verifyExistingFile`/`verifyDirectory` symlink rejection — an unpinned asymmetry between the two sibling backends in this PR. Verified (plain `readFileSync` follows symlinks; the write side's rename replaces the symlink). | Add a comment at the freshness-index read sites documenting the deliberate divergence (digest-addressed filenames are not caller-controlled path material — the caller's directory is the trust boundary, unlike the checkpointer's arbitrary node-key addressing), and add a test pinning the current behavior (symlink at the digest path is read through on `findConflict`; `recordWrite`'s rename replaces the symlink, not its target). |
| type-design-analyzer-1→**see deferred** | — | — |
| comment-analyzer-1 | `CompositeNodeKeyOpts` JSDoc (`checkpoint/composite-node-key.ts:32-34`) says "the options are ignored entirely" when `index` AND `attempt` are absent, but a namespace-alone save is rejected by `assertNoNamespaceAlone` (called at :142) per the 2026-08-14 ADR-0075 amendment. Verified. | Qualify the JSDoc: options are ignored entirely **except** a `namespace` alone (without `index`/`attempt`), which is rejected as ambiguous caller error per ADR-0075. |
| comment-analyzer-2 | `file/checkpointer.ts:23-24` module header says a save with no `index`/`attempt` is "byte-identical to a pre-extension save (stored key = the bare `nodeId`)" — but a namespace-alone save is rejected, so byte-identity holds only when `namespace` is also absent. Verified. | Qualify the header to "a save with no `index`, `attempt`, or `namespace`" (byte-identity clause), matching the amended ADR-0075 contract. |
| architecture-tech-lead-1 | `resumeFileJob` (`file/resume.ts`) performs event-log I/O on the caller's directory before any file-backend directory validation: `readFileEvents(directory)` at :191 precedes the first `isFileBackendPathString` gate inside `createFileJournal(directory)` at ~:212. E.g. `directory: ""` reads a CWD-relative `events/` first; `ResumeFileJobArgs.directory` documents no domain rule. Verified (step 0 gates `runId` only). | In step 0, alongside `runId`, re-validate `directory` with `isFileBackendPathString` and return a typed `cache-error(resumeFileJob)` (operation already in the closed `FileOperation` vocabulary, constructed through `fileCacheError` per SC-006) before `readFileEvents`. Document the directory domain on `ResumeFileJobArgs.directory` ("non-empty NUL-free string", matching the three factory siblings). Pin: `resumeFileJob({ directory: "" })` and a NUL-bearing directory → typed `cache-error(resumeFileJob)` with no I/O (mirror of the existing runId boundary re-validation suite). |
| code-simplifier-1 | The `default:` arm of the `typeof value` switch in `assertLosslessEventUnchecked` (`file/event-record.ts:465`) is unreachable — after the null/undefined early return, all seven reachable `typeof` results are explicitly cased — and its message interpolates a `typeof` value that cannot occur. Verified (no test pins the arm's message). | Delete the `default:` arm. Behavior-identical; makes the exhaustiveness visible. |
| code-simplifier-2 | The two inner catches in `appendEvent` (`file/journal.ts:380, :388`) re-wrap already-typed `serializeFileEventRecord`/`atomicWriteFile` rejections with the same operation and location the outer catch (:395) applies to every `withFileLock`-boundary failure — adding one redundant nested `appendEvent failed at run directory D:` layer, exactly the double-nesting the ride-through comments in atomic.ts/job.ts/freshness-index.ts say to avoid. Verified: `fsFailure` → `fileOperationError` infers the typed reason's `failureClass`, so class inference is preserved without the inner catches; the only nested-text pin (`file-job.test.ts:632`, "prefix exactly once") exercises the pre-lock FR-015 key path (job.ts ride-through), which these catches do not touch; the two per-file message pins (`file-journal.test.ts:1095` FR-009, `:1393` runtime-type-null) are `toContain` on inner content and survive. | Delete the two inner `try`/`catch` blocks; the single outer catch names the port-surface operation for every failure class (as its own comment states: "Re-tag both paths at the public journal boundary"). |
| code-simplifier-3 | The ride-through parity comments (`file/freshness-index.ts:~525` and `~583`) cite `journal.ts` as a ride-through exemplar, but the journal never rides typed errors through — it unconditionally re-wraps every throw (`fsFailure` at :241, :261, :300, :380, :388, :395). Verified (the real ride-throughs are `atomic.ts` acquireFileLock :458 and `job.ts` :250). | Correct both citations to the modules that actually ride through: `(atomic.ts/job.ts parity)`. Stays true regardless of whether code-simplifier-2 lands (the journal's outer catch still re-wraps). |

### Deferred — 3 (tracked to the scheduled `file/` + port deepen round)

| ID | Finding | Deferral reason |
|----|---------|-----------------|
| type-design-analyzer-1 | No in-scope `Checkpointer` backend pattern-validates `RunMeta.dagId` against the `DagId` brand's `DAG_ID_REGEX` (file codec `typeof`-checks at `checkpointer-codec.ts:261/328`; in-memory never checks). Verified. | The `Checkpointer` port is frozen (FR-042). Either fix — retyping `RunMeta.dagId` as `DagId` on the port, or adding `DAG_ID_REGEX` validation inside the codec — is an interface/behavior change to a frozen surface and belongs with the tracked port type-redesign / truthful-branding cluster (deferred across rounds 10–14) so the whole `RunId`/`NodeId`/`DagId` ownership question is adjudicated once. No wrongness rides on it now: `dagId` is never path material in scope, and both codecs fail closed on non-string shapes. |
| type-design-analyzer-2 | Public `InMemoryCheckpointer.__testRawMetas()` (`checkpoint/checkpointer.ts:473`) returns the live mutable internal `Map` through a publicly exported class. Verified (documented "test-only escape hatch … Production code MUST go through `setMeta`"). | Pre-existing framework convention (the `__test*`-in-barrel pattern predates this PR; code-reviewer verified it as unchanged-by-scope this round). The complete fix — test-only export surface, capability gate, or injected raw-state seed — is a shared-`checkpointerSuite` seam redesign spanning all three backends (in-memory, Redis, file): an interface change, not a distill, and the suite is the only consumer. No correctness defect in the interim (documented MUST + suite-owned). |
| type-design-analyzer-3 | `checkpoint/composite-node-key.ts` mixes three error channels — `compositeNodeKey` throws a plain `Error` (:140, documented as a contract-violation channel: "the file backend MUST re-validate identifiers with typed errors before calling this"), `parseCompositeNodeKey` returns `null` (:210), file-backend parsers return `Result` — forcing the only production call site (`file/checkpointer.ts:427`) to wrap/remap. Verified. | The throw is the documented brand-bypass channel with its single production call site already re-mapping to typed `writeFailed`; converting the pure encoder to `Result` is part of the tracked port type-redesign / structural-core cluster (deferred in rounds 10, 13, 14). No wrongness rides on it now. |

### Dismissed — 0

No claim failed verification; nothing is dismissed.

## Remediation start input

- `sourceRunsRoot`: `.claude/reviews/review-and-fix-runs`
- `sourceRun`: `standalone-2026-08-18-121200-f6-file-durable-runtime`
- `supportPaths`: [`.claude/plans/2026-08-18-pr-remediation-round-15.md`] — this plan file is created after the review run started, so it is dirty-but-not-in-frozen-scope; every code/test edit above targets in-scope files.

## Changed files (planned)

1. `packages/host/src/supervisor/lifecycle/worker-lifecycle-manager.ts` (code-reviewer-1)
2. `packages/host/src/supervisor/lifecycle/worker-registry-redis.ts` (silent-failure-hunter-1)
3. `packages/host/src/supervisor/lifecycle/bun-init-process-adapter.ts` (silent-failure-hunter-2)
4. `packages/host/src/__tests__/supervisor/lifecycle/worker-registry-redis.test.ts` (pin)
5. `packages/host/src/__tests__/supervisor/lifecycle/bun-init-process-adapter.test.ts` (pin)
6. `packages/framework/src/file/job.ts` — no code change (test only)
7. `packages/framework/src/__tests__/file-job.test.ts` (pr-test-analyzer-1 pin)
8. `packages/framework/src/__tests__/file-event-log… — see file-event-log suite file (pr-test-analyzer-2 pin)
9. `packages/framework/src/file/freshness-index.ts` (pr-test-analyzer-3 comment; code-simplifier-3 citation fix)
10. `packages/framework/src/__tests__/file-freshness-index.test.ts` (pr-test-analyzer-3 pin)
11. `packages/framework/src/checkpoint/composite-node-key.ts` (comment-analyzer-1 JSDoc)
12. `packages/framework/src/file/checkpointer.ts` (comment-analyzer-2 header)
13. `packages/framework/src/file/resume.ts` (architecture-tech-lead-1)
14. `packages/framework/src/__tests__/file-resume.test.ts` (pin)
15. `packages/framework/src/file/event-record.ts` (code-simplifier-1)
16. `packages/framework/src/file/journal.ts` (code-simplifier-2)

## Validation commands

```bash
cd packages/framework && bun run typecheck && bun test          # framework suite (expect prior 2895 + new pins, 0 fail)
cd packages/host && bun run typecheck && bun test               # host suite (expect prior 2019 + new pins, 0 fail)
cd .. && bun run typecheck                                      # workspace typecheck (12/12 projects)
cd packages/framework && bun run lint:boundaries                # SC-006 boundary-import gate
```

(Exact workspace script names confirmed at implementation time; the four compiler strictness checks from round-12 remain on.)

## Status (2026-08-18, post-implementation)

**All 12 accepted fixes are implemented and validated.** Validation evidence:

- `packages/framework`: `bun run typecheck` clean; `bun test` → **2881 pass / 0 fail** (2919 run, 38 skipped), incl. the new pins (Map/Set/Date clone isolation, per-file EACCES retriable class, symlink follow/replace, resume directory boundary ×4, drainReap onFault, reap-fault escalation ×4, corrupt-record observability ×2, beginDrain narrowed-type suite).
- `packages/host`: `bun run typecheck` clean; `bun test` → **757 pass / 0 fail**.
- Workspace: `bun run typecheck` → **12/12 projects exit 0**.
- Loom linter (`.claude/linter/rules` incl. the SC-006 boundary config, `--include-tests`): **183 violations before == 183 after — parity, zero deltas** (the one transient `max-function-lines` trip from the symlink comment was resolved by trimming the comment to one line).

**Phase 4 (registered remediation) is BLOCKED on an operator action** — not a validation failure:

- The remediation start (`remediation-2026-08-18-155943-f6-file-durable-runtime`, source run `standalone-2026-08-18-121200-f6-file-durable-runtime`, supportPaths = this plan) was **refused before any mutation** by the Loom runtime-skew guard: this Pi session loaded runtime revision `sha256:044b4ac0…`, but the loom checkout on disk is now `sha256:ce8f8a…` (new commit `8faa352` + in-flight uncommitted engine edits).
- No run directory was created; the refusal is the designed handshake, not a failure to diagnose around.
- **Operator action required: run `/reload` in this Pi session (or restart Pi), then the parent retries the exact remediation start + resume commands** (Phase 4), after which the engine stages/verifies/installs the index and the parent commits + pushes (no force-push) and files the Phase 5 report.

