# PR #48 remediation 8 — parsed collect values and total compose diagnostics

## Authority

- Branch: `feat/f1-authored-map`
- Reviewed commit: `68d31ffa34dfe10487f240098e0ae838983787a0`
- Review run: `.claude/reviews/review-and-fix-runs/20260913T130100Z-pr48-review-8`
- Canonical review result: `.claude/reviews/review-and-fix-runs/20260913T130100Z-pr48-review-8/result.json`
- Canonical result digest: `03b3549bf543ecf10e0b24871821db1568d8a841b98a747a5403c1393d7b7ecb`
- Review disposition: 2 emitted/admitted criticals, 2 surviving criticals, 0 refuted criticals, 10 advisories.
- Dry run: false.

Only canonical `result.json` supplies remediation authority. Root causes, invariants, sibling accounting, and Historical RED statements below are `DECLARED`; only a later registered remediation runner may fresh-observe repaired checks.

## Exact frozen review scope

```text
.claude/plans/2026-09-08-pr46-correctness-closure.md
.claude/plans/2026-09-12-pr-remediation-2.md
.claude/plans/2026-09-12-pr-remediation-3.md
.claude/plans/2026-09-12-pr-remediation.md
.claude/plans/2026-09-13-pr-remediation-4.md
.claude/plans/2026-09-13-pr-remediation-5.md
.claude/plans/2026-09-13-pr-remediation-6.md
.claude/plans/2026-09-13-pr-remediation-7.md
.gitignore
.loom/verification-manifest.json
CONTEXT.md
docs/adr/0086-root-owned-mapped-child-execution.md
docs/adr/README.md
docs/features.md
docs/plans/2026-09-06-f1-runtime-width-fanout.md
docs/requirements.md
packages/framework/docs/llm-dag-authoring.md
packages/framework/src/__tests__/build-described-dag.test.ts
packages/framework/src/__tests__/build-input.test.ts
packages/framework/src/__tests__/cli/authored-map.test.ts
packages/framework/src/__tests__/cli/authored.test.ts
packages/framework/src/__tests__/cli/compose.test.ts
packages/framework/src/__tests__/validate-dag.test.ts
packages/framework/src/cli/authored-codegen.ts
packages/framework/src/cli/authored.ts
packages/framework/src/cli/compose.ts
packages/framework/src/cli/identifiers.ts
packages/framework/src/cli/visualize.ts
packages/framework/src/dag-runtime/topology.ts
packages/framework/src/describe/build-described-dag.ts
packages/framework/src/describe/index.ts
packages/framework/src/nodes/index.ts
packages/framework/src/nodes/map.ts
packages/framework/src/shared/build-input.ts
packages/framework/src/shared/validate-dag.ts
packages/framework/src/types/dag.ts
packages/framework/src/types/ids.ts
```

The plan and `packages/framework/src/dag-runtime/run-mapped-fan.ts` are the anticipated remediation support paths outside that frozen scope. Operator-owned `.loom/verification-manifest.json` remains protected and unchanged; it is review scope, never a remediation sibling.

## Surviving critical dispositions

| Finding ID | Disposition | Declared repair group |
| --- | --- | --- |
| `code-reviewer-1` | repaired | `group.separate-collected-item-schema` |
| `silent-failure-hunter-1` | repaired | `group.total-compose-failure-formatting` |

## Declared repair groups

### `group.separate-collected-item-schema`

Findings: `code-reviewer-1`.

**DECLARED root cause.** `createCollectMapNode` used `childOutputSchema` for two different domains: parsing raw child/checkpoint outputs into `ChildOut`, then parsing already-produced `ChildOut` values inside the root collect output. A coercing, preprocessing, defaulting, or transforming schema is not generally closed or idempotent over its parsed output.

**DECLARED invariant.** Fresh child DAG results and replayed fan completions are each parsed exactly once by `childOutputSchema`: fan persistence retains the child DAG result before this map-level adaptation. Already-parsed gather values and root collect checkpoints are parsed by a separately supplied `collectedItemSchema`. The derived keyed output schema remains the sole owner of frozen null-prototype reconstruction, and authored codegen explicitly supplies both schema roles.

