# PR Remediation Plan — validation pass

**Date:** 2026-06-13
**Branch:** feat/llm-authoring-improvements
**Findings:** 1 critical, 2 advisory fixed (across 6 review agents)

A fresh 6-agent review of the whole branch (130 files, 4914 insertions) after the
two prior remediation commits (`4cdd63c`, `ba4840f`). Five agents returned clean
or advisory-only; two independently surfaced the same critical gap the earlier
clock-as-capability migration left behind.

## Critical Fixes

### Fix 1: `clock` capability declared & advertised but never wired in the host
- **Source:** code-reviewer + architecture-tech-lead (independent, same finding)
- **Files:** packages/host/src/main.ts:193 (omission); evidence at
  packages/examples/dags/09-dag-factory-seams.ts:51,
  packages/framework/src/__tests__/dag-input-edges.test.ts:260
- **Issue:** The prior pass migrated the clock from a DAG-factory seam to a
  first-class `clock` capability — `systemClock`/`fixedClock`, the
  `BUILTIN_CAPABILITY_KEYS` registration, and all docs/examples. But the host
  only registered `createHttpCapability()` in its `capabilities` array.
  `makeNodeContext` therefore left `ctx.clock` `null`, and `validateCapabilities`
  fails any `requires: ["clock"]` DAG at run start with `missing-capability`.
  Shipped golden example 09 declares `requires: ["clock"]`; it passes its unit
  test (which injects `fixedClock`) but is unrunnable on the real host.
- **Fix:** Register `{ name: "clock", client: systemClock }` alongside the HTTP
  handle in `main.ts` (import `systemClock` from `@fuguejs/framework`).
  `extractClients` → `makeNodeContext` then surfaces `ctx.clock`.
- **Test:** Added a regression guard in
  `packages/host/src/__tests__/node-context-factory.test.ts` mirroring the
  existing http-wiring block — a wired clock handle yields a non-null `ctx.clock`
  with a working `now()`; no handle leaves it `null` (documents the gap).

## Advisory Fixes

### Fix 2: `--owner` interpolated into `fugue.yaml` unescaped
- **Source:** pr-test-analyzer
- **File:** packages/framework/src/cli/new-templates.ts:765
- **Issue:** `owner` (freeform author input) was string-interpolated into YAML, so
  an owner containing `:`, `#`, or a newline produced malformed `fugue.yaml`.
- **Fix:** Emit the owner via a new `yamlScalar` helper — plain when YAML-safe
  (`owner: peter.hansen`), otherwise a `JSON.stringify` double-quoted scalar
  (JSON's escape grammar ⊂ YAML double-quoted), so hostile input round-trips to a
  valid single scalar by construction. `team` is path-derived kebab → left plain.
- **Test:** Added a negative test in `new.test.ts` (a `:`+newline owner stays a
  single quoted scalar; no injected top-level key appears).

### Fix 3: README public-surface list omits the new source-node exports
- **Source:** comment-analyzer
- **File:** packages/framework/README.md
- **Issue:** The `nodes/` reference (claims to enumerate the `src/index.ts`
  surface) omitted the newly-exported `createSourceNode`/`SourceNodeConfig`, and
  the `executor/` section omitted `defineSources`/`SourcesDagConfig`.
- **Fix:** Added both, with a one-line note on each.

### Incidental: `buildScaffold` switch → `match().exhaustive()`
- The loom lint hook (`prefer-ts-pattern`) gates edits to
  `new-templates.ts`; the pre-existing `switch (shape)` was converted to a
  ts-pattern `match` (behavior-preserving) so the owner fix could land clean.

## Deferred (not worth the scope/risk this pass)

- **`isSource?: boolean` → discriminated `SourceNodeDef`/`NodeKind:"source"`
  variant** (type-design-analyzer, also deferred in the prior pass). The
  `{ isSource: true, inputSchema: <non-void> }` illegal combo is *representable*
  but fully backstopped at runtime by the `validateDagShape` source/root
  biconditional and the `createSourceNode` factory; the definition-time fan-in
  check closes the practical gap. Core `NodeDef` redesign with broad blast radius.
- **Stringly-typed fan-in `$input`/source-id key matching** (type-design). Inherent
  ceiling of runtime Zod introspection; well-mitigated by the shared
  `fanInKeyCheck` + lint B1. Not actionable without dependent types.
- **`__brand*Unchecked` casts** (type-design). `@internal`, hot-path-only,
  doc-justified. Off the barrel.
- **`assertFanInKeys` throws while the linter consumes the same result as data**
  (architecture). Defensible as module-load construction; acceptable as-is.
- **`parseNewArgs` rejects `--`-prefixed flag values** (code-reviewer). Acceptable
  guard against a missing value; owner/dir/team are kebab-constrained. Low impact.
- **Untested error paths** (pr-test-analyzer): `runPromptsSync` failure →
  partial-write, empty-`sources` unreachable guard, `joinWantsInput` edge-wiring
  assertion, `analyzer-failed` lint branch, a `fanInKeyCheck` property test. Each
  needs internal-failure injection; the behavior is covered transitively. Worth a
  follow-up but not load-bearing.

## Validation Commands
```bash
bun run --filter @fuguejs/framework typecheck   # ✅ exit 0
bun run --filter @fuguejs/host typecheck         # ✅ exit 0
bun test --cwd packages/framework                # ✅ 1586 pass, 34 skip, 0 fail
bun test --cwd packages/host                      # ✅ all pass (exit 0)
bun test --cwd packages/examples                  # ✅ 21 pass, 0 fail
bun scripts/check-doc-links.ts                    # ✅ 15 files, all links resolve
```
