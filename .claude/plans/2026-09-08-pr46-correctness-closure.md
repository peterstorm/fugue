# PR46 correctness closure — implementation and evidence record

**Date:** 2026-09-08  
**Branch:** `feat/f1-map-node`  
**Observed base HEAD:** `8d8e48b5d531d17615199eb7063ddc045e81141a`  
**Status:** Adjudicated remediation implemented: **2 surviving criticals closed,
4 accepted advisories implemented, 5 advisories deferred, 0 refuted findings**.
The original canonical result remains unchanged, including its single intent-lens
dissent. Worker tests and RED/GREEN history are recorded below; the final integrated
candidate count, parent final validation, registered remediation and publication
remain pending. **Not a shipped/merge-ready certification of current HEAD.**

This new record does not replace or modify archived remediation plans or registered
review/Run state. Parent owns source integration, canonical review, final validation
and publication. The documentation worker records the supported contract only and
does not stage or commit.

> **Completion postscript (2026-09-12).** The pending language below is the
> immutable worker-era evidence boundary. Parent validation completed, PR #46
> merged as `f93fbf8` on 2026-09-08, and PR #47's canonical shared verification
> passed on merge commit `3ad7321`. This postscript records those later facts
> without rewriting historical counts or claiming npm publication/deployment.

## Governing contract

- [CONTEXT](../../CONTEXT.md) — ubiquitous language and invariants.
- [F1 plan](../../docs/plans/2026-09-06-f1-runtime-width-fanout.md), especially §13 —
  current contract; historical proposals remain explicitly superseded.
- [ADR-0086](../../docs/adr/0086-root-owned-mapped-child-execution.md) — decision.
- ADRs 0021, 0053/0054, 0075/0085 and 0083 — single runtime path, per-invocation
  authority, composite addressing and shared spend durability.

## Four original demonstrated defect groups — closed in candidate

| Group | Demonstrated wrongness | Implemented closure and acceptance surface |
|---|---|---|
| 1. Observer lifecycle ownership | Public child root runs reused RunId and finalized/discarded the root BufferedObserver history; downstream failure lost earlier successful child events. | Explicit root/mapped-child scope; only root emits observer run-start/run-end. Real `BufferedObserver`/`errorOnly` controls cover root success, downstream/child/finalizer failure and empty fan. Child events/spans remain; child judges finish before fan save. |
| 2. Definition snapshot and unsupported composition | Live constructor configuration changed execution after definition; nested maps were accepted and aliased inner completions. | Visible frozen `mapping`, no map `run`; bounded child parsing captures policy and refuses nested/human/freshness semantics. Alias, malformed descriptor/requirements and exact-owned-snapshot regressions cover the actual public parser/runtime path. |
| 3. Retry versus reroute durability | Old per-index completions satisfied a valid backward reroute, returning stale results for changed or identical inputs. | Both lookup/save use persisted parent `freshnessExecutionEpoch` as `attempt`. Tests cover ordinary retry, changed/same-valued reroute, direct-to-fan reroute, partial new-generation replacement and replacement immediately after committed epoch advance. |
| 4. Host child authority composition | A direct broker-only child ran, while mapping lost options-held minting authority; static fixtures hid the missing dispatch. | Root inventories outer/direct-child requirements before predecessor work, snapshots broker claims once, dispatches each child with original base authority/origin/broker receiver/host meter and its own requirements. Real host/Redis composition covers broker grant/denial, missing capability at zero/nonzero width, metered LLM aliases and spend rehydration. |

These are four defect groups, not four isolated line edits. The following family
fixes are necessary parts of a truthful closure, not advisory scope expansion.

## Necessary companion/family fixes — implemented

1. **Actual child writer addressing.** Frozen `MappedChildScope` carries map NodeId,
   index and parent epoch to `CheckpointWriter.write`'s fourth argument. The host
   codec addresses the real child NodeId with namespace=mapNodeId, index and
   attempt=epoch; root calls omit scope. Literal/property/live Redis assertions
   distinguish sibling maps, child nodes, indices and epochs. Manual index-only
   writer tests were not production-path proof.
