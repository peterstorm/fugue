# PR Remediation — review run 20260915T072724Z-pr48-review-14 (round 48, second consecutive clean pass)

- **Branch:** `feat/f1-authored-map`
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/20260915T072724Z-pr48-review-14`
- **Reviewed HEAD:** `b878e1f6` (clean tree; scope = changed-path-union, 40 paths)
- **Adjudication (canonical `result.json`, digest `707e6480e0ede61a5931bddfa2cd739ad1dd62c80456a239263189547d799b4e`):**
  0 surviving criticals, 0 refuted criticals, 15 advisories, panel null.
- **Surviving-critical dispositions:** none — zero surviving criticals, so no Declared Repair Groups, no
  selected checks, and `defectFamily: {"kind":"not-required"}` at remediation start.
- **Refuted-finding audit:** none — nothing refuted, nothing withheld from fixing.

## Advisory dispositions (parent policy: accepted / deferred / dismissed)

| ID | Reviewer | Location | Disposition | Reason |
| --- | --- | --- | --- | --- |
| `code-reviewer-1` | code-reviewer | `packages/framework/src/shared/validate-dag.ts:90` | accepted | The new sideEffects-less-node rejection (the round-13 accepted code-reviewer-2 fix) is the one defensive branch of the mandatory soundness gate without a test pin, while every sibling branch is pinned in `validate-dag.test.ts`. A one-case pin (sideEffects-less node through the untyped cast path → named node-attributed validation error) is cheap, in-scope, and mirrors the pin discipline the prior round applied to the `'__proto__'` and `loadedPrompts` surfaces. |
| `code-reviewer-2` | code-reviewer | `packages/framework/src/cli/authored-codegen.ts:717` | accepted | `emitMapNode` interpolates `childSchema` twice inline although the terminal's already-emitted `$child_<Pascal>Schema` const serves both roles result-identically: `childPlan(terminal).outSpec === childOutputSpec(node.child)` (both derive from the terminal via `withConfidence`/`childNodeOutputSpec`, verified by reading both functions), neither config field mutates the schema object, and the mapping identity check (`isAuthoredCollectGather`) compares references. Fix: export `terminalRefs` from `authored.ts` (real second consumer in `authored-codegen.ts`), resolve the terminal plan, and reference its const name for both fields — one schema instance per generated map factory instead of three. |
| `silent-failure-hunter-1` | silent-failure-hunter | `packages/framework/src/describe/build-described-dag.ts:251` | deferred | The complete fix requires either making `warningSink` required (an interface change across in-scope test files — 12 `buildDescribedDag` call sites, 2 test files pass no sink) or defaulting the port to an I/O-writing sink inside the pure builder (an FC/IS violation: business logic mixed with I/O). The gap is diagnostic-only, every in-scope CLI caller passes a sink, and the null schema itself is visible in the payload. Deferred to a focused design pass on the sink contract. |
| `silent-failure-hunter-2` | silent-failure-hunter | `packages/framework/src/describe/build-described-dag.ts:249` | deferred | The null-schema degradation for an unresolvable output node is explicitly documented as deliberate ("Non-fatal by design: an unresolvable output node degrades the DESCRIPTION to a null schema rather than failing the describe endpoint outright") and pinned by the in-scope test `renders a null outputSchema when outputNodeId names a node the DAG does not contain`. Flipping it to `err` would reverse a documented design choice consumed by the describe endpoint; the module-doc symmetry tension is a design decision, not a defect. Deferred. |
| `pr-test-analyzer-1` | pr-test-analyzer | `packages/framework/src/shared/validate-dag.ts:90` | accepted | Same surface as `code-reviewer-1` (both reviewers flagged the missing pin independently); the one-case pin covers both findings. |
| `pr-test-analyzer-2` | pr-test-analyzer | `packages/framework/src/shared/validate-dag.ts:469` | accepted | The total `safeErrorMessage` rendering of hostile guard values is message-identical for every stringifiable pinned value (NaN, -1, 1.5, Infinity), so the accepted type-design-analyzer-2 fix is invisible to the current suite. One hostile non-stringifiable case (e.g. `Object.create(null)` as a retryLimits entry) pins the total rendering so a reverted `String()` regression settles in the promised typed Err. |
| `type-design-analyzer-1` | type-design-analyzer | `packages/framework/src/dag-runtime/topology.ts:201` | accepted | `DagInputId` is a subtype of `NodeId` (`types/ids.ts:44`), so typing `IncomingSources.required/optional` as `readonly NodeId[]` admits `DAG_INPUT` and extends the parse-dont-validate proof from the branded EdgeDef endpoints through `computeIncomingByNode` into the branded `buildNodeInput` at zero runtime cost. Fix touches `shared/incoming.ts` (accepted-advisory path not in the reviewed scope → named in `supportPaths`) plus the in-scope annotation at `topology.ts:201`. |
| `comment-analyzer-1` | comment-analyzer | `packages/framework/src/types/ids.ts:144` | accepted | Stale and miscounted doc: three `try*` parsers exist; `tryDagId` tests `DAG_ID_REGEX` directly and never calls `matchesIdPattern`, so the helper backs exactly two of the three. A maintainer taking "the ONE test" literally could route `tryDagId` through `matchesIdPattern`, whose character class includes `:` and would silently weaken DagId's no-colon grammar. Comment-only fix. |
| `comment-analyzer-2` | comment-analyzer | `packages/framework/src/types/ids.ts:6` | accepted | The validating `__brandXxx` variants validate against the same grammars themselves; the actual unchecked bypasses are the `*Unchecked` variants, which the header never mentions. "Escape hatches ... that has already validated by other means" misdescribes them as validation bypasses. Comment-only fix. |
| `comment-analyzer-3` | comment-analyzer | `packages/framework/src/types/dag.ts:277` | accepted | No CLI identifier named `SHAPES` exists: the CLI's shape union is the `Shape` type (`cli/new-templates.ts:47`), re-exporting the tuple. Name the actual projection. Comment-only fix; the substantive single-source claim is accurate. |
| `comment-analyzer-4` | comment-analyzer | `packages/framework/src/__tests__/build-described-dag.test.ts:113` | accepted | Grammar: "a already-branded" → "an already-branded". Trivial comment-only polish. |
| `code-simplifier-1` | code-simplifier | `packages/framework/src/dag-runtime/topology.ts:130` | deferred | Removal of the three dead exports (`outgoingOf`, slow-path `incomingSources`, raw-edges `seedInitialActiveSet` overload) changes the exported API surface and spans re-export files outside the frozen scope (`dag-runtime/conditional.ts`, `dag-runtime/index.ts`) — interface-bound. The reviewer's own recommendation is a deepen session rather than remediation. Deferred to a deepen pass. |
| `code-simplifier-2` | code-simplifier | `packages/framework/src/cli/authored.ts:740` | accepted | `authoredNodeVariants` splices `HumanReviewNodeSchema`/`MapNodeSchema` by numeric index, so a reader must count indices to know the kind vocabulary order. Listing the six variants explicitly in the current `KIND_LIST` order (fetch, transform, llm, human-review, source, map) is behavior-neutral — discriminated-union parsing is by distinct literal discriminator — and `KIND_LIST` plus its pinned test keep their exact order. |
| `code-simplifier-3` | code-simplifier | `packages/framework/src/describe/build-described-dag.ts:160` | accepted | Eleven redundant `as string` casts on branded NodeId/DagId values where widening to string is implicit. Brand-to-base widening is always implicit, so the casts suggest a narrowing hazard that does not exist and fight the documented transparency invariant. Dropping them leaves every payload field byte-identical. |
| `code-simplifier-4` | authored-codegen | `packages/framework/src/cli/authored-codegen.ts:680` | accepted | `emitMapNode`'s two loops over `childIds` each re-derive the same throwing `plans.get` accessor with the identical invariant message that `emitChildStructure` already factors. A module-level `childPlanOf(plans, id)` accessor shared by both loops (and `emitChildStructure`'s local `plan`) states the "unknown child node" invariant once instead of three times across two functions. Behavior-neutral. |

**Totals:** 12 accepted, 3 deferred, 0 dismissed, 0 surviving criticals, 0 refuted.

## Accepted advisory fixes (implementation inventory)

1. `packages/framework/src/__tests__/validate-dag.test.ts` — pins for `code-reviewer-1`/`pr-test-analyzer-1`
   (sideEffects-less-node gate rejection) and `pr-test-analyzer-2` (hostile non-stringifiable guard value
   renders through `safeErrorMessage` into the typed Err).
2. `packages/framework/src/cli/authored-codegen.ts` — `code-reviewer-2`: resolve the child terminal plan and
   reference its emitted schema const for both `childOutputSchema` and `collectedItemSchema`; `code-simplifier-4`:
   module-level `childPlanOf(plans, id)` accessor shared by both `childIds` loops and `emitChildStructure`.
3. `packages/framework/src/cli/authored.ts` — export `terminalRefs` (codegen consumer); `code-simplifier-2`:
   explicit six-variant `authoredNodeVariants` list in `KIND_LIST` order.
4. `packages/framework/src/shared/incoming.ts` — `type-design-analyzer-1`: `IncomingSources.required/optional`
   as `readonly NodeId[]` (imports `types/ids.js`; types/ is a leaf, no cycle).
5. `packages/framework/src/dag-runtime/topology.ts` — `type-design-analyzer-1` in-scope annotation:
   `required`/`optional` local arrays as `NodeId[]`.
6. `packages/framework/src/types/ids.ts` — `comment-analyzer-1`/`-2`: matchesIdPattern doc + header doc.
7. `packages/framework/src/types/dag.ts` — `comment-analyzer-3`: DAG_SHAPES doc names `Shape`.
8. `packages/framework/src/__tests__/build-described-dag.test.ts` — `comment-analyzer-4`: grammar.
9. `packages/framework/src/describe/build-described-dag.ts` — `code-simplifier-3`: drop the eleven redundant
   `as string` casts (payload byte-identical).

## Support paths (remediation start input)

- `.claude/plans/2026-09-15-pr-remediation-2.md` (this plan — not in the reviewed scope)
- `packages/framework/src/shared/incoming.ts` (accepted-advisory `type-design-analyzer-1` target — not in the
  reviewed scope)

## Validation commands

- `PATH="/tmp/bun-1.4.2/bun-linux-x64:$PATH" REDIS_URL=redis://:fugue-test@127.0.0.1:6380 bun run verify`
  (verification prerequisites, typecheck, docs, script tests, full suite)
- Development runs are not P3 evidence; zero surviving criticals require no operator check or manifest.
