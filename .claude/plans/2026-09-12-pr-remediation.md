# PR #48 Review-and-Fix Remediation Plan

**Date:** 2026-09-12
**Branch:** `feat/f1-authored-map`
**Reviewed HEAD:** `00bfd550ffa403e567a29d6597998edcc907f0c3`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/20260912T155318Z-pr48-review`
**Canonical result digest:** `0e8b3655f40580817dcb44f1c3a887a2372cf18d26b1fa57257c92f17631fa8c`

## Frozen Review Scope

- `.claude/plans/2026-09-08-pr46-correctness-closure.md`
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
- `packages/framework/src/nodes/map.ts`
- `packages/framework/src/shared/validate-dag.ts`
- `packages/framework/src/types/dag.ts`

Support paths outside this frozen scope are this plan and
`packages/framework/src/nodes/index.ts`, whose public barrel must expose the
accepted honest collect constructor.

## Adjudication Summary

The registered review emitted and admitted 8 critical and 12 advisory findings.
The registered three-lens Refutation Panel upheld all 8 critical findings; none
were refuted. The eight criticals describe two defect families: one structured
prompt-value serialization defect and seven reports/evidence views of one child
lexical-scope isolation defect.

## Surviving-Critical Dispositions

Every canonical Finding ID appears exactly once below.

| Finding ID | Disposition | Declared Repair Group |
|---|---|---|
| `code-reviewer-1` | repaired | `group.structured-prompt-values` |
| `code-reviewer-2` | repaired | `group.map-child-lexical-scope` |
| `silent-failure-hunter-1` | repaired | `group.map-child-lexical-scope` |
| `pr-test-analyzer-1` | repaired | `group.map-child-lexical-scope` |
| `pr-test-analyzer-2` | repaired | `group.map-child-lexical-scope` |
| `type-design-analyzer-1` | repaired | `group.map-child-lexical-scope` |
| `architecture-tech-lead-1` | repaired | `group.map-child-lexical-scope` |
| `code-simplifier-1` | repaired | `group.map-child-lexical-scope` |

There are no unresolved or out-of-scope critical dispositions.

## Declared Repair Groups

### `group.structured-prompt-values`

- **Finding IDs:** `code-reviewer-1`
- **Root cause — DECLARED:** The shared non-fan-in LLM input emitter interpolates
  every direct field as a scalar even though recursive authored field schemas now
  admit arrays of objects. JavaScript string coercion therefore erases structured
  values as `[object Object]`.
- **Invariant — DECLARED:** Every generated prompt variable preserves its authored
  value: scalar fields remain scalar interpolation values and array/object fields
  are deterministically JSON-serialized before interpolation, for both root and
  mapped-child LLMs.
- **Sibling accounting — DECLARED:**
  - `packages/framework/src/cli/authored-codegen.ts` — **repaired**: audit the one
    shared LLM-input planning/emission path for direct and fan-in inputs; retain
    existing JSON serialization for fan-in values and add schema-directed
    serialization for structured direct fields.
  - `packages/framework/src/__tests__/cli/authored-map.test.ts` — **repaired**:
    add a real generated-prompt regression for map-to-LLM and child-item array
    input, asserting record content rather than generated source alone.
- **Selected fixed check:** `project:verify`
- **Historical RED — DECLARED:** Against reviewed HEAD `00bfd550`, a generated
  non-fan-in LLM prompt receiving `[{"recordId":"r-1","score":0.92}]` renders
  `[object Object]` and loses the records.
- **Historical RED reference — DECLARED:** canonical Finding `code-reviewer-1` in
  review run `20260912T155318Z-pr48-review`.

### `group.map-child-lexical-scope`

- **Finding IDs:** `code-reviewer-2`, `silent-failure-hunter-1`,
  `pr-test-analyzer-1`, `pr-test-analyzer-2`, `type-design-analyzer-1`,
  `architecture-tech-lead-1`, `code-simplifier-1`
- **Root cause — DECLARED:** Child declarations are emitted in the map factory's
  lexical scope using root-style names. The parser validates the child in an
  isolated authored namespace, but codegen does not represent its enclosing
  generated bindings, so child variables/schemas can shadow the factory model
  parameter and outer input/output schema references.
- **Invariant — DECLARED:** All generated child-local bindings live in a
  deterministic codegen-only namespace that authored identifiers cannot produce;
  accepted parent/child identifier equality and a child named `model` cannot
  shadow factory parameters, imports, or outer schema references.
- **Sibling accounting — DECLARED:**
  - `packages/framework/src/cli/authored-codegen.ts` — **repaired**: use one
    child-local naming projection consistently for schemas, node bindings, LLM
    factories, structure references, and the model parameter.
  - `packages/framework/src/cli/identifiers.ts` — **checked-unmodified**: retain
    the existing authored-identifier domain; codegen lexical isolation, rather
    than rejecting otherwise valid domain names, closes every enclosing-scope
    collision.
  - `packages/framework/src/__tests__/cli/authored-map.test.ts` — **repaired**:
    add real-gauntlet regressions for mixed `model`/LLM children and equal or
    colliding parent/child schema names, including exact described map output and
    valid predecessor input-schema acceptance.
- **Selected fixed check:** `project:verify`
- **Historical RED — DECLARED:** Against reviewed HEAD `00bfd550`, a mixed child
  with ordinary node `model` and an LLM fails generated-module import with a
  duplicate binding; parent/child schema-name collisions can instead pass the
  gauntlet while changing the generated map input or output schema.
- **Historical RED reference — DECLARED:** canonical Findings `code-reviewer-2`,
  `silent-failure-hunter-1`, `pr-test-analyzer-1`, `pr-test-analyzer-2`,
  `type-design-analyzer-1`, `architecture-tech-lead-1`, and
  `code-simplifier-1` in review run `20260912T155318Z-pr48-review`.

## Advisory Dispositions

| Advisory ID | Disposition | Reason / accepted fix |
|---|---|---|
| `code-reviewer-3` | accepted | FR-F1-011 explicitly requires actionable gather-then-review guidance. Add a targeted child-HITL parse diagnostic and regression. |
| `type-design-analyzer-2` | accepted | The public `authoredGather` field can lie about an arbitrary reducer. Replace caller-asserted provenance with an honest collect-map constructor that owns the derived schema, reducer, and describe metadata. |
| `comment-analyzer-1` | accepted | Correct the module comment: `AuthoredDag` is a complementary authoring representation, not a structural superset of `DescribedDag`. |
| `comment-analyzer-2` | accepted | Update the stale predicate result example to `{ outcome: "below-min-confidence" }`. |
| `comment-analyzer-3` | accepted | State that `validateDagShape` is the `DagDef` issuer and public constructors delegate to that gate. |
| `comment-analyzer-4` | accepted | Narrow the snapshot claim to captured references and explicitly exclude mutable implementation/closure state. |
| `comment-analyzer-5` | accepted | Document that loaded and introspected prompt names are unioned. |
| `comment-analyzer-6` | accepted | Include fixed authored collect reducers in the `ok(...)` import-gating comment. |
| `comment-analyzer-7` | accepted | Narrow FR-F1-010 to the real guarantee: authored JSON accepts/evaluates no supplied expression or reducer source. |
| `architecture-tech-lead-2` | deferred | The claim is sound, but a shared immutable planner would redesign validation/codegen interfaces across every authored topology. The two blocking drifts have bounded fixes and regressions; doing the larger seam move inside this remediation would materially widen risk. Revisit as a dedicated authored-graph deepening after PR-C. |
| `architecture-tech-lead-3` | deferred | The compose state-machine concern is pre-existing and the PR changes only its author guidance. Extracting a pure transition protocol is a broad interface redesign unrelated to the admitted PR-C failures; schedule a dedicated compose deepening with its own state-transition properties. |
| `code-simplifier-2` | accepted | Generalize the existing pure router validator with an output-spec resolver and use it for root and child routers while preserving diagnostics. |

No advisory is dismissed.

## Refuted-Critical Audit

`result.json.refuted_critical_findings` is empty. The panel upheld each critical
under reproduction, intent, and security lenses, so there is no refuted finding
to repair or omit from reporting.

## Implementation Order

1. Add Historical RED regression cases for structured prompt input and both
   lexical-shadowing modes.
2. Introduce deterministic child-local generated names and use them through all
   child schema/node/factory/structure references.
3. Make direct LLM prompt variables schema-aware and JSON-serialize structured
   fields.
4. Replace caller-asserted gather metadata with an honest collect-map constructor.
5. Apply the child-HITL diagnostic, router-validator consolidation, and accepted
   comment/requirement corrections.
6. Run the focused suites and framework typecheck, then a distill apply pass.
7. Run the canonical repository verification command before registered
   remediation.

## Validation Commands

Development validation:

```bash
bun test packages/framework/src/__tests__/cli/authored-map.test.ts \
  packages/framework/src/__tests__/cli/authored.test.ts \
  packages/framework/src/__tests__/cli/visualize.test.ts \
  packages/framework/src/__tests__/mapped-describe-capabilities.test.ts
(cd packages/framework && bun run typecheck)
bun run check:docs
git diff --check
```

Canonical validation and selected registered check:

```bash
bun run verify
```

The canonical command must run with the repository's required Bun 1.4.2 and a
password-authenticated Redis URL. These commands are development evidence only;
the later registered remediation run must freshly observe `project:verify` and
its required report before installing the verified index.