2. **Options/resources without ownership leakage.** One `runPreparedDag` kernel
   body, private local child jobs, shared root clock/RNG/FreshnessIndex and original
   signal/clients/cache/prompt/spend closures. Structural child DagId is not a new
   host resource namespace. Root JobLike, replay map, retry overrides,
   human/commit/trace/classification hooks and background ownership stay root-only.
3. **Snapshot eligibility follows execution.** The independent verifier reproduced
   an accessor revealing child freshness only after preflight. Final correction
   checks early observations, captured discriminants before parsing, and the exact
   owned frozen child returned by the parser. Eight regressions/properties cover
   changing side-effect/profile/human/kind observations and bounded cyclic-map
   refusal. Supported accessor policy is captured without execution-time rereads.
4. **Cancellation.** The host acceptance test exposed false fan success and further
   child egress after root abort. Bounded fan gates now prevent subsequent indices
   and reduction, including empty/final-index success. A concurrently completed
   child can still have its completion saved. The old host abort RED is superseded;
   no fixture workaround makes the child return Err merely to hide the gap.
5. **Revoked-array/parser family.** `resolveMappedItems` fences `Array.isArray`
   itself; malformed/revoked requirement containers and throwing map descriptors
   fail typed rather than bypassing validation or escaping unexpectedly.
6. **Pure codec ownership.** Move the complete codec unchanged from checkpoint
   infrastructure to `shared/composite-node-key.ts`; runtime/file/checkpoint imports
   point inward and the redundant runtime capability import is removed. No new
   encoder, forwarding module, compatibility alias, lint-policy waiver or public
   named API change. The moved codec's SHA256 is
   `978dca9a3c9e9893d4760850a05eb2d5710f55e73b91229dcf7737e96fd5a9ca`.

Public type locality is deliberate: ordinary callable `NodeDef` stays in
`types/node.ts`; DAG/map/inference types live together in `types/dag.ts`.
`DagNodeDef` is the union, `MapNodeDef` has no `run`, and `withHumanReview`
preserves ordinary/map argument types at root level. The former
`types/dag-internals.ts` is removed without a cycle exception or compatibility alias.

## Exact durable and authority laws

- A map remains **one immutable outer node**, with one gathered output. Its frozen
  descriptor captures child, schemas, reducer and width policy. `evalJudges`
  entries/configs, criteria arrays and rubric records are owned frozen snapshots.
  Opaque schemas/functions are references, not recursively cloned/fingerprinted
  implementations or rewritten closures.
- Root preparation selects a bounded child inventory and snapshots each distinct
  broker claim once, before predecessor work even for zero width. Child dispatch
  starts from original base context/origin/host meter, never a parent's minted
  overlay. Describe capabilities are the sorted, deduplicated union of this same
  bounded runtime inventory; neither topology nor the map's checkpointer-only
  request is widened.
- Fan completions are map-output records at
  `dag@<mapNodeId>@<index>@<executionEpoch>`, with identical lookup/save options.
  Same-generation retry/replacement reuses acknowledged indices; valid reroute
  advances the durable parent epoch before work, even when values do not change.
- Every nonempty loaded `corruptNodeAddresses` refuses mapped-fan work, including
  unrelated keys, other indices/old epochs, opaque digest filenames and zero width.
  Before replay/gather, child execution, reduction, save or metadata seeding, the
  fan returns attributable `checkpoint-corrupt`. Public `runDag` preserves it in
  `retry-exhausted` with `rootErrorKind: checkpoint-corrupt` and serialized original
  `lastError` (default zero retries: one attempt). File/Redis adapters still warn
  and drop corrupt entries; configured retries may load again but cannot bypass
  the refusal. There is no automatic destructive cleanup. Operators inspect and
  repair storage, then rerun; they must not treat corrupt acknowledged work as a
  healthy missing index. Healthy prefixes are reused; genuinely missing work runs.
