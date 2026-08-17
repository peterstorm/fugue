# PR Remediation Plan — 2026-08-17 (Round 7)

**Branch:** `feat/f6-file-durable-runtime`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-17-131348-f6-file-durable-runtime`
**Authority:** `result.json` (tally-published, digest `a79cbcf03009af144dd6ffd4c002ce871559e8e4c3e3ac700605029f5fd8797e`)
**Head at review:** `489dfa3`

## Review outcome

- Reviewers: 7 (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead, code-simplifier) — 68 frozen files.
- Raw criticals: 2 · **Surviving criticals: 2** · **Refuted criticals: 0** · Advisories: 16.
- Refutation Panel: 3 lenses (reproduction / intent / blast-radius), `review-verifier-agent` × 3, threshold 2, pinned by the engine tally.
- All prior-round fixes (round-6 C1–C4, A1–A19, deferrals D1/D2) independently re-verified landed in the frozen source by four reviewers (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer).

## Refuted-finding audit

None — `result.json.refuted_critical_findings` is empty. Audit note for the record:

- **`comment-analyzer-1`** survived 2–1 over a **dissenting `intent`-lens vote** (`refuted_by: ["intent"]`). The dissent claimed the WHATWG structured-clone algorithm preserves symbol-keyed own properties, which would make the flagged comment true. The parent **empirically overruled the dissent** on both runtimes in the review environment: `structuredClone({ [Symbol('x')]: 42 })` yields a clone with **zero** own symbol properties on both bun 1.3.13 and Node v24 (the drop is structural — only string-keyed own properties are copied). The `reproduction` and `blast-radius` lenses' factual premise is the one that reproduces, and the sibling `__testDeepFreeze` comment in the same file (job.ts:89–96) already documents the FR-009 symbol rejection, contradicting the line-78 rationale. The dissent's spec citation was therefore a misstatement, and the tally (threshold 2) upholds the finding.
- **`comment-analyzer-2`** survived 3/3 with no refuting evidence.

## Surviving criticals (all mandatory)

### C1 — `comment-analyzer-1` — `packages/framework/src/file/job.ts:78`
**Claim (panel-upheld 2/3, dissent overruled empirically):** the `deepFreeze` rationale states "`structuredClone` preserves own symbol properties, so they are part of the snapshot the contract promises is fully immutable". False on both links of the chain: (1) `structuredClone` **drops** symbol-keyed own properties (verified on bun + Node v24); (2) the FR-009 write-boundary pre-scan (`assertLosslessEvent` via `serializeFileCheckpoint`) rejects symbol-keyed state at the factory seed and `updateData`, so the snapshot never contains them (as the sibling `__testDeepFreeze` comment at job.ts:89–96 itself states). A maintainer trusting the comment would believe `Reflect.ownKeys` defends a live invariant in the `data`-getter path; it only matters for hand-built values through the test seam.
**Fix:** rewrite the `Reflect.ownKeys` comment to state the true rationale: the `data` getter's clone can never carry symbol-keyed properties — `structuredClone` omits symbol keys, and the FR-009 boundary rejects symbol-keyed state at seed/`updateData` — but `Reflect.ownKeys` (not `Object.getOwnPropertyNames`) keeps the primitive correct for any future snapshot source that does carry them, pinned by `__testDeepFreeze` (and its pin at `file-job.test.ts`). Comment-only change; no code or test semantics change.

### C2 — `comment-analyzer-2` — `packages/framework/src/checkpoint/checkpointer.ts:15`
**Claim (panel-upheld 3/3):** the `TTL_SECONDS` doc comment says "the file backend consumes the same constant through `file/layout.ts` (its TTL import)". `file/layout.ts` has **no** TTL import at all (verified: zero `TTL` matches; its imports are `node:crypto`, `../types/ids.js`, `../state-machine/serialize.js`, `./boundary-error.js`). The file backend's actual consumers import `TTL_SECONDS` directly from this port file (`file/checkpointer.ts:78`, `file/freshness-index.ts:28`). Stale clause left by the round-6 A8 remediation, which planned a `layout.ts` conduit but landed direct imports.
**Fix:** replace the clause with the true topology: "the file backend consumes the same constant directly from this port file (`file/checkpointer.ts`, `file/freshness-index.ts`), and the Redis backend mirrors the same 24-hour contract." Comment-only change.

## Advisory dispositions (16)

Accepted: 14 · Deferred: 2 · Dismissed: 0.

### Accepted (14)

| # | ID | Fix |
|---|----|-----|
| A0 | `silent-failure-hunter-1` | **InMemoryCheckpointer non-finite clock silently disables FR-027 expiry.** `setMeta` stores `new Date(NaN)` with `ok(undefined)` and no signal; `load`'s TTL comparison becomes a NaN comparison that is always `false`, so an expired checkpoint is served and never expires — while the file backend's twin rejects the identical clock input as a `permanent` `cache-error` (pinned at `file-checkpointer.test.ts`). Mirror the file backend's guards: in `setMeta`, reject `!Number.isFinite(ms) \|\| Number.isNaN(new Date(ms).getTime())` after `this.now()` with a typed `cache-error("checkpoint:setMeta")` carrying `failureClass: "permanent"` (deterministic — every retry reproduces it, parity with the file backend's pin); in `load`, capture `this.now()` first and reject non-finite/invalid the same way (`"checkpoint:load"`, `permanent`) before the TTL comparison. Extend the module-private `cacheError` helper with the optional `failureClass` (both existing throwing-clock call sites keep their unclassed values — no pinned behavior change). Messages mirror the file backend: `` `setMeta clock returned a non-representable timestamp for run ${…}: ${…}` `` / `` `load clock returned …` `` via the total renderers. New pin in `redis-checkpointer.test.ts`'s in-memory totality block (beside the throwing-clock pin): NaN clock ⇒ both `setMeta` and `load` fail closed with `cache-error`, correct `operation`, `failureClass: "permanent"`, `retriabilityOf: "non-retriable"`. Sound claim, real backend-swap parity gap, small complete in-scope fix. |
| A1 | `pr-test-analyzer-1` | **`parseFileFactoryClock` class-instance branch unpinned in two matrices.** Add a `new (class {})()` options-bag row to the factory-grammar matrices in `file-journal.test.ts` (`createFileJournal`) and `file-freshness-index.test.ts` (`createFileFreshnessIndex`), each pinning the exact prototype-branch message `"options must be a plain object"` (the branch the stricter sibling parser pins at `file-checkpointer.test.ts:2248`; `null` takes the different first-check message `…, got <null>`, so the exact-message pin is what isolates the branch). Closes the documented asymmetry; additive assertions only. |
| A2 | `type-design-analyzer-1` | **`FakeLlmClient` silently resolves an async provider to a wrong response.** `FakeResponseProvider`/`FakeWithToolsScript` admit `unknown` returns, so an accidentally-`async` function type-checks; `JSON.stringify(promise)` is `"{}"`, and `sendStructured` resolves `ok({ output: {}, rawText: "{}" })` — a silent empty response (reproduced by the reviewer). The `sendWithTools` twin degrades to a misleading misattributed crash. Fix: one module-private total `isThenable` guard (object with a function `then`) applied at both seams — `sendStructured` after the `isFrameworkError` check, `sendWithTools` after the `turnSpec` fetch — each returning the existing local `crash(message)` typed `node-crash` naming the synchronous-seam contract; document the synchronous-seam + loud-failure contract on both provider types. Pins in `llm-fake-client.test.ts`'s FR-040 totality block: async `sendStructured` provider ⇒ typed `node-crash` (not `ok({})`); Map value that is a Promise ⇒ same; async `withToolsScript` function ⇒ typed `node-crash`. Real silent-failure class at a caller seam; small complete in-scope fix. |
| A3 | `type-design-analyzer-2` | **`isPlainRecord` name over-promises vs sibling `isPlainObject`.** Behavior is currently safe (callers only need "object that is not an array"; prototype-cleaning happens elsewhere in the codec pipeline). Fix the drift trap at the predicate: extend the `layout.ts` `isPlainRecord` doc to state the deliberate leniency explicitly — unlike `checkpointer-codec.ts`'s `isPlainObject`, class instances (prototype ≠ `Object.prototype`/null) PASS; a `plainRecord: true` snapshot field does not imply a prototype-clean record. Document, not rename: the name is the shared round-6 A9 home used at 6 call sites, and a rename would churn the diagnostic snapshot field names (`plainRecord`) pinned in codec tests for no behavior gain. |
| A4 | `comment-analyzer-3` | **Sixth unresolvable provenance citation.** `file-verified-directory.test.ts:3` cites "advisory A8 of the 2026-08-14 PR remediation" — in the frozen 2026-08-14 plan A8 is a different (deferred) finding. Apply the round-6 A13 self-contained provenance (same phrase used at the 5 enumerated sites): "…the verified-directory containment policy of the file backend, extracted from the checkpointer adapter during the 2026-08-14 codec separation remediation — see review run `.claude/reviews/review-and-fix-runs/standalone-2026-08-14-f6-file-durable-runtime`." |
| A5 | `comment-analyzer-4` | **Stale `errors.test.ts` header.** The header describes only the `llm-budget-exceeded` block, but the file now pins 10 `describe` blocks (checkpoint-write-failed diagnostics, llm-budget-exceeded, infra-unreachable, policy-refusal, downstream-denied, capability-broker taxonomy SC-013, `retriabilityOf`, `safeErrorMessage` hostile matrix, total Node errno diagnostics, `messageOf`). Rewrite the header to name the file as the shared error-taxonomy test surface and enumerate the blocks. |
| A6 | `architecture-tech-lead-2` | **Public forensic codec is a shallow fragment.** `parseFileEventRecord` is the barrel-exported forensic reader but requires input preprocessed by `tryParseEventRecordJson` (JSON.parse + canonical grammar gate + `deserializeValue`), which the barrel does not export — a host passing `JSON.parse(text)` directly gets a spurious corrupt verdict ("literal reserved serializer tag key") on any valid record containing a Map/Set/Date, and loses the fail-closed pollution-key guarantee the reader has. Fix: add `parseStoredEventRecord(text: string, source: string): Result<FileEventRecord, string>` in `event-record.ts` — the exact two-stage composition `readStrict` performs (raw seam → strict envelope parse) — export it from the `file.ts` barrel beside `parseFileEventRecord`, document `parseFileEventRecord` as the deserialized-input stage and the composite as the text entry point, and update the barrel header's forensic-reads line. Keep `parseFileEventRecord` exported (still the internal stage + hand-built-raw entry). Pins in `file-event-record.test.ts`: a Map-bearing record serialized by `serializeFileEventRecord` round-trips through `parseStoredEventRecord` (spurious-corrupt regression pin); a raw text with a pollution tag object still fails closed through the composite. Real caller footgun with a false-positive on legitimate input; small complete in-scope fix (new export, pre-release, no compat shim needed per CONTEXT.md invariant 8). |
| A7 | `code-simplifier-1` | **`createFileJournal` double-wraps its own typed errors.** The body pre-wraps the directory check and the clock parse in `fileOperationError` values that the outer catch wraps again — the rendered message triple-nests `createFileJournal failed at …`. Distill to the sibling factories' shape (`createFileCheckpointerUnchecked`/`createFileFreshnessIndexUnchecked` + one outer catch): the body throws plain `Error`s (the same messages `parseFileFactoryClock` already throws bare), the single outer catch wraps once at `"factory configuration"`. Covering pins survive (`file-journal.test.ts` pins `message.length > 0`; `file-job.test.ts:562` pins the `"factory configuration"` substring, which remains present in the job-level re-wrap). |
| A8 | `code-simplifier-2` | **Dead type re-export.** Delete `export type { FileEventRecord };` at the bottom of `file/journal.ts` — the `file.ts` barrel exports the type from `event-record.js`, no repo file imports it from `journal.js`, and the package `exports` map makes `file/journal.js` unreachable anyway. Zero runtime effect; matches CONTEXT.md invariant 8 (pre-release: no compat shims). |
| A9 | `code-simplifier-3` | **Overlapping `types` boundary rules in `check-imports.ts`.** The second `scope: ["types"]` rule applies to every `types/**` file except `types/index.ts`, duplicating the first rule's forbidden modules there and emitting two violations (different `reason` strings) for one import. Narrow its scope to `["types/index.ts"]` (exact-path entry — `inScope` matches `.ts` entries exactly): `index.ts` keeps its narrower policy (may import `../shared`; must not `../dag-runtime`/`../executor` — identical to today), every other file keeps the first rule's full policy, the duplicate report disappears. Pass/fail set byte-identical. |
| A10 | `code-simplifier-4` | **`fileCacheError` re-implements its callee's ternary.** The `publicFrameworkError.cacheError` factory already branches on `failureClass === undefined` and produces the identical object in both arms; delegate in one call (`publicFrameworkError.cacheError(operation, message, failureClass)`), keeping the wrapper's one real job — narrowing `operation` to the closed `FileOperation` vocabulary. Behavior identical on all inputs. |
| A11 | `code-simplifier-5` | **False-sharing comment at `checkpoint/checkpointer.ts:170`.** The `checkpointWriteFailed` doc claims "one encoding shared with the file backend's `writeFailed`", but the module keeps a private duplicate (own `stringOf` + placeholders) that only stays in parity manually — exactly the drift that round-6 C4 proved can occur. Reword to "parity with the file backend's `writeFailed` (checkpointer-codec.ts) — manually mirrored, pinned by the hostile-value corpus on both sides" so the documented invariant is true. Consistent with deferring the structural consolidation (D1 below). |
| A12 | `code-simplifier-6` | **`asCacheError` triplicated with drifted assertions.** Consolidate into one helper in a new `__tests__/_cache-error-helpers.ts` (project `_`-prefixed test-library convention): the journal shape (optional `expectedOperation` + `message.length > 0` check) — the strictest common shape; adopting it at the two sites that lacked the length check only ADDS an assertion. Delete the three private copies (`file-event-record.test.ts`, `file-job.test.ts`, `file-journal.test.ts`). |
| A13 | `code-simplifier-7` | **`findReservedTagKey` computes `Object.keys(value)` twice.** Bind `const keys = Object.keys(value)` once and run both the reserved-tag scan and the reverse walk over it. Behavior identical (synchronous walk, no mutation/re-entrancy between the two calls). |

### Deferred (2)

| # | ID | Reason |
|---|----|--------|
| D1 | `architecture-tech-lead-1` — the honest-branding `checkpoint-write-failed` construction policy (total `stringOf`, `checkpoint_invalid_run`/`checkpoint_invalid_node` placeholders, additive `invalid*` diagnostics) is duplicated between `checkpoint/checkpointer.ts` and `file/checkpointer-codec.ts` rather than shared | Sound, and the drift risk is proven real (round-6 C4 was exactly this drift). Deferred because the complete fix is a cross-layer structural refactor — a new shared constructor in `types/error-factories.ts`, re-pointing both adapters, and migrating the hostile-value test corpus across the module boundary — while the Redis adapter (outside this review's scope) would still carry a third surface, so the scoped fix is not the single-encoding the claim names. No current behavioral defect: both sides are byte-identical today and the parity is pinned by the hostile-value corpus on both sides; A11 makes the documented invariant true in the interim. Schedule for the next `types/`-layer deepening round alongside the Redis checkpointer scope. |
| D2 | `architecture-tech-lead-3` — the pure AD-5 freshness decision logic (`selectLatestWrite`, `decideConflict`, the closed singleton codec, the Redis equal-score tie-break) in `file/freshness-index.ts` is module-private and reachable only through the filesystem adapter, unlike the checkpointer whose pure codec was split into `checkpointer-codec.ts` | Sound as a deepening opportunity, but it is a behavior-preserving 530-line module reorganization with a test-relocation surface and no current defect (the property surface is already pinned via fast-check through the adapter, and the `__test*` exports are the only symptom). The project precedent for this exact idiom (the checkpointer codec split) was executed in a dedicated remediation round, not folded into a findings round. Schedule for the next `file/` deepening round. |

### Dismissed

None.

## Files to change (all in frozen scope unless noted)

- `packages/framework/src/file/job.ts` (C1 comment)
- `packages/framework/src/checkpoint/checkpointer.ts` (C2 comment; A0 guards + `cacheError` helper; A11 comment)
- `packages/framework/src/__tests__/redis-checkpointer.test.ts` (A0 pin)
- `packages/framework/src/__tests__/file-journal.test.ts` (A1 matrix row; A7 message survives; A12 helper adoption)
- `packages/framework/src/__tests__/file-freshness-index.test.ts` (A1 matrix row)
- `packages/framework/src/llm/fake-client.ts` (A2 thenable guards + type docs)
- `packages/framework/src/__tests__/llm-fake-client.test.ts` (A2 pins)
- `packages/framework/src/file/layout.ts` (A3 doc)
- `packages/framework/src/__tests__/file-verified-directory.test.ts` (A4 provenance)
- `packages/framework/src/__tests__/errors.test.ts` (A5 header)
- `packages/framework/src/file/event-record.ts` (A6 composite parse; A13 double `Object.keys`)
- `packages/framework/src/file.ts` (A6 barrel export + header line)
- `packages/framework/src/__tests__/file-event-record.test.ts` (A6 pins; A12 helper adoption)
- `packages/framework/src/file/journal.ts` (A7 factory distill; A8 dead re-export)
- `packages/framework/src/scripts/check-imports.ts` (A9 rule scope)
- `packages/framework/src/file/boundary-error.ts` (A10 delegation)
- `packages/framework/src/__tests__/file-job.test.ts` (A12 helper adoption)
- **Support (new, not in reviewed scope):** `packages/framework/src/__tests__/_cache-error-helpers.ts` (A12 shared helper); `.claude/plans/2026-08-17-pr-remediation-round-7.md` (this plan)

## Validation

```bash
cd /home/peterstorm/dev/agentic/fugue
bun run typecheck                       # root: tsc --noEmit in every package
bun test packages/framework -- 'file-'  # scoped first, then:
bun run test                            # full suite, all packages
```

Specific regression checks beyond the suite:
- `file-journal` factory matrix (A1 row + A7 message shape), `file-freshness-index` matrix (A1), `llm-fake-client` totality block (A2), `redis-checkpointer` in-memory totality block (A0), `file-event-record` composite-parse pins (A6), `boundary-imports` gate (A9), full in-scope test set (all 20 in-scope files).
