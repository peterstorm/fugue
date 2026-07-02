# PR Remediation Plan — fugue

**Date:** 2026-07-02
**Branch:** feat/deterministic-core-phase-b (PR #33)
**Findings:** 5 critical, ~20 advisory (deduped across 6 review agents)

## Critical Fixes

### Fix 1: `__proto__` field name silently vanishes from generated schemas
- **Source:** code-reviewer (critical), type-design-analyzer
- **File:** packages/framework/src/cli/authored.ts:31,49; authored-codegen.ts:41
- **Issue:** IDENT accepts `__proto__`; emitted as an object-literal prototype setter, the field silently does not exist in generated `z.object`/defaults/buildInput. Passes the full gauntlet.
- **Fix:** Reject `__proto__` as a field name at parse time (deny-list refine on FieldSpecSchema), with a hostile-input test.

### Fix 2: Leading-digit kebab ids produce invalid JS identifiers
- **Source:** type-design-analyzer (critical)
- **File:** packages/framework/src/cli/authored.ts:29 (KEBAB)
- **Issue:** `2fast` passes KEBAB for node ids and dag name; codegen emits `const 2fast = ...` → SyntaxError only at gauntlet time, violating the parse-time identifier-safety invariant.
- **Fix:** Tighten first segment to start with a letter (`/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/`) for node ids and dag name + leading-digit rejection test.

### Fix 3: Ctrl-C/EOF during interview recorded as the answer; paid LLM calls continue
- **Source:** silent-failure-hunter (critical), code-reviewer
- **File:** packages/framework/src/cli/compose.ts:272-278,315-317; bin/fugue.ts:164-178
- **Issue:** The `"abort"` close sentinel is only checked at the accept prompt; interview-phase `ask` pushes it verbatim and the loop keeps making LLM + gauntlet calls against a dead terminal.
- **Fix:** Change `ComposeIo.ask` to return a discriminated result (`{kind:"answer",text} | {kind:"closed"}`); check it at every ask site (interview + accept) → `{ ok:false, reason:"aborted" }`. Update bin wiring and scripted test fakes.

### Fix 4: bin header's JSON-only-stdout contract is false for compose
- **Source:** comment-analyzer (critical)
- **File:** packages/framework/bin/fugue.ts:24
- **Fix:** Amend header: compose is interactive (prose on stdout; only final outcome line is JSON).

### Fix 5: JS_RESERVED_WORDS omits `with`, `debugger` (and strict-mode `eval`/`arguments`)
- **Source:** comment-analyzer (critical — comment overclaims; real hole)
- **File:** packages/framework/src/cli/identifiers.ts:24-28
- **Fix:** Add the missing words + test (`with` as node id rejected at parse time).

## Advisory Fixes (in scope)

1. **visualize.ts:24 / compose.ts:143** — `safeId`/`safe` can merge distinct ids (`a:b` vs `a_b`) and collide with reserved `dag_input`/`dag_output` tokens. Prefix real node ids (e.g. `n_`) + tests. (code-reviewer)
2. **authored.ts:42 / compose.ts:170** — constrain enum `values` with SINGLE_LINE at parse time and escape `when.equals` in authoredToMermaid edge labels (reuse escapeLabel-style escaping). (code-reviewer, silent-failure-hunter)
3. **gauntlet.ts:40-53 / compose.ts:291,323** — guard gauntlet IO throws (incl. finally-rm); convert to `{ ok:false, ..., problems: withDraftJson([...]) }` so the draft survives environment failures. (silent-failure-hunter)
4. **compose.ts:250,258-261,294-299,330-333** — `repair-exhausted` and `llm-error` outcomes must carry the last proven draft via withDraftJson. (silent-failure-hunter)
5. **new.ts:353-357** — surface `verdict.advisories` in the success NewResult for `--from`. (silent-failure-hunter)
6. **authored.ts:363-369** — reject duplicate router `{field, equals}` predicates (unreachable case) + test. (type-design-analyzer)
7. **compose.ts:51 / bin/fugue.ts:144-151** — validate `--team` against KEBAB at the CLI boundary. (type-design-analyzer)
8. **compose.ts:34-35** — delete dead back-compat re-export of runGauntlet. (comment-analyzer, architecture)
9. **Doc fixes** (comment-analyzer 3-10): identifiers.ts:64 (`${camel}Node` rationale), authored-codegen.ts:102 (ref dead for llm nodes), identifiers.ts:85 (InputSchema always emitted), new.ts:1-20 (header: --from mode + side effects), new.ts:77-82 (ParsedNewFromArgs variant), new.ts:328-330 (sidecar readers), authored-codegen.ts:409 + new.ts:302 (generated-by attribution), types.ts:210-212 (DescribeResult wraps import, not lint).
10. **Test gaps** (pr-test-analyzer): parseNewArgs `--from` happy + 4 mutual-exclusion tests; runNewFrom error paths (unreadable, schema-invalid, gauntlet-failure); transport llm-error turn; schema-repair exhaustion + "got questions" branch; writeAuthoredScaffold-throws branch; pin message in source-kind-outside-sources test.

## Deferred (documented, not in this pass — architectural refactors beyond minimal-fix scope)

- Brand AuthoredDag (`.brand<"AuthoredDag">()`); AuthoredNode discriminated union on `kind` (type-design-analyzer).
- identifiers.ts as name-constructor single source of truth consumed by codegen (architecture).
- Converge authoredToMermaid onto describedToMermaid via gauntlet-carried DescribedDag (architecture).
- Extract pure parseComposeArgs from bin (architecture).
- Shared confidence-bucket constant across schema/codegen/prompt (architecture).
- Converge new-templates.ts onto AuthoredDag presets (architecture — phase decision).

## Validation Commands
```bash
cd packages/framework && bun run typecheck
cd packages/framework && bun test
```
