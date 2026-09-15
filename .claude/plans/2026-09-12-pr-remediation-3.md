# PR #48 Remediation Plan — Review 3

## Authority

- Branch: `feat/f1-authored-map`
- Reviewed HEAD: `6723007f03e61773554c416c2c7a06f725009920`
- Review run: `.claude/reviews/review-and-fix-runs/20260912T191201Z-pr48-review-3`
- Canonical result digest: `988f0e9682ba103396600af15107a77023f47ca54d52925e42271ce5783f1543`
- Emitted/admitted: 5 critical, 20 advisory
- After refutation: 5 surviving critical, 0 refuted critical, 20 advisory

## Exact frozen review scope

- `.claude/plans/2026-09-08-pr46-correctness-closure.md`
- `.claude/plans/2026-09-12-pr-remediation-2.md`
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

## Surviving critical dispositions and Declared Repair Groups

### `group.atomic-collect-construction`

- Finding `code-reviewer-1`: **repaired** by this group.
- DECLARED root cause: `createCollectMapNode` reread the accessor-backed `childOutputSchema` separately while deriving the output schema, mapping descriptor, and provenance binding.
- DECLARED invariant: every collect constructor input reference is captured once, and the exact captured child schema derives output validation, mapping validation, and provenance.
- Siblings:
  - `packages/framework/src/nodes/map.ts` — repaired: capture the child schema once before issuing the coupled collect values.
  - `packages/framework/src/__tests__/cli/authored-map.test.ts` — repaired: a stateful-accessor regression proves one read and truthful reducer output.
- Selected fixed check: `project:authored-map-regression`.
- DECLARED Historical RED: on reviewed HEAD, a stateful child-schema accessor was read three times and yielded a `defineDag`-accepted collect node whose reducer output failed its own output schema. Reference: review-3 `code-reviewer-1`.

### `group.total-authored-parse`

- Finding `silent-failure-hunter-1`: **repaired** by this group.
- DECLARED root cause: recursive Zod parsing and recursive freezing had no pre-parse depth bound or exception-to-result boundary.
- DECLARED invariant: every authored wire value either produces a deeply frozen `AuthoredDag` or a bounded `AuthoredParseResult`; no schema-invalid draft escapes compose through an exception.
- Siblings:
  - `packages/framework/src/cli/authored.ts` — repaired: iteratively reject over-deep/cyclic values and fold parser exceptions into structured problems.
  - `packages/framework/src/cli/compose.ts` — repaired: safely render untrusted invalid drafts in repair prompts so serialization cannot bypass the outcome protocol.
  - `packages/framework/src/__tests__/cli/authored-map.test.ts` — repaired: deep authored values return problems, and a deep refinement enters bounded repair while retaining prior work.
  - `packages/framework/docs/llm-dag-authoring.md` — repaired: document the bounded recursive authoring depth.
- Selected fixed check: `project:authored-map-regression`.
- DECLARED Historical RED: on reviewed HEAD, a deeply recursive schema-invalid refinement threw `RangeError` from `parseAuthoredDag`, rejected `runCompose`, and bypassed last-proven-draft preservation. Reference: review-3 `silent-failure-hunter-1`.

### `group.total-dag-identifiers`

- Finding `silent-failure-hunter-2`: **repaired** by this group.
- DECLARED root cause: `validateDagShape` normalized raw DAG, output, and edge identifiers with throwing smart constructors before establishing their parse proofs.
- DECLARED invariant: every raw identifier is parsed through a Result-returning constructor before normalization; malformed DAG IDs, output IDs, and edge endpoints return `Err<FrameworkError>` and never throw.
- Siblings:
  - `packages/framework/src/shared/validate-dag.ts` — repaired: parse and retain branded identifiers once before all downstream validation/snapshotting.
  - `packages/framework/src/__tests__/cli/authored-map.test.ts` — repaired: malformed DAG/output/from/to identifiers all return typed validation errors without throwing.
- Selected fixed check: `project:authored-map-regression`.
- DECLARED Historical RED: on reviewed HEAD, malformed DAG IDs, output IDs, and edge endpoints escaped `validateDagShape` as raw smart-constructor exceptions. Reference: review-3 `silent-failure-hunter-2`.

### `group.registered-static-contract-check`

- Finding `pr-test-analyzer-1`: **repaired** by this group.
- DECLARED root cause: the registered Bun test command transpiled but did not compile the dormant `@ts-expect-error` and assignment contracts in its target test file.
- DECLARED invariant: the registered authored-map test executes the framework TypeScript compiler as an asserted testcase, so a static contract regression makes its required JUnit report fail.
- Siblings:
  - `.loom/verification-manifest.json` — checked-unmodified: its registered command continues to own/reset/write the required JUnit report; the target test now includes the compiler gate.
  - `packages/framework/src/__tests__/cli/authored-map.test.ts` — repaired: invoke the repository compiler and surface its complete output on failure.
