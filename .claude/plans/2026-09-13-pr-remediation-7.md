# PR #48 remediation 7 — bounded prompt filenames and total DAG validation

## Authority

- Branch: `feat/f1-authored-map`
- Reviewed HEAD: `93124d7e65dd46d1abba5e69659e444914529910`
- Review run: `.claude/reviews/review-and-fix-runs/20260913T110131Z-pr48-review-7`
- Canonical result digest: `69d10730c606975bbe46a4c23387b72df1ff6891bb5013e06d889d180d540c9d`
- Mode: `all`, `dryRun: false`
- Refutation: all three admitted criticals survived unanimous reproduction, intent, and security review; no critical was refuted.

## Exact frozen review scope

- `.claude/plans/2026-09-08-pr46-correctness-closure.md`
- `.claude/plans/2026-09-12-pr-remediation.md`
- `.claude/plans/2026-09-12-pr-remediation-2.md`
- `.claude/plans/2026-09-12-pr-remediation-3.md`
- `.claude/plans/2026-09-13-pr-remediation-4.md`
- `.claude/plans/2026-09-13-pr-remediation-5.md`
- `.claude/plans/2026-09-13-pr-remediation-6.md`
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
- `packages/framework/src/types/ids.ts`

## Surviving-critical dispositions

| Finding | Disposition | Declared Repair Group |
| --- | --- | --- |
| `code-reviewer-1` | repaired | `group.bounded-prompt-file-identity` |
| `silent-failure-hunter-1` | repaired | `group.total-dag-validation-boundaries` |
| `silent-failure-hunter-2` | repaired | `group.total-dag-validation-boundaries` |

## Declared Repair Group: `group.bounded-prompt-file-identity`

### DECLARED root cause

Prompt identity was collision-aware only at the logical node level. Root multi-LLM names concatenated DAG and node identifiers, while mapped-child names concatenated DAG, map, and child identifiers, but neither derivation adapted the resulting registry/file basename to the filesystem's 255-byte component bound. The parser therefore issued individually valid 128-character identifier proofs whose derived prompt path was not materializable.

### DECLARED invariant

Every generated prompt identity is deterministic, collision-resistant, and materializable as `<name>.txt` within the portable 255-byte filesystem component bound. Existing names at or below the bound remain byte-identical; overlong root and mapped-child names preserve a readable prefix and gain a full SHA-256 suffix derived from the complete logical name. A successful `AuthoredDag` can never fail scaffold writing solely because codegen combined valid identifiers into an overlong prompt basename.

### Sibling accounting

- `packages/framework/src/cli/authored-codegen.ts` — **repaired**: route both ordinary multi-LLM and mapped-child prompt names through one pure NAME_MAX adapter using the existing SHA-256 dependency.
- `packages/framework/src/cli/new.ts` — **checked-unmodified**: the one scaffold writer correctly treats prompt names as registry keys plus `.txt`; bounded identity belongs before this I/O shell.
- `packages/framework/src/cli/prompts.ts` — **checked-unmodified**: prompt sync/check consumes already-materialized basenames and needs no authored-codegen exception.
- `packages/framework/src/__tests__/cli/authored-map.test.ts` — **repaired**: pin ordinary and child prompt boundary behavior, determinism, collision resistance, unchanged short names, and successful real scaffold writing at maximal authored identifier lengths.
- `packages/framework/docs/llm-dag-authoring.md` — **repaired**: document the bounded long-name adaptation instead of claiming every child prompt retains the literal concatenation.
- `CONTEXT.md` — **repaired**: record prompt file identity as part of the parser/codegen materializability contract.

### Selected check and Historical RED

- Check: `project:authored-map-regression`
- Historical RED (`DECLARED`): on reviewed HEAD `93124d7e`, a parsed map with 128-character DAG, map, and child-LLM identifiers generated a 386-character prompt name; `writeAuthoredScaffold` threw `ENAMETOOLONG` while opening `<name>.txt` after earlier scaffold files had been written. Ordinary multi-LLM prompt concatenation had the same sibling defect at its own boundary.
- Reference: review run `20260913T110131Z-pr48-review-7`, finding `code-reviewer-1`.

## Declared Repair Group: `group.total-dag-validation-boundaries`

### DECLARED root cause

Two opaque caller operations remained outside the mandatory DAG parser's containment region: `withRetryLimits` spread caller-provided overrides before invoking `validateDagShape`, and source validation invoked an opaque Zod schema's `safeParse` callback directly. Accessor/proxy failures and throwing Zod refinements therefore escaped the public `Result` channel.

### DECLARED invariant

Every caller-controlled read or callback used to derive a `DagDef` is captured within an exception-containment region and converted to a node-attributed `validation` error. `withRetryLimits` and `validateDagShape` are total for hostile retry-limit containers and throwing source schemas: each returns exactly one `Result` arm and never leaks the supplied exception. Successful inputs preserve existing validation order and output bytes.

### Sibling accounting

