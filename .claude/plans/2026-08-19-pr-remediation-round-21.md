# Round-21 PR Remediation — F6 File-Durable Runtime

- **Date:** 2026-08-19
- **Branch:** `feat/f6-file-durable-runtime` (working tree clean @ `78b2b51`)
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-19-183719-f6-file-durable-runtime`
- **Result:** `result.json` digest `e7aa0359f48a25e3eedd3f6415ca390fadbebb13448975183896575a3ce59302` (36,065 bytes)
- **Frozen scope:** 365 paths (changed-path union)
- **Outcome:** 0 surviving criticals · 0 refuted criticals · 21 advisory entries (18 unique claims; pr-test-analyzer-4/5/6 are duplicate registrations of pr-test-analyzer-1/2/3) → **16 accepted / 1 deferred / 1 dismissed**

## Critical findings

None. All seven reviewers reported zero criticals; the Refutation Panel did not run (empty critical set). `panel: null`.

## Advisory dispositions

| ID | Claim (abbrev.) | Disposition | Reason |
|---|---|---|---|
| silent-failure-hunter-1 | oracle `queryable.execute` unguarded `finally { await conn.close() }` masks a successful statement as failure; retry → double-execution hazard for DML | **accepted** | Verified `packages/adapter-oracle/src/index.ts:469-475`; sibling `connect()` path (:493-502) deliberately swallows release failures, `healthCheckWithTimeout`'s header (:528-538) names the production seam. Fix: nested release — capture the execute result, attempt close in a second try/catch with credential-stripped warn, return the primary outcome. Pinnable: `oracle-adapter.test.ts` already drives `mock.module("oracledb")` (5 sites). |
| silent-failure-hunter-2 | `findConflict` treats an undecodable latest-write member as `ok(null)` no-conflict — fail-open, bypassing the caller's ADR-0025 fail-closed contract | **accepted** | Verified `redis-freshness-index.ts:203-220` (undecodable member → fall-through `ok(null)`) vs `freshness-emission.ts:168-186` (err → wave abort, ADR-0025). File twin `file/freshness-index.ts:632-635` has the same soft path (`warnCorrupt` → `ok(null)`) — but its sibling corrupt branch (:563-573) is already deterministic fail-closed. Fix: both adapters return `cache-error` (`freshness:findConflict`) naming the corrupt member on this class; update the twin's provisional-`ok(null)` contract docs (:21, :456-462) and the deliberate pins (`file-freshness-index.test.ts`, `redis-freshness-index.test.ts`). |
| pr-test-analyzer-1 | git-sync round-20 timeout-branch fix unpinned (error-first delivery, KILL_GRACE_MS race, SIGKILL escalation) | **accepted** | Verified `git-sync.ts:56-82` rework in place; `git-sync.test.ts` has zero timeout-behavior coverage (`:204` smoke only). Fix: PATH-shim `git` fixture tests — prompt `git-timeout`/`bun-install-failed` delivery, error-not-gated-on-exit, SIGKILL escalation of a SIGTERM-ignoring child. Test file is OUT of scope → support path. |
| pr-test-analyzer-2 | `parsePersistedStatus` corrupt verdict (round-20) unpinned | **accepted** | Verified `run-store.ts:99-108` corrupt branch + caller `:309-314`; `redis-stores.test.ts` covers only meta/decision corrupt i-v-v, not the new verdict. Fix: seeded-Redis-fake tests exercising unparseable-meta → `{kind:"corrupt"}` treated-as-live + bounded warn. Test file is OUT of scope → support path. |
| pr-test-analyzer-3 | bootstrap.ts Redis-outage degradation + cache-error rendering untested; imported by zero tests | **deferred** | Claim verified (rendering present at `bootstrap.ts:237-257`), but a proportionate pin requires either a module-mock stack against an app entry point (`ioredis`/`@anthropic-ai/sdk`/`@azure/identity` imports, `bootstrap()` reads env and boots tracing/server) or a shell refactor exporting an app-internal seam — the same test-seam-cost class deferred at round-20 (`journalCapacityError`) and round-10 (A6). Tracked for the test round. |
| type-design-analyzer-1 | empty `backoffMs: []` passes the retry gate vacuously (no attempt-0 delay) | **accepted** | Verified `validate-dag.ts:117-118` (`every` vacuous) + `machine.ts:85` `??` default never fires for `[]`. Fix: reject empty ladders at the gate (`length === 0` → `validation`-kind error) AND type `NodeRetryConfig.backoffMs` as `readonly [number, ...number[]]` (illegal state unrepresentable; no `[]` construction exists repo-wide). Pins beside the round-20 gate pins (`validate-dag.test.ts:156-201`). |
| type-design-analyzer-2 | `retryLimits`/`defaultRetryLimit` forwarded through `validateDagShape` with a bare cast, no domain check | **accepted** | Verified `validate-dag.ts:446-450` bare `as Readonly<Record<string, number>>` pass-through; consumers (`retry-policy.ts getRetryLimit`, `handleNodeFailed`) compare against attempt counts. Fix: finite non-negative safe-integer checks at the same gate (reuse the `isNonNegativeSafeInteger` convention) for both fields + pins. |
| type-design-analyzer-3 | default `jitterRatio` encoded twice (`machine.ts:86` `?? 0.2`; `executor.ts:37` `DEFAULT_JITTER_RATIO`) | **accepted** | Verified both sites; one retry-delay computation, two defaults. Fix: single-source `DEFAULT_JITTER_RATIO` beside `applyJitter` in `shared/jitter.ts` (leaf both modules already depend on); machine and executor import it. `shared/jitter.ts` is OUT of scope → support path. |
| type-design-analyzer-4 | `FreshnessConflict`/`FreshnessCheckResult` exported but referenced nowhere — dead port surface | **dismissed** | Factually false premise: both types are LIVE — used by `checkFreshness` (`dag-runtime/freshness-check.ts:38,57`) and re-exported by `dag-runtime/index.ts:39` and the port file itself. They describe the pure in-memory check (multi-conflict result), not the index's first-conflict lookup; the naming overlap is a doc nuance, not dead surface. No fix. |
| comment-analyzer-1 | review-process provenance labels (`review C1/C2/C5/C7.5`, `review suggestion`, `deepening-round adjudication`, date-stamped remediation notes) in production JSDoc | **accepted** | Verified 14 sites (host.ts:168,452; domain/auth.ts:305,411; http/middleware/auth.ts:66; domain/config.ts:163; capability-scope.ts:107; graph-capability.ts:169; node-context-factory.ts:254,356; tool-use-loop.ts:91; composite-node-key.ts:22; checkpointer.ts:135; verified-directory.ts:3; file/checkpointer.ts:64; checkpointer-codec.ts:3). Fix: drop the unresolvable process labels, keep the durable rationale. |
| comment-analyzer-2 | `node-context-factory.ts:356` future-tense roadmap claim ("not yet on the broker's mintFor seam") | **accepted** | Fix: drop the "not yet" clause; the run-scoped meter is the deliberate current design. |
| comment-analyzer-3 | `keycloak-broker.ts:174` "T10 seam" — in-repo-undefined ambiguous label + negative-history phrasing | **accepted** | Fix: reword positively (handles constructed by `buildGraphHandle` over the WIF token; see `graph-capability.ts`), drop T10. |
| comment-analyzer-4 | keyed/keyless digest-disjointness argument duplicated in full at three+ doc sites | **accepted** | Verified `layout.ts:28-38`, `event-record.ts:34-43`, `event-record.ts` dedupKeyError inline, `eventDigestOf` JSDoc. Fix: keep the canonical argument at the `dedupKeyError` inline comment (where the enforcement lives); reduce the headers/JSDoc to pointers per the modules' own one-encoding/copies-drift policy. |
| architecture-tech-lead-1 | `resumeFileJob` constructs the full write-side `FileJournal` factory only to call `readCheckpoint`; run-directory read surface split across two modules/transports | **accepted** | Verified `resume.ts:243`; `FileJournal.readCheckpoint` has no other production consumer (grep). Fix: move the raw read (`string \| null`, ENOENT-only absence, typed `fsFailure("readCheckpoint", …)`) beside `readFileEvents` in `event-log.ts` as `readCheckpointFile(directory)`; resume uses it; `FileJournal.readCheckpoint` delegates. Behavior-identical (existing pins survive). |
| architecture-tech-lead-2 | `FoundryRunSummaryObserver` per-run buffer bounded only by the production wrapper — invariant in a comment, not structure | **accepted** | Verified `observability-composition.ts:112-123`; class is exported and constructed directly by 6+ test sites (option (a) unreachable). Fix: mirror the framework `BufferedObserver`'s own orphan-eviction discipline — TTL sweep over run-orphaned buffers with an injectable clock (house pattern at `observer/buffered.ts:83-124`), class safe standalone. |
| code-simplifier-1 | `parseCheckpoint` contract docblock duplicated near-verbatim (`resume.ts:147-166` vs `resume-proof.ts:171-190`), already drifted ("caught in the proof too" vs "caught here too") | **accepted** | Fix: canonical copy stays on `ResumeProofArgs.parseCheckpoint` (the proof owns the FR-040 guard); `ResumeFileJobArgs.parseCheckpoint` becomes one line + pointer. |
| code-simplifier-2 | `isValidDate` (checkpointer-codec.ts:153) dead export — one in-module use, no consumer, not in barrel | **accepted** | Verified grep: zero consumers outside the module. Fix: drop `export`. |
| code-simplifier-3 | `journal.ts:395-398` claims exactly one `appendEvent failed at run directory D:` layer; lock-body failures wrap appendEvent → withFileLock → appendEvent (phrase twice); `withFileLock`'s body catch lacks the `isFrameworkError` ride-through its sibling `acquireFileLock` catch has | **accepted** | Verified both catches (`atomic.ts:581-583` vs `:450-456`); the nested chain INCLUDING the `withFileLock` (lock-path) layer is deliberately pinned at `file-freshness-index.test.ts:906-932` — the structural ride-through would break that pinned diagnostic contract. Fix: correct the comment to the real chain (lock-body failures carry the `withFileLock` lock-path layer + the outer `appendEvent` layer; pre-lock failures carry one layer) — behavior-preserving. |

## Accepted fixes (16)

1. **adapter-oracle `execute`**: nested release — primary outcome preserved, close failure logged credential-stripped; new `mock.module("oracledb")` pin (close rejects after successful execute → result still ok).
2. **freshness fail-closed (both adapters)**: undecodable latest member / corrupt singleton → `cache-error "freshness:findConflict"` naming the member; docs (`file/freshness-index.ts` header + findConflict contract) and pins updated; the `:563` deterministic-fail-closed twin is the model.
3. **`git-sync.test.ts`** (support path): PATH-shim `git` fixture — (a) timed-out spawn returns `git-timeout`/`bun-install-failed` within the budget, not gated on `proc.exited`; (b) SIGTERM-ignoring child escalated to SIGKILL within the grace window (child PID observed dead); (c) `runBunInstall` twin.
4. **`redis-stores.test.ts`** (support path): seeded-Redis fake — corrupt run-meta JSON → `countActiveRuns` treats as live with exactly one bounded warn (verdict branch).
5. **`validate-dag.ts`**: empty `backoffMs` rejected (`validation`-kind); `NodeRetryConfig.backoffMs` typed `readonly [number, ...number[]]`; `retryLimits` values + `defaultRetryLimit` gated finite non-negative safe integers; pins at the round-20 gate tests.
6. **`shared/jitter.ts`** (support path): `DEFAULT_JITTER_RATIO` single-sourced; `machine.ts` + `executor.ts` import it.
7. **Provenance-label strip** (14 sites) — labels removed, rationale kept.
8. **`node-context-factory.ts`**: future-tense clause removed.
9. **`keycloak-broker.ts`**: T10 label + negative history reworded.
10. **Digest-disjointness docs**: canonical at `dedupKeyError` inline; `layout.ts` header, `event-record.ts` header, `eventDigestOf` JSDoc → pointers.
11. **`parseCheckpoint` docblock**: canonical on the proof; one-line pointer from the resume shell.
12. **`checkpointer-codec.ts`**: `isValidDate` export dropped (module-private).
13. **`journal.ts` comment**: corrected to the real wrap chain.
14. **`resume.ts`/`event-log.ts`/`journal.ts`**: narrow `readCheckpointFile` read seam; journal method delegates.
15. **`observability-composition.ts`**: TTL orphan sweep mirroring `BufferedObserver` (injectable clock) + pins.
16. **`oracle-adapter.test.ts`** pin and **`file-freshness-index.test.ts`/`redis-freshness-index.test.ts`** pin updates per fixes 1–2.

## Deferred (1)

- **pr-test-analyzer-3** (bootstrap degradation untested) — app entry-point harness cost; tracked for the test round. The round-20 rendering fix itself is verified in place.

## Dismissed (1)

- **type-design-analyzer-4** — types are live (see disposition table for grep evidence).

## Refuted-finding audit

None — the critical set was empty, so the Refutation Panel did not run. Nothing to report or preserve.

## Support paths (registered in the remediation start input)

- `.claude/plans/2026-08-19-pr-remediation-round-21.md` (this plan)
- `packages/host/src/__tests__/git-sync.test.ts` (fix 3)
- `packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts` (fix 4)
- `packages/framework/src/shared/jitter.ts` (fix 6)

## Validation

- `bun run --filter '*' typecheck` (root; all packages incl. framework bin tsconfig)
- `cd packages/framework && bun test` (full framework suite — 2,964 tests, includes freshness/validate-dag/resume/journal suites)
- `cd packages/host && bun run test` (host package script incl. signals suite; `git-sync.test.ts` targeted first)
- `cd packages/adapter-oracle && bun test` (oracle suite incl. new close-rejection pin)
- `cd apps/customer-summary && bun test` (observability-composition pins)
- Stop without staging/committing if any suite fails.
