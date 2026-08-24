# 2026-08-19 — PR Remediation, Round 23

- **Branch:** `feat/f6-file-durable-runtime`
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-19-200419-f6-file-durable-runtime`
- **HEAD reviewed:** `e35cb66` (round-22 remediation)
- **Result authority:** `result.json` (digest `1a203c63…`, 372-file scope)

## Adjudication summary

| Outcome | Count |
|---|---|
| Surviving critical findings (mandatory) | 0 |
| Refuted critical findings (report only, never fix) | 0 |
| Advisory findings accepted | 15 |
| Advisory findings deferred | 3 |
| Advisory findings dismissed | 2 |

## Phase 2 — Plan

No surviving critical findings; remediation applies the 15 accepted advisories below.

### Advisory dispositions

#### Accepted (15)

1. **silent-failure-hunter-1** — `packages/framework/src/queue-bullmq/event-log.ts:105` (`parseEnvelope`): the `payloadIndex === -1 || payloadIndex + 1 >= fields.length` branch conflates a true legacy entry (no `payload` field) with a present-but-valueless payload (truncated stream entry). The latter silently fabricates `{ payload: undefined }` events that replay as history, while the adjacent corrupt-JSON path fails closed loudly. **Fix:** split the branches — `payloadIndex === -1` keeps the legacy reconstruction; `payloadIndex + 1 >= fields.length` warns and throws the same typed corrupt-entry Error class as the JSON branch. **Pin** in `queue-bullmq-adapter.test.ts` (in scope): a stream entry whose payload field has no value fails `readEvents` closed with the corrupt-entry error; a legacy no-payload entry still reconstructs.
2. **silent-failure-hunter-2** — `packages/host/src/adapters/token-store.ts:194` (`listTeams`): the skip branch treats a failed `redis.get` identically to an absent key and continues with no log, truncating the team list during a Redis blip. **Fix:** split the error case (`!valueResult.ok` → `logger?.warn` naming kind + team, then continue) from the absent case (silent skip, self-heals on revoke). **Pin** in `packages/host/src/__tests__/token-store.test.ts` (support path — outside the frozen scope): a failing team-key read is logged as a warning and the remaining teams still list.
3. **silent-failure-hunter-3** — `packages/framework/src/observer/foundry-event-mapping.ts:106,125` (`metricEmission`/`finiteMeasurements`): non-finite metric values drop silently. **Fix:** keep the drop (Application Insights constraint) but make it observable — warn through `fwLogger()` naming the metric and the rejected value, bounded by `safeDiagnosticRender`; same message for the measurements bag when a non-finite entry is dropped. **Pin** in `packages/framework/src/observer/foundry-event-mapping.test.ts` (support path): non-finite metric still emits no metric, but a warning is produced.
4. **pr-test-analyzer-1** — `packages/framework/src/observer/buffered.ts:180` (round-22 cr-1 twin): the inactivity-eviction fix has no framework-suite pin that distinguishes `lastActivityAt`-based from `createdAt`-based eviction (reverting to createdAt passes all tests). **Fix (test-only):** add pins to `packages/framework/src/__tests__/buffered-observer.test.ts` (in scope) with an injected clock: (a) buffer with events past TTL but fresh `lastActivityAt` is NOT evicted; (b) idle buffer past TTL IS evicted with the orphan warning.
5. **type-design-analyzer-1** — conflicting-write shape defined structurally three times: `FreshnessConflict.conflictingWrite` (`types/freshness.ts:34`), `FreshnessViolationEvent.conflictingWrite` (`types/events.ts:173`), `WriteEntry` (`types/freshness.ts:47`) are byte-identical. **Fix:** move `WriteEntry` into `types/witness.ts` (below both consumers; no cycle — `events.ts` and `freshness.ts` already import from `witness.ts`), re-export from `types/freshness.ts` for back-compat, and type both `conflictingWrite` fields as `WriteEntry`. Type-only, compile-checked.
6. **type-design-analyzer-3** — `RunState.corruptNodeIds?: readonly string[]` is optional, hiding the drop-and-surface contract. **Fix:** make it always present (`readonly string[]`, empty on a clean load): in-memory `load` returns `corruptNodeIds: []`, Redis and file adapters include the field unconditionally (drop the `...(length > 0 …)` conditional spread). Persisted envelopes are unchanged (field is read-side only). No pinned load-shape assertions break (suite asserts field-wise).
7. **type-design-analyzer-5** — `FileJournal.readCheckpoint(): string | null` is the untyped twin of the capability-typed `writeCheckpoint`. **Fix:** introduce `RawCheckpointJson` brand (nominal `string & { readonly __rawCheckpointJson: unique symbol }`), minted at the single read site (`journal.ts:498`), documenting "parsing is the caller's business" in the type. Zero consumer churn (no in-repo port consumers besides `file-job.test.ts`, which still sees a string).
8. **comment-analyzer-1** — `file/checkpointer.ts:24-27` header: "byte-identity clause covers exactly the no-options and index/attempt forms" is wrong — `compositeNodeKey(nodeId, { index: 0 })` emits `dag@nodeId@0@0`, so byte-identity holds only for the no-options form. **Fix:** reword the clause to separate the forms.
9. **comment-analyzer-2** — `file/resume-proof.ts:13-14` header: "(1 read events → 8 checkpoint-corrupt…)" mislabels ADR-0077 step 1 (read `checkpoint.json` before the event log). **Fix:** "(1 read checkpoint → 8 checkpoint-corrupt; …)".
10. **comment-analyzer-3** — `file/freshness-index.ts:472` "third of the five file-backend clock sites" is an inconsistent count. **Fix:** state the count explicitly: "the third clock-guard implementation, covering the last two of the five clock sites (`recordWrite`, `findConflict`)".
11. **architecture-tech-lead-1** — Checkpointer meta/node record codecs encoded twice (`redis-checkpointer.ts:34-120` vs `file/checkpointer-codec.ts`) with already-drifted read-side gates (Redis accepts any parseable date where the file codec requires canonical ISO; any string nodeId where the file codec requires `ID_PATTERN`); Redis comment cites the non-existent `parseStoredNode`. **Fix:** extract the pure record validators into the checkpoint core (`checkpoint/checkpointer.ts`, beside `evaluateCheckpointLoadGates`):
    - `parseCanonicalIsoDate` moves to core (re-exported from the file codec — its test imports it from there);
    - `parseRunMetaRecord(raw) → Result<{ meta, createdAt }, string>` — plain-record gate, field gates, canonical-ISO dates, safe-integer nodeCount, optional subject/dagFingerprint/frameworkVersion — messages byte-identical to the file codec's pinned strings;
    - `parseNodeStateRecord(raw) → Result<{ nodeId, completedAt }, string>` — `ID_PATTERN` nodeId gate + canonical ISO completedAt with the file codec's pinned messages.
    Each adapter keeps its own storage envelope (file: schemaVersion wrapper + digest filenames + serializer-tag output validation; Redis: flat JSON hash fields + Lua) and maps the shared `Result` into its local style (file: `err` passthrough; Redis: throw the message). Redis's read domain TIGHTENS to the file codec's (fail-closed parity); every in-suite fixture is written via the adapters' own serializers (`toISOString()`), so no fixture changes. Fix the `parseStoredNode` comment reference in the same change. `_checkpointer-suite.ts` + `file-checkpointer-codec.test.ts` pins (+ typecheck) verify.
12. **code-simplifier-2** — the guarded checkpoint-clock read (try/catch + representability gate + "permanent" classification) is triplicated across `checkpoint/checkpointer.ts:335`, `redis-checkpointer.ts:167`, `file/checkpointer.ts:315`. **Fix:** one shared `guardedCheckpointClockRead({ now, operation, runId, render, cacheError, throwMessage })` in the checkpoint core; each adapter passes its own total renderers and error constructor so every message stays byte-identical (file's throw-arm message includes `under <directory>` — pinned at `file-checkpointer.test.ts:339`).
13. **code-simplifier-3** — `packages/adapter-fs/src/index.ts:87,124` hand-roll weaker copies of the framework's total `safeErrorMessage`/`probeErrorCode` (`String(e)` and `"code" in e` can throw on hostile thrown values). `adapter-fs` already depends on `@fuguejs/framework`. **Fix:** reuse `safeErrorMessage` for `msg` and `probeErrorCode` for the code probe — behavior-identical for `node:fs` errors, strictly more total.
14. **code-simplifier-4** — `packages/framework/src/cache/cache.ts:49,59,75,81` re-encode `e instanceof Error ? e.message : String(e)`; swap in the package's own total `safeErrorMessage` (byte-identical messages for ordinary Errors).
15. **code-simplifier-5** — `packages/framework/src/file/freshness-index.ts:377,404` encode "expired when age > TTL_MS" twice. **Fix:** one `isExpired(writtenAtMs, nowMs)` helper used by both `selectLatestWrite` and `decideConflict` (behavior-preserving; messages unchanged; existing freshness tests cover both call sites).

#### Deferred (3)

1. **type-design-analyzer-2** (`FileJournal.appendEvent` `dedupKey?: string`) — the widened root is the shared `JobLike` port (`state-machine/types.ts:113` `computeDedupKey: … => string`, `appendEvent` param) and its consumers `runner.ts`/`persistence.ts`, all OUTSIDE the frozen review scope. Narrowing only the file leg breaks typecheck in out-of-scope `persistence.ts`; a complete fix narrows the whole `JobLike` chain (5+ files, 3 out of scope). Deferred to a scoped JobLike-surface pass; the runtime boundary already rejects invalid keys (`parseOptionalDedupKey`, journal.ts:314).
2. **type-design-analyzer-4** (`RunState.nodes` keyed by a `StoredNodeKey` brand) — API-visible type redesign touching every adapter load path and every `nodes[...]` consumer for zero behavior change; the grammar is already enforced at the single mint (`parseCompositeNodeKey`) and per-entry at load. Same class as round-22's deferred tag-stamping seam redesign; tracked for the deepening round.
3. **pr-test-analyzer-2** (customer-summary `bootstrap()` zero tests) — the shell changed mostly diagnostic wiring + a behavior-preserving refactor (reviewer's own rating: low risk, 4/10); a meaningful test needs a Redis/OTel harness (infrastructure decision, cf. round-22's deferred REDIS_URL CI item), and the changed seams already have coverage (`setUpTracing` → `setup-tracing.test.ts`, config → `loadConfig` tests). Deferred to an app-level integration suite with a harness.

#### Dismissed (2)

1. **pr-test-analyzer-3** (`resume.ts:227-232` unreachable non-`FrameworkError` re-tag fence unpinned) — the reviewer's own assessment: 3/10, "Acceptable as a documented fence; noting only for completeness." Unreachable by construction (static import; `event-log.ts` throws only typed `FrameworkError`); pinning would require inverting the boundary to inject a hostile reader — production restructuring for a fence that cannot fire. The typed ride-through at `:226` is already pinned (`file-resume.test.ts:1581`).
2. **code-simplifier-1** (`shared/retry-async.ts` "entirely dead") — claim refuted by evidence: `packages/framework/src/scheduler/scheduler.ts` imports `retryAsync` and calls it at `:292,:339,:349`; `scheduler-cron.test.ts` and `retry-async.test.ts` exercise it. The module cannot be deleted without behavioral change.

### Refuted critical findings audit

None this round (0 criticals were reported; no refutation panel ran).

## Phase 3 — Implementation and validation

Files touched (all in the frozen review scope except the three support paths below):

- `packages/framework/src/types/witness.ts`, `types/freshness.ts`, `types/events.ts` — tda-1
- `packages/framework/src/checkpoint/checkpointer.ts` — tda-3, atl-1, cs-2
- `packages/framework/src/checkpoint/redis-checkpointer.ts` — tda-3, atl-1, cs-2 (+ `parseStoredNode` comment fix)
- `packages/framework/src/file/checkpointer.ts` — tda-3, cs-2, ca-1
- `packages/framework/src/file/checkpointer-codec.ts` — atl-1 (delegates to shared validators; re-exports `parseCanonicalIsoDate`)
- `packages/framework/src/file/journal.ts` — tda-5
- `packages/framework/src/file/resume-proof.ts` — ca-2
- `packages/framework/src/file/freshness-index.ts` — ca-3, cs-5
- `packages/framework/src/observer/buffered.ts` — untouched; `packages/framework/src/__tests__/buffered-observer.test.ts` — pta-1 pin
- `packages/framework/src/observer/foundry-event-mapping.ts` — sfh-3
- `packages/framework/src/queue-bullmq/event-log.ts`; `packages/framework/src/queue-bullmq/__tests__/queue-bullmq-adapter.test.ts` — sfh-1 + pin
- `packages/host/src/adapters/token-store.ts` — sfh-2
- `packages/framework/src/cache/cache.ts` — cs-4
- `packages/adapter-fs/src/index.ts` — cs-3

Support paths (NOT in the frozen review scope; registered in the remediation start input):
- `.claude/plans/2026-08-19-pr-remediation-round-23.md` (this plan)
- `packages/host/src/__tests__/token-store.test.ts` (sfh-2 regression pin)
- `packages/framework/src/observer/foundry-event-mapping.test.ts` (sfh-3 regression pin)

Validation:
```bash
bun run --filter framework typecheck
bun run --filter host typecheck
bun run --filter customer-summary typecheck
bun run --filter adapter-fs typecheck
bun run --filter framework test        # full framework suite (incl. parity + property pins)
bun run --filter host test
bun run --filter adapter-fs test
```
Redis-gated suites skip (no REDIS_URL) — unchanged from prior rounds; Redis read-gate tightening is verified by reading fixtures (all written via the adapters' own canonical-ISO serializers) and by the in-scope `redis-checkpointer.test.ts` typecheck, since those tests cannot execute without Redis.

## Phase 4 — Registered remediation

Fresh remediation run over the same runs root, `sourceRun` = the review run above, `supportPaths` = the three paths above. Resume until `done` (engine stages audited paths, verifies repo witness, atomically installs the verified index). Commit with message `fix(f6): round-23 review remediation — 0 criticals, 15 accepted advisories` and push unless `--no-push`.