- Host child writer STRING keys are
  `fugue:<tenant>:<rootDag>:<run>:<mapNodeId>@<childNodeId>@<index>@<executionEpoch>`.
  Root canonical keys are unchanged. Readable fan completions live in the separate
  `$nodes` HASH; `$meta` and `$spend` remain distinct. Host cache/prompt closures
  retain root namespaces; the response cache has no new map-index address policy.
  Host writer calls with a runId different from the closure-bound run reject before
  scope/value observation, key encoding, serialization, diagnostics or Redis/spend
  effects; matching-run root/mapped keys and retention behavior are unchanged.
- Children share root RunId/resources but no observer root lifecycle or root job
  ownership. Child judges finish foreground before completion acknowledgement.
- Nested maps, child human review and child read/write freshness extractors are
  refused against the actual owned snapshot. Ordinary reads/writes without
  extractors remain legal; gather then review at root level.
- Cancellation cannot undo external effects. Work without acknowledged fan
  completion may repeat after interruption; no exactly-once external-effect claim.

## Deferred advisories and explicit non-goals

**Deferred, not closure guarantees:** recursive child fingerprints; indexed broker
Invocation audit dimensions; root aggregation of child judge/guardrail DagRunMeta
summaries. They are not accepted criteria quietly left unimplemented.

Also outside PR46: PR-C authored-map/plate rendering, PR-D whole-fan budget
projection, concurrent fan scheduling, nested-map semantics, indexed human gates
and indexed/epoch freshness witnesses. No unrelated host authority policy,
deployment lifecycle or ordinary-node cancellation redesign is included.

## Evidence history — keep candidate boundaries intact

All authoritative execution below used **Docker Bun 1.4.2**, not host Bun 1.3.13.
Full logs are local `/tmp` evidence; they are not shipped package references.

| Stage | Observed result | Interpretation |
|---|---|---|
| Original reconnaissance | Existing focused tests green; real-entry probes demonstrated the four groups above. | Reconnaissance was not closure acceptance or a new registered review. |
| Framework/host integration after abort correction | **164 pass, 0 fail**, five files, including five real SIGKILL/resume cases. | Supersedes the host report's cancellation RED. |
| Earlier whole-candidate baseline | Root workspace **7,141 pass, 3 skip, 0 fail**; all 12 workspace typechecks passed. CI package total **6,865 pass, 3 skip, 0 fail**, including host signal tier; docs links passed. | Counts precede final snapshot/codec corrections. Workspace/CI totals overlap, not additive coverage. |
| Independent targeted verification | Integrated 164 and six existing suites 173 passed; scratch **4 pass, 1 fail**, strict type gate passed. | Demonstrated the owned-snapshot eligibility gap; not merely an advisory. |
| Final scoped corrections | Full framework **3,721 pass, 0 fail, 0 skip**, 195 files; framework source/bin typechecks passed. Independent scratch **5 pass, 0 fail**, strict type gate passed; named public API identity smoke passed. | Supersedes independent snapshot RED. No final whole-workspace/host count inferred from this narrower run. |
| Final corrected lint | **Zero introduced findings**, zero engine errors, 51 extant dirty TS paths. | Nine total baseline findings: seven original plus two pre-existing file-codec long functions newly exposed by the codec move; normalized against HEAD with unchanged policy. Earlier two runtime→checkpoint violations are removed. |
| Parent final acceptance | **Pending final validation.** | Parent records the final current-candidate count, canonical review and publication; no merge-ready claim here. |

The baseline's three skips were the existing unimplemented live Entra WIF
placeholder and two PID-namespace tests whose namespace prerequisite was
unavailable. Redis-gated suites actually ran. Environmental failures from earlier
read-only fixture/root-permission runs remain recorded in worker reports and were
superseded by correctly configured passing runs, not test weakening.

Five real Redis/process cases use actual registered-DAG `createRunExecutor`,
`RedisRunStore`, lease/execution-fence checks and fresh-process replacement after
SIGKILL. Independently inspected durable prefixes precede the kill. They do not
prove booted HTTP, BullMQ acquisition/renewal/requeue, live identity-provider or
LLM transport, or production tenant Redis ACL enforcement; broker/provider ports
are typed fakes. The evidence asserts the actual tested seams, not deployment.

### Local evidence inventory

