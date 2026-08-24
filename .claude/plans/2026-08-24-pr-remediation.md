# PR Remediation Plan — Adjudicated Standalone Review (round 39)

**Branch:** `feat/f6-file-durable-runtime`
**Review HEAD (frozen source):** `22b358415a54e6691db6cdb5c5365d049024c57f`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-review-20260823T190000Z-raf`
**Canonical result:** `<run>/result.json` (digest `5aad93d9698f773e2d6aeb5f11559b7226a77c371858d04510b489156c5000c3`)
**Frozen scope:** 473 files (see `result.json.scope`)
**Adjudication:** 7 reviewers → 5 critical findings → 3-lens Refutation Panel
(`reproduction`, `intent`, `blast-radius`) → **5 surviving / 0 refuted**, 62 advisories.

`pr-test-analyzer-1` and `pr-test-analyzer-10` are the SAME defect (the engine
admitted the claim once from the reviewer's `findings` block and once from its
`Machine Summary` line). Likewise `silent-failure-hunter-1/-3`,
`silent-failure-hunter-2/-4`, and `architecture-tech-lead-1/-2`. They are counted
as issued but remediated once.

---

## Surviving critical findings — all mandatory

### C1 — `code-reviewer-1` · `packages/framework/src/dag-runtime/wave-execution.ts:246`

**Claim (upheld 3/3).** A retriable freshness-index failure returns `node-failed`
without `partialOutputs`, so `handleNodeFailed` re-enters the same wave with
`ctx.outputs` unchanged and every already-succeeded sibling — including `writes`
/ `external-call` nodes whose real side effect already landed — is re-dispatched.
Duplicate charge / notification / API call.

**Why the naive fix is wrong** (raised by the `intent` lens and confirmed by
reading the code): simply attaching `partialOutputs` makes the retry skip those
nodes in dispatch, and `emitFreshnessWitnessEvents` ALSO skips them
(`skippedNodeIds` is derived from `priorOutputs.has(nodeId)`). The retry would
then complete the wave without ever recording the write witness whose recording
failed — silently defeating ADR-0025 fail-closed freshness. The same latent gap
already exists on the in-dispatch failure path, which carries `partialOutputs`
today.

**Fix.** Separate "output already produced" from "freshness witness already
recorded", so both invariants hold:

1. `freshness-emission.ts` — return a `FreshnessEmissionOutcome` ADT that carries
   the witnessed node set on BOTH the complete and the aborted branch, so partial
   progress is a representable, typed value rather than a lost fact:
   ```ts
   type FreshnessEmissionOutcome =
     | { kind: "complete"; witnessed: ReadonlySet<NodeId> }
     | { kind: "aborted";  witnessed: ReadonlySet<NodeId>; error: FrameworkError };
   ```
2. `wave-execution.ts` / `executor.ts` — carry a run-scoped `witnessedNodeIds:
   Set<NodeId>` accumulator on `WaveConfig`/`PostWaveContext`, built once in
   `buildDagExecutor` beside the existing `capturedWitnesses` accumulator (same
   precedent, same lifetime, no persistence-format change).
3. The freshness skip rule becomes `resumeCheckpoint?.has(id) ||
   witnessedNodeIds.has(id)` — replacing the `priorOutputs.has(id)` proxy. A node
   resumed from a checkpoint still performed its I/O in a prior process (ADR-0025
   unchanged); a node carried from a failed attempt of THIS wave has not been
   witnessed and must be.
4. Extract the `partialOutputs` computation into one helper and use it on the
   freshness-failure branch as well as the in-dispatch branch.

**Regression tests.** (a) a wave whose freshness index fails retriably re-runs
only the un-witnessed node, and the already-succeeded `writes` sibling's `run` is
invoked exactly once; (b) that sibling's write witness IS recorded on the retry.

### C2 — `pr-test-analyzer-1` / `-10` · `packages/host/src/supervisor/lifecycle/grace-window-purge.ts:224`

**Claim (upheld 3/3).** `hardDelete` deletes `fugue:tenants:<id>` guarded only by
`existing === undefined` — never by status or tombstone identity. `register`
explicitly REVIVES a deregistered tenant, and the sweep runs on a timer with four
awaited I/O steps before `hardDelete`, so a revive landing mid-purge has the
now-active tenant's config record permanently deleted. No test covers it.

**Fix.**
1. `hardDelete(tombstone: DeregisteredTenantConfig)` — the port now demands the
   witness the sweep actually observed, not a bare id (parse-don't-validate: the
   caller cannot ask for a delete it has no tombstone for). Inside
   `serializeMutation` (which already serialises against `register`), delete only
   when the live entry is still `status: "deregistered"` with the SAME
   `deregisteredAt`. `deregister` preserves the original `deregisteredAt` on
   repeat and mints a fresh one after a revive, so this one comparison catches
   both revive and revive-then-re-tombstone. The compare and the delete are
   inside the same mutation turn, so this step is genuinely atomic.
2. `hardDelete` returns a typed `HardDeleteOutcome` (`"deleted" | "absent" |
   "superseded"`) so a skipped delete is a reported fact, not a silent success.
3. Steps 1–4 of `purgeTenantFootprint` re-check the tombstone witness before each
   destructive step and abort the purge with a `superseded` outcome. This narrows
   — it cannot eliminate — the window on those recoverable steps; the
   permanently-destructive step 5 is fully closed by (1). Documented as such in
   the module header rather than implied.

**Regression tests.** revive-during-purge: `hardDelete` refuses and reports
`superseded`, the tenant config survives, and the sweep aborts the remaining
destructive steps.

### C3 — `code-simplifier-1` · `packages/adapter-oracle/src/index.ts:672`

**Claim (upheld 3/3).** The late-failure `.catch` is attached unconditionally, so
EVERY execute rejection logs `late probe failure after timeout` even when no
timeout ever fired. `@fuguejs/pg`'s twin gates the identical catch on a `timedOut`
flag set only inside the timer callback.

**Fix.** Mirror `adapter-pg`: set `timedOut = true` in the `setTimeout` callback
and gate the warning on it. Regression test: a fast-rejecting execute produces the
`Err` with no late-probe warning; a timed-out one still warns.

### C4 — `code-simplifier-2` · `packages/adapter-ms-graph/src/path-resolving.ts:199`

**Claim (upheld 3/3).** `graphJson` always composes
`AbortSignal.timeout(requestTimeoutMs)`, while the same package's `buildSignal`
treats a non-positive `timeoutMs` as "no timeout". `requestTimeoutMs` is an
unvalidated optional `number` on a publicly exported adapter factory, so a
consumer passing `0` gets instant-abort on resolution and no timeout on byte I/O.

**Fix.** Extract `buildSignal` into a new leaf module
`packages/adapter-ms-graph/src/request-signal.ts` and import it from BOTH
`index.ts` and `path-resolving.ts` (a leaf, so no import cycle — `index.ts`
already re-exports `path-resolving.ts`). One composition, one meaning for the
knob. Regression test: `requestTimeoutMs: 0` yields the same signal shape on both
paths.

---

## Advisory dispositions

62 issued advisory findings; 57 unique claims after de-duplication.
**Accepted: 56 unique. Dismissed: 1. Deferred: 0.**

### Dismissed

- **`comment-analyzer-1`** — "source comments embed ephemeral review-round ids
  (`round-38 cs-2`) pointing at `.claude/plans/*.md` workflow artifacts that are
  not durable documentation."
  **Reason:** the premise is factually wrong for this repository. Every
  `.claude/plans/*-pr-remediation*.md` file the comments reference is committed
  and is itself inside this review's own 473-file frozen scope (`result.json`
  lists 30+ of them). The provenance markers resolve to tracked files under
  version control, so they are not dangling. Stripping ~25 accurate cross-
  references across 25 files would remove working provenance for a cosmetic gain.

### Accepted — behaviour

| ID | File | Fix |
|----|------|-----|
| `silent-failure-hunter-1`/`-3` | `framework/src/tracing/azure-monitor-exporter.ts:236` | Guard the inner `shutdown()` with the file's own log-then-continue discipline, matching its documented `export()` contract. |
| `silent-failure-hunter-2`/`-4` | `framework/src/nodes/eval-judge.ts:268` | Classify caught exceptions: orchestrator-shaped bugs route to `crashResult`, genuine LLM/network failures stay `llmFailureResult`, so the documented `crash` outcome and the `judgesCrashed` signal become reachable. |
| `code-simplifier-25` | `apps/customer-summary/scripts/smoke-full.ts:73` | Import the `Tracer` type — the annotation currently does not type-check, Bun just strips it. |
| `architecture-tech-lead-1`/`-2` | `framework/src/dag-runtime/freshness-check.ts:38` | Delete the dead batch `checkFreshness` duplicate and re-target its property-test invariant at `InMemoryFreshnessIndex.findConflict`, the algorithm actually in the seam. |
| `comment-analyzer-2` | `framework/src/file/checkpointer-codec.ts:73` | Correct the builder attribution to `types/checkpoint-address.ts`. |

### Accepted — reuse / duplication (`distill` moves)

`code-simplifier-3` … `-24` and `-26` … `-48` — 45 findings, each a
"reuse before rewrite" move whose target already exists in the codebase:
local `FrameworkError` factories (oracle ×4, pg ×2), dead `PostWaveContext`
fields, the shared `emitNodeError` closure, the project `bestEffort` helper,
CLI transform/writer/abort-literal dedupes, the `MAX_SAFE_RECORD_DEPTH` guard
hoist, `wrapRedisOp`, `brandedId` reuse, `Object.hasOwn` ×2, the 503/401
response helpers, the `run-dag` dead ternary, the registry transition helper,
`failClosed`, `startSweep` reuse for the grace-window timer, `logSafely`,
two `customer-summary` dedupes, and 23 test-file fixture/helper consolidations.
All are in-scope, behaviour-preserving, and verified against a green baseline
one move at a time.

`code-simplifier-19` and `-21` are folded into the C2 work (same files).
`code-simplifier-5` and `-6` are folded into the C1 work (same files).

### Accepted — test coverage

`pr-test-analyzer-2` … `-9` — eight coverage gaps:
`createFileFreshnessIndex` wired into a real `runDagStateful` wave;
`abortSpawn` after a post-live `persistRecord` failure; `RedisCheckpointer.saveNode`
ignoring composite `SaveNodeOpts` (FR-023); best-effort `persistRecord` failure
during `drain`; `parseDecimalComponent` on an `Infinity`-overflowing digit string;
a dedicated `lossless-json` host-wrapper suite; `healthCheckWithTimeout` against a
`probe()` that escapes its `Result` contract; `tokenEndpointOrigin`'s unparseable-
URL fallback.

---

## Refuted findings audit

**None.** All five critical findings were upheld unanimously by all three panel
lenses. Panel reasoning is preserved verbatim in
`<run>/transcripts/refutation-slot:*/attempt-1.raw` and summarised in the final
report. No finding was audited-and-skipped.

---

## Validation

```bash
bun run typecheck          # all 12 workspaces
bun run test               # all 12 workspaces, full suite
```

Baseline before any edit: typecheck clean, `bun run test` green in all 12
workspaces (framework 3118 pass / 0 fail, customer-summary 231 pass / 0 fail).
Validation must be green again before remediation installation; the run stages
nothing if it is not.

## Found while implementing

Three things surfaced during remediation that the review could not have named,
recorded here because they changed the work:

1. **`checkFreshness` is not merely dead** (revises the `architecture-tech-lead-1`
   disposition). `__tests__/freshness-check-property.test.ts:134` uses it as the
   DIFFERENTIAL ORACLE for `InMemoryFreshnessIndex.findConflict` across 500
   generated write sequences — i.e. the forcing function the advisory said was
   missing already exists. Deleting it (option A) would have removed a real
   guard. Applied instead: keep the algorithm, document its two jobs (forensics +
   oracle) in the module header and `CONTEXT.md`, and remove it from the package
   barrel — which closes the actual defect, a public export with no caller.
2. **A real bug behind an accepted coverage gap.** Writing the `pr-test-analyzer-8`
   test showed `healthCheckWithTimeout` called `tokens.probe(...)` directly, so a
   provider that throws SYNCHRONOUSLY (rather than returning a rejected promise)
   escaped the handler entirely and would take down the readiness endpoint.
   Fixed in `packages/http-auth/src/index.ts` by routing the call through
   `Promise.resolve().then(...)`; both contract violations now land on the same
   `Err`, and the provider's message is deliberately not interpolated (it can
   carry a credential and this string reaches an unauthenticated response).
3. **`apps/customer-summary/scripts/` is excluded from typechecking** — its
   `tsconfig.json` has `"include": ["src"]`, which is why the missing `Tracer`
   import (`code-simplifier-25`) went unnoticed. The named defect is fixed, but a
   scoped typecheck of that directory reports ~12 further pre-existing errors
   (unbranded id literals in the smoke scripts, an import of a non-existent
   `ToolCall` export, unused locals). Adding `scripts` to the tsconfig `include`
   is the durable fix; `apps/customer-summary/tsconfig.json` and `package.json`
   are NOT in the frozen review scope, so this is reported rather than done here.

## Support paths (not inside the frozen review scope)

- `.claude/plans/2026-08-24-pr-remediation.md` (this plan)
- `packages/adapter-ms-graph/src/request-signal.ts` (new leaf for C4)
- `packages/adapter-ms-graph/src/__tests__/request-signal.test.ts` (C4 regression)
- `packages/framework/src/dag-runtime/index.ts` (barrel: drop the `checkFreshness` export)
- `packages/framework/src/__tests__/freshness-retry-exactly-once.test.ts` (C1 regression)
- `packages/framework/src/__tests__/freshness-file-dag-integration.test.ts` (`pr-test-analyzer-2`)
- `packages/framework/src/__tests__/redis-checkpointer-composite-opts.test.ts` (`pr-test-analyzer-4`)
- `packages/host/src/__tests__/hitl/lossless-json.test.ts` (`pr-test-analyzer-7`)
