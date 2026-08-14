# PR Remediation — F6 file durable runtime

- **Date:** 2026-08-14
- **Branch:** `feat/f6-file-durable-runtime`
- **Review run:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-14-f6-file-durable-runtime`
- **Authority:** `result.json` digest `f6e6c379fd0122d8ef18ca73c1c592fa9950c2f019646d607ed381b96f0c777f`

## Exact reviewed scope

`.claude/plans/2026-08-12-f6-file-durable-runtime.md`; `.claude/specs/2026-08-12-f6-file-durable-runtime/{brainstorm.md,plan-alignment.md,probe.txt,spec.md}`; `docs/adr/{0075-composite-checkpoint-node-key-encoding-with-canonical-folding.md,0076-on-disk-layout-programjournal-parity-with-the-digest-filename-adaptation.md,0077-resume-agreement-proof-log-authoritative-checkpoint-may-lag.md,0078-journal-single-writer-contract-and-append-serialization.md,0079-file-freshness-index-digest-addressed-latest-write-files-with-lazy-ttl-parity.md,0080-failure-surface-result-everywhere-the-port-allows-typed-throwing-inside-the-joblike-shell.md,README.md}`; `packages/framework/package.json`; `packages/framework/src/__tests__/{_checkpointer-suite.ts,boundary-imports.test.ts,cli/visualize.test.ts,composite-node-key.test.ts,error-factories.test.ts,errors.test.ts,file-atomic.test.ts,file-boundary-error.test.ts,file-boundary.test.ts,file-checkpointer.test.ts,file-event-record.test.ts,file-freshness-index.test.ts,file-job.test.ts,file-journal.test.ts,file-layout.test.ts,file-resume.test.ts,redis-checkpointer.test.ts}`; `packages/framework/src/checkpoint/{checkpointer.ts,composite-node-key.ts,index.ts}`; `packages/framework/src/file.ts`; `packages/framework/src/file/{atomic.ts,boundary-error.ts,checkpointer.ts,event-log.ts,event-record.ts,freshness-index.ts,job.ts,journal.ts,layout.ts,resume.ts}`; `packages/framework/src/llm/fake-client.ts`; `packages/framework/src/scripts/check-imports.ts`; `packages/framework/src/state-machine/{index.ts,replay.ts,serialize.ts}`; `packages/framework/src/types/{errors.ts,safe-error.ts}`.

## Surviving critical findings — mandatory

### C1 — caller-owned file-job snapshots

`packages/framework/src/file/job.ts:216` retains the initial and `updateData` state/context references. A caller can mutate them after construction/commit, changing `job.data` while durable checkpoint bytes remain unchanged.

**Fix:** introduce a pure checkpoint smart constructor/codec that performs the existing losslessness proof and returns both opaque validated checkpoint bytes and a detached deserialized snapshot. Construct the initial working snapshot from that detached representation before the factory returns; on `updateData`, derive the detached representation before the first `await`, write its opaque bytes, then advance only to the detached snapshot after commit. Add regressions that mutate initial and update arguments, including mutation while the write promise is pending, and prove `job.data` remains equal to durable bytes.

### C2 — file-checkpointer descendant symlink escape

`packages/framework/src/file/checkpointer.ts:1193` follows pre-existing symlink entries at `<base>/<runId>` and `<base>/<runId>/nodes`, allowing meta/node I/O outside the caller-supplied checkpoint base.

**Fix:** establish the caller-supplied base as a canonical trust anchor; for every managed run/nodes directory, inspect with `lstat`, reject symbolic links/non-directories, resolve the real path, prove it is the expected direct descendant of its canonical parent, and perform I/O against the verified canonical path. Re-check managed directory identity around writes to reduce check/use exposure. Preserve `checkpoint-write-failed` for invalid write values and `cache-error(setMeta|saveNode|load)` for filesystem containment failures. Add regressions for symlinked run and nodes directories on setMeta/saveNode/load, assert no outside bytes are created/read, and preserve unknown-run `ok(null)`.

Node path APIs do not provide portable `openat`/dirfd-relative traversal; the remediation prevents pre-existing descendant symlink traversal and narrows races but does not claim protection from an adversary concurrently renaming filesystem entries. Document that precise residual instead of claiming complete `O_NOFOLLOW` anchoring.

### C3 — boundary gate omits current `file-*.test.ts` files

`packages/framework/src/__tests__/boundary-imports.test.ts:8` says every file-backend test is gated, but `check-imports.ts` enumerates only selected files.

**Fix:** add deterministic single-wildcard scope matching and replace the stale enumeration with `__tests__/file-*.test.ts`; update comments and gate-integrity fixtures to prove currently omitted names are covered and unrelated test helpers are not accidentally scoped.

## Advisory dispositions

### A1 — `FileJournal.writeCheckpoint` accepts arbitrary strings — **accepted**

The claim is sound: the public low-level journal type currently permits a checkpoint that its own strict resume path rejects. This is practical to fix with C1. `writeCheckpoint` will accept only the opaque output of the checkpoint smart constructor, with a runtime-private marker as well as a TypeScript invariant. Journal tests will use the smart constructor and will assert that forged/raw values fail through typed `cache-error(writeCheckpoint)` without writing bytes.

### A2 — in-memory checkpointer permits addressed/state nodeId disagreement — **dismissed**

The concern is generally valid but changing it in this remediation would violate explicit F6 compatibility requirements FR-023 and the reviewed plan: in-memory and Redis behavior must remain byte-identical and composite/address behavior is file-specific in this pass. The file checkpointer already rejects disagreement at its persistence boundary. A cross-backend contract change requires a separate versioned feature, not an in-scope remediation.

### A3 — process-scoped atomic temp path contends under same-process concurrency — **accepted**

The claim is reproducible and the fix is local. Give every `atomicWriteFile` call a caller-owned same-directory unique temp path, clean up only that path, update durable-layout documentation, and add a same-target concurrent-write regression proving all calls settle successfully, the final target equals one complete payload, and no temp litter remains.

### A4 — shared `Checkpointer.saveNode` options have backend-specific semantics — **dismissed**

This is the deliberate, versioned FR-023/ADR-0075 compatibility decision: existing in-memory and Redis implementations must ignore options while file opts into composite addressing. Making it universal, unsupported, or a new capability would contradict the approved feature scope and existing gate pin. Revisit only with the future F1/F8 feature that extends the other backends.

## Refuted critical audit

None. `result.json.refuted_critical_findings` is empty. The panel upheld all three canonical critical findings at the 2-of-3 threshold. For C2, the intent lens objected that adversarial symlink anchoring was originally out of scope, but reproduction and test-coverage upheld the concrete pre-existing-symlink escape, so the finding survives and is mandatory.

## Planned support/documentation paths

- `.claude/plans/2026-08-14-pr-remediation.md` (this plan; outside reviewed scope)
- `packages/framework/src/file/checkpoint-record.ts` (new pure smart-constructor/opaque checkpoint representation; outside reviewed scope)
- Existing reviewed tests and ADR/plan files as needed to keep contracts truthful.

## Validation

1. `cd packages/framework && bun test src/__tests__/file-job.test.ts src/__tests__/file-journal.test.ts src/__tests__/file-atomic.test.ts src/__tests__/file-checkpointer.test.ts src/__tests__/boundary-imports.test.ts`
2. `cd packages/framework && bun run typecheck`
3. `cd packages/framework && bun test --path-ignore-patterns='dist/**'`
4. `bun run check:docs`
5. Start the registered remediation run against the immutable review result, authorize the plan and new checkpoint-codec support path, resume to verified-index installation, then commit and push without force.
