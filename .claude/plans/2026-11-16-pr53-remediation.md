# PR #53 remediation — review runs pr53-review-s1..s6

- **Branch:** feat/lint-max-enforcement (PR #53)
- **Scope:** the 275 files changed since the previous review-and-fix (0d0f5b7..HEAD at 1c27ec0..caf578f), each diffed by the engine against merge base a5c8df0, partitioned into six read-budget slices (`pr53-review-s1`..`s6`, runs root `.claude/reviews/review-and-fix-runs`).
- **Reviewers:** 7 per slice (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead + deepen, code-simplifier + distill). Spawned as workflow subagents; their final bytes and delivered tool outputs were handed to the engine with `helper orchestration submit --tool-outputs` (read coverage verified by the engine; 5 attempt-2 retries for unread pages).

## Critical findings
None emitted in any slice (engine inspection: 0 surviving, 0 refuted). Defect-family accounting: `not-required`.

## Advisory dispositions (published, DECLARED)
Policy runs `pr53-policy-s1`..`s6` (`standalone-disposition-published`). Totals: 47 accepted, 49 deferred, 9 dismissed of 105.

### s1 — source digest `9c8311d01662909335b727b880e6f27e39f56a5dc1a2e3f4733597d0bee69aca`

| Finding | Decision | Reason |
|---|---|---|
| pr-test-analyzer-1 | accepted | Sound: no test pins the HITL worker/reconciliation failure fences in boot-abort teardown. Add a regression test. |
| pr-test-analyzer-2 | deferred | Optional hardening per the finding itself: behaviour is preserved and the facade tests in worker-lifecycle-manager.test.ts exercise the extracted helpers; a full env-composition table test is a separate test-coverage task. |
| type-design-analyzer-1 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| type-design-analyzer-2 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| type-design-analyzer-3 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| comment-analyzer-1 | accepted | Stale comment names a bunServer no longer in scope; reword. |
| comment-analyzer-2 | accepted | Comment points at a refactored-away performShutdown attempt; repoint to ShutdownRecorder.attempt. |
| comment-analyzer-3 | accepted | Change-log narration in a doc comment; keep only the lasting rationale. |
| comment-analyzer-4 | accepted | HostShell doc describes pre-refactor lets; restate the ownership invariant. |
| comment-analyzer-5 | accepted | lazySpawn comment says deletes happen below in the body; they now live in helpers. Reword. |
| comment-analyzer-6 | accepted | One compound realm phrase is half code, half prose; make both realm names uniform. |
| architecture-tech-lead-1 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| architecture-tech-lead-2 | deferred | The field-mirroring duplication part is fixed under code-simplifier-1; extracting the pure lifecycle decisions into a functional-core module is a deepen pass beyond this PR. |
| architecture-tech-lead-3 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| code-simplifier-1 | accepted | Module-private LifecycleCtx mirrors WorkerLifecycleDeps field by field; derive it from the deps type and spread. |
| code-simplifier-2 | accepted | logHostBooted reads a nullable shell.server that cannot be null there; pass the bound port instead. |
| code-simplifier-3 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| code-simplifier-4 | accepted | Fix the mixed realm phrase at line 293 (same fix as comment-analyzer-6); the file-wide formatting point is the deferred Loom vocabulary follow-up. |

### s2 — source digest `087fee5a8b096626e3e40d34dcd7f1002bcd7bab2dd928a0a446353c2d874903`

| Finding | Decision | Reason |
|---|---|---|
| type-design-analyzer-1 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| type-design-analyzer-2 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| type-design-analyzer-3 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| comment-analyzer-1 | accepted | BrokerCells doc describes the old store() call shape; update to storeFreshToken. |
| comment-analyzer-2 | deferred | Deferred: the mixed code formatting is the cost of Loom's no-dangling-doc-reference rule having no vocabulary for names that live outside this repo's TS/JSON/shell/YAML corpus (external services, runtime paths, Python eval names, test-only identifiers). A uniform fix needs a Loom feature (external-name allowlist or wider corpus); stripping valid code spans from the resolving siblings would trade one inconsistency for lost formatting. Tracked as a Loom follow-up. |
| comment-analyzer-3 | deferred | Deferred: the mixed code formatting is the cost of Loom's no-dangling-doc-reference rule having no vocabulary for names that live outside this repo's TS/JSON/shell/YAML corpus (external services, runtime paths, Python eval names, test-only identifiers). A uniform fix needs a Loom feature (external-name allowlist or wider corpus); stripping valid code spans from the resolving siblings would trade one inconsistency for lost formatting. Tracked as a Loom follow-up. |
| comment-analyzer-4 | accepted | queue-bullmq boundary description no longer matches its allow list; correct it. |
| architecture-tech-lead-1 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| architecture-tech-lead-2 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| architecture-tech-lead-3 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| architecture-tech-lead-4 | accepted | Sound: host adapters/ and http/ allow each other though no such edges exist, permitting a cycle. Tighten the allow lists to the edges the code uses. |
| architecture-tech-lead-5 | dismissed | Both dropped pureModules entries name files absent from the tree; Loom's full tier fails on a pure root matching no file, so removing them is required. |
| code-simplifier-1 | accepted | Same stale BrokerCells docblock as comment-analyzer-1; fixed together. |
| code-simplifier-2 | deferred | Taste-level per the finding; bundling the triple into a shell record is an internal interface reshaping, deferred with the broker deepening. |
| code-simplifier-3 | accepted | Verify whether the regex-escaped framework entry and bare node built-ins are load-bearing; remove or justify them. |
| code-simplifier-4 | dismissed | duplicateBlockBaseline is written by lint-project --write-baseline with one entry per copy and per file (README 'Baselines'), so repeated and mirrored keys are the documented multiset form, not noise. |

### s3 — source digest `e2fa01be304243905c3f39306ba46b58c694cf024a0bb6abd384a23519870c46`

| Finding | Decision | Reason |
|---|---|---|
| code-reviewer-1 | accepted | Keep Number.isInteger: it matches the BullMQ adapter's own integer check, so the in-memory fake and the adapter agree on QueueOpts. Pin with a test and list it in the PR's behaviour changes. |
| silent-failure-hunter-1 | accepted | The thrown checkpoint-write error is the only trace of the failure; include the error message for checkpoint-write-failed. |
| pr-test-analyzer-1 | accepted | Pin the integer validation with a fractional-value test (same fix as code-reviewer-1). |
| pr-test-analyzer-2 | accepted | Add tests for checkMlflow transition logging and buildCheckpointWriter's error arm. |
| type-design-analyzer-1 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| type-design-analyzer-2 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| type-design-analyzer-3 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| comment-analyzer-1 | accepted | assembleAppDeps comment says composeObservability above sets the observer; it no longer does. Fix. |
| comment-analyzer-2 | accepted | validateConnectivity doc claims a finally block that does not exist; correct it. |
| comment-analyzer-3 | deferred | Deferred: the mixed code formatting is the cost of Loom's no-dangling-doc-reference rule having no vocabulary for names that live outside this repo's TS/JSON/shell/YAML corpus (external services, runtime paths, Python eval names, test-only identifiers). A uniform fix needs a Loom feature (external-name allowlist or wider corpus); stripping valid code spans from the resolving siblings would trade one inconsistency for lost formatting. Tracked as a Loom follow-up. |
| architecture-tech-lead-1 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| architecture-tech-lead-2 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| architecture-tech-lead-3 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| architecture-tech-lead-4 | accepted | Pin the integer validation and the handler-threw error log with tests and declare both in the PR description. |
| architecture-tech-lead-5 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| architecture-tech-lead-6 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| code-simplifier-1 | accepted | Same integer-validation pin as code-reviewer-1. |
| code-simplifier-2 | accepted | Keep the new log (a thrown failure handler was silently swallowed before); pin it with a test and declare it in the PR's behaviour changes. |
| code-simplifier-3 | dismissed | Dismissed: deliberate change from the previous adjudicated PR #53 remediation (0d0f5b7, accepted advisories), not an accidental side effect of the extraction; pinned by tests in this remediation. |
| code-simplifier-4 | dismissed | Dismissed: deliberate change from the previous adjudicated PR #53 remediation (0d0f5b7, accepted advisories), not an accidental side effect of the extraction; pinned by tests in this remediation. |
| code-simplifier-5 | accepted | All-or-nothing Redis wiring on setup failure is a correctness fix; pin it with a test. |
| code-simplifier-6 | dismissed | Dismissed: deliberate change from the previous adjudicated PR #53 remediation (0d0f5b7, accepted advisories), not an accidental side effect of the extraction; pinned by tests in this remediation. |
| code-simplifier-7 | accepted | buildHealth's returned object is mis-indented; reindent. |
| code-simplifier-8 | deferred | Deferred: the mixed code formatting is the cost of Loom's no-dangling-doc-reference rule having no vocabulary for names that live outside this repo's TS/JSON/shell/YAML corpus (external services, runtime paths, Python eval names, test-only identifiers). A uniform fix needs a Loom feature (external-name allowlist or wider corpus); stripping valid code spans from the resolving siblings would trade one inconsistency for lost formatting. Tracked as a Loom follow-up. |

### s4 — source digest `452272429f1f70396b287be0b60ed650983c7c3866f680b140df3227044ffa65`

| Finding | Decision | Reason |
|---|---|---|
| code-reviewer-1 | accepted | library-ux.md:181 still cites the gone runDagInner/executor.ts:223; correct it. |
| type-design-analyzer-1 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| type-design-analyzer-2 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| comment-analyzer-1 | accepted | Docblock says seven typeof results; the match has eight arms. Fix. |
| comment-analyzer-2 | accepted | Map-accumulation comment sits above a function that accumulates nothing; move it to planSync/checkRegistryDrift. |
| comment-analyzer-3 | accepted | Same runDagInner line as code-reviewer-1. |
| comment-analyzer-4 | accepted | Make the eval-pipeline fixture paths uniformly repo-relative. |
| comment-analyzer-5 | accepted | Header import list mixes .ts and .js; write the specifiers consistently. |
| comment-analyzer-6 | deferred | Deferred: the mixed code formatting is the cost of Loom's no-dangling-doc-reference rule having no vocabulary for names that live outside this repo's TS/JSON/shell/YAML corpus (external services, runtime paths, Python eval names, test-only identifiers). A uniform fix needs a Loom feature (external-name allowlist or wider corpus); stripping valid code spans from the resolving siblings would trade one inconsistency for lost formatting. Tracked as a Loom follow-up. |
| architecture-tech-lead-1 | accepted | Same runDagInner line as code-reviewer-1. |
| architecture-tech-lead-2 | deferred | Deferred: the mixed code formatting is the cost of Loom's no-dangling-doc-reference rule having no vocabulary for names that live outside this repo's TS/JSON/shell/YAML corpus (external services, runtime paths, Python eval names, test-only identifiers). A uniform fix needs a Loom feature (external-name allowlist or wider corpus); stripping valid code spans from the resolving siblings would trade one inconsistency for lost formatting. Tracked as a Loom follow-up. |
| architecture-tech-lead-3 | dismissed | ts-pattern match().exhaustive() is the project's sanctioned totality form (typescript-patterns.md 'Totality', enforced by switch-totality) and ts-pattern is an allowed pure dependency of the framework boundary; the stale header is fixed under code-simplifier-2. |
| architecture-tech-lead-4 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| code-simplifier-1 | dismissed | Same as architecture-tech-lead-3: the match form is required by the switch-totality rule this PR enforces. |
| code-simplifier-2 | accepted | Update the module header to list the ts-pattern import. |
| code-simplifier-3 | accepted | PromptsInputs hand-rolls the project's Result shape; use Result inside the module. |
| code-simplifier-4 | accepted | isDateFormat doc still says 'ported statement for statement'; restate the parity guarantee accurately. |
| code-simplifier-5 | accepted | Same runDagInner line as code-reviewer-1. |
| code-simplifier-6 | deferred | Deferred: the mixed code formatting is the cost of Loom's no-dangling-doc-reference rule having no vocabulary for names that live outside this repo's TS/JSON/shell/YAML corpus (external services, runtime paths, Python eval names, test-only identifiers). A uniform fix needs a Loom feature (external-name allowlist or wider corpus); stripping valid code spans from the resolving siblings would trade one inconsistency for lost formatting. Tracked as a Loom follow-up. |
| code-simplifier-7 | dismissed | Two callers passing literals through a small lookup map is clear idiom; taste, no state removed. |

### s5 — source digest `d40bdfce6bb4155111d1fde48486d9d2f6ceb8797cdd727288b6e143c0fbb4b7`

| Finding | Decision | Reason |
|---|---|---|
| type-design-analyzer-1 | deferred | Tightening the OpenAI Responses wire guard into a full schema risks rejecting real payloads; it needs recorded-fixture coverage first. No current misbehaviour. |
| type-design-analyzer-2 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| type-design-analyzer-3 | deferred | Deferred: consolidating the helper across @fuguejs/framework and @fuguejs/host means adding a public framework export, an interface change (deepen), not an in-place simplification; no behaviour is wrong today. |
| comment-analyzer-1 | accepted | The added sentence and the table disagree on hyphenation; make them consistent. |
| comment-analyzer-2 | deferred | Deferred: the mixed code formatting is the cost of Loom's no-dangling-doc-reference rule having no vocabulary for names that live outside this repo's TS/JSON/shell/YAML corpus (external services, runtime paths, Python eval names, test-only identifiers). A uniform fix needs a Loom feature (external-name allowlist or wider corpus); stripping valid code spans from the resolving siblings would trade one inconsistency for lost formatting. Tracked as a Loom follow-up. |
| comment-analyzer-3 | accepted | ADR-0021 history bullet now shows a current path beside historical ones; restore the historical location as prose. |
| comment-analyzer-4 | deferred | Deferred: the mixed code formatting is the cost of Loom's no-dangling-doc-reference rule having no vocabulary for names that live outside this repo's TS/JSON/shell/YAML corpus (external services, runtime paths, Python eval names, test-only identifiers). A uniform fix needs a Loom feature (external-name allowlist or wider corpus); stripping valid code spans from the resolving siblings would trade one inconsistency for lost formatting. Tracked as a Loom follow-up. |
| architecture-tech-lead-1 | deferred | Agreed direction: teaching Loom's checker about deferred spec ids and external tokens is the Loom follow-up recorded for the formatting advisories; out of this repo. |
| architecture-tech-lead-2 | accepted | realm-jwt-verifier header still names http/middleware/auth.ts as the port's home; point it at domain/auth.ts. |
| architecture-tech-lead-3 | deferred | Deferred: consolidating the helper across @fuguejs/framework and @fuguejs/host means adding a public framework export, an interface change (deepen), not an in-place simplification; no behaviour is wrong today. |
| architecture-tech-lead-4 | deferred | Same as type-design-analyzer-1: a full Responses schema needs recorded-fixture coverage before it can replace the guard safely. |
| architecture-tech-lead-5 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| code-simplifier-1 | deferred | Deferred: consolidating the helper across @fuguejs/framework and @fuguejs/host means adding a public framework export, an interface change (deepen), not an in-place simplification; no behaviour is wrong today. |
| code-simplifier-2 | deferred | Deferred: consolidating the helper across @fuguejs/framework and @fuguejs/host means adding a public framework export, an interface change (deepen), not an in-place simplification; no behaviour is wrong today. |
| code-simplifier-3 | accepted | Garbled lib//`packages/` span in ADR-0061; rewrite the phrase. |
| code-simplifier-4 | deferred | Deferred: the mixed code formatting is the cost of Loom's no-dangling-doc-reference rule having no vocabulary for names that live outside this repo's TS/JSON/shell/YAML corpus (external services, runtime paths, Python eval names, test-only identifiers). A uniform fix needs a Loom feature (external-name allowlist or wider corpus); stripping valid code spans from the resolving siblings would trade one inconsistency for lost formatting. Tracked as a Loom follow-up. |
| code-simplifier-5 | accepted | A design record's type name was renamed; restore the historical name as prose. |
| code-simplifier-6 | dismissed | Declaration order of hoisted module functions has no behavioural effect; taste. |
| code-simplifier-7 | accepted | CONTEXT_ONLY_KINDS doc overclaims 'cannot drift apart'; state exactly what it guarantees. |

### s6 — source digest `cee5295e3512b5bf09718ebc648c40b476cbbf2e6b5b58b2ce9880aa737e59b1`

| Finding | Decision | Reason |
|---|---|---|
| type-design-analyzer-1 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| comment-analyzer-1 | accepted | ci.yml comment claims a private Loom clone needing LOOM_DEPLOY_KEY; both repos are public. Remove. |
| comment-analyzer-2 | deferred | Deferred: the mixed code formatting is the cost of Loom's no-dangling-doc-reference rule having no vocabulary for names that live outside this repo's TS/JSON/shell/YAML corpus (external services, runtime paths, Python eval names, test-only identifiers). A uniform fix needs a Loom feature (external-name allowlist or wider corpus); stripping valid code spans from the resolving siblings would trade one inconsistency for lost formatting. Tracked as a Loom follow-up. |
| comment-analyzer-3 | accepted | ADR-0069 leaves a bare PASSWORD suffix; write both env var names in full. |
| architecture-tech-lead-1 | accepted | secrets: inherit forwards every secret to a workflow that reads none; drop it. |
| architecture-tech-lead-2 | deferred | Deferred: a behaviour-preserving type/interface deepening of code this PR only decomposed to satisfy max-function-lines; nothing is wrong today and the redesign widens this lint-enforcement PR beyond its scope. Belongs in a dedicated deepen pass. |
| code-simplifier-1 | accepted | Same dead secrets: inherit and stale comment as architecture-tech-lead-1. |
| code-simplifier-2 | deferred | Deferred: the mixed code formatting is the cost of Loom's no-dangling-doc-reference rule having no vocabulary for names that live outside this repo's TS/JSON/shell/YAML corpus (external services, runtime paths, Python eval names, test-only identifiers). A uniform fix needs a Loom feature (external-name allowlist or wider corpus); stripping valid code spans from the resolving siblings would trade one inconsistency for lost formatting. Tracked as a Loom follow-up. |

## Accepted fixes (work packages)
- **Host** (`packages/host/`): host.ts stale comments (s1 comment-analyzer-1..4); logHostBooted takes the bound port (s1 code-simplifier-2); worker-lifecycle lazySpawn comment and LifecycleCtx derived from WorkerLifecycleDeps (s1 comment-analyzer-5, code-simplifier-1); boot-abort teardown failure-fence regression test (s1 pr-test-analyzer-1); BrokerCells doc (s2 comment-analyzer-1, code-simplifier-1); realm-jwt-verifier header (s5 architecture-tech-lead-2).
- **Framework / apps** : in-memory queue integer validation + handler-threw error log pinned by tests (s3 code-reviewer-1, pr-test-analyzer-1, architecture-tech-lead-4, code-simplifier-1/2); bootstrap checkpoint-write message, assembleAppDeps comment, buildHealth indentation, tests for checkMlflow transitions / checkpoint-writer error / setUpRedis all-or-nothing (s3 silent-failure-hunter-1, comment-analyzer-1, code-simplifier-5/7, pr-test-analyzer-2); oracle validateConnectivity doc (s3 comment-analyzer-2); event-record docblock and header (s4 comment-analyzer-1/5, code-simplifier-2); prompts.ts comment placement and Result (s4 comment-analyzer-2, code-simplifier-3); isDateFormat doc (s4 code-simplifier-4); CONTEXT_ONLY_KINDS doc (s5 code-simplifier-7).
- **Docs / config / CI**: entra runbook realm phrase (s1 comment-analyzer-6, code-simplifier-4); lint config: queue-bullmq description, host adapters/http edges tightened to real imports, escaped/bare entries checked (s2 comment-analyzer-4, architecture-tech-lead-4, code-simplifier-3); library-ux runDagInner line (s4 x4); eval-pipeline fixture paths (s4 comment-analyzer-4); f1-pr-d plan hyphenation, ADR-0021 history, ADR-0061 garbled span, ADR-0058 historical name (s5); ci.yml dead `secrets: inherit` and stale comment, ADR-0069 env names (s6).

## Deferred follow-ups
- **Loom**: no-dangling-doc-reference needs a vocabulary for names outside the repo corpus (external services, runtime paths, Python, test-only names) so the mixed-backtick advisories can be fixed uniformly.
- **Deepen pass**: HostShell / LifecycleCtx / BrokerCells / HitlWiring / RedisSetup / BackendState encapsulation and tagged unions; pure lifecycle decisions; cross-package isJsonObject consolidation (needs a framework export); OpenAI Responses schema (needs recorded fixtures).

## Remediation
One registered remediation run sourced on `pr53-review-s1`, `defectFamily: not-required` (zero criticals in every slice), with `supportPaths` naming this plan and every accepted-advisory path outside s1's frozen scope.

## Validation
`nix develop` (Bun 1.4.2) with a throwaway Redis on :6389 (as CI) and Podman up: `bun run verify` — prerequisites, `bun run lint` (pinned Loom), typecheck, check:docs, test:scripts, all workspace tests.