**Sibling accounting.**

| Path | Status | Reason |
| --- | --- | --- |
| `packages/framework/src/nodes/map.ts` | repaired | Give collect construction distinct raw-child and collected-item schemas; derive the keyed output from the latter. |
| `packages/framework/src/types/dag.ts` | checked-unmodified | Runtime mapping needs only the raw-child parser; the collected-item parser is captured inside the constructor-owned output schema and its identity is already bound through that output schema. |
| `packages/framework/src/dag-runtime/run-mapped-fan.ts` | repaired | Persist the child DAG result after successful map-level parsing, rather than persisting the adapted value and adapting it again on replay. |
| `packages/framework/src/cli/authored-codegen.ts` | repaired | Closed authored collect generation supplies its known structural child schema in both explicit roles. |
| `packages/framework/src/__tests__/cli/authored-map.test.ts` | repaired | Pin transforming child parsing, final gather, root replay validation/hardening, capture, and generated constructor wiring through the registered check. |
| `packages/framework/docs/llm-dag-authoring.md` | repaired | Document the two schema roles and transform-safe direct API contract. |
| `docs/adr/0086-root-owned-mapped-child-execution.md` | repaired | Record the pre-adaptation fan-completion representation and parse-once replay rule. |
| `docs/features.md` | repaired | Correct the collect output shape and explain separate raw/parsed schema responsibilities. |
| `docs/requirements.md` | repaired | Record the parse-once collect requirement. |
| `CONTEXT.md` | repaired | Make raw child output parsing and parsed gather validation distinct ubiquitous-language concepts. |

Selected check: `project:authored-map-regression`.

**DECLARED Historical RED.** On reviewed commit `68d31ffa`, a child returning `"1"` with `childOutputSchema: z.string().transform(Number)` is parsed to `1` by mapped execution, then the derived `z.array(childOutputSchema)` reparses `1` as a string input and public `runDag` returns output-validation failure instead of `{ results: [1] }`. Reference: review run `20260913T130100Z-pr48-review-8`, finding `code-reviewer-1`, plus `/tmp/pr48-review8-repro.ts` executed with Bun 1.4.2.

### `group.total-compose-failure-formatting`

Findings: `silent-failure-hunter-1`.

**DECLARED root cause.** Two compose environment-failure catches bypassed the existing total unknown-error helpers and directly used `instanceof`, property reads, and `String(e)`, allowing diagnostic formatting to replace the primary gauntlet or writer failure with a second throw.

**DECLARED invariant.** Every caught compose collaborator failure is rendered only through one total helper (`safeErrorStack` then `safeErrorMessage`), so arbitrary JavaScript rejection values always settle in the promised typed outcome and preserve the current draft.

**Sibling accounting.**

| Path | Status | Reason |
| --- | --- | --- |
| `packages/framework/src/cli/compose.ts` | repaired | Reuse one total diagnostic renderer at LLM, gauntlet, and scaffold-writer catches. |
| `packages/framework/src/types/safe-error.ts` | checked-unmodified | Existing helpers already contain hostile getters, proxies, coercion, and stack inspection. |
| `packages/framework/src/__tests__/cli/authored-map.test.ts` | repaired | The registered suite exercises complete `runCompose` gauntlet failures with null-prototype and revoked-proxy rejection values and asserts draft-preserving typed outcomes. |
| `packages/framework/src/__tests__/cli/compose.test.ts` | checked-unmodified | Existing ordinary Error coverage continues to pin stack preservation; the hostile-value regression lives in the registered check. |
| `CONTEXT.md` | repaired | Clarify that compose collaborator failures also obey the Result/no-throw boundary. |

Selected check: `project:authored-map-regression`.

