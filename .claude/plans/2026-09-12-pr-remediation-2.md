# PR #48 remediation — review round 2

**Date:** 2026-09-12
**Branch:** `feat/f1-authored-map`
**Reviewed HEAD:** `cdbeb481f9eb2075c3b247cf9cc014e77807344d`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/20260912T172332Z-pr48-review-2`
**Canonical result digest:** `2383a836398132a5bbf58b661cec27986edaf63c2c181067d88593731c93c7ff`

## Frozen review scope

- `.claude/plans/2026-09-08-pr46-correctness-closure.md`
- `.claude/plans/2026-09-12-pr-remediation.md`
- `.gitignore`
- `.loom/verification-manifest.json`
- `CONTEXT.md`
- `docs/adr/0086-root-owned-mapped-child-execution.md`
- `docs/adr/README.md`
- `docs/features.md`
- `docs/plans/2026-09-06-f1-runtime-width-fanout.md`
- `docs/requirements.md`
- `packages/framework/docs/llm-dag-authoring.md`
- `packages/framework/src/__tests__/cli/authored-map.test.ts`
- `packages/framework/src/__tests__/cli/authored.test.ts`
- `packages/framework/src/cli/authored-codegen.ts`
- `packages/framework/src/cli/authored.ts`
- `packages/framework/src/cli/compose.ts`
- `packages/framework/src/cli/identifiers.ts`
- `packages/framework/src/cli/visualize.ts`
- `packages/framework/src/describe/build-described-dag.ts`
- `packages/framework/src/describe/index.ts`
- `packages/framework/src/nodes/index.ts`
- `packages/framework/src/nodes/map.ts`
- `packages/framework/src/shared/validate-dag.ts`
- `packages/framework/src/types/dag.ts`

## Canonical adjudication

The registered review emitted/admitted 6 critical and 20 advisory findings. The three-lens Refutation Panel retained all 6 critical findings and refuted none.

## Surviving-critical dispositions

| Finding | Disposition | Declared Repair Group |
|---|---|---|
| `code-reviewer-1` | repaired | `group.collect-provenance-binding` |
| `silent-failure-hunter-1` | repaired | `group.collect-provenance-binding` |
| `pr-test-analyzer-1` | repaired | `group.collect-provenance-binding` |
| `code-reviewer-2` | repaired | `group.authored-dag-immutability` |
| `type-design-analyzer-1` | repaired | `group.authored-dag-immutability` |
| `type-design-analyzer-2` | repaired | `group.collect-output-key-type` |

## Declared Repair Groups

All grouping, root causes, invariants, sibling accounting, and Historical RED statements below have `DECLARED` provenance. Only the registered remediation runner may produce `ENGINE_OBSERVED` repaired-check evidence.

### `group.collect-provenance-binding`

**Finding IDs:** `code-reviewer-1`, `silent-failure-hunter-1`, `pr-test-analyzer-1`

**Root cause:** The private-symbol token authenticated only its own origin. It did not bind that token to the exact reducer, output schema, and child-output schema issued by `createCollectMapNode`, so copying the token transferred descriptive authority.

**Invariant:** Authored collect metadata survives DAG validation only when its token is presented with the exact constructor-issued reducer, output schema, and child-output schema identities. Cloned or transplanted tokens fail closed.

**Sibling accounting:**

- `packages/framework/src/types/dag.ts` — repaired: issue and verify identity-bound collect provenance through one complete predicate.
- `packages/framework/src/nodes/map.ts` — repaired: bind each token to the exact collect schema/reducer triple at construction.
- `packages/framework/src/shared/validate-dag.ts` — repaired: validate the complete binding before preserving metadata.
- `packages/framework/src/__tests__/cli/authored-map.test.ts` — repaired: exercise transplanted metadata through `defineDag`/describe and prove rejection.

**Selected check:** `project:authored-map-regression`

**Historical RED:** On reviewed HEAD `cdbeb481`, copying `authoredGather` from a legitimate collect map onto a custom reducer/output schema passed `defineDag` and caused describe output to claim false collect semantics (review findings `code-reviewer-1`, `silent-failure-hunter-1`, and `pr-test-analyzer-1`).

### `group.authored-dag-immutability`

**Finding IDs:** `code-reviewer-2`, `type-design-analyzer-1`

**Root cause:** Zod branding established validation provenance but the parsed object graph and its inferred public type remained mutable, allowing callers to invalidate the proof after parsing.

**Invariant:** Successful authoring parse returns an owned, recursively frozen, deeply readonly `AuthoredDag`; no type-correct or runtime mutation can change any validated field before code generation.

**Sibling accounting:**

- `packages/framework/src/cli/authored.ts` — repaired: recursively freeze the owned parse result and expose deep-readonly authoring types.
- `packages/framework/src/__tests__/cli/authored-map.test.ts` — repaired: prove nested map/child mutation resistance and stable code generation.
- `packages/framework/src/__tests__/cli/authored.test.ts` — repaired: prove recursive parser-owned freezing while caller-owned raw input stays independently mutable.

**Selected check:** `project:authored-map-regression`

**Historical RED:** On reviewed HEAD `cdbeb481`, assignments to `maxWidth` or `widthFrom` remained type-correct after parsing and caused late generated-module failure or an invariant throw (review findings `code-reviewer-2` and `type-design-analyzer-1`).

### `group.collect-output-key-type`

**Finding ID:** `type-design-analyzer-2`

**Root cause:** `CollectedMapOutput` mapped every member of `Field` into one object, while the reducer emits one runtime-selected key.

**Invariant:** A literal field produces one required-key object, a union field produces a union of one-key objects, and a widened string field exposes possibly-absent keys.

**Sibling accounting:**

- `packages/framework/src/nodes/map.ts` — repaired: make output typing distributive for unions and optional for widened strings.
- `packages/framework/src/__tests__/cli/authored-map.test.ts` — repaired: cover literal, union, widened, empty, and ordered multi-item collect behavior.

**Selected check:** `project:authored-map-regression`

**Historical RED:** On reviewed HEAD `cdbeb481`, `CollectedMapOutput<"left" | "right", T>` required both keys and `CollectedMapOutput<string, T>` promised an array at every key although runtime creates only one (review finding `type-design-analyzer-2`).

## Advisory dispositions

### Accepted

- `pr-test-analyzer-2` — add empty and ordered multi-item reducer/output-schema behavior tests; this directly protects the public collect constructor.
- `type-design-analyzer-3` — bind collect provenance to the complete descriptor identities; subsumed by `group.collect-provenance-binding` without placing the advisory in that critical group.
- `type-design-analyzer-4` — canonicalize recursive schema field order before mapped-router terminal comparison; equivalent object schemas must compare by meaning, not source order.
- `comment-analyzer-1` — correct the authored node-union comment to name both output-omitting variants.
- `comment-analyzer-2` — replace obsolete superset notation with the actual generation/description relationship.
- `comment-analyzer-3` — describe assembly as deterministic with an optional diagnostic callback, not pure.
- `comment-analyzer-4` — document actual edge shape/normalization/membership ordering.
- `comment-analyzer-5` — attach the soundness-gate JSDoc directly to `validateDagShape`.
- `comment-analyzer-6` — attach round-budget JSDoc directly to `requireRoundBudget`.
- `comment-analyzer-7` — centralize child-local generated names rather than narrowing the ownership claim.
- `comment-analyzer-8` — centralize child-local generated names in `identifiers.ts`, restoring the documented ownership boundary.
- `comment-analyzer-9` — document LLM factory, map factory, and ordinary const reference branches.
- `comment-analyzer-10` — document map factories and conservative LLM collision accounting.
- `architecture-tech-lead-1` — issue an owned recursively immutable `AuthoredDag`; subsumed by `group.authored-dag-immutability` without placing the advisory in that critical group.
- `architecture-tech-lead-2` — move child-local naming policy into `identifiers.ts`; this is a bounded, practical recurrence prevention for the prior collision family.
- `code-simplifier-1` — make one provenance predicate prove marker shape and exact binding.
- `code-simplifier-3` — use one pure structure-order helper for child and root transforms.
- `code-simplifier-4` — flatten `nodeRefName` into guard returns.
- `code-simplifier-5` — retain one complete integrity coupling contract and shorten `stampGenerated` documentation.

### Deferred

- `code-simplifier-2` — discriminating the complete `NodePlan`/wired-plan state changes the internal planning interface across all five topology emitters. It is sound follow-up deepening, but broad and unnecessary to repair this round's concrete correctness defects.

### Dismissed

None.

## Refuted-critical audit

None. The panel upheld all six critical findings through the reproduction and intent lenses; the security lens was uncertain and therefore neutral.

## Implementation and validation

1. Bind collect metadata to exact constructor-owned schema/reducer identities and reject transplanted metadata at DAG validation.
2. Return an owned deeply frozen/read-only `AuthoredDag` from both parse entry points.
3. Correct collect output typing for literal, union, and widened field types.
4. Apply accepted router, identifier-policy, ordering, comment, and test improvements.
5. Run focused authored-map/authored/validation/describe tests and framework typecheck.
6. Run `bun run verify` with Bun 1.4.2 and password-authenticated Redis.
7. Run registered remediation with `project:authored-map-regression`; only Loom may install the verified index.
