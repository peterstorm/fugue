# PR #48 remediation plan — review 4

Date: 2026-09-13

Branch: `feat/f1-authored-map`

Reviewed HEAD: `381801949d27e0b98281f84fda4c831ae49e0dae`

Review run: `.claude/reviews/review-and-fix-runs/20260913T062927Z-pr48-review-4`

Canonical result digest: `e578470d714bf097e198c013e2af727495d11f81651a1c9d64cd444b2956165a`

## Frozen scope

The review covers the complete PR diff from `main` through reviewed HEAD. Remediation may modify files in that frozen scope plus this plan, which must be registered as an explicit support path.

## Refutation audit

The engine admitted one critical and sent it to the three-member panel:

- Reproduction: **upheld** — generated fetch/source/transform callbacks return `ok(...)` placeholders, and gauntlet validation accepts them.
- Intent: **refuted** — existing comments describe successful placeholders as deliberate scaffold behavior.
- Security: **upheld** — successful fabricated values can cross runtime trust boundaries and drive downstream effects.

Strict majority therefore retained the finding. There are no refuted critical findings to preserve.

## Surviving-critical disposition

### `silent-failure-hunter-1` — repaired via `group.fail-closed-generated-bodies`

**Claim:** Generated fetch, source, and transform placeholders silently return schema-valid fabricated values as successful node results.

**DECLARED root cause:** The authored generator reused schema-shaped defaults to keep generated modules importable, but represented “not implemented” as `Ok<fabricated output>` instead of a typed execution refusal.

**DECLARED invariant:** Every unedited authored fetch/source/transform body is importable and gauntlet-valid but returns `Err<FrameworkError>` naming its node and unimplemented body; it cannot produce a successful domain value before an author replaces the marked body.

**Sibling accounting:**

- `packages/framework/src/cli/authored-codegen.ts` — **repaired**: emit one canonical typed unimplemented expression for all three executable placeholder kinds and import only `err`/`frameworkError` when needed.
- `packages/framework/src/cli/identifiers.ts` — **repaired**: add the generated failure-helper names to the single import/collision catalogue.
- `packages/framework/src/__tests__/cli/authored-map.test.ts` — **repaired**: the registered regression imports generated outer/child nodes and executes every placeholder kind, asserting typed failures and no fabricated success.
- `packages/framework/src/__tests__/cli/authored.test.ts` — **repaired**: update generated-import and integrity/import-selection contracts from successful defaults to fail-closed bodies.
- `packages/framework/docs/llm-dag-authoring.md` — **repaired**: state that authored generated bodies fail closed until implemented.

**Selected fixed check:** `project:authored-map-regression`.

**DECLARED Historical RED:** On reviewed HEAD `38180194`, generated fetch/source/transform body regions contain `ok(...)` with schema-valid `"todo"`, zero, false, enum-first, and empty-array defaults. Executing an untouched generated node therefore returns success. Reference: review run `20260913T062927Z-pr48-review-4`, finding `silent-failure-hunter-1`.

The registered command must freshly create `.loom/completion-reports/authored-map-regression.junit.xml`; only its engine observation becomes `ENGINE_OBSERVED`.

## Advisory dispositions

### Accepted

- `silent-failure-hunter-2` — Display non-empty gauntlet schema-serialization warnings before the accept prompt; they can qualify what the operator is approving.
- `pr-test-analyzer-1` — Add table-driven map-role parse/codegen/import coverage for first linear, fan source/branch, router classifier/handler, and explicit fan-in-role refusals.
- `pr-test-analyzer-2` — Add a cyclic programmatic-input refusal and a shared-acyclic-reference positive control for the iterative authored preflight.
- `type-design-analyzer-1` — Constrain typed map `widthFrom` to array-valued string keys of the inferred input while retaining runtime checks for forged/untyped callers.
- `type-design-analyzer-2` — Redeclare map `isSource`, `sideEffects`, and `confidence` policy in `MapNodeDef`; reject forged contradictory runtime values during DAG validation.
- `comment-analyzer-1` — Narrow the documentation’s no-throw promise to operational Result-returning APIs and retain construction/caller-invariant exceptions.
- `comment-analyzer-2` — Correct `KebabIdent` commentary: the brand proves lexical shape; authored reserved-word checks provide emission safety.
- `comment-analyzer-3` — Describe `ComposeTurn` as the closed model envelope and AuthoredDag as the only graph-artifact channel.
- `comment-analyzer-4` — Describe repair diagnostics as JSON-serialized data embedded in textual turns, not structured events.
- `comment-analyzer-5` — Contrast finite delay/ratio configuration with safe-integer count budgets.
- `code-simplifier-2` — Compute total LLM count and per-plan model dependence once, then reuse those planning facts.
- `code-simplifier-3` — Reuse the single parsed DAG-validation sentinel throughout `validateDagShape`.
- `code-simplifier-4` — Describe `loadedPrompts` as an initial set augmented by node introspection, not contradictory sole authority.

### Deferred

- `code-simplifier-1` — Parent and child topology emitters share shape names but have different legal states and formatting contracts: parent fan-out may omit a join; child fan-out may not; child schemas are inline and namespaced. A single private planner would need a callback-heavy interface that exposes nearly the same policy it hides. This is a broader emitter-interface deepening, not a safe local distillation in this remediation.

### Dismissed

None.

## Implementation sequence

1. Replace successful generated defaults with one deterministic typed unimplemented error expression; update import accounting and docs.
2. Add runtime/static regressions for all generated body kinds.
3. Strengthen map width-field and fixed-policy types, mirror the policy at `validateDagShape`, and add compiler/runtime regressions.
4. Add map-role, fan-in-refusal, cycle/shared-reference, and compose-warning tests.
5. Apply accepted comment and private planning simplifications.
6. Run focused typecheck/tests and documentation checks.
7. Run `distill` apply mode against a green focused baseline, one behavior-preserving move at a time.
8. Run authenticated canonical `bun run verify`.
9. Start fresh schema-v2 remediation against the immutable source review, registering this plan as support and selecting `project:authored-map-regression`.
10. Commit/push only Loom’s exact verified installed index.

## Validation commands

```bash
bun run --cwd packages/framework typecheck
bun test \
  packages/framework/src/__tests__/cli/authored-map.test.ts \
  packages/framework/src/__tests__/cli/authored.test.ts \
  packages/framework/src/__tests__/cli/compose.test.ts \
  packages/framework/src/__tests__/map-node.test.ts \
  packages/framework/src/__tests__/validate-dag.test.ts
bun test scripts/__tests__/check-doc-links.test.ts
bun scripts/check-doc-links.ts
bun run verify
```

## Evidence boundary

Root cause, invariant, grouping, sibling status, Historical RED, and advisory dispositions above are `DECLARED`. Development test runs are validation only. Only the registered remediation runner may produce `ENGINE_OBSERVED` repaired-check evidence, `repair-checked` assessment, and verified-index installation authority.
