# 2026-08-19 PR Remediation — Round 24 (F6 file-durable-runtime)

**Branch:** `feat/f6-file-durable-runtime` (base `6c316cb`; reviewed scope = frozen diff of 375 files)
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-19-203500-f6-file-durable-runtime`
**Source:** canonical `result.json` published by the Standalone Review Program (digest `689297164f88a832b6afe895a520933d1d6b75ae0ef85a8bd0cc8805ce0b3464`)

## Result summary

- `surviving_critical_findings`: **0** (panel never convened; `panel: null`)
- `refuted_critical_findings`: **0**
- `advisory_findings`: **19** entries = **17 unique claims** (silent-failure-hunter-3/4 are the wire-contract re-encodings of silent-failure-hunter-1/2)

## Dispositions (all 17 unique advisories)

### Accepted — 12

| id | claim | fix |
|----|-------|-----|
| silent-failure-hunter-1/3 | `releaseFileLock` (atomic.ts:545) silently no-ops on pid mismatch without consulting the ownership token — `withFileLock` reports success while an owned lock stays on disk when pid metadata is corrupt | On pid mismatch, read the ownership token (non-throwing, silent on unreadable); if it **matches** ours, the lock is provably ours with corrupt pid bytes → warn and remove; only both-mismatch stays a silent no-op. New pins: (a) foreign pid + matching token ⇒ warn + removal; (b) foreign pid + no token + cleanup-impossible ⇒ still silent (existing pin preserved) |
| silent-failure-hunter-2/4 | `atomicWriteFile` (atomic.ts:86) cleanup pre-probes with `existsSync`, which swallows EACCES/EPERM — silent tmp litter | Drop the pre-probe; attempt `unlinkSync` unconditionally; ENOENT (via `isMissingPathError`) stays a benign no-op, every real unlink failure reaches the existing warn arm. Pin: EACCES-on-tmp-parent (0o500 dir) ⇒ warn fires (fails against the old code) |
| pr-test-analyzer-1 | journal.ts:487 `writeCheckpoint`'s `atomicWriteFile` fs-failure branch has no dedicated pin (all existing EACCES tests fail at `mkdirSync`) | Pin in file-journal.test.ts: run dir with existing `events/` + `checkpoint.json`, `chmod 0o500` (mkdir no-ops), `writeCheckpoint` ⇒ typed `cache-error(writeCheckpoint)` naming the dir, EACCES |
| pr-test-analyzer-2 | job.ts:138 `createFileJob`'s non-object `initial` TypeError branch untested | Add `{ directory: tempDir(), initial: null }` to the typed-factory-validation loop (asserts `cache-error(createFileJob)` "factory configuration") |
| type-design-analyzer-4 | event-log.ts:112 `readStrict` returns runtime-mutable arrays typed `readonly` | Extract the existing `deepFreeze` from job.ts into a shared module-private helper (`file/deep-freeze.ts`); `readStrict` deep-freezes each parsed record and the result array so the `readonly` promise is runtime-true. Pin `Object.isFrozen` on records and array |
| type-design-analyzer-5 | checkpoint-record.ts:42 `WeakSet` is module-instance-scoped — a commit minted by a duplicated module instance fails as an apparent forgery | Doc note at the WeakSet: duplicate-module-instance failure is the safe direction (fail closed, never a forged accept); symptom guide for the debugging session |
| comment-analyzer-1 | freshness-index.ts:10 header states "A lower succeededAtMs cannot overwrite a newer singleton" as absolute, but `selectLatestWrite`'s expiry branch replaces an expired current with any incoming write, and stale losers refresh `writtenAtMs` (Redis EXPIRE parity) | Qualify the header sentence exactly as suggested |
| comment-analyzer-2 | checkpoint-record.ts:62-64 comment example `{"data":{"__undefined__":true}}` "fails closed only at the caller's decode, late" — false: the FR-009 pre-scan rejects the reserved tag key at write time (verified by executing the codec) | Replace the example with one only the shape gate catches (`data: [1, 2]`) and note the tag-key shape is rejected by the pre-scan |
| architecture-tech-lead-2 | checkpointer.ts:613 load errs when global `fwLogger` throws emitting the corrupt-node warning — couples a successful durable read to a swappable telemetry singleton | Use the module's own `warnWithoutThrowing` (boundary-error.ts) for the emission; the drop stays surfaced via `corruptNodeIds`; update the pin at file-checkpointer.test.ts:1464 to assert load **succeeds** with a throwing logger (stronger, honest contract) |
| code-simplifier-1 | `retryAsyncResult` (shared/retry-async.ts:65) has zero importers in frozen tree and live repo | Delete the export + `toFrameworkError` plumbing + the `Result`/`ok`/`err`/`FrameworkError` imports that exist only for it; `retryAsync` and its doc pointer stay |
| code-simplifier-2 | `createInMemoryDecisionStore` (host/src/hitl/adapters/decision-store.ts:60) zero importers anywhere, contradicting header "(tests/dev)" | Delete the export and its now-unused module header sentence; Redis adapter (over the fake Redis port) is what every test uses |
| code-simplifier-3 | executor.ts:354-365 duplicates the `executeWave`+`recordOutcomes` body across `retrying`/`running` arms | Fold into one `.with({ kind: P.union("retrying", "running") })` arm; keep the jitter sleep under `p.kind === "retrying"`; import `P` from ts-pattern |

### Deferred — 1

| id | claim | reason |
|----|-------|--------|
| architecture-tech-lead-1 | Test-only seams widen the public `@fuguejs/framework/file` interface (`AtomicWriteFileTestHooks`, `FileLockTestHooks` hooks params, `atomicWriteFileHooks` in barrel-exported `FileFreshnessIndexOptions`, `__testDeepFreeze`, `__testSerializeRedisFreshnessMember`, `stealStaleFileLock`) | Complete fix is not practical as offered: the audit-verified concurrency tests need in-process deterministic hooks (memfs cannot interleave), so the hooks must reach the lock primitives — a testkit wrapper module would still forward hooks through the production signatures, or duplicate protocol code. The barrel already omits every test affordance (FR-042 contract is clean; the only barrel leak is `FileFreshnessIndexOptions.atomicWriteFileHooks`, explicitly documented `TEST-ONLY`), the module docs pin these seams as deliberate maintainer decisions, and the package is workspace-internal. Revisit in a dedicated interface-hygiene pass if `@fuguejs/framework` is ever published. |

### Dismissed — 4

| id | claim | reason |
|----|-------|--------|
| type-design-analyzer-1 | journal.ts:180 `appendEvent` accepts raw `dedupKey` while the module owns the `DedupKey` brand; FR-015 stays runtime-only at the append boundary | By design and consistent with this codebase's parse-don't-validate discipline: the journal boundary is the **single** FR-015 authority (`parseOptionalDedupKey` is THE encoding, with the `\|`-collision reasoning and the `computeDedupKey` fix hint in the typed permanent rejection). The kernel `JobLike` port (state-machine/types.ts) binds every adapter to raw `string`, so the two direct call sites (job.ts:227, persistence.ts:135) receive raw strings from that contract; a `DedupKey \| undefined` param would force a mint/cast dance with zero runtime change (the brand is castable), and the reject message with the runStateMachine fix hint would have to move or be duplicated. Runtime gate is complete and fail-closed; reviewer rated low. |
| type-design-analyzer-2 | `RawCheckpointJson` is a forgeable brand (`rawCheckpointJson` bare cast, journal.ts:220-221) | The twin's runtime gating is impossible for this type by construction: it brands **disk-sourced string bytes** (primitives — a `WeakSet` cannot hold primitives, and a `Set` would leak unboundedly), and the write-twin asymmetry is already documented at the type and at `readCheckpoint`'s JSDoc ("the capability-typed write twin's mirror", round-23 tda-5). The actual gate is the consumer's strict `parseCheckpoint` (FR-009), which is exactly what the brand makes visible. No honest tightening exists. |
| type-design-analyzer-3 | journal.ts:201 `readCheckpoint` typed `RawCheckpointJson \| null` but throws on non-ENOENT — hidden partial surface | The barrel contract explicitly declares "JobLike/Journal methods … throw only existing typed `FrameworkError` values" (file.ts header), so `readCheckpoint` follows the documented convention of its own class (`appendEvent`/`writeCheckpoint`/`writeProgress` are identical throwing shapes). The null/throw split is fail-safe ("never misreport a permission-broken dir as fresh start"), extensively documented at both the interface JSDoc and the shared `readCheckpointFile`, and the sole production consumer (`resumeFileJob`) already frames it as a throwing seam with its own re-tag. Zero production call sites exist to be misled. |
| type-design-analyzer-6 | job.ts:170 `get data()` returns shallow `Readonly` while runtime deep-freezes — type over-promises | It under-promises, not over-promises: shallow `Readonly` claims only top-level immutability; the runtime delivers strictly more (deep freeze of plain structures + clone isolation for Map/Set/Date), and both mechanism and limits are precisely documented at the getter. The failure mode (mutation of frozen content throws in strict mode) is fail-fast and test-visible. A `DeepReadonly` kernel change is **untruthful across adapters**: `dag-runtime/persistence.ts:104` re-injects LIVE DAG references into `data()` by design (queue/in-memory-job.ts returns live state too), so deep-readonly typing would either lie there or require deep-freezing live DAG state (a real behavior change). |

## Refuted-finding audit

None — the run produced a non-empty critical set of **zero**, so no Refutation Panel convened and there are no refuted criticals to report.

## Validation commands

```bash
cd /home/peterstorm/dev/agentic/fugue
bun run typecheck --workspace @fuguejs/framework   # per repo convention — see below
bun test packages/framework/src/__tests__/file-atomic.test.ts
bun test packages/framework/src/__tests__/file-journal.test.ts
bun test packages/framework/src/__tests__/file-job.test.ts
bun test packages/framework/src/__tests__/file-checkpointer.test.ts
bun test packages/framework/src/__tests__/file-event-log.test.ts
bun test packages/framework/src/__tests__/file-freshness-index.test.ts
bun test packages/framework/src/__tests__/retry-async.test.ts
bun test packages/framework/src/__tests__/executor.test.ts        # or dag-runtime suite
bun test packages/framework/src/__tests__/file-resume.test.ts      # readStrict freeze consumers
bun test packages/framework/src/__tests__/file-checkpoint-record.test.ts
```

Full relevant suite: `bun test packages/framework/src/__tests__/` plus `packages/host` tests touching decision-store imports (host unit tests). Exact workspace typecheck script confirmed at implementation time.