- `/tmp/fugue-pr46-closure-recon.md` — original demonstrated groups and review provenance.
- `/tmp/fugue-pr46-framework-closure.md` — root seam, fan generation and cancellation closure.
- `/tmp/fugue-pr46-host-closure.md` — host production scope and process tests; its abort RED is superseded.
- `/tmp/fugue-pr46-final-validation.md` — earlier 7,141/3-skip baseline, not current final certification.
- `/tmp/fugue-pr46-closure-independent-check.md` — independent snapshot defect; superseded by correction evidence.
- `/tmp/fugue-pr46-final-corrections.md` — exact-snapshot/codec correction, 3,721 framework tests and 5 probes.
- `/tmp/fugue-pr46-corrections-final-framework.log`
- `/tmp/fugue-pr46-corrections-final-independent.log`
- `/tmp/fugue-pr46-corrections-public-api.log`
- `/tmp/fugue-pr46-doc-closure.md` — documentation worker's changed-file/check record.

## Documentation closure and handoff

Current reference documentation covers ordinary versus map types, `createMapNode`,
`CheckpointWriter`/`MappedChildScope`, root resources and both durable address
spaces. ADR-0075's live source link points to the relocated shared codec; ADR-0086
and the ADR index record source ownership without rewriting old decisions. The
F1 plan preserves original proposals with explicit supersession instead of false
live implementation instructions. No archived remediation or review state is edited.

Documentation validation uses the existing `bun run check:docs` inside
`oven/bun:1.4.2-alpine`; its scope is shipped package docs/READMEs, not repository
ADRs/plans or anchor validity. The documentation report records the actual result.
Parent owns final review/source validation and any authoritative publication record.

## Canonical phase disposition — adjudicated remediation implemented

All six mandatory/accepted work items below are implemented in the candidate.
This supersedes the plan-only status, not the immutable source review or historical
evidence. Parent final integrated validation and registered installation remain
pending; implementation is not publication.

### Source authority and routing provenance

- Source Run Directory: `.claude/reviews/review-and-fix-runs/2026-09-08-pr46-correctness-closure`.
- Authoritative input: `.claude/reviews/review-and-fix-runs/2026-09-08-pr46-correctness-closure/result.json`.
- Verified result SHA256: `52c5fc4037987a06a1519a1f0de2f1a9024efc158fe6e1fd50f38af51e68e2cd`.
- Source review is **done**. Frozen scope is **exactly the 63 literal paths in
  that result's `scope` array**, including this plan and deleted paths; that
  digest-bound array is incorporated here as the exact scope, not a directory
  glob or an invitation to expand remediation. Branch/base remain as above.
- Canonical totals: **2 surviving criticals, 0 refuted criticals, 9 advisories**.
  Both criticals are mandatory. All nine advisory dispositions appear below:
  **4 ACCEPT, 5 DEFER, 0 dismissals**. There is no refuted-finding fix work.
- The corruption finding survived reproduction and blast-radius; intent alone
  voted to refute because the backend deliberately warns/drops corrupt entries.
  That single lens vote is not a canonical refutation. The resolution below
  preserves backend policy while making the mapped-fan consumer conservative.
  All three lenses upheld the missing-meta regression finding.
- Latest user-confirmed model policy: **CLOUD sessions → declared Sol/high;
  LOCAL sessions → local GLM/low**. The extra cloud-parent-to-local routing rule
  was removed outside this repository; pre-existing local routes remain intact.
  Reported probes resolved cloud → Sol/high and local → GLM/low. All three
  refutation lenses completed canonical attempt 2; failed attempt-1 connection evidence remains archived.
  These are panel attempts, not replacements for reviewer attempt-1 evidence in
  the result. This plan makes no routing or Run-state changes.

### Mandatory surviving criticals — both implemented

The following criteria retain the adjudicated scope; the implementation/evidence
record below identifies the actual paths and public error behavior.

