# PR Remediation — F6 file durable runtime (adjudicated round 2)

- **Date:** 2026-08-14
- **Branch:** `feat/f6-file-durable-runtime`
- **Review run:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-14-204509-f6-file-durable-runtime`
- **Authority:** tally-authored `result.json`, SHA-256 `58769b825b0ded14f1f409cf84f68f0829113e8b2fe0d3e969736930150a0aa3`
- **Panel:** reproduction, intent, and blast-radius lenses; all three canonical criticals upheld 3/3

## Exact reviewed scope

- `.claude/plans/2026-08-12-f6-file-durable-runtime.md`
- `.claude/plans/2026-08-14-pr-remediation.md`
- `.claude/specs/2026-08-12-f6-file-durable-runtime/{brainstorm.md,plan-alignment.md,probe.txt,spec.md}`
- `docs/adr/{0075-composite-checkpoint-node-key-encoding-with-canonical-folding.md,0076-on-disk-layout-programjournal-parity-with-the-digest-filename-adaptation.md,0077-resume-agreement-proof-log-authoritative-checkpoint-may-lag.md,0078-journal-single-writer-contract-and-append-serialization.md,0079-file-freshness-index-digest-addressed-latest-write-files-with-lazy-ttl-parity.md,0080-failure-surface-result-everywhere-the-port-allows-typed-throwing-inside-the-joblike-shell.md,README.md}`
- `packages/framework/package.json`
- `packages/framework/src/__tests__/{_checkpointer-suite.ts,boundary-imports.test.ts,cli/visualize.test.ts,composite-node-key.test.ts,error-factories.test.ts,errors.test.ts,file-atomic.test.ts,file-boundary-error.test.ts,file-boundary.test.ts,file-checkpointer.test.ts,file-event-record.test.ts,file-freshness-index.test.ts,file-job.test.ts,file-journal.test.ts,file-layout.test.ts,file-resume.test.ts,redis-checkpointer.test.ts}`
- `packages/framework/src/checkpoint/{checkpointer.ts,composite-node-key.ts,index.ts}`
- `packages/framework/src/file.ts`
- `packages/framework/src/file/{atomic.ts,boundary-error.ts,checkpoint-record.ts,checkpointer.ts,event-log.ts,event-record.ts,freshness-index.ts,job.ts,journal.ts,layout.ts,resume.ts}`
- `packages/framework/src/llm/fake-client.ts`
- `packages/framework/src/scripts/check-imports.ts`
- `packages/framework/src/state-machine/{index.ts,replay.ts,serialize.ts}`
- `packages/framework/src/types/{errors.ts,safe-error.ts}`

## Surviving critical findings — mandatory

### C1 — projection-only first writes fail for a missing run directory

`packages/framework/src/file/journal.ts:397` writes checkpoint/progress projections without first creating the caller-supplied run directory, so public `updateData`/`updateProgress` first writes fail with `ENOENT`.

**Fix:** create the run directory recursively at each projection write boundary before `atomicWriteFile`, preserving operation-specific typed errors. Add regressions for checkpoint and progress as the first write into a nonexistent nested directory and assert exact durable bytes.

### C2 — eventDigestOf does not enforce its documented shared sequence ceiling

`packages/framework/src/file/layout.ts:183` documents one naming/codec sequence domain, but `eventDigestOf` currently accepts sequences above `MAX_LEXICOGRAPHIC_SEQUENCE`.

**Fix:** make `eventDigestOf` reject values above the six-digit ceiling through its existing typed boundary and add boundary/overflow tests. Keep the shared-domain documentation truthful.

### C3 — fromJson is not an unconditional inverse of toJson

`packages/framework/src/state-machine/serialize.ts:350` says `fromJson` is the inverse of `toJson`, but reserved serializer-tag plain objects (for example `{ "__map__": [] }`) are intentionally interpreted as tagged values.

**Fix:** narrow the contract comment to JSON produced from the supported collision-free/lossless value domain and explicitly document reserved-tag collision behavior. Do not change the established wire encoding in a comment-remediation finding.

## Advisory dispositions

### A1 — lock acquisition drops owner-probe diagnostics — **accepted**

The claim is reproducible and the fix is local. Replace the boolean stale-owner probe result with a discriminated result that can carry the last fail-closed diagnostic. Preserve warning behavior, but include the diagnostic in the terminal typed acquire failure so disabled/missed logging does not erase the cause. Add EACCES/EIO acquire-timeout regressions and preserve silent EPERM behavior.

### A2 — SaveNodeOpts should be a capability-specific port type — **dismissed**

This conflicts with the explicit reviewed FR-023/ADR-0075 compatibility contract: the shared port intentionally accepts the versioned option while in-memory/Redis fold to canonical addressing and the file backend opts into composite addressing. The current port and method documentation already state that distinction. Splitting the capability would contradict the approved cross-backend API rather than repair an implementation defect.

### A3 — validated event fields remain primitive-typed — **accepted**

The parser establishes invariants that the type currently forgets. Introduce opaque `JournalSequence` and `DedupKey` brands plus Result-returning smart constructors; make `FileEventRecord` carry those types, route append/parser construction through the constructors, and keep low-level serialization boundaries accepting runtime primitives for hostile-input validation. Add compile-time assertions and runtime boundary tests.

### A4 — SaveNodeOpts documentation overstates universal composite storage — **accepted**

Although the method-level documentation has the caveat, the type-level paragraph is ambiguous in isolation. State directly there that only composite-capable backends (currently file) use composite storage and that in-memory/Redis ignore the options per FR-023.

### A5 — compositeNodeKey says the file backend is planned — **accepted**

The backend now exists. Change the stale future-tense comment to the present-tense contract.

### A6 — tests contain review-process labels — **accepted**

Replace scoped process artifacts (`silent-failure-hunter`, `refutation fix`, `advisory remediation`) with durable behavior-focused descriptions in `file-event-record.test.ts`, `boundary-imports.test.ts`, and `file-atomic.test.ts`. Preserve behavior and rationale.

### A7 — resume proof is coupled to filesystem acquisition — **accepted**

The agreement proof is a coherent pure algorithm embedded in the shell. Extract it to `file/resume-proof.ts` with data/decoder/machine inputs and a `Result` output; keep `resume.ts` as strict file acquisition plus delegation. Add direct pure proof tests for full agreement, strict-prefix lag, disagreement, and guarded hostile callbacks while retaining filesystem integration coverage.

### A8 — file checkpointer combines codec, containment, and orchestration — **accepted**

The 1,600-line adapter has separable pure and I/O policies. Extract pure meta/node/options codecs to `file/checkpointer-codec.ts` and verified-directory containment to `file/verified-directory.ts`; leave `createFileCheckpointer` as the thin filesystem shell. Add direct codec/containment tests and retain all existing adapter, symlink, atomicity, and parity tests.

## Refuted critical audit

None. `result.json.refuted_critical_findings` is empty. Every canonical critical was upheld by reproduction, intent, and blast-radius; no finding is eligible to be skipped as refuted.

## Planned support paths outside reviewed scope

- `packages/framework/src/file/resume-proof.ts`
- `packages/framework/src/file/checkpointer-codec.ts`
- `packages/framework/src/file/verified-directory.ts`
- `packages/framework/src/__tests__/file-resume-proof.test.ts`
- `packages/framework/src/__tests__/file-checkpointer-codec.test.ts`
- `packages/framework/src/__tests__/file-verified-directory.test.ts`

The remediation run must authorize these exact support paths. The plan itself is already in reviewed scope.

## Validation

1. `cd packages/framework && bun test src/__tests__/file-journal.test.ts src/__tests__/file-layout.test.ts src/__tests__/file-event-record.test.ts src/__tests__/file-atomic.test.ts`
2. `cd packages/framework && bun test src/__tests__/file-resume-proof.test.ts src/__tests__/file-resume.test.ts src/__tests__/file-checkpointer-codec.test.ts src/__tests__/file-verified-directory.test.ts src/__tests__/file-checkpointer.test.ts`
3. `cd packages/framework && bun run typecheck`
4. `cd packages/framework && bun test --path-ignore-patterns='dist/**'`
5. `bun run check:docs`
6. Start the registered remediation program against the immutable review run with every support path above, resume through validation/path audit/temporary-index verification, install the exact verified index, commit, and push without force.
