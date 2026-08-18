# PR Remediation — 2026-08-18 (round 13)

**Branch:** `feat/f6-file-durable-runtime` (up to date with origin at `cded1e2`)
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/20260714T000000Z-review`
**Authoritative inputs:** `result.json` (digest `a2273d08…01f4d`, published by the
registered Standalone Review Program; `done` outcome)
**Scope:** the frozen 303-file branch diff named in `result.json.scope`
**Panel:** lenses `reproduction` / `intent` / `blast-radius`, threshold 2 →
1 surviving critical, 0 refuted

## Reviewer counts (from result.json)

| reviewer | critical | advisory |
|---|---|---|
| code-reviewer | 0 | 1 |
| silent-failure-hunter | 0 | 1 |
| pr-test-analyzer | 0 | 5 |
| type-design-analyzer | 0 | 3 |
| comment-analyzer | 0 | 0 |
| architecture-tech-lead | 0 | 7 |
| code-simplifier | 1 | 10 |
| **total** | **1** | **27** |

## Surviving critical findings (mandatory)

### C1 — `code-simplifier-1` — guardrail `TOPIC_KEYWORDS` diverged from its documented mirror (upheld 3/3)

`apps/customer-summary/src/validation/grounding.ts:30` documents its private
`TOPIC_KEYWORDS` (comment at `:22`) as "mirrors extraction/topics.ts", but its
`general` entry diverged from `extraction/topics.ts:9`
(`inquiry, request, assistance` vs `contact`) while the other five topics stay
byte-identical. The guardrail (`checkTopicGrounding`, live on the DAG path via
`dag/nodes/grounding-guardrail.ts:85`) scores topic grounding against a table
the extractor no longer shares. Panel blast-radius: because the guardrail's
list drops `contact` (it is not a superset), a `general` keyTopic grounded
only by "contact" in the source fails every matching step and produces a
spurious ungrounded-topic warning plus a false MLflow ERROR span in the shipped
`ok` response. Git history: the copy was exact when the guardrail landed
(5ee80c4); the wider `general` net was added to the grounding copy alone in
47a1197 with no spec documenting it.

**Fix (behavior adjudication included):** one shared table — the extractor's.
The documented mirror names `extraction/topics.ts` as the source the mirror
reflects; the spec (FR-102/FR-104) drives topic classification from the
extractor's vocabulary; the guardrail's one-sided widening is the
undocumented drift the codebase's own single-encoding discipline
(`event-record.ts` header: "because copies drift") forbids.

1. `extraction/topics.ts`: export `TOPIC_KEYWORDS` (its `general` entry is
   authoritative: `help, question, support, information, contact`).
2. `validation/grounding.ts`: import the table from `../extraction/topics.js`,
   delete the private copy, replace the "mirrors" comment with a pointer to
   the shared table.
3. Behavior delta (accepted): the guardrail gains `contact` (the
   panel-identified spurious-warning case is fixed) and loses
   `inquiry`/`request`/`assistance` (a `general` topic grounded only by those
   now falls through to the existing word-overlap step instead of being
   accepted by an undocumented wider net). The extractor is byte-identical.
4. Regression pin in `__tests__/grounding.test.ts`:
   - a `general` keyTopic whose source text contains only "contact" PASSES
     (the exact panel blast-radius scenario);
   - the guardrail's table is the shared extractor table (same `general`
     entries), so a future one-sided edit fails the suite.

## Advisory dispositions (27)

### Accepted (14)

| id | fix |
|---|---|
| `code-reviewer-1` | `nodes/llm.ts:94` and `cli/authored.ts:611`: replace the raw NUL byte in each string literal with the `\u0000` escape. Runtime-identical (the prompt-hash and duplicate-predicate pins keep passing byte-for-byte); git classifies both files as text again, making future edits reviewable. |
| `silent-failure-hunter-1` (reduced) | `hitl/adapters/run-executor.ts`: (a) name the setup vs execution phase; (b) a context-build throw (host wiring fault: invalid tenant team, FR-040 unmapped agent client) now logs at `error` with the actual message instead of the detail-less `warn` — the genuine silent-failure hole; (c) the outer catch also carries the message at `error`; (d) reconcile the contradicted contract: `service.ts:211`'s comment claims the `err` channel covers "context build" — it does not (three intentional tests pin the channel split: context-build faults settle as the `failed` outcome so the recorded `FrameworkError` keeps the factory's descriptive message, which the `err`→`asRunFailure` path would drop). The comment and the run-executor module doc are corrected to state the real contract: `err` = pre-slice faults only. A new pin asserts the recorded `failed` error carries the factory message for a context-build throw. The full err-channel re-routing proposed by the reviewer was NOT taken: it breaks three intentional pins and degrades the recorded diagnostic. |
| `pr-test-analyzer-1` | `__tests__/file-freshness-index.test.ts:1134`: the 3-process convergence winner assertions sit inside `if (found.ok && found.value !== null)` — a no-op when the committed singleton is corrupt and dropped-with-warning. Replace with `unwrap(found)` + `expect(winner).not.toBeNull()` + the four field assertions, so the pin runs in exactly the failure case it guards. |
| `pr-test-analyzer-2` | `__tests__/file-journal.test.ts`: add the missing success-direction pin for the ADR-0078 writer/reader split — a validly-named record (`000001-<keyDigest("k-corrupt")>.json`) with corrupt CONTENT does not block a different-key append: the writer verifies names only, counts the corrupt record (sequence = 2 for the new record), and never parses its bytes. |
| `code-simplifier-2` | `extraction/sentiment.ts`: export `POSITIVE_KEYWORDS`/`NEGATIVE_KEYWORDS`; `validation/grounding.ts` imports them instead of its private byte-identical copy (the same drift hazard that already bit `TOPIC_KEYWORDS` in this file). Behavior-identical (verified identical lists, 16+16). |
| `code-simplifier-3` | delete the three zero-importer re-exports: `supervisor/supervisor.ts:72` (`WorkerLifecyclePort`), `supervisor/supervisor.ts:536` (`canServeRequests`), `http/router.ts:30` (`HostEnv`). Verified repo-wide: every consumer imports from the defining modules (`lifecycle/spawn-port.js`, `domain/host-state.js`, `http/env.js`), including all tests and the host barrel. Same class cc5cd92 swept. |
| `code-simplifier-4` | `supervisor/lifecycle/worker-lifecycle-manager.ts:583` `drain()`: collapse the unreachable `!draining.ok || draining.value.phase !== "draining"` guard (confirmed-live input + `beginDrain` hardcoding `draining` in its ok value) to the single ADT-meaningful `!draining.ok` arm — which now returns `err(workerUnavailable(tenant))` on BOTH paths of the logged invariant, matching the comment the old `draining.ok ? ok(undefined) : err(...)` arm contradicted. |
| `code-simplifier-5` | `bootstrap.ts:317`: delete `const deployment = config.AZURE_OPENAI_DEPLOYMENT ?? model` — provably always `=== model` in the azure branch (`model` is already `AZURE_OPENAI_DEPLOYMENT ?? LLM_MODEL ?? DEFAULT_MODELS[provider]`); use `model` in the URL and the log line. |
| `code-simplifier-6` | `bootstrap.ts:285-302`: one small `loadPrompt(name, onFail)` helper replaces the three near-identical 7-line load blocks, preserving each prompt's exact log level (error / warn / error) and message. |
| `code-simplifier-7` | `server.ts:262-265`: flatten the surviving nested ternary (the shape cded1e2 eliminated repo-wide) — name the decision `degraded = !mlflowOk \|\| tracingDegraded` and use a flat if/else over the three outcomes. Behavior-identical. |
| `code-simplifier-8` | `file/event-record.ts:207-219`: replace the private `render` (40-char cap, unguarded `String` arm, re-encoded string branch) with the shared `safeDiagnosticRender` alias every sibling file-backend module uses. Verified: no file-backend test pins the 40-char truncated form; only strings of length 41–60 change rendering (diagnostic-only). |
| `code-simplifier-9` | `checkpoint/checkpointer.ts` (`InMemoryCheckpointer`): consolidate the duplicated non-representable-clock rejection inlined in `load` and `setMeta` into one private `readClock(operation, runId)` helper — the file-backend twin's round-12 shape — preserving the operation-prefixed cache-error op (`checkpoint:load` / `checkpoint:setMeta`), the messages byte-for-byte, and the retriability split (throw → default; non-representable → `permanent`). |
| `code-simplifier-10` | `queue-bullmq/adapter.ts:84-92` + `:153-159`: tighten `defaultAttempts`/`concurrency` gates from `Number.isFinite(x) && x >= 1` to `Number.isInteger(x) && x >= 1` — the code now matches its own "finite integer >= 1" message (1.5 passes today). Adjudicated to the tightening arm: the message documents the intent, BullMQ counts are integral, no test pins non-integer acceptance, and fail-fast at the boundary is the repo standard. Messages unchanged. |
| `code-simplifier-11` | `dag-runtime/wave-execution.ts:60`: delete the `PostWaveContext` re-export (exists only for two test imports); point `__tests__/freshness-emission.test.ts:9` and `__tests__/route-emission.test.ts:8` at the defining `../dag-runtime/post-wave-context.js`. |

### Deferred (12)

| id | reason (evidence-based) |
|---|---|
| `pr-test-analyzer-3` | The A1 pin's live-ECONNREFUSED dependency is real but currently green and deterministic (free port → refusal is near-universal; the pin passed this review's test run). The hermetic fix is a connection-seam design call inside a third-party BullMQ wrapper — production-code surface for a test-infrastructure nicety, with no observed failure. Revisit if the pin flakes or the suite time budget degrades. |
| `pr-test-analyzer-4` | Redis-gated suites skip without `REDIS_URL` BY DESIGN; the merge gate provisions Redis (`test:redis` runs the full suite against a real instance), so the durability claims do execute at the gate that matters. Making the skip louder is CI-gate configuration; no CI file is in the frozen scope. |
| `type-design-analyzer-1` | `isNonNegativeSafeInteger` layering is tracked deferral **A17** in the round-12 record; the architecture review's own recommendation is to stage the move WITH the decision-core extractions "so the edge question is decided once, with the composite-node-key import, rather than piecemeal." No behavioral defect. |
| `type-design-analyzer-2` | The truthful-branding double-encoding is tracked deferral **A13**; copies are field-for-field identical and pinned per backend by the hostile corpora. FR-023 forbids restructuring the pre-existing in-memory adapter, which is the root-cause constraint the deferral respects. |
| `type-design-analyzer-3` | `foldStep`'s structural envelope narrowing is tracked deferral **A15**; branding `RecordedEvent` amends a shared KERNEL contract (`runner.ts` + `types.ts`) and, per the architecture review, "should carry a short ADR." The narrowing is documented and pinned; no reachable hazard at HEAD. |
| `architecture-tech-lead-1` | Journal append decision-core extraction (`planAppend`): no behavioral defect; the reviewer's explicit scheduling is "the round-12 record's scheduling (a dedicated `file/` deepening round) is the right vehicle." Structural work staged with the whole cluster. |
| `architecture-tech-lead-2` | Freshness FR-032 decision-core extraction: same deepening cluster, same vehicle (the sibling checkpointer split is the proven template to apply in that round). |
| `architecture-tech-lead-3` | Duplicate of `type-design-analyzer-2` (same A13 deferral, same copies). |
| `architecture-tech-lead-4` | Consolidating the two FR-009 walkers requires a design decision on the known `toJSON`-gate divergence the finding itself names; both walkers are hostile-corpus-pinned today. Staged with the deepening round, starting from the ruling on the divergence. |
| `architecture-tech-lead-5` | Duplicate of `type-design-analyzer-3` (same A15 deferral). |
| `architecture-tech-lead-6` | Duplicate of `type-design-analyzer-1` (same A17 deferral). |
| `architecture-tech-lead-7` | The two `{now?}` encodings agree on all inputs at HEAD (verdicts identical, pinned per factory); the round-10 record already adjudicated unification as a design call and left it staged. The descriptor-isolation difference is the checkpointer's documented, deliberate strictness. |

### Dismissed (1)

| id | reason (evidence-based) |
|---|---|
| `pr-test-analyzer-5` | Runner coupling to `process.execPath` is correct under the repo's MANDATED Bun runner (`bun run test` is the only test entry point; the root `package.json` has no Node/Vitest path). The "breaks under Node/Vitest" scenario is unreachable in this repo; adding runner-detection shims is defensive complexity for an unsupported configuration. |

## Refuted-finding audit

`result.json.refuted_critical_findings` is EMPTY — the panel refuted 0 of 1
critical. Nothing to audit beyond recording that the single critical survived
all three lenses (`upheld_by: [reproduction, intent, blast-radius]`,
`refuted_by: []`).

## Implementation order

1. C1 (shared keyword table + pins) + `code-simplifier-2` (same file pair).
2. App distills: `code-simplifier-5`, `-6` (bootstrap), `-7` (server), `-3` (host re-exports).
3. Framework fixes: `code-reviewer-1` (NUL), `-8` (render), `-9` (readClock),
   `-10` (integer gates), `-11` (re-export), `pr-test-analyzer-1` + `-2` (pins).
4. `silent-failure-hunter-1` (run-executor + service comment + pin).

## Support paths (new work outside the frozen review scope)

- `apps/customer-summary/src/extraction/topics.ts` (pre-existing main-line file; gains the table export)
- `apps/customer-summary/src/__tests__/grounding.test.ts` (pre-existing main-line file; gains the C1 pins)
- `.claude/plans/2026-08-18-pr-remediation.md` (this plan)

## Validation (must pass before remediation install)

1. `bun run typecheck` — all packages (strict + the four extra compiler flags).
2. `bun run test` — all 12 packages, full suite (Redis-gated suites skip without `REDIS_URL`, as in prior rounds).
3. Targeted evidence:
   - `git diff --numstat` + `git diff --text -- packages/framework/src/nodes/llm.ts packages/framework/src/cli/authored.ts` show TEXT diffs (NUL gone; `grep -c $'\x00'` → 0 in both files).
   - C1 pin: `general`-topic/`contact`-source grounding passes; shared-table identity holds.
   - run-executor: recorded `failed` error carries the factory message for a context-build throw; three pre-existing channel-split pins still green unmodified.
   - queue gates: integer 1.5 now rejected (new pin), integer behavior unchanged (existing pins).
   - in-memory checkpointer clock pins (redis-checkpointer.test.ts) green — messages byte-identical.
