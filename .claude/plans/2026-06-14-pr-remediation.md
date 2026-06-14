# PR Remediation Plan

**Date:** 2026-06-14
**Branch:** feat/human-review-authoring
**Findings:** 2 critical, 12 advisory (after dedup) — 2 critical + 7 advisory to fix, 5 dispositioned (won't-fix / false-positive / out-of-scope)

Six-agent review (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer,
comment-analyzer, architecture-tech-lead). code-reviewer and architecture came back essentially
clean; the substantive findings are concentrated in the HITL smoke driver and the docs.

## Critical Fixes

### Fix C1+C2+A1: smoke driver swallows HTTP/auth/5xx errors as poll timeouts / misleading messages
- **Source:** silent-failure-hunter
- **File:** examples/hitl-smoke/smoke.ts:46-55, 65-74, 36-37
- **Issue:** `pollUntil` never checks `res.ok`, so a 401/404/5xx body is parsed as run state →
  `status === undefined` → masked as a generic 20s poll timeout. The run-trigger collapses every
  non-202 (401/400/404/500) into a hard-coded "Is HITL enabled?" hypothesis. `unwrap` returns the
  whole envelope on an error body, letting error envelopes pass as status views.
- **Fix:** Introduce a single `requestJson(res, what)` boundary helper: throw an actionable
  `${what} → HTTP ${status}: ${body}` on non-OK, reject `{ ok: false, error }` envelopes, and
  guard non-JSON bodies. Route the run POST and both polls through it. Assert 202 + runId with the
  real body in the message instead of the canned HITL hypothesis.

## Advisory Fixes

### Fix A2: pollUntil conflates "reached wanted state" with terminal "failed"; drops recorded error
- **File:** examples/hitl-smoke/smoke.ts:51, 78-79
- **Fix:** Extract a pure `isPollDone(status, want)` predicate; surface the run's recorded `error`
  in the suspend-phase failure message instead of a generic dump.

### Fix A3: empty/whitespace human-review prompt accepted — illegal "asks-nothing" gate representable
- **Source:** silent-failure-hunter
- **File:** packages/framework/src/nodes/human-review.ts (withHumanReview — the single choke point)
- **Fix:** Validate a non-empty, trimmed prompt at construction time (parse-don't-validate, same
  pattern as `nodeId()` throwing on a bad id). Covers `createHumanReviewNode` since it funnels
  through `withHumanReview`. Add tests. Generated `--review` templates already emit non-empty
  prompts, so the lint matrix is unaffected.

### Fix A4: "all-or-nothing" comment overstates crash atomicity
- **File:** packages/framework/src/cli/new.ts:223-229
- **Fix:** Correct the comment to describe the real guarantee (in-process write *ordering*, not
  crash-atomic) and note a mid-batch IO failure can leave a partial scaffold. The error already
  propagates (not swallowed); the misleading claim is the actual defect. True FS atomicity
  (temp-dir + rename) is not cleanly reachable for the --force overwrite path, so accurate
  documentation is the correct fix, not a rename dance that isn't atomic anyway.

### Fix A5: smoke DAG has no automated lint guard (every other example is lint-guarded)
- **Source:** pr-test-analyzer
- **File:** examples/hitl-smoke/dags/demo/approval/dag.ts
- **Fix:** Add a `test` script to examples/hitl-smoke/package.json and a `runLint`-based test that
  lints the smoke DAG, mirroring packages/examples examples-lint.test.ts.

### Fix A6: smoke driver pure logic untested (reject path never auto-verified)
- **Source:** pr-test-analyzer
- **File:** examples/hitl-smoke/smoke.ts:39-55, 95-98
- **Fix:** Extract pure helpers (`decisionBody`, `expectedTerminal`, `isPollDone`) into
  `smoke-logic.ts`; unit-test them incl. the reject → "failed" path. Now cheap given A5 adds a
  test runner to the package.

### Fix A7: yamlScalar has only example coverage — property test FOUND A REAL BUG
- **Source:** pr-test-analyzer
- **File:** packages/framework/src/cli/new-templates.ts
- **Fix:** Export `yamlScalar`; add a fast-check round-trip property — for any string `s`,
  `parse('owner: ' + yamlScalar(s))` yields `{ owner: s }`.
- **Bug surfaced:** The property immediately failed on counterexample `"0"`. `yamlScalar("0")`
  passed `SAFE_YAML_SCALAR` so it stayed plain (`owner: 0`), but YAML type-coerces that to the
  number `0`, not the string `"0"` — same for `"true"`/`"null"`/`"1.5"`/any numeric/bool/null
  literal. The regex guarded syntax injection but NOT type coercion. Fixed `yamlScalar` to emit a
  plain scalar only when it both passes the regex AND round-trips to the identical string under the
  real YAML parser (added `yaml` to framework deps; CLI-only path, not in the runtime index). This
  is the deepest fix — it can never drift from YAML's coercion grammar, unlike an enumerated
  blocklist.

### Fix A11: authoring guide flag table omits --review
- **Source:** comment-analyzer
- **File:** packages/framework/docs/llm-dag-authoring.md:1069-1076, 1036
- **Fix:** Add a `--review` row to the `fugue new` flag table; the flag is parsed by the CLI and
  documented in `bin/fugue.ts --help` already.

### Fix A12: examples README overstates example 10's demonstrated helpers
- **Source:** comment-analyzer
- **File:** packages/examples/README.md:28
- **Fix:** The example only *calls* `createHumanReviewNode` (`withHumanReview` appears only in a
  header comment). Correct the "Helper / capability" column to `createHumanReviewNode`.

## Dispositioned (not fixing)

### A10 — NodeId brand "dropped" by createHumanReviewNode/withHumanReview — FALSE POSITIVE
- **Source:** type-design-analyzer + architecture-tech-lead (both, same misreading)
- **Verified:** Empirical type probe — `gate.id`, `wrapped.id`, `tx.id` all assign to `NodeId`,
  and a plain `string` is rejected (`@ts-expect-error` satisfied). `NodeDef.id` is already typed
  `NodeId` (types/node.ts:383), so `createTransformNode`'s `& { readonly id: NodeId }` is
  redundant and nothing is widened. No change; applying one would be a no-op intersection.

### A8 — passthrough test calls gate.run directly, bypassing inputSchema — by design
- The analyst noted this is "acceptable for a unit test of the helper; not a defect." `run-node`
  schema validation is the runtime's responsibility and covered elsewhere. No change.

### A9 — frameworkError raw-err guard covers only linear non-llm scaffold — low value
- Linear is currently the only scaffold with a hand-written error branch (analyst: "low
  priority"). No defect; revisit if other shapes gain hand-written error paths.

### dag-runtime/types.ts:24 — approve-with-edit newOutput: unknown — out of scope
- Pre-existing machinery, NOT in this PR's diff (both analysts flagged it as context). The edited
  value is re-validated against the schema at the consuming node's run boundary. Out of scope.

## Validation Commands
```bash
# framework
cd packages/framework && bun run typecheck && bun test
# examples
cd packages/examples && bun run typecheck && bun test
# hitl-smoke (new test runner)
cd examples/hitl-smoke && bun run typecheck && bun test
```