1. **`silent-failure-hunter-1` — refuse corrupt mapped-fan loads.**
   In `packages/framework/src/dag-runtime/run-mapped-fan.ts`, immediately after a
   successful load, reject **any nonempty `corruptNodeAddresses`** before child
   execution, gather/replay, reduction, `saveNode` or `setMeta`. Do not filter only
   addresses apparently matching the current index, map or epoch: an opaque
   digest cannot prove irrelevance. Return a typed `checkpoint-corrupt` error
   attributable to the current run and map node, with useful corrupt-address
   context. Handle both `CorruptCheckpointAddress` cases (`node-key` and
   `digest-filename`) as the existing ADT, without pretending a digest is a key.
   Keep file/Redis Checkpointer warning-and-drop/load behavior unchanged; this is
   a stricter mapped-fan consumer policy, not a global recovery-policy rewrite.

   Acceptance must use public `runDag` and actual checkpoint load behavior:
   persist a completed fan prefix through real file and Redis checkpointers,
   corrupt its durable record, inspect the resulting corruption address, then
   resume and assert the typed attributable failure. Cover both ADT cases,
   including an unreadable file envelope. Assert **zero child executions, zero
   reducer calls, zero saves and zero metadata writes after the corrupt load**;
   verify the durable prefix is not overwritten. Setup writes are not execution
   side effects. Pair negatives with healthy-prefix reuse and genuinely missing-
   prefix execution controls, proving acknowledged work is reused and legitimate
   missing work still executes. An invented corrupt `RunState` alone is not
   acceptance evidence.

2. **`pr-test-analyzer-1` — fresh-run metadata failure regression.**
   Add an actual public `runDag` regression whose fan Checkpointer `load`
   returns `Ok(null)` and whose attempted initial `setMeta` returns a specific
   `Err`. Assert the failure preserves the original FrameworkError/error cause
   through the public boundary and that **no child, save or reducer runs**.
   Prove the null-load/failed-meta branch was reached, not an earlier preflight
   failure. Current code already checks the `Result`; pin its behavior rather
   than manufacture an unnecessary production rewrite. Correct propagation only
   if this real-path test demonstrates a gap.

### All advisory dispositions

All **ACCEPT** rows are implemented; all **DEFER** rows remain deferred. Actions
below preserve the adjudicated criteria; actual paths/evidence follow.

| Finding | Disposition | Concrete action or evidence-based deferral |
|---|---|---|
| `code-reviewer-1` | **ACCEPT** | Own and freeze mapped-child `evalJudges` definitions, including nested criteria arrays and rubric records, rather than copying only the outer array. Preserve opaque function/schema references under the existing snapshot contract. Alias-mutation tests must demonstrate that later mutations cannot change the captured evaluator definition or executed evaluation. Primary paths: `packages/framework/src/shared/validate-dag.ts`, `packages/framework/src/__tests__/map-child-snapshot.test.ts`. |
| `code-reviewer-2` | **ACCEPT** | Make describe capabilities use the **same bounded runtime inventory** of outer nodes and direct mapped children via a shared pure helper, not a second traversal with different semantics. Test child-only requirements, deterministic deduplication, ordinary DAGs and unchanged outer map `requires`. Do not widen the map's checkpointer-only request or change per-child authority dispatch. Primary consumers: `packages/framework/src/dag-runtime/run-dag-stateful.ts`, `packages/framework/src/describe/build-described-dag.ts`; actual shared helper/test paths are recorded below. |
| `silent-failure-hunter-2` | **DEFER** | Missing-HITL-hook diagnostics are a pre-existing lower-level telemetry gap; public preflight already rejects the unsupported invocation. A diagnostic redesign is not a mapped-child correctness obligation. No new lower-level observer guarantee is claimed. |
| `silent-failure-hunter-3` | **DEFER** | A failing `warningSink` follows the pre-existing best-effort describe diagnostic-sink convention. There is no secondary delivery channel; inventing a new logging/failure policy is not needed for map closure. |
| `silent-failure-hunter-4` | **DEFER** | Unknown/throwing `Error.cause` inspection belongs to the pre-existing exception-boundary fallback taxonomy and needs a separate policy decision. This deferral does **not** permit discarding an actual `Result` error; the accepted metadata regression must preserve that concrete cause. |
| `pr-test-analyzer-2` | **ACCEPT** | Add public `runDag` coverage where a fresh child passes its own DAG output contract but fails `mapping.childOutputSchema`. Require a typed map failure, no persistence or gather of the rejected output, no reducer, and no subsequent child execution. Do not confuse this with corrupt replay coverage. Implemented test path: `packages/framework/src/__tests__/map-checkpoint-corruption.test.ts` (rather than the proposed `map-runtime-composition.test.ts`); the existing production schema gate needed no change. |
| `type-design-analyzer-1` | **DEFER** | Closure-bound writer redesign would widen the public interface change. `CheckpointWriter` is an addressable port, not an unforgeable capability; real runtime call scopes are already proven, and no node-code sandbox is claimed. Keep the existing interface; the accepted bound-run guard below is independent. |
| `type-design-analyzer-2` | **ACCEPT** | In `packages/host/src/adapters/node-context-factory.ts`, reject a `CheckpointWriter.write` runId differing from the closure-bound run **before any write**, consistently with the readable bound-run Checkpointer. Use a narrow typed guard, not a writer-port redesign. In `packages/host/src/__tests__/node-context-factory.test.ts`, pin the mismatch error and zero writes for root and mapped calls, with matching-run positive controls and unchanged keys. |
| `architecture-tech-lead-1` | **DEFER** | Existing shared codec/replay rules plus the required public real-path regressions can establish the complete sequential contract. A new pure fan-progress state machine is not necessary for this closure; reconsider when concurrent scheduling creates that need, not as speculative restructuring now. |