**DECLARED Historical RED.** On reviewed commit `68d31ffa`, a valid draft reaching an injected gauntlet that throws `Object.create(null)` reaches the catch, `String(e)` throws `TypeError: Cannot convert object to primitive value`, and `runCompose` rejects rather than returning `gauntlet-failed` with the draft. Reference: review run `20260913T130100Z-pr48-review-8`, finding `silent-failure-hunter-1`, plus `/tmp/pr48-review8-repro.ts` executed with Bun 1.4.2.

## Advisory dispositions

| Advisory ID | Disposition | Reason / accepted work |
| --- | --- | --- |
| `silent-failure-hunter-2` | deferred | The sink failure is real but the current best-effort `DescribedDag` Result has no second diagnostic channel after the sole warning sink fails. Returning warning-delivery state requires a public describe contract redesign; emitting ambient console output would violate dependency injection and library locality. |
| `pr-test-analyzer-1` | accepted | Body-implement and publicly execute all five generated inline child topologies, asserting exact ordered gathered outputs. |
| `pr-test-analyzer-2` | accepted | Make fan-source and fan-branch map results observable through consuming joins and assert exact values/order rather than only `execution.ok`. |
| `comment-analyzer-1` | accepted | Qualify the typed width guarantee to literal keys and document runtime checking for dynamic strings/proofs. |
| `comment-analyzer-2` | accepted | Correct authored collect output from a top-level array to a keyed frozen null-prototype object. |
| `comment-analyzer-3` | accepted | Rewrite the build-input test header/name around total incoming-source cardinality. |
| `comment-analyzer-4` | accepted | Name the actual ID domains sharing `ID_MAX_LENGTH`; do not claim every `Kebab` proof is bounded. |
| `architecture-tech-lead-1` | deferred | A shared immutable authored graph planner changes parser/codegen module seams and remains dedicated post-PR-C architecture work, not a focused correctness remediation. |
| `architecture-tech-lead-2` | deferred | A pure compose state machine is valuable but redesigns the complete orchestration interface and requires dedicated transition/property-test design. |
| `code-simplifier-1` | dismissed | This is not a code claim or simplification opportunity: the reviewer explicitly stopped after context paging failed and inferred no finding. |

## Refuted critical audit

None. The Refutation Panel unanimously upheld both criticals under reproduction, intent, and blast-radius lenses.

## Intended changed paths

- `.claude/plans/2026-09-13-pr-remediation-8.md`
- `CONTEXT.md`
- `docs/adr/0086-root-owned-mapped-child-execution.md`
- `docs/features.md`
- `docs/requirements.md`
- `packages/framework/docs/llm-dag-authoring.md`
- `packages/framework/src/nodes/map.ts`
- `packages/framework/src/cli/authored-codegen.ts`
- `packages/framework/src/cli/compose.ts`
- `packages/framework/src/dag-runtime/run-mapped-fan.ts`
- `packages/framework/src/__tests__/cli/authored-map.test.ts`
- `packages/framework/src/__tests__/build-input.test.ts`
- `packages/framework/src/types/ids.ts`

## Validation

Use repository-required Bun 1.4.2. Run tests last for each implementation wave.

```bash
PATH=/tmp/bun-1.4.2/bun-linux-x64:$PATH bun test \
  packages/framework/src/__tests__/cli/authored-map.test.ts \
  packages/framework/src/__tests__/cli/compose.test.ts \
  packages/framework/src/__tests__/build-input.test.ts \
  packages/framework/src/__tests__/map-runtime-composition.test.ts \
  packages/framework/src/__tests__/map-node.test.ts \
  packages/framework/src/__tests__/build-described-dag.test.ts
PATH=/tmp/bun-1.4.2/bun-linux-x64:$PATH bun run --cwd packages/framework typecheck
PATH=/tmp/bun-1.4.2/bun-linux-x64:$PATH bun run check:docs
git diff --check
```

After the final distill apply-mode pass and a green focused baseline, run canonical `bun run verify` with an authenticated Redis endpoint, then start a fresh registered remediation using only this plan as an out-of-scope support path. Commit and push only the exact Loom-installed verified index.
