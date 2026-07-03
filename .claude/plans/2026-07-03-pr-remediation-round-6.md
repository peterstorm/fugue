# PR Remediation Plan — Round 6

**Date:** 2026-07-03
**Branch:** feat/deterministic-core-phase-b
**Findings:** 1 critical, 12 advisory (6 review agents: code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead)

## Critical Fixes

### Fix 1: Digit-leading `fugue new` name emits a SyntaxError scaffold under ok:true
- **Source:** type-design-analyzer
- **Files:** packages/framework/src/cli/identifiers.ts:166-176, new.ts:175, new-templates.ts:99
- **Issue:** `dagOptsInterfaceName` is string-typed and name-initial: `pascalCase("2fast")` → `2fastDagOpts`. `fugue new team/2fast --shape linear --llm` passes plain-KEBAB validation, emits `export interface 2fastDagOpts {` — a SyntaxError — and per NewResult docs template scaffolds never run the gauntlet, so the broken file lands under `ok: true`. Exactly the failure class KEBAB_IDENT exists to prevent, reintroduced through the one unbranded constructor.
- **Fix:** brand BOTH DAG-level constructors (`dagFactoryName`, `dagOptsInterfaceName`) to take `KebabIdent`; tighten `fugue new` name validation (new.ts:175) to `parseKebabIdent` with a clear problem message naming the rule (name must camelCase to a valid JS identifier — no digit-leading segment where it matters). Thread the branded name through runNew → new-templates. The authored pipeline already passes branded `dag.name` (authored-codegen.ts:487) — verify it still compiles.
- **Tests:** `fugue new team/2fast --llm` (and non-llm) → rejected with the named rule; existing accepted names unchanged; update any fixtures/messages that assert the old validation text.

## Advisory Fixes

### Fix 2: escapeLabel does not neutralize line terminators
- **Source:** code-reviewer (80)
- **File:** packages/framework/src/cli/visualize.ts:39
- **Fix:** `s.replace(/"/g, "&quot;").replace(LINE_TERMINATORS, " ")` reusing the single-sourced class from identifiers.ts. Tests: predicate label containing `"` (pins the &quot; path — currently unexercised, pr-test-analyzer 3/10) and containing `\n`/U+2028.

### Fix 3: GauntletResult / VisualizeResult drop DescribeResult.warnings
- **Source:** silent-failure-hunter
- **Files:** packages/framework/src/cli/gauntlet.ts:89-93, visualize.ts:105-116
- **Fix:** carry `described.warnings` on the ok arms of GauntletResult and VisualizeResult, per the warnings-threading contract this PR itself added to DescribeResult ("in-process consumers never have to scrape stderr"). Update consumers/tests.

### Fix 4: runNew's emptiness probe escapes the stdout-JSON envelope
- **Source:** silent-failure-hunter
- **File:** packages/framework/src/cli/new.ts:231
- **Fix:** move `await isDirNonEmpty(dir)` inside the existing try (or wrap in the same `{ ok: false, problems }` fold) so EACCES/ENOTDIR lands in the documented envelope like every other environment failure.

### Fix 5: `team` unbranded in AuthoredDag schema
- **Source:** type-design-analyzer
- **File:** packages/framework/src/cli/authored.ts:309 (consumer: compose.ts:406)
- **Fix:** `.transform` through `parseKebab` so the parsed dag carries the proof, matching sibling `name`.

### Fix 6: ComposeOptions.intent non-emptiness comment-enforced only
- **Source:** type-design-analyzer
- **File:** packages/framework/src/cli/compose.ts:67,202-205
- **Fix:** brand a non-empty trimmed `Intent` with a sole `parseIntent` producer (consistent with `team`'s treatment), produced by parseComposeArgs; runCompose demands the brand. Test: whitespace-only intent `["   ", "--team", "assist"]` rejected with "intent must be non-empty" (pr-test-analyzer 4/10).

### Fix 7: `rounds` telemetry discarded on failure arms
- **Source:** type-design-analyzer
- **File:** packages/framework/src/cli/compose.ts:94
- **Fix:** carry `rounds` on the failure arms too (repair-exhausted is precisely where it is diagnostic; add to abort/llm-error/gauntlet-failed/write-failed for symmetry). Update tests.

### Fix 8: No fixture for LLM node in the sources assemble role
- **Source:** pr-test-analyzer (6/10)
- **File:** packages/framework/src/cli/authored-codegen.ts:560
- **Fix:** add a `sources-llm-assemble` fixture to FIXTURES (rides the acceptance-matrix loop for free) + one string assertion pinning the `$input` → `_input` sanitization in emitted buildInput/prompt.

### Fix 9: Gauntlet warn sink not injectable — the diff's only mock-framework usage
- **Source:** architecture-tech-lead (76)
- **Files:** packages/framework/src/cli/gauntlet.ts:99-115; compose.test.ts:1008,1027,1046
- **Fix:** add `readonly warn?: (message: string) => void` to GauntletDeps (default `(m) => process.stderr.write(m)`); convert the three spyOn(process.stderr) tests to fake-based captured-array assertions.

### Fix 10: prompts/registry.json byte format triplicated
- **Source:** architecture-tech-lead (75)
- **Files:** packages/framework/src/cli/new.ts:276-282,479-484, prompts.ts:98
- **Fix:** export `freshRegistryEntry(body)` + `serializeRegistry(entries)` from prompts.ts (or a leaf module); consume at all three sites; delete the load-bearing "byte-for-byte" comment; add a round-trip test through readRegistry.

### Fix 11: bin header calls a pretty-printed JSON block a "line"
- **Source:** comment-analyzer
- **File:** packages/framework/bin/fugue.ts:24-26
- **Fix:** reword to "only its final output is a JSON block" (outcome is `JSON.stringify(outcome, null, 2)`).

## Deferred

### Compose subprocess accept-path e2e (bin-level draft → "yes" → write → ok JSON)
- **Reason:** pr-test-analyzer rated 2/10 — every component (runCompose accept path, readlineComposeIo answer path, bin env wiring) is individually covered; the composition test requires a mock LLM server harness at the subprocess boundary.
- **Recommendation:** add alongside the next bin-level feature change.

## Validation Commands
```bash
cd /home/peterstorm/dev/agentic/fugue/packages/framework && bunx tsc --noEmit
cd /home/peterstorm/dev/agentic/fugue && bun test packages/framework/src/__tests__/cli/
```