### Actual worker ownership and support-path accounting

- Fan runtime/regressions: `runMappedFan` in
  `packages/framework/src/dag-runtime/run-mapped-fan.ts` and the new
  `packages/framework/src/__tests__/map-checkpoint-corruption.test.ts`.
  All three adjudicated fan regressions live in the new suite, including metadata
  and fresh-schema cases; no extra edit to `map-runtime-composition.test.ts` was
  needed. The production change is only the corruption gate; the other two
  existing gates are pinned by tests and counterfactual mutations.
- Snapshot/describe: `packages/framework/src/shared/validate-dag.ts`,
  `packages/framework/src/__tests__/map-child-snapshot.test.ts`,
  `packages/framework/src/shared/runtime-node-inventory.ts`,
  `packages/framework/src/dag-runtime/run-dag-stateful.ts`,
  `packages/framework/src/describe/build-described-dag.ts`, and
  `packages/framework/src/__tests__/mapped-describe-capabilities.test.ts`.
- Host writer: `packages/host/src/adapters/node-context-factory.ts` and
  `packages/host/src/__tests__/node-context-factory.test.ts`; no new support path.

**Actual `supportPaths`: exactly these three paths outside the frozen 63-path scope:**

1. `packages/framework/src/__tests__/map-checkpoint-corruption.test.ts`
2. `packages/framework/src/__tests__/mapped-describe-capabilities.test.ts`
3. `packages/framework/src/shared/runtime-node-inventory.ts`

No other out-of-scope repository path was used. Parent must register this exact
list in the fresh remediation start input before installation, not mutate the
frozen source-review scope/result to absorb it. This documentation pass creates
or alters no review/Run, routing, source, Git index or commit state.

### Adjudicated implementation evidence — worker history, not final candidate totals

All execution used Docker **Bun 1.4.2**, non-root uid/gid 1000:100. Counts overlap
across stages/workers and are **not additive**. No whole-workspace or full-host
current-candidate result is inferred from a focused or framework-only gate.