- `packages/framework/src/shared/validate-dag.ts` — **repaired**: capture retry overrides before DAG reconstruction, contain the source unit-schema probe, and retain safe diagnostic rendering in typed validation errors.
- `packages/framework/src/executor/validate-dag.ts` — **checked-unmodified**: this module only re-exports the repaired canonical implementation.
- `packages/framework/src/executor/run-dag.ts` — **checked-unmodified**: per-call retry overrides already delegate to `withRetryLimits`; the fix belongs at that public parser seam.
- `packages/framework/src/__tests__/cli/authored-map.test.ts` — **repaired**: the registered check reproduces accessor/proxy retry failures and a throwing source-schema refinement and asserts node-attributed `Err` values.
- `packages/framework/src/__tests__/validate-dag.test.ts` — **repaired**: focused validator regressions pin both total boundaries alongside the existing source/retry contracts.
- `CONTEXT.md` — **repaired**: the no-cross-boundary-exception rule explicitly includes opaque schema probes and retry-override capture.

### Selected check and Historical RED

- Check: `project:authored-map-regression`
- Historical RED (`DECLARED`): on reviewed HEAD `93124d7e`, an enumerable getter or proxy trap in `withRetryLimits(..., limits)` threw during object spread before `validateDagShape`, and `z.any().superRefine(() => { throw ... })` escaped from the source `inputSchema.safeParse(undefined)` probe. Neither call returned its declared `Result`.
- Reference: review run `20260913T110131Z-pr48-review-7`, findings `silent-failure-hunter-1` and `silent-failure-hunter-2`.

## Advisory dispositions

### Accepted

- `pr-test-analyzer-1` — execute generated fan-source, fan-branch, and router-handler map roles through public `runDag`; the new router execution exposed and therefore also repairs the shared input assembler's mismatch with the documented `defineRouter` contract: one selected conditional/default source is a bare upstream value, while genuine multi-source optional fan-in remains keyed.
- `pr-test-analyzer-2` — add valid and malformed root-map checkpoint replay cases to prove output-schema re-hardening and child-item rejection across resume.
- `comment-analyzer-1` — clarify that prototype-named keys are never inherited but can be present as the selected own gather field.
- `comment-analyzer-2` — narrow `ID_PATTERN` JSDoc to its actual consumers and distinguish the stricter `DagId` grammar.
- `code-simplifier-2` — make `ChildNodePlan.outSpec` non-nullable and delete the impossible mapped-child schema branch.
- `code-simplifier-3` — derive parsed compose intent/team once after raw argument collection, preserving accumulate-all diagnostic order.
- `code-simplifier-4` — express the linear terminal set as `order.slice(-1)`.
- `code-simplifier-5` — flatten freshness extractor XOR selection without changing error precedence.

### Deferred

- `type-design-analyzer-1` — statically relating mapped item input, generic child DAG input/output, and child schema requires parameterizing the public `DagDef` aggregate or adding a new mapped-child contract; this is a broad public type redesign, not a focused boundary repair.
- `architecture-tech-lead-1` — a shared immutable authored graph plan changes parser/codegen interfaces across all five topologies; retain this explicitly scheduled post-PR-C deepening rather than partially migrating it here.
- `architecture-tech-lead-2` — a pure compose state machine changes workflow/effect interfaces and requires dedicated property design; it remains separate post-PR-C work.
- `code-simplifier-1` — consolidating root/child topology wiring is the same shared-planner deepening as `architecture-tech-lead-1`; extracting only part now would introduce an intermediate seam without resolving semantic ownership.

### Dismissed

None.

## Refuted-finding audit

No critical finding was refuted. Reproduction, intent, and security panel members unanimously upheld all three admitted criticals.

## Intended changed paths

- `.claude/plans/2026-09-13-pr-remediation-7.md`
- `CONTEXT.md`
- `packages/framework/docs/llm-dag-authoring.md`
- `packages/framework/src/__tests__/cli/authored-map.test.ts`
- `packages/framework/src/__tests__/validate-dag.test.ts`
- `packages/framework/src/cli/authored-codegen.ts`
- `packages/framework/src/cli/authored.ts`
- `packages/framework/src/cli/compose.ts`
- `packages/framework/src/nodes/map.ts`
- `packages/framework/src/shared/validate-dag.ts`
- `packages/framework/src/shared/build-input.ts`
- `packages/framework/src/dag-runtime/topology.ts`
- `packages/framework/src/types/ids.ts`
- `packages/framework/src/__tests__/build-input.test.ts`

This new plan, `packages/framework/src/shared/build-input.ts`, `packages/framework/src/dag-runtime/topology.ts`, and `packages/framework/src/__tests__/build-input.test.ts` are remediation support paths outside the frozen review scope. The latter three are accepted-advisory support, not critical-repair siblings. No protected authority/evidence path is a remediation sibling.

## Validation

Development evidence (not P3 authority):

1. `bun test packages/framework/src/__tests__/cli/authored-map.test.ts packages/framework/src/__tests__/validate-dag.test.ts packages/framework/src/__tests__/cli/compose.test.ts packages/framework/src/__tests__/cli/authored.test.ts packages/framework/src/__tests__/build-input.test.ts`
2. `bun run --cwd packages/framework typecheck`
3. `bun run verify` with Bun 1.4.2 and an authenticated Redis endpoint
4. `bun run check:docs`
5. `git diff --check`

Registered P3 observation:

- `project:authored-map-regression` must freshly produce its configured required JUnit report with more than zero tests and zero failures.
