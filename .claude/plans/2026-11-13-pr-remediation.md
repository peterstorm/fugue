# PR #53 review-and-fix remediation plan — 2026-11-13

Branch: `feat/lint-max-enforcement` (PR #53, peterstorm/fugue).
Source reviews: six partitioned standalone-review runs in `.claude/reviews/review-and-fix-runs/`:
`pr53-s0`, `pr53-s1b`, `pr53-s2`, `pr53-s3`, `pr53-s4`, `pr53-s5` (the full 117-file diff
exceeded one run's read-coverage budget; each slice was reviewed by all seven reviewers, and
every slice's criticals went through the engine's Refutation Panel).

Aggregate: **5 surviving criticals, 159 advisories, 0 refuted findings.**

## Surviving-critical dispositions (all `repaired`)

| Finding | Run | Group | Check (Historical RED declared) |
|---|---|---|---|
| silent-failure-hunter-1 (grounding-guardrail OutputSchema omits the `failed` arm → validator throw fails the run with 500 instead of degrading) | pr53-s0 | `group.guardrail-failed-arm` | `project:pr53-cs-regression` |
| pr-test-analyzer-1 (extracted bootstrap seams — setUpRedis/buildHealth — untested; durability wiring unverifiable) | pr53-s0 | `group.bootstrap-seams` | `project:pr53-cs-regression` |
| pr-test-analyzer-1 (closeEvalFailed/closeGuardrailFailed arms unpinned) | pr53-s1b | `group.telemetry-arms` | `project:pr53-fw-regression` |
| pr-test-analyzer-1 (GenAI message redaction rule untested — raw prompt text could leak on a mis-supplied filter) | pr53-s2 | `group.genai-redaction` | `project:pr53-fw-regression` |
| pr-test-analyzer-1 (host sync-path fan-cap regression undetectable: no test observes the RunOptions createDagExecutor hands to runDag with a non-default cap) | pr53-s4 | `group.fan-cap-e2e` | `project:pr53-host-regression` |

### Declared repair groups

**group.guardrail-failed-arm** (pr53-s0/silent-failure-hunter-1)
- Root cause (DECLARED): the node's OutputSchema narrows to `skipped | validated` while the
  framework wrapper (`packages/framework/src/nodes/guardrail.ts`) emits `kind: "failed"` when
  `validate()` throws, so the wrapper's own output fails the node's output validation and the
  run 500s instead of degrading.
- Invariant (DECLARED): a guardrail node's OutputSchema admits every arm the guardrail
  wrapper can emit; a validator throw surfaces as `GuardrailFailed` and the assembler degrades.
- Siblings (DECLARED): `schemas/guardrail.ts` (arm schemas, annotated), `assemble-response.ts`
  (degrade path — reviewed, no change needed), `grounding-guardrail.ts` (schema fix).
- Fix: include `GuardrailFailedSchema` in the node's OutputSchema; pin with a test that a
  throwing validator yields a degraded run, not a failed one.

**group.bootstrap-seams** (pr53-s0/pr-test-analyzer-1)
- Root cause (DECLARED): the decomposition made the Redis/readiness wiring module-private;
  `bootstrap()` is invoked only by `src/index.ts`, so no test executes the durability seam.
- Invariant (DECLARED): the Redis-unreachable branch (all three collaborators null) and the
  readiness wiring are pinned by tests that fail if the wiring slips.
- Siblings (DECLARED): `bootstrap.ts` (export the seams), new `__tests__/bootstrap-seams.test.ts`.
- Note: the refutation panel's blast-radius verifier showed the reviewer's stated 200-without-
  checkpointing consequence is already blocked by the /summarize 503 gate; the surviving claim
  is the unverified seam, which the tests pin.

**group.telemetry-arms** (pr53-s1b/pr-test-analyzer-1)
- Root cause (DECLARED): the closeRootSpan extraction moved the eval-failed and
  guardrail-failed arms into helpers no test executes; the ok/error siblings are pinned, these
  two are not.
- Invariant (DECLARED): each arm's span status message and EVENT_NODE_OUTPUT attributes are
  asserted; a mis-wired arm (closeOk in place of closeEvalFailed, swapped arguments) fails a test.

**group.genai-redaction** (pr53-s2/pr-test-analyzer-1)
- Root cause (DECLARED): the extraction re-plumbed the content-filter argument
  (`contentAttrs(filter, field, text)`, third positional param on addThinkingEvent) with no test
  on the filter-or-redact rule for any of the three GenAI message events.
- Invariant (DECLARED): filter null ⇒ `<field>_redacted` + `<field>_chars` and no raw content,
  for system, user and assistant events; a wired filter ⇒ content; `ai.llm.has_thinking` only
  when thinking is supplied.

**group.fan-cap-e2e** (pr53-s4/pr-test-analyzer-1)
- Root cause (DECLARED): FR-030's sync-run cap threading moved into the private
  `createDagExecutor`; every suite either pins the seam directly, calls runDag with hand-built
  options, or boots the host with the default cap — indistinguishable from a dropped argument.
- Invariant (DECLARED): a host booted with a non-default `FAN_CHILD_CONCURRENCY_MAX` runs a
  map-fan through the synchronous path with child concurrency bounded by that cap (observed
  through the checkpointer's concurrent saves).

## Advisory dispositions

Published via standalone-disposition, one program per source run:
`pr53-policy-pr53-s0` … `pr53-policy-pr53-s5` (artifacts/disposition.json in each run directory;
records copy the exact lineage `origin` values in inventory order).

Totals: **81 accepted, 78 deferred, 0 dismissed.**
- Accepted: doc/config text corrections (fixHint, stale counts, wrong reasons, boundary
  descriptions, dead allow entry), small type tightenings (scope forwarding, null-tolerance,
  isInteger, branded keys, unions replacing boolean flags), logging at warn/error where the
  sibling path logs, small dedups (releaseQuietly, never-proof helper, Step→Result alias,
  CheckpointMeta→RunMeta), and the new tests pinning unpinned behavior.
- Deferred: larger refactors that need their own change (RedisSetup/NotifierWiring unions,
  service-deps narrowing, boundary splitting, shared wire-guard module, traversal-core
  dedup, MLflow derivation exports, kind-taxonomy changes, most new fixtures) — each with a
  concrete reason in its disposition entry.

## Refuted-finding audit

No finding was fully refuted. Five findings went to panels; in each, at least one verifier
verdict was `refuted` (partial), recorded here because refuted verdicts are never fixed:
- pr53-s0/pr-test-analyzer-1: blast-radius refuted the stated 200-without-checkpointing
  consequence (the 503 gate blocks it); the coverage-gap claim survived 2–1.
- pr53-s1b/pr-test-analyzer-1: intent refuted "exercised by no test" (existing e2e tests run
  the paths without asserting); the unpinned-arm claim survived 2–1.
- pr53-s2/pr-test-analyzer-1: reproduction returned `uncertain` (requires a future edit to
  fire); upheld 2–1 on intent and blast radius.
- pr53-s4/pr-test-analyzer-1: intent refuted (required-branded parameter makes the literal
  "pass undefined" regression a compile error); upheld 2–1 on reproduction (typed-but-wrong
  values remain silent) and blast radius.

## Implementation and validation

Phase 3 implements the 5 critical repairs and the 81 accepted advisories. Validation before
remediation: `bun run lint`, `bun run typecheck`, `bun run check:docs`, package test suites
(framework, host with REDIS_URL, customer-summary, xlsx, adapters, http-auth).

Remediation checks (operator-owned manifest `.loom/verification-manifest.json`): three
`bun test --reporter=junit --reporter-outfile=.loom/completion-reports/<id>.xml` checks over
one new regression test file per package
(`apps/customer-summary/src/__tests__/pr53-repair-regression.test.ts`,
`packages/framework/src/__tests__/pr53-repair-regression.test.ts`,
`packages/host/src/__tests__/pr53-repair-regression.test.ts`). Report paths are untracked and
git-ignored; each check writes a fresh report on every run. Historical RED: each new test
fails against the pre-fix code by construction (the guardrail test asserts the degraded run the
current code does not produce; the seam/telemetry/redaction/fan-cap tests assert behavior no
existing test observes).

Remediation runs: one per critical-bearing source (`pr53-rem-s0`, `pr53-rem-s1b`, `pr53-rem-s2`,
`pr53-rem-s4`), each naming the plan file and every fix path outside that source's frozen scope
in `supportPaths`. pr53-s3 and pr53-s5 have zero surviving criticals; their accepted advisory
fixes are installed through the other runs' remediation (listed in supportPaths) and no
remediation run is started for them.