| Worker/stage | Observed result | Interpretation |
|---|---|---|
| Fan, pre-fix runtime with final 16 tests | **7 pass, 9 fail** | All nine corruption cases wrongly succeeded before the gate. Isolated `/tmp` counterfactual; no live source swapping. |
| Fan, metadata-return bypass mutant | **15 pass, 1 fail** | Detects ignoring the real `Ok(null)` → failed initial `setMeta` result. |
| Fan, fresh child-output parser bypass mutant | **15 pass, 1 fail** | Detects persisting/gathering a child result rejected by the mapping schema. |
| Fan, final focused/distill gate | **76 pass, 0 fail** | Corruption, map-node and runtime-composition suites; real Redis active on port 16388. |
| Snapshot/describe, pre-edit baseline | **88 pass, 0 fail** | Existing snapshot/composition/describe/evaluator controls. |
| Snapshot/describe, confirmed pre-fix RED | **8 pass, 15 fail** | Corrected the test's missing-capability assertion to the actual ADT before recording this RED. |
| Snapshot/describe, initial GREEN | **103 pass, 0 fail** | Five relevant files. |
| Snapshot/describe, strengthened distill baseline and recheck | **61 pass, 0 fail** each | Real evaluator factory/LLM coverage retained through the one-move simplification. |
| Both framework workers, final full framework | **3,752 pass, 0 fail, 0 skip**, 197 files, each | Overlapping integrated framework runs; both source/bin typechecks pass. Snapshot worker Redis preflight on port 6379 returned PONG. Not a final whole-candidate total. |
| Snapshot/describe, host manifest suite and separate probe | **12 pass, 0 fail**; **1 pass, 0 fail** | Existing host manifest suite plus actual `buildManifest` mapped/custom-capability scratch probe. |
| Host writer, pre-fix RED | **92 pass, 7 fail** | All seven new wrong-run cases fail before the guard; existing tests pass. |
| Host writer, GREEN and distill baseline | **99 pass, 0 fail** each; 344 assertions at baseline | Matching-run controls and both root/mapped refusal paths. |
| Host writer, final focused gate | **150 pass, 0 fail**, 857 assertions, three files | Writer, Redis-checkpointer and cache-key suites; configured host source typecheck passes. Port fakes, not live Redis/process proof. |
| Integrated dirty-TS lint history | **54 files, 9 baseline findings, 0 introduced, 0 engine errors** | Same normalized findings as the earlier corrected lint; not globally clean lint. |
| Owned lint and whitespace | Fan: **0 findings** in 2 files; snapshot/describe: **1 baseline** in 6; writer: **3 baseline** in 2; all **0 introduced/engine errors** | Unchanged policy; each worker's `git diff --check` passes. These counts overlap the integrated audit. |
| Parent final whole-candidate gates | **Pending** | No final candidate count, index installation or publication claimed. |

**Acceptance details.** The fan suite contains six finite-ADT/width refusal cases
(both address arms plus an unrelated old-epoch key, each at widths 0 and 2), three
real durable corruption cases (recoverable file node key, unreadable file envelope/
digest filename, truncated Redis HASH entry), four file/Redis healthy-or-missing
prefix controls, failed/successful fresh metadata controls, and fresh-output schema
refusal with a matching positive control. Real corrupt resumes leave the earlier
durable prefix byte-identical: only load occurs, with zero child/reducer/save/meta
work. Adapters still warn and return surviving nodes with the corrupt addresses.

The public corruption result is **`retry-exhausted`**, not a newly promised top-level
`checkpoint-corrupt`: `rootErrorKind` is `checkpoint-corrupt`, `lastError` serializes
the original run/map-attributable error and both address ADT variants, and default
zero retries gives `attempts: 1`. Tests parse that cause with the existing
`PersistedFrameworkErrorSchema`. The specific permanent `cache-error(checkpoint:setMeta)`
is preserved intact through public `runDag`; the failed metadata case reaches
exactly `[load, setMeta]`. Fresh child output 4 passes the child DAG but fails the
map's maximum-3 schema at index 0, with no fan save/reducer/subsequent child; valid
outputs 2 then save/gather normally.

Snapshot tests cover mutation after both `createMapNode` and `defineDag`, owned
frozen evaluator receivers, real `createEvalJudgeNode` execution with typed fake
LLM, arbitrary criteria/both rubric variants, single-read accessors and five
throwing-accessor typed refusals. Caller data/functions/schemas are not frozen.
Describe tests exercise public builder/CLI/runtime, child-only built-in/custom
requirements, deterministic union properties, ordinary topology, zero/nonzero
preflight, one claim per distinct capability and per-node mint attribution.

