# PR Remediation Plan — Round 4

**Date:** 2026-07-02
**Branch:** feat/deterministic-core-phase-b (PR #33)
**Findings:** 3 critical, 25 advisory (12-agent cross-repo review, fugue half)

## Critical Fixes

### Fix 1: U+2028/U+2029 comment breakout — arbitrary code injection (confirmed end-to-end)
- **Source:** type-design-analyzer
- **File:** packages/framework/src/cli/authored.ts:51 (SINGLE_LINE), packages/framework/src/cli/authored-codegen.ts:78 (comment())
- **Issue:** `SINGLE_LINE = /^[^\r\n]+$/` and comment()'s `/[\r\n]+/g` scrub miss U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR), which JS honors as source line terminators — including terminating `//` comments. A purpose/description like `"x globalThis.__PWNED=1"` passes the schema, breaks out of the generated comment into code position, executes during the gauntlet import (inside the compose / `new --from` process) and lands in the written dag.ts. Violates the central "LLM only emits data, never code" invariant.
- **Fix:** Single-source the JS line-terminator class in identifiers.ts (e.g. `LINE_TERMINATORS = /[\r\n  ]/` + derived SINGLE_LINE regex) and consume it in both authored.ts (schema) and authored-codegen.ts (comment scrub). Add tests: schema rejects U+2028/U+2029 in purpose/description/field descriptions; comment() scrubs them; extend the existing newline-rejection fast-check property's character class.

### Fix 2: Under Bun, rl.question on a closed interface throws synchronously — SIGINT abort path crashes
- **Source:** code-reviewer (verified empirically under Bun and Node)
- **File:** packages/framework/src/cli/compose-io.ts:44-57
- **Issue:** The sync throw escapes ask() before the Promise.race / rejection-fold attaches; Ctrl-C mid-round → next io.ask → raw stack trace on stderr, no JSON outcome envelope. Breaks the "only final outcome line is JSON" contract exactly on the interrupt path.
- **Fix:** In readlineComposeIo.ask: short-circuit `if (isClosed) return Promise.resolve(closed);` then wrap the rl.question call in try/catch — sync throw with isClosed folds to closed, sync throw on a live interface rethrows. Extend fakeRl with a sync-throwing question variant and pin the Bun behavior with a test.

### Fix 3: Ctrl-C on a real TTY is swallowed by readline — process SIGINT handler never fires
- **Source:** silent-failure-hunter
- **File:** packages/framework/bin/fugue.ts:158-161
- **Issue:** In TTY raw mode readline consumes ^C and emits 'SIGINT' on the Interface; with no rl listener, readline emits 'pause' instead — the pending ask never settles, session hangs, abort silently discarded. The process-level handler only covers kill -INT / non-TTY stdin.
- **Fix:** Extract the handler to a named function; register both `process.once("SIGINT", interrupt)` AND `rl.once("SIGINT", interrupt)` (guard against double-fire: rl.close() is idempotent but the stderr line should print once). Comment why both registrations exist (fake can't cover this wiring).

## Advisory Fixes

### A1: authored-codegen.ts:570 — unconditional `ok` import unused in all-LLM DAGs
- **Fix:** Include `ok` in buildImports only when `dag.nodes.some(n => n.kind === "fetch" || n.kind === "transform" || n.kind === "source")`, mirroring the `confidence`/hasLlm gating. Add a test generating an all-LLM DAG and asserting no unused import.

### A2: new.ts:375,379 — runNewFrom breaks the JSON envelope on environment failures
- **Fix:** Wrap the gauntlet call → `{ok:false, problems:[...]}` (reason gauntlet-failed style message) and the writeAuthoredScaffold call → write-failed style, matching the file-read catch at new.ts:363-367 and runCompose's handling of the identical operations. Add tests with a throwing gauntlet / write failure.

### A3: gauntlet.ts:82 — rmdir(stagingBase).catch(() => {}) swallows EACCES/EPERM/EIO
- **Fix:** Catch, ignore ENOTEMPTY, warn on stderr for other codes (symmetry with the rm on line 75).

### A4: bin/fugue.ts:231 — process.exit(code) can truncate piped JSON payloads
- **Fix:** `process.exitCode = code` and natural drain (all handles closed by then); keep hard exit only in the pathological catch arm.

### A5: compose.ts:222 — SYSTEM_PROMPT hand-duplicates the closed node-kind/shape vocabulary
- **Source:** architecture-tech-lead
- **Fix:** Derive the token lists from the catalogues; per-kind prose descriptions as `Record<AuthoredNodeKind, string>` (satisfies-checked) and shapes likewise, so an added kind/shape is a compile error in the prompt builder. Assert prompt content in a test (contains every kind/shape token).

### A6: authored.ts:222 — nodeRef uses KEBAB while node ids use KEBAB_IDENT
- **Fix:** Align the ref regex with the id regex for precise lexical rejection.

### A7: authored.ts:290 + visualize.ts edgeLine — inferred-return exhaustiveness without assertNever
- **Fix:** Add explicit assertNever default branches.

### A8: vocabulary.ts:39 — CONFIDENCE_FIELD structurally typed
- **Fix:** `satisfies FieldSpec` (const-preserving) so FieldSpec changes flag at the definition site.

### A9–A14: Comment/doc corrections
- authored.ts:61 — drop the false "Mermaid edge labels" interpolation context; name the real one (prompt bodies via jsonShape).
- new.ts:63 — quote the actual ID_REGEX (`/^[A-Za-z0-9_:-]{1,128}$/`) so it stops contradicting visualize.ts:26.
- compose.ts:96 — "Absent only when no draft had yet survived the gauntlet, or on a deliberate abort."
- gauntlet.ts:15 — "Cleaned up best-effort (a failed rm warns on stderr rather than masking the verdict)."
- types.ts:48 — SHAPE_HELPER doc: both Shape and DagProvenance derive from the canonical DAG_SHAPES tuple.
- new-templates.ts:884 — fix the one-space misalignment in the generated README verify block.
- visualize.ts:26-29, visualize.test.ts:72-74, authored.test.ts:346-347 — replace removed-code narration with standalone invariant statements (injective, namespaced; union error map must name the vocabulary).

### A15–A19: Test additions
- identifiers: fast-check property — arbitrary KEBAB_IDENT node-id sets either reject at parse or generate collision-free gauntlet-survivable code (low numRuns, mirror hostile-text asyncProperty).
- SIGINT e2e: subprocess test sending SIGINT to a running compose (non-TTY path exercises the process handler; assert aborted JSON outcome + exit 1).
- DescribeResult divergence: runDescribe on the existing manual-fan-in-mismatch fixture (fails lint, still describes).
- compose.ts:433/500 — "expected corrected/refined draft, got questions" fail-closed branches.
- gauntlet describe-fails-after-lint-passes branch + cleanup-warning stderr path; bin exit-2 usage paths (unknown command, missing path, bad prompts subcommand, capabilities with args).

## Implementation status (2026-07-02)

All critical fixes (1–3) and all advisory fixes (A1–A19) implemented; nothing
new deferred. Validation: `bun x tsc --noEmit` clean; `bun test
src/__tests__/cli/` 253 pass / 0 fail (baseline 234); full framework suite
1838 pass / 34 skip / 0 fail. Note on A18's describe-fails / cleanup-warning
branches: `runGauntlet` gained an optional injectable `GauntletDeps`
(lint/describe/cleanup) mirroring the existing injectable-gauntlet seam on
`runCompose`/`runNewFrom`, since real generated code makes those branches
nearly unrepresentable.

## Deferred

### Aborted outcomes omit draft: lastProven
- **Reason:** compose.ts:93-97 documents this as a deliberate design decision from a prior round; reversing it is a product call, not a defect fix.
- **Recommendation:** Revisit with the user — attaching the proven draft to aborted outcomes costs nothing and keeps `fugue new --from` replay possible after Ctrl-C.

### runCompose pure-decision extraction (interpretAnswer, RepairBudget, outcome constructors)
- **Reason:** Behavior-preserving structural refactor mid-review-cycle; belongs in a dedicated refactor commit like rounds 2–3 did.
- **Recommendation:** Land as the next "deferred refactors" commit.

## Validation Commands
```bash
cd packages/framework && bun x tsc --noEmit && bun test src/__tests__/cli/
```
