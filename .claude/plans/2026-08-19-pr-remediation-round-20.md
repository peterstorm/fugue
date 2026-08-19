# Round-20 PR Remediation — F6 File-Durable Runtime

- **Date:** 2026-08-19
- **Branch:** `feat/f6-file-durable-runtime` (base `origin/main` @ `6c316cb5…`)
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-19-181832-f6-file-durable-runtime`
- **Result:** `result.json` sha `69aaedfb8fc3fba6e03513a1acb9fc68d573e22eaa262d1eaa649cdc01f0be70` (34,270 bytes)
- **Frozen scope:** 364 paths (changed-path union)
- **Outcome:** 0 surviving criticals · 0 refuted criticals · 16 advisories → **10 accepted / 6 deferred / 0 dismissed**

## Critical findings

None. All seven reviewers reported zero criticals; the Refutation Panel did not run (empty critical set).

## Advisory dispositions

| ID | Claim (abbrev.) | Disposition | Reason |
|---|---|---|---|
| silent-failure-hunter-1 | git-sync timeout branches await `proc.exited` before returning the error; kill result ignored → bounded timeout degenerates to unbounded hang | **accepted** | Verified both sites (`spawnGit` :56-63, `runBunInstall` :249-259): cleanup gates error delivery; a SIGTERM-ignoring child stalls `executeSyncCycle`/`initialSync` forever with no error. Fix: deliver the timeout error first; bounded (2 s grace) background kill→SIGKILL escalation + stream drain that can never delay the error. |
| silent-failure-hunter-2 | bootstrap.ts cache get/set fallbacks log only `r.error.kind`, dropping cache-error operation/message | **accepted** | Verified :237-253; sibling `checkpointWriter` path (:267-268) already renders `— ${r.error.message}` — internal inconsistency. Fix: render message for `cache-error` at both `get` and `set`. |
| silent-failure-hunter-3 | `persistedStatusIsTerminal` silently swallows malformed run-meta JSON in the active-index self-heal | **accepted** | Verified :91-99 — silent catch; the same module logs corrupt meta everywhere else (`readMeta` :202-208, prune failures :294-303). Fix: verdict-returning parse (`terminal` / `live` / `corrupt` with parse error); caller logs a bounded warn before treating corrupt as live. Behavior preserved (corrupt still counts). |
| pr-test-analyzer-1 | resume.ts `readCheckpoint` non-FrameworkError re-tag arm unreachable through public paths; header FR-040 hostile-journal claim is doc-only | **accepted** | Verified :233-247 — arm is defense-in-depth; claim overstates a hostile journal as expected. Fix: keep the totality fence (ADR-0080), reword header + inline comment to state it is a boundary-totality fence against internal contract drift, not an expected hostile path. No injection seam (would add test-only API surface for a statically-imported factory). |
| pr-test-analyzer-2 | journal append-time capacity gate pinned only via exported `journalCapacityError` seam, never in-path | **deferred** | Deepening-round D4 sanction: `journalCapacityError` is a test-owned seam by design. An in-path pin costs 1,000,000 real event files (CI-heavy) or a production `maxSequences` knob (new message-contract and dedup interplay surface). Prior-round precedent: round-10 A6 dismissed the same end-to-end capacity request; reviewer self-rated 3/10 "deliberate tradeoff". Tracked. |
| type-design-analyzer-1 | `checkpoint-write-failed` placeholders `checkpoint_invalid_run`/`checkpoint_invalid_node` are grammar-valid and value-indistinguishable from real ids | **deferred** | Deliberate design adjudicated across rounds 8/9/11 (truthful branding; `invalidRunId` FIRST consumer contract documented at errors.ts:71-91; canonical single-encoding placeholders in error-factories.ts) and explicitly "required for public source compatibility" — the honest fix (`RunId | null` or non-brand-inhabiting field) is a breaking API-shape change with wide consumer blast radius (all four exhaustive matchers + every `e.runId` correlation). Needs a breaking-pass type-design round, not a remediation edit. |
| type-design-analyzer-2 | FrameworkError closed union fuses host identity-provider concerns into the reusable framework package | **deferred** | Documented deliberate decision (FR-X-001/002, reviewer concedes); fix is a framework-level error-envelope redesign with cross-package blast radius. Structural, no current wrongness. |
| type-design-analyzer-3 | `__brand*Unchecked` zero-validation casts convention-gated by `__` naming only | **accepted** | Verified: exactly 3 production importers (redis-checkpointer.ts, checkpointer-codec.ts; `__brandConfidenceUnchecked` is confidence.ts's own export, not an ids import) + 2 pinning test files. Fix: new check-imports AST imported-binding rule — only whitelisted modules may import the three ids.js unchecked casts; SC-006 hard-fail gate + direct unit pins on the audit function. |
| type-design-analyzer-4 | `NodeRetryConfig.backoffMs`/`jitterRatio` numeric invariants doc-only; NaN/negative/out-of-range flows into `applyJitter` | **accepted** | Verified: no validation anywhere (machine.ts:85-86, retry-policy.ts, executor.ts:283-284 consume raw). Fix: validate in `validateDagShape` (the single mandatory soundness gate; `validation`-kind error carrying nodeId — idiomatic, no new kind). |
| comment-analyzer-1 | `isNonNegativeSafeInteger` JSDoc's tail-coercion trap claim unreachable | **accepted** | Empirically verified: `Number.isSafeInteger(valueOf-object)` → false with no trap fired; `>=` can only ever see Numbers. JSDoc's causal story is wrong; typeof's real role is type-predicate narrowing. Rewrite. |
| comment-analyzer-2 | JSDoc calls `Number.isSafeInteger` "the non-coercing ES6 twin of the legacy global" | **accepted** | Correct: no legacy global `isSafeInteger` exists; the twin family is `Number.isFinite`/`Number.isNaN`. Rewrite. |
| architecture-tech-lead-1 | Checkpointer load-gate sequence triplicated across InMemory/Redis/File | **deferred** | Round-19 tracked deferral (same finding, architecture-tech-lead-1): storage reads interleave with gates per adapter; extractable core covers only meta-level gates; parity suite already pins observable equivalence; value is locality, not correctness. Consolidation → deepening round. |
| architecture-tech-lead-2 | Two divergent `{ now }` factory-options parsers | **deferred** | Round-19 tracked deferral (code-simplifier-6): divergence documented in options.ts; folding changes pinned hostile-Proxy behavior. → deepening round. |
| architecture-tech-lead-3 | `replayEvents`/`foldStep` shape-sniff envelopes from raw events; silent unwrap hazard | **deferred** | Round-19 tracked deferral ("RecordedEvent branding"): the shape-sniff disappears when envelopes are branded; runtime brands cannot survive JSON persistence, so the fix spans every reader seam + the fold. Documented in-code as a narrowing contract; no in-repo machine collides. → deepening round. |
| code-simplifier-1 | redundant `as { state: S }`/`as { context: C }` casts in `updateData` | **accepted** | Verified job.ts:203-204 — `d` is already `{ state: S; context: C }`; capture `{ state: d.state, context: d.context }`. Behavior-identical snapshot semantics. |
| code-simplifier-2 | duplicate module-header line in replay.ts | **accepted** | Verified replay.ts:2 restates line 1 and the block below; delete. |

## Accepted fixes (10)

1. **git-sync.ts** (×2 sites): timeout branch returns the error immediately; bounded background cleanup — race `proc.exited` against a 2 s `KILL_GRACE_MS` window, escalate to `SIGKILL` if still alive, then drain stdout/stderr. Kill/cleanup never gates the error.
2. **bootstrap.ts** (×2 sites): `[cache] get/set failed for key=…` logs render `— ${r.error.message}` when `kind === "cache-error"` (checkpointWriter parity).
3. **run-store.ts**: `persistedStatusIsTerminal` → `parsePersistedStatus` returning `{kind:"terminal"|"live"} | {kind:"corrupt", parseError}`; caller logs a bounded warn on corrupt before treating as live.
4. **resume.ts**: header + inline comment reworded — the re-tag arm is the FR-040/ADR-0080 boundary-totality fence against internal contract drift, not a hostile-journal expectation.
5. **check-imports.ts** (+ boundary-imports.test.ts): new AST imported-binding rule — `__brandRunIdUnchecked`/`__brandNodeIdUnchecked`/`__brandDagIdUnchecked` importable only from `checkpoint/redis-checkpointer.ts`, `file/checkpointer-codec.ts`, `__tests__/file-boundary.test.ts`, `__tests__/file-checkpointer.test.ts`; header bullet + doc bullet; direct unit pins on the exported audit function.
6. **validate-dag.ts** (+ validate-dag.test.ts): per-node retry-config checks — every `backoffMs` entry finite and ≥ 0; `jitterRatio` finite in [0, 1]; `validation`-kind errors naming the node; pins via `validateDagShape`.
7. **composite-node-key.ts**: `isNonNegativeSafeInteger` JSDoc rewritten truthfully (spec short-circuit; typeof = type narrowing; `Number.*` non-coercing family wording).
8. **job.ts**: `state: (d as { state: S }).state` → `state: d.state` (+ context).
9. **replay.ts**: delete duplicate second header line.
10. **replay.ts**: unchanged (same file as 9 — the deleted line is the only replay.ts edit).

## Refuted-finding audit

No critical findings were produced, so the Refutation Panel never convened (`panel` absent, `refuted_critical_findings` empty). Nothing to retain.

## Validation

- `bun test packages/framework` (workspace framework suite — includes SC-006 boundary gate, validate-dag, file/resume, file/job, composite-key, replay pins)
- `bun test packages/host` (git-sync + run-store touch host; host suite 2000+)
- `bun test apps/customer-summary`
- `bun run --cwd packages/framework typecheck` (or repo-wide `bun run typecheck` if available) + `bun run --cwd packages/framework build` as applicable
- SC-006 gate is part of the framework suite (hard-fail on any violation)

## Remediation run

- Source run: `standalone-2026-08-19-181832-f6-file-durable-runtime`
- Support paths (outside frozen scope): `.claude/plans/2026-08-19-pr-remediation-round-20.md`
- No regression pins outside scope this round (all pins land inside in-scope test files).
