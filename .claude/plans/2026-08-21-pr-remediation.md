# PR Remediation — 2026-08-21

> **Superseded for active remediation by Round 30 below.** Earlier rounds remain as historical evidence; the only authority for Round 30 findings and dispositions is its linked canonical `result.json`.

## Authority

- Branch: `feat/f6-file-durable-runtime`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/run.vtN26syQLu`
- Canonical result: `.claude/reviews/review-and-fix-runs/run.vtN26syQLu/result.json`
- Canonical result digest: `5a386198c7636979dbaeae8280cbbe5b50d1a9c2709a5f3f9e1fd8f40880dfad` (37,959 bytes; digest matches the `done` completion receipt)
- Exact frozen scope: the literal 414 paths in `result.json.scope`; the canonical result is the sole source of review findings, adjudication, and scope.
- Reviewer roster (7, all request-bound evidence captured): `code-reviewer` (attempt 2 — attempt 1 engine-rejected, diagnostic `transcript-shape: messages[121].content[1].arguments.command must be a string for Bash`, recorded in `transcripts/standalone-slot:1:code-reviewer/attempt-1.rejected`), `silent-failure-hunter`, `pr-test-analyzer`, `type-design-analyzer`, `comment-analyzer`, `architecture-tech-lead` (deepen), `code-simplifier` (distill).
- Required support paths outside the frozen scope:
  - `.claude/plans/2026-08-21-pr-remediation.md`
  - `apps/customer-summary/src/__tests__/bootstrap-prompts.test.ts` (new regression pin for the surviving critical)
  - `packages/host/src/__tests__/hitl-transport-selection.test.ts` (new unit tests for the extracted pure seam)

## Mandatory surviving critical findings

1. **`silent-failure-hunter-1` — pipeline-fatal prompt load failure degrades every run silently (bootstrap.ts:312)**
   - Panel outcome: `survives: true` (threshold 2; upheld by `reproduction` + `blast-radius`; refuted-by `intent` only). The intent lens's reading of the module comment (severity-tier rubric) is recorded in the panel reasoning, but the two upholding lenses establish the operator-visible defect: `FilePromptRegistry.load` returns `err` rather than throwing, bootstrap logs and continues, `deps.prompts` lacks `synthesis-system`, `createSummaryDag` threads `synthesisSystemPrompt: undefined` into the synthesize node, and `llm.ts:89` falls back to the generic `"You are an AI assistant..."` system prompt. Every subsequent `/summarize` completes 200 under the degraded system prompt; no per-request, response, or readiness signal exists (only the one startup `log.error`).
   - Fix (the file's own fatal idiom — `resolveObservabilityBackends` throws, `index.ts` maps bootstrap throws to `Fatal: bootstrap failed` + `process.exit(1)`):
     - Extract `export const loadAppPrompts(registry: PromptRegistry, log: AppLogger): Promise<Map<string, string>>` from `bootstrap` (the established extraction idiom, cf. `setUpTracing`).
     - `synthesis` and `synthesis-system` are pipeline-fatal: on `load` failure throw a `Error` naming the prompt and the `prompt-not-found` reason (narrowed from the `FrameworkError` union). Bootstrap therefore fails loudly instead of serving degraded summaries.
     - `summary-eval-rubric` stays best-effort: `log.warn` + skip (post-hoc eval tooling only, per the module's own severity rubric).
     - Replace the `loadPrompt` helper + three awaits with `const prompts = await loadAppPrompts(promptRegistry, log);` and update the load-path comment to the new semantics (fatal prompts fail bootstrap; rubric degrades).
   - Regression pin (new file `apps/customer-summary/src/__tests__/bootstrap-prompts.test.ts`, plain-object `PromptRegistry` fake — port pattern, no mocks):
     - all loads ok → map carries all three texts;
     - `synthesis` load failure → rejects naming the prompt + reason;
     - `synthesis-system` load failure → rejects naming the prompt + reason;
     - rubric load failure → resolves with both fatal prompts present (degradation preserved).

## Advisory dispositions

1. **`silent-failure-hunter-2` — accepted.** Readiness reports green while the LLM is the unconfigured `FakeLlmClient` fallback (every `/summarize` guaranteed to fail). Same readiedness-gate idiom as the Redis/checkpointer path:
   - `apps/customer-summary/src/server.ts` `HealthDeps`: add `readonly checkLlm?: () => Promise<boolean>` (default-true when unwired — existing test apps that build `createApp` directly with a fake LLM keep today's readiness); `checkReadiness` computes `llmOk` with the same rejecting-probe-logged guard; `httpStatus`/`status` treat `!llmOk` as not-ready (503) exactly like `!redisOk`; `/readyz` JSON gains `llm: llmOk`.
   - `apps/customer-summary/src/bootstrap.ts`: set `llmIsFake = true` in the no-API-key branch; wire `checkLlm: async () => !llmIsFake` into `deps.health`.
   - `apps/customer-summary/src/__tests__/server.test.ts`: readyz tests — `checkLlm` false ⇒ 503 `not-ready` with `llm: false`; throwing `checkLlm` ⇒ not-ready (probe-guard parity).
2. **`silent-failure-hunter-3` — accepted.** `cleanupTimedOutChild`'s `void` async IIFE has no terminal guard: a rejecting `drainStreams` (per its `Promise<unknown>` contract) or a throwing `forceKill` becomes a process-level unhandled rejection with no log line. Wrap the IIFE body in a terminal `try/catch` that `console.warn`s a `[git-sync]` breadcrumb (established host-adapter idiom, cf. `module-loader.ts`); the guard lives at the helper so both call sites and future ones are covered.
   - `packages/host/src/__tests__/git-sync.test.ts`: extend the stalled-clone timeout test with an `unhandledRejection` listener during the cleanup window asserting none fires.
3. **`silent-failure-hunter-4` — accepted.** `parseToolCalls` sets a `__parse_error__` marker that no code inspects (single grep hit in production code; `unknown_input` is not a taxonomy entry anywhere) and the comment claims an `unknown_input` classification that never happens — the input actually fails the tool's Zod `inputSchema` as `invalid_input`. Delete the dead marker (pass the raw arguments string through, which yields the clearer `expected object, received string` Zod message for model recovery) and correct the comment to the true behavior. No test pins the marker (verified by grep).
4. **`pr-test-analyzer-1` — accepted.** No scale regression through the real journal: `appendEvent` is O(files) per call (listing + naming-contract verification) and resume's strict-prefix scan is O(n) (AD-3), unguarded at the design's stated hundreds-to-low-thousands scale (largest real-journal test today: ~25–30 events). Add a scale describe block to `packages/framework/src/__tests__/file-journal.test.ts`:
   - N = 1000 keyed appends through `createFileJournal` (measured ~2 s locally — practical);
   - `writeCheckpoint(serializeFileCheckpoint(...))` every 100 appends + final;
   - assert exactly 1000 well-named records with contiguous 6-digit sequences `000000…000999` (lexicographic order == append order survives at scale);
   - `resumeFileJob` with a minimal counting machine (the `file-resume.test.ts` machine idiom) + strict `parseCheckpoint` ⇒ `ok` with final state = full 1000-event replay (guards the O(n) prefix scan);
   - generous wall-clock guard (total < 60 s) that catches pathological per-append regressions at this scale without flaking on a slow CI runner.
5. **`type-design-analyzer-1` — accepted.** `serializeMeta` (file/checkpointer-codec.ts:204) gates `meta.dagId` on string-ness only, so the file write boundary accepts a dagId outside the `DagId` domain that the SAME backend's `load` rejects as `checkpoint-corrupt` (`parseRunMetaRecord` → `tryDagId`) and that the in-memory backend's `RunMeta.dagId` typing already excludes. Re-establish the domain at the write boundary: after the string check, `tryDagId(dagId)` (reuse the existing `types/ids.ts` guard) and throw on `err` — `setMeta`'s existing catch maps that throw to the typed `checkpoint-write-failed`, matching in-memory parity.
   - `packages/framework/src/__tests__/file-checkpointer-codec.test.ts`: `serializeMeta` throws for an out-of-domain dagId (colon-bearing, per `DAG_ID_REGEX`) and for non-string.
   - `packages/framework/src/__tests__/file-checkpointer.test.ts`: end-to-end `setMeta` with an out-of-domain dagId ⇒ `err` (`checkpoint-write-failed`), never `ok`-then-corrupt-on-load.
6. **`type-design-analyzer-2` — accepted.** `FileJournal.readCheckpoint()` returns the `RawCheckpointJson` brand, but neither `RawCheckpointJson` nor its mint `rawCheckpointJson` is exported from the `@fuguejs/framework/file` barrel — the type-level obligation the brand exists to make visible (round-23 tda-5) is unreachable from the public subpath. Export both beside the journal exports in `packages/framework/src/file.ts`.
7. **`comment-analyzer-1` — accepted.** `acquireFileLock`'s doc calls the ≈5 s backoff budget "the exact ceiling for live-holder contention" while its own parenthetical (each attempt probes, finds the owner live, and sleeps) shows the wall-time ceiling is the 5 s SLEEP budget plus 50× per-attempt probe/staging overhead. Reword: ≈5 s is the sleep budget; the pure-live-holder wall-time ceiling is that budget PLUS per-attempt overhead.
8. **`comment-analyzer-2` — accepted.** The freshness-index `readClock` comment's hardcoded enumeration ("third clock-guard implementation, covering the last two of the five clock sites") has no canonical enumeration to check against and will silently go stale when any clock site is added/removed. Reword to point at the shared guard shape and the sibling implementations without the brittle count.
9. **`architecture-tech-lead-1` — accepted.** HITL notifier transport selection (Bot Framework vs webhook vs disabled) + its boot-warning invariants are inlined in `createHost` (host.ts:542-671) with no pure seam, testable only via full-host boot — unlike the sibling `selectCapabilityBroker` extracted in the same file. Extract a pure `selectHitlNotifierTransport(config: Pick<HostConfig, "BOT_APP_ID" | "BOT_APP_PASSWORD" | "BOT_TOKEN_URL" | "TEAMS_WEBHOOK_URL" | "HITL_APPROVAL_BASE_URL" | "PORT">): HitlNotifierSelection` returning the discriminated union `bot-framework { appId, appPassword, tokenUrl? } | webhook { webhookUrl, approvalBaseUrl } | disabled { reason: "bot-password-missing" | "unconfigured" }`; `createHost` consumes it (Bot precedence, `http://localhost:${PORT}` default approval base, the single `BOT_APP_ID without BOT_APP_PASSWORD` boot warning move into the consumption branch). Unit tests in the new `packages/host/src/__tests__/hitl-transport-selection.test.ts` (modeled on `broker-selection.test.ts`): both-configured ⇒ bot wins; password-missing ⇒ disabled + reason; webhook-only ⇒ webhook with derived and explicit `approvalBaseUrl`; neither ⇒ disabled `unconfigured`.
10. **`code-simplifier-1` — accepted.** `parseSaveNodeBoundary` builds the frozen `saveOpts` in three branches repeating the conditional namespace spread. Fold to one ambiguity guard (`namespace` present with neither `index` nor `attempt`) plus one conditional-spread construction — behavior-identical across all four presence combinations (verified by the existing codec suite pins).
11. **`code-simplifier-2` — accepted.** `serializeMeta` constructs `new Date(createdAtMs)` before the `isRepresentableTimestampMs` guard, an invalid-Date-then-discarded reading. Move the gate above the construction (zero behavior change).

