# PR Remediation — 2026-08-19 (round 19)

- **Branch:** `feat/f6-file-durable-runtime` (clean tree at `c1a06af`)
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-19-173713-f6-file-durable-runtime` (state: `done`)
- **Scope:** full branch state — 363 files, `kind: all`
- **Result:** `1` surviving critical (upheld 3/3 by Refutation Panel), `2` refuted criticals, `22` advisories

## Surviving critical findings (mandatory)

### C1 — `comment-analyzer-1` (packages/host/src/hitl/__tests__/service.test.ts:548, critical)
The four `service.ts:NN` anchors in the test-comment **Headers** of `service.test.ts` (lines 548, 571, 609, 638) are stale — each cites a range that now holds different code, misdirecting readers by ~35–46 lines. All three panel verifiers upheld (reproduction, intent, blast-radius/security).

**Fix:** Re-anchor all four comments to the current ranges in `packages/host/src/hitl/service.ts`:
- `:548` corrupt-checkpoint settle → current block (~172–183)
- `:571` executor host-infra-err settle → current block (~209–227)
- `:609` `completed` fold → current block (~229–235)
- `:638` `putDecision`-then-enqueue-fail → current block (~274–289)
Anchors are verified against the actual code before writing (the verifiers' ranges are the starting point; the code is the authority). No test-code changes — comment-only.

## Advisory dispositions (autonomous triage)

| id | claim | disposition | reason |
|---|---|---|---|
| silent-failure-hunter-1 | BufferedObserver reads injected clock `this.now()` bare — non-finite clock silently disables orphan eviction forever, throwing clock crashes the sweep timer | **accepted** | Branch-wide clock discipline (ADR-0080 / readClock parity) already applied at the journal, both checkpointers, freshness-index, and RedisCheckpointer; this seam is the one observer violated. Guard the sweep clock exactly like `readClock`: catch throws → log + skip sweep; non-finite → warn + skip; stamp `createdAt` through the same guard. |
| silent-failure-hunter-2 | RedisCheckpointer `deserializeMeta`/`deserializeNode` pass `nodeCount`/`nodeId`/`dagId` from persisted bytes unchecked (negative/Infinity/string/undefined flows to consumers; file twin rejects the same bytes as `checkpoint-corrupt`) | **accepted** | Fail-closed parity: gate `nodeCount` with `isNonNegativeSafeInteger`, `dagId`/`nodeId` with `typeof === "string"`; violations throw the invalid-date-style error the existing catch maps to `checkpoint-corrupt`. The pass-through doc covers id-domain brands only, not numeric sanity. |
| pr-test-analyzer-3 | WorkerState ADT has no direct unit/property test | **dismissed** | Claim false — `packages/host/src/__tests__/supervisor/lifecycle/worker-lifecycle.test.ts` explicitly covers legal + illegal transitions, idle-evict vs eager-pin, drain, and property tests (`WorkerState` imported at line 29; `adoptDraining` re-adoption pinned). Same false-positive class as the refuted criticals. |
| pr-test-analyzer-4 | llm-meter/metred-llm zero tests | **dismissed** | Claim false — `packages/host/src/__tests__/llm-meter.test.ts` covers `accumulate`/`usageFor`/`budgetDecision`/`admitWithReservation` incl. NaN/Infinity hardening; `metered-llm.test.ts` has 19 tests. |
| pr-test-analyzer-5 | env-file-secrets-source fail-closed parsing zero tests | **dismissed** | Claim false — `packages/host/src/__tests__/supervisor/secrets/env-file-secrets-source.test.ts` covers parseEnvFile quotes/escapes/unterminated/export/empty-file fail-closed cases. |
| pr-test-analyzer-6 | realm-jwt-verifier JWKS classification untested | **dismissed** | Claim false — `packages/host/src/adapters/__tests__/realm-jwt-verifier.test.ts` pins valid → `SignatureVerified`, bad-sig/garbage → `invalid`, JWKS-down → `unavailable`, and alg-confusion allowlist rejection. |
| pr-test-analyzer-7 | circuit-breaker/circuit-guard zero tests | **dismissed** | Claim false — `packages/host/src/__tests__/circuit-breaker.test.ts` (`initCircuit`/`recordSuccess` closed→half-open→closed transitions) and `circuit-guard.test.ts` exist. |
| pr-test-analyzer-8 | dag-diff/git-sync/sync-loop untested | **dismissed** | Claim false — `packages/host/src/__tests__/diff.property.test.ts` (fast-check over `diffDags`/`hasChanges`/`diffSummary`) plus `git-sync.test.ts` and `sync-loop.test.ts` exist. |
| pr-test-analyzer-9 | `classifyGuardrailOutcome` dead or unpinned | **dismissed** | The "unpinned" half is false — `packages/framework/src/__tests__/classify-guardrail-outcome.test.ts` pins all branches. The "dead" half is accurate (no production importer; not package-public) but harmless: a pure, documented, tested classifier; removal would delete a pinned reference implementation. Residue is a distill-round candidate, not a defect. |
| type-design-analyzer-1 | replay `foldStep` shape-sniffs `RecordedEvent` envelopes; collision with domain events not unrepresentable | **deferred** | The envelope is JSON-persisted across backends — a runtime brand cannot survive serialization, so the unforgeable in-memory gate (weak-set pattern) would have to be installed at every reader seam (file + bullmq event logs) plus the fold. Documented in-code ("Envelope or raw event — same machine API"); no in-repo machine collides with the envelope shape. Port-interface consolidation → deepening round. |
| type-design-analyzer-2 | keyed dedup never verifies key→event binding; same-key different-event silently dropped | **deferred** | Deliberate durable contract, documented at journal.ts ("the filename digest suffix IS the durable fact") and pinned (SC-003 no-op only after commit). Content-verification on match is a spec-level append-contract change (what does a mismatch mean — error? new record?) with no in-repo caller violating the discipline. Needs a spec decision, not a code patch. |
| type-design-analyzer-3 | `RunState.nodes` keys untyped (canonical vs composite indistinguishable) | **deferred** | Port interface change (`Record<string, NodeState>` → branded key type) across all three checkpointers plus every nodes-iterating consumer (resume, executor, supervisor accounting). Interface adjudication → deepening round. |
| comment-analyzer-2 | dag-registration.ts NOTE mislabels the "placeholder" source; per-request NodeContext claim contradicted by wiring | **accepted** | Comment-only fix: reword the NOTE to state the real wiring (real `JsonFixtureSource` + placeholder `customerId` closed over by the assembly node; validated input payload carries per-request customer ids). |
| comment-analyzer-3 | oracle-adapter.test.ts:786 seam anchor points at pool construction, not the per-query seam | **accepted** | Re-anchor to `index.ts:459-464` (verified against code) or drop the line number and name the seam (Production queryable block). |
| architecture-tech-lead-1 | Checkpointer load-gate sequence triplicated across InMemory/Redis/File | **deferred** | Storage reads are interleaved with the gates differently per adapter (map get vs HSET reads vs fs reads), and the per-node corrupt-drop legs are adapter-specific (hash-field decode vs `parseNodeFile`) — the extractable pure core covers only the meta-level gates. Parity suite already pins observable equivalence; value is locality, not correctness. Consolidation → deepening round. |
| architecture-tech-lead-2 | FileFreshnessIndex re-implements Redis's ZSET member grammar for equal-score tie-break | **accepted** | Small, behavior-preserving consolidation: port-level `freshnessMemberKey` (+ byte-string comparator) in `types/freshness.ts`, consumed by `RedisFreshnessIndex.encodeMember` and `FileFreshnessIndex.selectLatestWrite`. Byte-identical output; parity pins already constrain both sides; the file test re-export (`__testSerializeRedisFreshnessMember`) keeps working via the shared function. |
| code-simplifier-1 | job.ts `\|`-hint rewrap double-nests the typed FR-015 rejection | **accepted** | Delete the special-case branch; the `isFrameworkError` ride-through (next lines) preserves the typed permanent `cache-error(appendEvent)` and its FR-015/computeDedupKey hint. Message contracts pinned on the journal error, not the rewrap. |
| code-simplifier-2 | shared FR-009 pre-scan hardcodes event-flavored labels; checkpoint-path failures misname `serializeFileEventRecord` and double the `(FR-009)` suffix | **accepted** | Parameterize the walk's operation/root labels (event defaults keep event-path messages byte-identical); checkpoint codec passes its own labels. No pin asserts the checkpoint path's inner label text. |
| code-simplifier-3 | `validCommit` pass-through at journal.ts:421-443 | **accepted** | Drop the variable and assignment; use `commit` directly after the `isFileCheckpointCommit` guard (try/catch + `TypeError`→`permanent` wrap unchanged). |
| code-simplifier-4 | `isMissingPathError` docs claim one encoding; five in-scope sites hand-spell `probe.kind === "code" && probe.code === "ENOENT"` | **accepted** | Sites already hold a probe (single-probe discipline forbids re-probing via `isMissingPathError`), so share the *rule*: add probe-accepting `isMissingPathProbe` beside `isMissingPathError` in `types/safe-error.ts`, adopt at the five sites (event-log.ts:91, checkpointer.ts:573, atomic.ts:491/514, freshness-index.ts:582), and update the doc to name both forms. |
| code-simplifier-5 | two ~200-line FR-009 walks (`assertLosslessEventUnchecked` vs `materializeCanonicalOutput`) already diverged | **deferred** | Reviewer explicitly assigns to `deepen`; consolidation crosses modules and pinned messages. Deepening round. |
| code-simplifier-6 | two encodings of the `{ now }` factory-options grammar (`parseFileFactoryClock` vs stricter `parseFileCheckpointerClock`) | **deferred** | Reviewer explicitly assigns to `deepen`; folding changes pinned hostile-Proxy behavior. Deepening round. |

**Accepted:** 9 (sfh-1, sfh-2, ca-2, ca-3, atl-2, cs-1, cs-2, cs-3, cs-4). **Deferred:** 6 (tda-1, tda-2, tda-3, atl-1, cs-5, cs-6 — all port-interface consolidations/contract decisions routed to the deepening round with evidence above). **Dismissed:** 7 (pta-3..9 — every claim contradicted by a dedicated in-scope test suite; the reviewer's "zero tests" class was already refuted 3/3 for its criticals by the panel).

## Accepted advisory fixes (in addition to C1)

1. **sfh-1** `observer/buffered.ts` — guarded sweep clock (throw → log, non-finite → warn, both skip the sweep; stamp `createdAt` through the guard). Pins: hostile-clock tests in `__tests__/buffered-observer.test.ts` (throwing clock leaves buffers + logs; NaN clock leaves buffers; finite clock evicts as before).
2. **sfh-2** `checkpoint/redis-checkpointer.ts` — `deserializeMeta`/`deserializeNode` shape gates (non-negative safe-integer `nodeCount`, string `dagId`/`nodeId`), thrown inside the existing try → `checkpoint-corrupt` mapping. Pins: hostile-meta/hostile-node rows in `__tests__/redis-checkpointer.test.ts` asserting `checkpoint-corrupt`, mirroring the file corpus.
3. **ca-2** `apps/customer-summary/src/dag-registration.ts` — reword the NOTE to the true wiring.
4. **ca-3** `packages/adapter-oracle/src/__tests__/oracle-adapter.test.ts:786` — re-anchor to `index.ts:459-464`.
5. **atl-2** `types/freshness.ts` — add documented `freshnessMemberKey(runId, nodeId, kind, value)` (exact `JSON.stringify([runId, nodeId, witnessKind, witnessValue])` tuple) and `compareFreshnessMemberKeys` (unsigned byte-string, Redis tie-break), with the ADR-0079 rationale; `redis-freshness-index.ts` `encodeMember` and `file/freshness-index.ts` `serializeRedisFreshnessMember`/`compareRedisMemberSerialization` become consumers (deleting the local copies; file test re-export preserved).
6. **cs-1** `file/job.ts` — delete the `dedupKey.includes("|")` rewrap branch.
7. **cs-2** `file/checkpoint-record.ts` + `file/event-record.ts` — parameterize `assertLosslessEventUnchecked`'s operation/root labels (event defaults); `updateData`/seed pass checkpoint labels. Exact messages preserved on the event path.
8. **cs-3** `file/journal.ts` — drop the `validCommit` pass-through.
9. **cs-4** `types/safe-error.ts` + five sites — add `isMissingPathProbe`; adopt at event-log.ts:91, checkpointer.ts:573, atomic.ts:491, atomic.ts:514, freshness-index.ts:582; doc updated.

## Refuted critical findings audit (never fixed — panel evidence retained)

- **`pr-test-analyzer-1`** (redis-acl.ts:311 — "cross-tenant Redis ACL isolation core has zero test references"): **refuted 3/3**. `packages/host/src/__tests__/supervisor/secrets/redis-acl.test.ts` imports and tests `buildAclSpec`/`aclUsername` (scope-only key pattern, no `~*`, command denials, cross-tenant non-overlap, fast-check properties, forged-TenantId defense); `worker-bootstrap.test.ts` tests `parseAclCredential` (both-present/absent/partial/blank/trimming); integration suites (isolation-redis-acl-real-server, isolation-cross-tenant-read, isolation-supervisor-secrets) exercise the spec end-to-end.
- **`pr-test-analyzer-2`** (grace-window-purge.ts:197 — "deregistration data deletion has zero tests"): **refuted 3/3**. `grace-window-purge.test.ts` covers `gracePurgeDueAt`/`isGraceWindowElapsed`/`selectPurgeable`/`purgeTenantFootprint` (step ordering + injected fail-closed partial failures with typed `failedSteps`)/`runGracePurgeSweep`; `purge-keyspace.test.ts` covers `purgeTenantKeyspace` best-effort enumeration (failing `del` does not abort, first error kept, scan abort, cursor pagination).

## Validation commands (run after implementation)

```bash
cd packages/framework && bun run typecheck && bun test
cd packages/host && bun test
cd apps/customer-summary && bun test
cd packages/adapter-oracle && bun test
```

## Remediation run

- The registered remediation run names this plan file as a `supportPath` (outside frozen review scope).
