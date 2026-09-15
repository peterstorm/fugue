# PR #48 remediation 6 — identifier proofs and collect-output schema fidelity

## Authority

- Branch: `feat/f1-authored-map`
- Reviewed HEAD: `4d30e4aac39f768b12b4bc47f2de339101e46c1b`
- Review run: `.claude/reviews/review-and-fix-runs/20260913T094527Z-pr48-review-6`
- Canonical result digest: `b2039259dd31020082655baef12c3db7e628d391847dde1799f80182a72f87a3`
- Mode: `all`, `dryRun: false`
- Refutation: all four admitted criticals survived unanimous reproduction, intent, and security review; no critical was refuted.

## Exact frozen review scope

- `.claude/plans/2026-09-08-pr46-correctness-closure.md`
- `.claude/plans/2026-09-12-pr-remediation.md`
- `.claude/plans/2026-09-12-pr-remediation-2.md`
- `.claude/plans/2026-09-12-pr-remediation-3.md`
- `.claude/plans/2026-09-13-pr-remediation-4.md`
- `.claude/plans/2026-09-13-pr-remediation-5.md`
- `.gitignore`
- `.loom/verification-manifest.json`
- `CONTEXT.md`
- `docs/adr/0086-root-owned-mapped-child-execution.md`
- `docs/adr/README.md`
- `docs/features.md`
- `docs/plans/2026-09-06-f1-runtime-width-fanout.md`
- `docs/requirements.md`
- `packages/framework/docs/llm-dag-authoring.md`
- `packages/framework/src/__tests__/build-described-dag.test.ts`
- `packages/framework/src/__tests__/cli/authored-map.test.ts`
- `packages/framework/src/__tests__/cli/authored.test.ts`
- `packages/framework/src/__tests__/cli/compose.test.ts`
- `packages/framework/src/__tests__/validate-dag.test.ts`
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

## Surviving-critical dispositions

| Finding | Disposition | Declared Repair Group |
| --- | --- | --- |
| `code-reviewer-1` | repaired | `group.authored-runtime-identifier-domain` |
| `silent-failure-hunter-1` | repaired | `group.truthful-collect-output` |
| `type-design-analyzer-1` | repaired | `group.truthful-collect-output` |
| `comment-analyzer-1` | repaired | `group.truthful-collect-output` |

## Declared Repair Group: `group.authored-runtime-identifier-domain`

### DECLARED root cause

The authoring-only `KebabIdent` smart constructor checked lexical shape but not the runtime `DagId`/`NodeId` maximum length. The authored parser could therefore issue a branded codegen proof that downstream runtime constructors refused.

### DECLARED invariant

Every authored DAG name, child DAG id, node id, and structural node reference is a `KebabIdent` no longer than the canonical runtime identifier maximum. A successful `parseAuthoredDag` result can never fail generated module construction solely because one of those identifiers is outside the runtime `DagId`/`NodeId` domain.

### Sibling accounting

- `packages/framework/src/types/ids.ts` — **repaired**: export one canonical maximum and derive both runtime regexes from it rather than duplicating the numeric bound.
- `packages/framework/src/cli/identifiers.ts` — **repaired**: make the sole `KebabIdent` parser enforce the canonical maximum and document its low-level import.
- `packages/framework/src/cli/authored.ts` — **repaired**: diagnostics for names, ids, and references state the length bound carried by the brand.
- `packages/framework/src/__tests__/cli/authored.test.ts` — **repaired**: reject 129-character root DAG names and node ids/references while accepting the 128-character boundary and importing the generated module.
- `packages/framework/src/__tests__/cli/authored-map.test.ts` — **repaired**: reject a 129-character child DAG id and gauntlet-check the 128-character boundary.
- `packages/framework/src/__tests__/cli/new.test.ts` — **checked-unmodified**: `fugue new` already delegates its DAG name to `parseKebabIdent` and therefore inherits the repaired proof without a second validation path.
- `packages/framework/docs/llm-dag-authoring.md` — **repaired**: authored identifier rules explicitly name the shared 128-character limit.
- `CONTEXT.md` — **repaired**: AuthoredDag records identifier-domain parity as part of its parser-issued codegen proof.

### Selected check and Historical RED

- Check: `project:authored-map-regression`
- Historical RED (`DECLARED`): on reviewed HEAD `4d30e4aa`, `parseKebabIdent` accepted a 129-character lexical identifier, so `parseAuthoredDag` issued the branded DAG and generated code that threw when `nodeId`/`dagId` enforced `{1,128}` during module import.
- Reference: review run `20260913T094527Z-pr48-review-6`, finding `code-reviewer-1`.

## Declared Repair Group: `group.truthful-collect-output`

### DECLARED root cause

`createCollectMapNode` represented one collected dictionary three different ways: the reducer hardened a null-prototype record, `z.object` parsed it into a mutable ordinary object, and the TypeScript `Record` surface implicitly exposed callable `Object.prototype` members that the hardened value intentionally lacks. The constructor therefore issued mutually inconsistent runtime, schema, and static proofs.

### DECLARED invariant

One constructor-owned collected-output representation governs reduction, schema parsing, and public typing. Reduction and every successful output-schema parse return a frozen null-prototype record with a frozen result array. Each ordinary prototype-name lookup is statically and dynamically either the gathered array (when that name may be the selected field) or `undefined`; no inherited callable is exposed.

### Sibling accounting

