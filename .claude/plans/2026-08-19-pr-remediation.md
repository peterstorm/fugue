# PR Remediation — 2026-08-19

- **Branch:** `feat/f6-file-durable-runtime` (clean tree at `b30bfd0`)
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-19-170800-f6-file-durable-runtime` (state: `done`)
- **Scope:** full branch diff vs merge-base (359 files, `kind: all`)
- **Result:** `1` surviving critical (upheld 3/3 by Refutation Panel), `0` refuted criticals, `16` advisories

## Surviving critical findings (mandatory)

### C1 — `comment-analyzer-1` (apps/customer-summary/src/validation/grounding.ts:51, critical)
JSDoc on `checkTopicGrounding` claims "a topic is grounded if the **majority** of its meaningful words appear in the source text", but the word-overlap branch grounds on `matchedWords.length >= 1` (single word or ≥4-char stem prefix). All three panel verifiers upheld (reproduction, intent, blast-radius).

**Fix:** Rewrite the JSDoc to state the true contract:
- direct mention, keyword-mapping hit, any-group substring+source hit → grounded;
- word-overlap fallback: **at least one** meaningful word (length > 3, non-domain-stop-word) or a ≥4-char stem prefix appears in source → grounded;
- topic whose meaningful-word set is empty (all `DOMAIN_STOP_WORDS`) always passes.
Add pinning tests in `apps/customer-summary/src/__tests__/grounding.test.ts`:
- multi-word topic with only ONE word in source passes (pins `>= 1`, not majority);
- stop-word-only topic ("customer support") passes with zero source overlap;
- stem-prefix-only match passes.

## Advisory dispositions (autonomous triage)

| id | claim | disposition | reason |
|---|---|---|---|
| silent-failure-hunter-1 | module-loader.ts readdir(promptsDir) bare catch swallows EACCES/ENOTDIR/ELOOP as "no prompts" | **accepted** | Real operator-misconfiguration silencing; sibling code in same function already routes non-ENOENT through `onFileError`/hard error. Probe errno; only ENOENT = absence. |
| pr-test-analyzer-1 | no test pins freshness `recordWrite`/`findConflict` boundary-validation rejections | **accepted** | Regression on any gate (witness kind, event type, finiteness) passes the suite; add hostile matrix to `file-boundary.test.ts` mirroring the journal's FR-015 matrix style. |
| pr-test-analyzer-2 | subclassed Map/Set/array FR-009 rejections untested | **accepted** | Round-trip backstop cannot self-detect this class; add small matrix next to existing hostile blocks in `file-event-record.test.ts`. |
| type-design-analyzer-1 | witness()/witnessValue()/stampWitness() never runtime-check kind | **accepted** | `WitnessKind` is a closed 6-value union the file adapter already gates; move the gate into the leaf that owns the union (`types/witness.ts`) so every minting path enforces it. `__brandWitness` deserialization bypass unchanged. |
| type-design-analyzer-2 | redis-freshness-index.ts:204 casts persisted witnessKind without `isWitnessKind` | **accepted** | Off-contract kinds from Redis bytes flow into conflict decisions; gate in `decodeMember` (treat as corrupt entry → `null`, same as shape failure). |
| type-design-analyzer-3 | `FileCheckpointCommit` declares nominal `[FILE_CHECKPOINT_COMMIT]: true` field no runtime object carries | **accepted** | One-line honesty fix: assign the key in the frozen minted object; WeakSet stays the real gate. |
| type-design-analyzer-4 | raw-string throws at job.ts:132/138/200, atomic.ts:73/76, freshness-index.ts:477 | **accepted** | Boundary shell already converts them (ADR-0080 holds), but the strings forfeit stack traces/`instanceof` for intermediate consumers; convert to `TypeError`/`Error` with identical messages (pins unaffected). |
| type-design-analyzer-5 | resourceName() doesn't enforce `system:entity[:id]` convention | **dismissed** | The brand enforces the invariant that matters (Witness↔SideEffectProfile cross-wiring; raw strings cannot mint a `ResourceName`), and the framework never parses resource beyond equality/digest. Production call sites legitimately violate the convention (`fetch.ts` uses `resourceName(config.id)`, `nodes/llm.ts` uses `llm:<model>`), so enforcement would be a breaking behavior change with no correctness driver. Convention stays documentation. |
| comment-analyzer-2 | checkSentimentConsistency JSDoc doesn't document numeric contract | **accepted** | Document exact thresholds: rejection requires 2× keyword imbalance AND ≥3 opposing indicators, asymmetric per direction; neutral always passes. |
| comment-analyzer-3 | checkTopicGrounding JSDoc omits unconditional stop-word pass | **accepted** | Folded into C1's JSDoc rewrite (same docblock) + pinned by test. |
| architecture-tech-lead-1 | RedisCheckpointer.load uses bare `this.now()` (throw escapes, NaN voids TTL); setMeta ignores clock seam | **accepted** | Add the shared `readClock` guard (copy of in-memory twin in `checkpoint/checkpointer.ts`) and stamp `serializeMeta` createdAt from the injected clock; hostile-clock corpus then covers the Redis leg via `clock-parity`/shared-suite pins. |
| architecture-tech-lead-2 | RedisCheckpointer.load reads `opts.expectedDagFingerprint` 3× without snapshotting | **accepted** | Snapshot once under a guard (exact in-memory pattern); stateful/throwing getter can no longer disagree across gate/comparison/payload. |
| code-simplifier-1 | event-log.ts readStrict inlines the `parseStoredEventRecord` composition | **accepted** | Reuse the barrel's documented text entry point; keep the `permanent: true` mapping (one error arm). |
| code-simplifier-2 | freshness-index triplicates witness-field validation | **accepted** | Extract `parseWitnessFields(raw, label, afterResource?)`; exact messages (`${label}.kind is not a WitnessKind`, etc.) and exact gate order preserved (stored-entry reader interposes digest/content agreement between resource and value). |
| code-simplifier-3 | ENOENT probe hand-spelled at ~10 sites | **accepted** | Promote verified-directory's private `isMissingPathError` to `types/safe-error.ts` (beside `probeErrorCode`), adopt at the named non-message sites. |
| code-simplifier-4 | buffered.ts two byte-identical dispatch-failure catches | **accepted** | Extract `accountDispatchFailure(event, error, prefix)`; replay-loop counts `replayFailures` outside; accounting contract (count + dead-letter-or-log, never both/neither) stated once. |

**Deferred:** none. **Dismissed:** type-design-analyzer-5 (evidence above).

## Refuted critical findings audit
None — the panel upheld the only critical (3/3: reproduction, intent, blast-radius). No refuted findings to report.

## Validation commands (run after implementation)
```bash
cd packages/framework && bun run typecheck && bun test
cd apps/customer-summary && bun test
cd packages/host && bun test
```
Full repo typecheck: `bun run typecheck` at root (tsconfig.base.json changed in branch).

## Remediation run
- Registered remediation run names this plan file as a `supportPath` (outside frozen review scope).