Writer tests reject root/mapped wrong-run calls with/without TTL before Redis,
encoding, hostile scope/value getters or diagnostics; factory/spend controls prove
zero checkpoint/spend commits. Matching calls retain literal canonical/composite
keys and 9-second checkpoint/60-second spend retention arguments. The configured
host tsconfig excludes legacy `src/__tests__`: the modified writer suite was
executed by Bun, **not independently strict-typechecked** by that source gate.

**Superseded attempts:** concurrent snapshot-test type errors during an intermediate
fan run are superseded by both workers' final green typechecks. Snapshot worker's
rejected `--incremental false` composite-project command and initial scratch-probe
Zod import were corrected in validation commands/probe only, not repository config.
Neither these failures nor the earlier historical REDs are hidden by weaker tests.

**Distill apply evidence:** fan replaced a duplicate local error schema with
`PersistedFrameworkErrorSchema`; describe replaced a manual accumulator/cast with
stdlib `flatMap` + `Set`. Each was one move from a green baseline followed by green
covering/full gates. Writer applied no extra move: its direct guard already earns
its form. All workers skipped deferred interface/state-machine redesign, recursive
snapshots/fingerprints, unrelated baseline lint cleanup and cosmetic churn.

Authoritative worker reports and complete command/log histories:

- `/tmp/fugue-pr46-checkpoint-remediation.md`; RED/mutants/final logs named there,
  including `/tmp/fugue-pr46-checkpoint-final-framework.log` and
  `/tmp/fugue-pr46-checkpoint-integrated-lint/lint.json`.
- `/tmp/fugue-pr46-snapshot-description-remediation.md`; evidence directory
  `/tmp/fugue-pr46-snapshot-description/` (`red-confirmed.log`, `final-framework.log`,
  `final-types.log`, host manifest logs and normalized baseline/candidate lint).
- `/tmp/fugue-pr46-writer-run-binding-remediation.md`; evidence directory
  `/tmp/fugue-pr46-writer-run-binding/` (`red.log`, `green-baseline.log`,
  `distill-baseline.log`, `final-validation.log`, baseline/final lint).
- `/tmp/fugue-pr46-adjudicated-docs.md` — this documentation pass's checks/handoff.

### Validation and completion gates — pending for the new candidate

Earlier evidence, including the parent-reported **7,149 + 7** validation, remains
**historical, prior to this adjudication**. It is not final validation of these
implemented changes and is not added to overlapping older totals. Worker evidence
above establishes targeted closure; final integrated code-check numbers are
**pending**.

1. **Implemented; parent acceptance verification pending.** All six work items
   have targeted negative/positive controls. Real file/Redis corruption cases ran
   with Redis active and no skips; actual causes remain observable at the public
   boundary. Preserve these controls through final validation.
2. Under the established **Docker Bun 1.4.2** environment with its working Redis
   URL and process-test prerequisites, run the targeted suites (including actual
   support tests), then full relevant framework/host suites and workspace gates.
   Repository-root commands inside that configured container are:
   - `bun test packages/framework/src/__tests__/map-checkpoint-corruption.test.ts packages/framework/src/__tests__/mapped-describe-capabilities.test.ts packages/framework/src/__tests__/map-runtime-composition.test.ts packages/framework/src/__tests__/map-child-snapshot.test.ts packages/host/src/__tests__/node-context-factory.test.ts`
   - `bun run --filter '@fuguejs/framework' test`
   - `bun run --filter '@fuguejs/host' test` (retains the separate signal tier)
   - `bun run typecheck`
   - `bun run test`
   - `bun run check:docs`
   The focused command includes both actual support test paths; do not omit real
   corruption or describe cases.
3. Run the established unchanged-policy lint/boundary audit against the complete
   integrated candidate, not only the original 51 dirty TypeScript paths. Record
   real commands, logs, skips/prerequisites and actual current totals. Apply the
   required distill pass only from a green baseline, preserve interfaces, then
   rerun affected tests and report simplifications applied/skipped.
4. Parent verifies each acceptance criterion, records final evidence and actual
   support paths, and uses the registered remediation workflow for path audit and
   verified-index installation. Source authority remains immutable. No staging,
   commit, publication or merge-ready certification occurs in this documentation pass.