- Selected fixed check: `project:authored-map-regression`.
- DECLARED Historical RED: on reviewed HEAD, the registered command could pass after a type-only regression because Bun stripped the unexecuted static assertions. Reference: review-3 `pr-test-analyzer-1`.

### `group.finite-collect-key-domain`

- Finding `type-design-analyzer-1`: **repaired** by this group.
- DECLARED root cause: `CollectedMapOutput` distinguished only exact `string` from literals, misclassifying infinite template-literal domains as finite required-key records.
- DECLARED invariant: finite literal members produce one required-key output arm; every infinite string domain, including template-literal patterns, exposes matching keys as potentially absent.
- Siblings:
  - `packages/framework/src/nodes/map.ts` — repaired: classify each distributive field member by whether an empty object can satisfy its key domain.
  - `packages/framework/src/__tests__/cli/authored-map.test.ts` — repaired: compiler assertions cover literal unions, exact string, and template-literal key domains.
- Selected fixed check: `project:authored-map-regression`.
- DECLARED Historical RED: on reviewed HEAD, `CollectedMapOutput<\`results_${string}\`, T>` let callers read an absent matching key as a definitely present array. Reference: review-3 `type-design-analyzer-1`.

## Advisory dispositions

### Accepted

- `code-reviewer-2`: the parse-depth defect shares `group.total-authored-parse`; add a supported bound and structured refusal.
- `silent-failure-hunter-4`: preserve complete structured mapped-child errors rather than collapsing non-validation variants.
- `silent-failure-hunter-5`: reject unsafe round budgets with `Number.isSafeInteger`.
- `pr-test-analyzer-2`: independently mismatch output schema, child schema, and reducer provenance identities.
- `pr-test-analyzer-3`: cover recursively reordered fields inside array element schemas.
- `pr-test-analyzer-4`: pin `Number.MAX_SAFE_INTEGER` acceptance and the unsafe successor rejection.
- `comment-analyzer-1`: move edge-normalization JSDoc to `normalizeEdge`.
- `comment-analyzer-2`: describe the actual shared schema-parser uses, excluding gathers.
- `comment-analyzer-3`: correct round-budget commentary alongside the safe-integer repair.
- `comment-analyzer-4`: replace obsolete line-number citations with stable symbol names.
- `comment-analyzer-5`: narrow identifier-accounting prose to top-level emitted names; map child-local accounting remains covered in the authored-map suite.
- `architecture-tech-lead-3`: describe maps through a plain `{kind, field}` projection rather than leaking the provenance capability by identity.
- `code-simplifier-2`: replace the child LLM emitter's positional boolean with a named option.
- `code-simplifier-3`: use the already planned map reference for declaration and structure emission.
- `code-simplifier-4`: factor the shared public map execution configuration without changing either public structural interface.
- `code-simplifier-5`: centralize the explicit LLM-confidence shape rule while preserving diagnostics.

### Deferred

- `silent-failure-hunter-3`: returning secondary warning-sink failures requires changing the stable `DescribedDag`/warning interface; current best-effort contract intentionally keeps null authoritative when diagnostic delivery itself fails.
- `architecture-tech-lead-1`: a single immutable topology compiler/plan ADT is valuable but redesigns validation, prompt planning, root emission, and child emission as one larger follow-up.
- `architecture-tech-lead-2`: a pure compose state-machine/effect interpreter is valuable but is a whole-orchestrator seam redesign beyond this targeted PR-C repair.
- `code-simplifier-1`: same broad topology-plan interface redesign as `architecture-tech-lead-1`; do not partially introduce a second planning representation.

### Dismissed

- None.

## Refuted-finding audit

- None. All five admitted critical findings survived the Refutation Panel.

## Validation

Development validation:

```bash
bun run --cwd packages/framework typecheck
bun test packages/framework/src/__tests__/cli/authored-map.test.ts
bun test packages/framework/src/__tests__/cli/authored.test.ts
bun test packages/framework/src/__tests__/cli/compose.test.ts
bun test packages/framework/src/__tests__/validate-dag.test.ts
bun test packages/framework/src/__tests__/build-described-dag.test.ts
bun run check:docs
git diff --check
```

Canonical validation:

```bash
REDIS_URL=<authenticated-local-redis> bun run verify
```

Registered observation and verified-index installation use a fresh schema-v2 remediation run sourced from `20260912T191201Z-pr48-review-3`, with this plan as the sole support path and `project:authored-map-regression` selected for every repair group.
