# PR Remediation Plan — Round 7

**Date:** 2026-07-04
**Branch:** feat/deterministic-core-phase-b
**Review:** 6-agent parallel (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-agent)
**Findings:** 1 critical, 9 advisory

code-reviewer and silent-failure-hunter returned CLEAN (0/0); prior-round
regressions (readline SIGINT/close-race, codegen injection) verified STILL
FIXED. The one critical is a type-design exhaustiveness gap.

## Applied Fixes

### Fix 1 [CRITICAL]: `StructureSchema` exhaustiveness over canonical shapes
- **Source:** type-design-analyzer
- **File:** `packages/framework/src/cli/authored.ts:264`
- **Issue:** `StructureSchema`'s five shape literals were hand-written with no
  compile-time link to the canonical `DAG_SHAPES` tuple. The `assertNever` in
  `structureRefs` only fires when a variant is ADDED to the union — it cannot
  force the union to COVER every `Shape`. Adding a sixth shape to `DAG_SHAPES`
  compiled clean and left it silently un-authorable (rejected at runtime with a
  generic `invalid_union` message, no compile signal).
- **Fix:** added two type-level anchors mirroring the `_NoExtraShapes` backstop
  in `types.ts` — `_StructureCoversShapes` (`Exclude<Shape, ...shape>`) and
  `_StructureNoExtraShapes` (reverse direction) — tying `StructureSchema` to
  `DAG_SHAPES` in both directions. A new shape now fails to compile until it has
  a `StructureSchema` variant.

### Fix 2: Document `NewResult`/`DescribeResult` failure-arm asymmetry
- **Source:** type-design-analyzer (advisory), comment-analyzer
- **File:** `packages/framework/src/cli/types.ts:245,270`
- **Issue:** failure arms omit `warnings`/`advisories` — correct and intentional
  (advisories are a property of a produced artifact; nothing was written / import
  failed before serialization), but a future reader could "fix" it by adding
  empty arrays.
- **Fix:** documented the deliberate asymmetry on both failure arms.

### Fix 3: Document shared `.fugue-compose` staging base + per-session ESM growth
- **Source:** comment-analyzer, architecture-agent
- **File:** `packages/framework/src/cli/gauntlet.ts:13`
- **Issue:** `.fugue-compose` base is compose-branded but `new --from` also
  creates it; and each repair round imports a fresh `dag.ts` accumulating one
  ESM module record per draft — unaddressed by the `importDagFile`
  subprocess-only lifecycle comment.
- **Fix:** header now notes the shared/neutral base creation and the
  bounded-by-`maxRepairs` per-session module-record accumulation.

### Fix 4: Document `writeAuthoredScaffold` readdir-fold asymmetry
- **Source:** comment-analyzer
- **File:** `packages/framework/src/cli/new.ts:481`
- **Issue:** unlike `runNew`, `writeAuthoredScaffold` does not fold a probe
  `EACCES`/`ENOTDIR` here — it relies on every caller's outer try/catch.
- **Fix:** documented that the fold lives once at the caller boundary by design.

## Rejected / Deferred

### `ComposeTurnSchema` draft `dag: z.unknown()` → `.refine(!== undefined)`
- **Source:** type-design-analyzer (advisory)
- **Decision:** REJECTED. Verified the call path: a missing `dag` currently
  parses as a valid draft turn, then `parseAuthoredDag(undefined)` feeds the
  repair loop (resilient, per the module's explicit "deliberately `unknown` at
  the wire so problems feed the repair loop rather than fail the transport"
  design). Adding the refine would fail `sendStructured` schema validation,
  turning a repairable case into a hard `llm-error` abort — a resilience
  regression against documented intent. The agent itself rated the current
  behavior "defensible" and noted "the loop still converges."

### `RouterCase.when.field` shared IDENT smart constructor; `structureRefs` role string
- **Source:** type-design-analyzer (advisory)
- **Reason:** consolidation nicety with "no drift today"; the role string is
  message-only and never feeds codegen. Not defects.

### `runCompose` process.cwd() injection; `paths.ts` dedicated test
- **Source:** architecture-agent, pr-test-analyzer (rated 2/10)
- **Reason:** `runCompose` IS the shell orchestrator and tests already control
  root via `options.root`; `resolveRoot` is a trivial `node:path` wrapper
  covered transitively. Signature-changing / low-value.

## Validation

```bash
cd packages/framework && npx tsc --noEmit   # → exit 0
bun test src/__tests__/cli                  # → 286 pass, 0 fail
```

Note: `@fuguejs/host` package has pre-existing typecheck errors (missing
`@fuguejs/http-auth` / `@fuguejs/oracle` workspace deps) unrelated to this PR.
