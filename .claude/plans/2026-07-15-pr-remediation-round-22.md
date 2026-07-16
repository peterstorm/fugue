# PR Remediation Plan — Round 22

**Date:** 2026-07-15
**Branch:** feat/deterministic-core-phase-b
**Findings:** 1 critical, 3 advisory (applied)

Round 22 of the sustained cross-repo remediation (`this repo and fugue pr`),
driven from the loom repo. Three parallel review agents ran over fugue's
recently-touched core (code-reviewer, silent-failure-hunter, type-design-analyzer),
focused on the LLM error taxonomy and the CLI codegen/integrity coupling.

The cross-repo `@fugue-integrity` coupling was verified **byte-for-byte sound**
(no drift in the body markers, structural projection, or hash), and the
`httpFailureToError` / `classifyLlmError` HTTP-status policy was confirmed
**genuinely single-sourced** through `classifyHttpStatus`.

## Critical Fixes

### Fix 1: Retriability is now a typed, exhaustive property of the taxonomy
- **Source:** type-design-analyzer
- **File:** `packages/framework/src/types/errors.ts`, `packages/framework/src/dag-runtime/retry-policy.ts:76-86`
- **Issue:** Retriability — the defining behavioral axis of `FrameworkError` —
  was type-encoded on only 1 of 27 variants (`node-crash.retriability`). For all
  other kinds it was computed by a hand-maintained boolean disjunction in
  `handleNodeFailed` that is **not** an exhaustive match. A newly added error kind
  would silently default to retriable-with-backoff (the unsafe,
  non-fail-closed direction) with **no compile error**.
- **Fix:** Introduced `retriabilityOf(e): Retriability` in `errors.ts` — an
  exhaustive `match(...).exhaustive()` over all 27 kinds — and rewired
  `handleNodeFailed`'s fast-fail branch to `retriabilityOf(error) ===
  "non-retriable"`. **Behavior-preserving**: the classification reproduces the old
  disjunction exactly (locked by a 27-row table test). Adding a new kind is now a
  compile error until its retriability is declared.

## Advisory Fixes (applied)

### Fix 2: `usageOfError` made exhaustive (FR-W0-001 attribution)
- **Source:** silent-failure-hunter / type-design-analyzer
- **File:** `packages/framework/src/types/errors.ts:325`
- **Issue:** `.otherwise(() => undefined)` meant a future `usage?`-carrying
  variant would silently read as no-usage — a 100%-attribution regression with no
  compile error.
- **Fix:** Replaced `.otherwise` with the remaining 24 kinds listed explicitly +
  `.exhaustive()`. A new usage carrier not added to the three usage arms is now a
  compile error.

### Fix 3: `messageOf` helper — dedup `lastError` kind-lists
- **Source:** type-design-analyzer
- **File:** `packages/framework/src/types/errors.ts`, `retry-policy.ts:145,219`
- **Issue:** Two identical hand-maintained `node-crash | transient` kind checks
  built `retry-exhausted.lastError`; a second drift-prone truth alongside the
  retriability list. Also left `infra-unreachable`'s message buried in JSON.
- **Fix:** Extracted `messageOf(e)` as the single summariser; both call sites
  delegate.

### Fix 4: Remove provably-dead imports in the LLM clients
- **Source:** code-reviewer / silent-failure-hunter
- **File:** `anthropic-client.ts:30`, `openai-client.ts:14-48`
- **Issue:** `dispatchToolCallsWithSpans` (both), `fwLogger`, and several
  import-only OpenAI type/guard names (`ToolCall`, `ToolDispatchResult`,
  `MessageBlock`, `FunctionCallBlock`, `ReasoningBlock`, `FunctionCallOutputItem`,
  `isFunctionCallBlock`, `isReasoningBlock`) were unused (verified: each appears
  only at its import line). Lint noise (`noUnusedLocals` off).
- **Fix:** Removed the dead names; kept the still-used imports.

## Considered — deliberately not fixed

- **`sendStructured` returns truncated-but-parseable payloads as `ok()`
  (silent-failure advisory):** the code-reviewer confirmed this is a **deliberate,
  documented divergence** from `sendWithTools` ("structured-output JSON may
  complete before the cap"). Forcing an early-return would break the legitimate
  small-schema case; low reachability. Left as-is.
- **`checkFanInKeys` skips `unverifiable` schemas silently (silent-failure
  advisory):** the skip is a **documented design choice** shared by both callers
  (`fan-in-keys.ts:31` — "treated as skip rather than a false positive"); the
  executor path can't emit advisories, so surfacing one only in lint introduces
  cross-caller asymmetry. Left as-is.
- **`ResponsesOutputItem` open catch-all arm (type-design advisory):** intentional
  forward-compat, no change required.

## Validation

```bash
cd packages/framework && bunx tsc --noEmit   # ✅ clean (host pkg has pre-existing
                                             #    unrelated http-auth/oracle errors)
bun test                                      # ✅ 1983 pass, 0 fail
```