- `packages/framework/src/nodes/map.ts` — **repaired**: encode absent/possible prototype members in `CollectedMapOutput` and transform successful schema parses back through the same null-prototype constructor used by reduction.
- `packages/framework/src/dag-runtime/run-node.ts` — **checked-unmodified**: normal execution and checkpoint replay already retain the node's parsed `outputSchema` value; the repair belongs in the collect constructor rather than a map-specific runtime exception.
- `packages/framework/src/dag-runtime/route-emission.ts` — **checked-unmodified**: conditional routing rechecks the already-hardened node result and needs no alternate reconstruction rule.
- `packages/framework/src/__tests__/cli/authored-map.test.ts` — **repaired**: pin compile-time prototype-member behavior plus reducer, direct schema parse, and public `runDag` output prototype/freeze/ordering behavior.
- `packages/framework/docs/llm-dag-authoring.md` — **repaired**: describe the schema-preserved null-prototype contract and typed prototype-name lookup.
- `CONTEXT.md` — **repaired**: sharpen Map Node language to include schema validation and final execution output, not only the reducer intermediate.

### Selected check and Historical RED

- Check: `project:authored-map-regression`
- Historical RED (`DECLARED`): on reviewed HEAD `4d30e4aa`, the reducer returned a frozen null-prototype record, but `outputSchema.parse` and normal `runDag` execution returned a mutable `Object.prototype` object whose inherited `toString` contradicted `CollectedMapOutput<string, T>`; meanwhile TypeScript also accepted callable `toString()` on the reducer's null-prototype output.
- Reference: review run `20260913T094527Z-pr48-review-6`, findings `silent-failure-hunter-1`, `type-design-analyzer-1`, and `comment-analyzer-1`.

## Advisory dispositions

### Accepted

- `silent-failure-hunter-2` — add exhaustive defaults to child and root authored-node emission switches; this is local and makes new node variants compile-fail at every emitter.
- `pr-test-analyzer-1` — replace the discriminator-only nested-map negative with a structurally complete nested map and assert the dedicated FR-F1-011 refusal.
- `pr-test-analyzer-2` — execute a generated body-implemented map through public `runDag` with an in-memory checkpointer and multiple ordered items; this also observes the final collect schema boundary.
- `pr-test-analyzer-3` — add a positive map-then-root-human-review parse/generate/describe regression for the documented gather-first alternative.
- `type-design-analyzer-2` — reject every supplied map `isSource` value other than `false`, not only `true`, before issuing `DagDef`.
- `comment-analyzer-2` — narrow durable fan language to successfully acknowledged indices and retain the unacknowledged-effect replay caveat.
- `comment-analyzer-3` — narrow the Result/no-throw checklist statement to operational Result-returning APIs, preserving documented throwing construction gateways.
- `comment-analyzer-4` — describe generated identifier accounting as a conservative reservation superset and name map ordinary-const reservation explicitly.

### Deferred

- `silent-failure-hunter-3` — distinguishing hostile programmatic input accessor failures from internal Zod/freezing defects requires a new public parse-failure ADT and compose transition semantics; the current boundary remains total and this taxonomy redesign is not needed for either surviving repair group.
- `architecture-tech-lead-1` — a shared authored-graph planning interface would redesign validation/codegen seams across all five topologies; defer to a dedicated deepening after PR-C rather than mix a broad module migration into two boundary repairs.
- `architecture-tech-lead-2` — a pure compose reducer changes the workflow interface and all effect seams; defer to a dedicated compose architecture change with property tests.
- `code-simplifier-1` — a discriminated/wired `NodePlan` is an interface/state-space redesign coupled to the shared authored planner; defer with `architecture-tech-lead-1` rather than partially migrate plan states.
- `code-simplifier-2` — consolidating child/root topology wiring is the same cross-topology planning deepening and risks formatting/integrity drift; defer to the shared planner work while retaining focused exhaustive switches now.

### Dismissed

None.

## Refuted-finding audit

No critical finding was refuted. Reproduction, intent, and security panel members unanimously upheld all four admitted criticals.

## Intended changed paths

- `.claude/plans/2026-09-13-pr-remediation-6.md`
- `CONTEXT.md`
- `docs/features.md`
- `packages/framework/docs/llm-dag-authoring.md`
- `packages/framework/src/types/ids.ts`
- `packages/framework/src/cli/identifiers.ts`
- `packages/framework/src/cli/authored.ts`
- `packages/framework/src/cli/authored-codegen.ts`
- `packages/framework/src/nodes/map.ts`
- `packages/framework/src/shared/validate-dag.ts`
- `packages/framework/src/__tests__/cli/authored.test.ts`
- `packages/framework/src/__tests__/cli/authored-map.test.ts`

`packages/framework/src/types/ids.ts` and this plan are remediation support paths outside the frozen review scope. No protected authority/evidence path is a remediation sibling.

## Validation

Development evidence (not P3 authority):

1. `bun test packages/framework/src/__tests__/cli/authored-map.test.ts packages/framework/src/__tests__/cli/authored.test.ts packages/framework/src/__tests__/validate-dag.test.ts packages/framework/src/__tests__/map-runtime-composition.test.ts`
2. `bun run --cwd packages/framework typecheck`
3. `bun run verify` with an authenticated Redis endpoint
4. `bun run check:docs`
5. `git diff --check`

Registered P3 observation:

- `project:authored-map-regression` must freshly produce its configured required JUnit report with more than zero tests and zero failures.