No advisory is deferred or dismissed: every claim was verified against the code and every fix is a complete in-scope change (or a named new test file registered as a support path).

## Round 30 — active remediation plan

### Authority and exact reviewed scope

- Branch: `feat/f6-file-durable-runtime`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/standalone-review-20260821-221908-21514`
- Canonical result: `.claude/reviews/review-and-fix-runs/standalone-review-20260821-221908-21514/result.json`
- Result digest: `3e851009fd0229d411473035fa1455eaa024c185280bbf1fd2fbd797f06a9704` (40,987 bytes).
- Exact scope: the literal 419 paths in `result.json.scope`; this plan relies exclusively on the published `surviving_critical_findings`, `advisory_findings`, and `refuted_critical_findings` below.
- Support paths outside the frozen scope to register before remediation: this plan only.

### Mandatory surviving critical findings

1. **`silent-failure-hunter-2` — `packages/host/src/hitl/adapters/run-executor.ts:59`.** A hostile caught value can throw while `toFrameworkError` or logging evaluates `.cause`, `.message`, `instanceof`, or `String`, violating `RunExecutorPort.run`'s never-throw contract.
   - Replace raw diagnostic/cause access with total framework diagnostic helpers and a guarded `Reflect.get`-based framework-error inspection.
   - Ensure the catch path always returns `ok({ kind: "failed", error })`, including a revoked proxy or throwing coercion hook.
   - Add an adversarial caught-value regression test that proves the failed outcome survives and uses a safe fallback diagnostic.

2. **`architecture-tech-lead-1` — `packages/host/src/hitl/service.ts:132`.** A successful `RunStorePort.create` followed by failed `RunQueuePort.enqueue` leaves a non-terminal active run with no wakeup path.
   - Compensate the created record by terminally settling it as `failed` with the typed enqueue failure mapped through the existing `asRunFailure`; terminal settlement removes it from ADR-0074's active-run index.
   - If compensation itself fails, surface that typed persistence error rather than reporting the start as successful.
   - Add a plain-fake test proving failed initial enqueue leaves a terminal failed run, removes its active-index slot, and returns the enqueue error.

### Advisory dispositions

| ID | Disposition | Reason and planned action |
| --- | --- | --- |
| `code-reviewer-1` | accepted | `module-graph-acyclic.test.ts` wrongly relies on package-root invocation while the documented command runs from repository root. Derive `SRC` from the test module directory and run the framework suite from root. |
| `silent-failure-hunter-3` | deferred | ADR-0060 explicitly makes decision-store and notifier failures non-fatal after durable parking; requiring a logger or defining a process-stderr fallback changes the host observability contract and needs a dedicated operational-sink design. The existing optional logger still records the typed error when wired. |
| `silent-failure-hunter-4` | accepted | A missing team record named by the durable enumeration index is persistence drift, not a complete list. Return typed `redis-unavailable` after a warning rather than silently returning a partial listing; pin it in token-store tests. |
| `pr-test-analyzer-2` | dismissed | Direct evidence refutes the alleged gap: `packages/adapter-fs/src/__tests__/fs-adapter.test.ts` already pins pre-abort for content and metadata, mid-read `AbortError`/`TimeoutError`, confinement before I/O, and `mapFsError` classifications. No redundant tests are warranted. |
| `type-design-analyzer-1` | accepted | Existing legitimate callers use non-colon names (for example `"src"`), so enforcing the claimed grammar would be a breaking false invariant. Correct the documentation to state the actual non-empty invariant and call the colon shape a convention only. |
| `comment-analyzer-1` | accepted | Clarify PostgreSQL `queryOne` as returning the first validated row (or null), matching the existing implementation without changing query semantics. |
| `comment-analyzer-2` | accepted | Apply the same first-row clarification to Oracle `queryOne`. |
| `code-simplifier-1` | accepted | Extract the repeated freshness node-error envelope into one local helper while preserving error/message/timestamp behavior; run its focused tests after the single simplification move. |
| `code-simplifier-2` | accepted | Centralize the hostile-clock read and finite-timestamp guard in `InMemoryCache` without changing `get`/`set` errors; run cache/clock tests after the move. |
| `code-simplifier-3` | accepted | Share thrown-span finalization in capability tracing without changing error rethrow, span status, exception recording, or close ordering; run tracing tests after the move. |

### Refuted-critical audit — retain, never fix

1. **`silent-failure-hunter-1` — `packages/framework/src/file/atomic.ts:223`**: *“protocolEntries treats an unreadable fence directory as no fence entries…”* Refuted by the reproduction and security lenses: `tryFencedBirth` must create inside the fence and wraps failure; if creation succeeds but listing fails, `readdirSync` is wrapped as a typed file-operation failure.
2. **`pr-test-analyzer-1` — `packages/adapter-fs/src/index.ts:141`**: *“no direct tests prove confinement…”* Refuted unanimously: `fs-adapter.test.ts` already exercises traversal, escaping absolute paths, root-directory rejection, and verifies traversal through `getContent` performs no injected filesystem I/O; `getMetadata` shares the gate.

### Planned paths and validation

- Criticals: `packages/host/src/hitl/adapters/run-executor.ts`, `packages/host/src/hitl/adapters/__tests__/run-executor.test.ts`, `packages/host/src/hitl/service.ts`, `packages/host/src/hitl/__tests__/service.test.ts`.
- Accepted advisories: `packages/framework/src/__tests__/module-graph-acyclic.test.ts`, `packages/host/src/adapters/token-store.ts`, `packages/host/src/__tests__/token-store.test.ts`, `packages/framework/src/types/witness.ts`, `packages/adapter-pg/src/index.ts`, `packages/adapter-oracle/src/index.ts`, `packages/framework/src/dag-runtime/freshness-emission.ts`, `packages/framework/src/cache/cache.ts`, `packages/framework/src/tracing/capability-tracing.ts`, and their existing focused tests.
- Support: `.claude/plans/2026-08-21-pr-remediation.md`.
- Validation: focused `bun test` commands for every changed package/test file; `bun test packages/framework`; `bun test packages/host`; `bun test packages/adapter-fs`; `bun run typecheck`; then the registered remediation run's engine-owned audit and temporary-index installation.

## Refuted critical audit — retain, never fix

None. `result.json.refuted_critical_findings` is empty (0). The `intent` lens did refute the surviving critical's comment-contract premise, but the panel's registered outcome for `standalone-review:silent-failure-hunter-1` is `survives: true` (2 upholds vs the threshold of 2; refutation requires the panel outcome, and `refuted_by: ["intent"]` is recorded on the surviving outcome for the audit trail — see `result.json.panel.outcomes[0]`).

## Planned touched paths

- `.claude/plans/2026-08-21-pr-remediation.md` (support)
- `apps/customer-summary/src/bootstrap.ts`
- `apps/customer-summary/src/server.ts`
- `apps/customer-summary/src/__tests__/server.test.ts`
- `apps/customer-summary/src/__tests__/bootstrap-prompts.test.ts` (support, new)
- `packages/host/src/adapters/git-sync.ts`
- `packages/host/src/__tests__/git-sync.test.ts`
- `packages/framework/src/llm/openai-types.ts`
- `packages/framework/src/__tests__/file-journal.test.ts`
- `packages/framework/src/file/checkpointer-codec.ts`
- `packages/framework/src/__tests__/file-checkpointer-codec.test.ts`
- `packages/framework/src/__tests__/file-checkpointer.test.ts`
- `packages/framework/src/file.ts`
- `packages/framework/src/file/atomic.ts`
- `packages/framework/src/file/freshness-index.ts`
- `packages/host/src/host.ts`
- `packages/host/src/__tests__/hitl-transport-selection.test.ts` (support, new)

## Validation

Run focused gates after coherent fixes, then full repository gates:

```bash
bun test apps/customer-summary/src/__tests__/bootstrap-prompts.test.ts apps/customer-summary/src/__tests__/server.test.ts
bun test packages/framework/src/__tests__/file-checkpointer-codec.test.ts packages/framework/src/__tests__/file-checkpointer.test.ts
bun test packages/framework/src/__tests__/file-journal.test.ts
bun test packages/framework/src/__tests__/openai-client.test.ts packages/framework/src/__tests__/tool-dispatch.test.ts
bun test packages/host/src/__tests__/git-sync.test.ts packages/host/src/__tests__/hitl-transport-selection.test.ts
bun run check:docs
bun run typecheck
bun run test
```

After green implementation, run the mandatory `distill` apply-mode pass one move at a time with covering tests. Registered remediation then owns path audit, temporary-index staging, verification, and atomic index installation.
